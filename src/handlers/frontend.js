import { loadSettings } from '../utils/settings.js';
import {
  DEFAULT_SITE_TITLE,
  THEME_ASSET_CACHE_TTL_SECONDS,
  THEME_COMMIT_CACHE_TTL_SECONDS
} from '../utils/config.js';
import {
  parseCspOrigins,
  buildApiDomainsWithWs,
  buildCspHeader,
  buildBackgroundStyle,
  stripCspMeta,
  injectApiBase
} from '../utils/csp.js';
import { checkAuth } from '../middleware/auth.js';

const IMMUTABLE_ASSET_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const PREVIEW_COOKIE = 'cfsm_theme_preview';
const PREVIEW_AUTH_COOKIE = 'cfsm_theme_preview_auth';

let filesCache = null;

async function loadFrontendFiles(env) {
  if (filesCache) return filesCache;

  try {
    const files = {};

    if (env.ASSETS) {
      try {
        const mainFiles = ['dashboard.html', 'style.css'];
        for (const filename of mainFiles) {
          try {
            const res = await env.ASSETS.fetch(new Request(`http://static/${filename}`));
            if (res.ok) {
              files[filename] = await res.text();
            }
          } catch (e) {
            // ignore missing asset binding files
          }
        }
      } catch (e) {
        console.log('[INFO] No ASSETS binding');
      }
    }

    filesCache = files;
    return filesCache;
  } catch (e) {
    console.error('[ERROR] Failed to load frontend files:', e);
    return {};
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function insertBeforeHeadClose(html, content) {
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${content}\n</head>`);
  }
  return `${content}\n${html}`;
}

function injectTitle(html, title) {
  const safeTitle = escapeHtml(title || DEFAULT_SITE_TITLE);
  if (/<title>.*?<\/title>/is.test(html)) {
    return html.replace(/<title>.*?<\/title>/is, `<title>${safeTitle}</title>`);
  }
  return insertBeforeHeadClose(html, `<title>${safeTitle}</title>`);
}

function injectFavicon(html, favicon) {
  const value = String(favicon || '').trim();
  if (!value) return html;

  const withoutExistingIcons = html.replace(/<link\b(?=[^>]*\brel=["'][^"']*(?:shortcut\s+icon|icon)[^"']*["'])[^>]*>\s*/gi, '');
  const safeFavicon = escapeHtml(value);
  return insertBeforeHeadClose(withoutExistingIcons, `<link rel="icon" href="${safeFavicon}">`);
}

function getEnvApiBases(env) {
  return parseCspOrigins(env?.API_BASE || '');
}

function injectAppearanceSettings(html, settings, env = {}) {
  let modifiedHtml = stripCspMeta(html);

  modifiedHtml = injectTitle(modifiedHtml, settings.site_title || DEFAULT_SITE_TITLE);
  modifiedHtml = injectFavicon(modifiedHtml, settings.favicon);

  const envApiBases = getEnvApiBases(env);
  modifiedHtml = injectApiBase(modifiedHtml, envApiBases);

  const cspStatic = settings.csp_static || '';
  const cspApi = settings.csp_api || '';
  const staticDomains = parseCspOrigins(cspStatic);
  const rawApiDomains = [
    ...envApiBases,
    ...parseCspOrigins(cspApi)
  ];
  const apiDomains = buildApiDomainsWithWs(rawApiDomains);
  const csp = buildCspHeader({ staticDomains, apiDomains });

  if (settings.custom_head) {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, settings.custom_head);
  }

  if (settings.custom_script) {
    if (/<\/body>/i.test(modifiedHtml)) {
      modifiedHtml = modifiedHtml.replace(/<\/body>/i, `<script>${settings.custom_script}</script>\n</body>`);
    } else {
      modifiedHtml += `\n<script>${settings.custom_script}</script>`;
    }
  }

  if (settings.custom_bg || settings.custom_bg_mobile) {
    modifiedHtml = insertBeforeHeadClose(modifiedHtml, buildBackgroundStyle(settings.custom_bg, settings.custom_bg_mobile));
  }

  return {
    html: modifiedHtml,
    csp
  };
}

function getContentType(path) {
  const cleanPath = String(path || '').split('?')[0].toLowerCase();
  if (cleanPath.endsWith('.html')) return 'text/html;charset=UTF-8';
  if (cleanPath.endsWith('.js') || cleanPath.endsWith('.mjs')) return 'application/javascript;charset=UTF-8';
  if (cleanPath.endsWith('.css')) return 'text/css;charset=UTF-8';
  if (cleanPath.endsWith('.json')) return 'application/json;charset=UTF-8';
  if (cleanPath.endsWith('.svg')) return 'image/svg+xml';
  if (cleanPath.endsWith('.png')) return 'image/png';
  if (cleanPath.endsWith('.jpg') || cleanPath.endsWith('.jpeg')) return 'image/jpeg';
  if (cleanPath.endsWith('.webp') || cleanPath.endsWith('.webpg')) return 'image/webp';
  if (cleanPath.endsWith('.gif')) return 'image/gif';
  if (cleanPath.endsWith('.ico')) return 'image/x-icon';
  if (cleanPath.endsWith('.avif')) return 'image/avif';
  if (cleanPath.endsWith('.woff')) return 'font/woff';
  if (cleanPath.endsWith('.woff2')) return 'font/woff2';
  if (cleanPath.endsWith('.ttf')) return 'font/ttf';
  if (cleanPath.endsWith('.otf')) return 'font/otf';
  if (cleanPath.endsWith('.map')) return 'application/json;charset=UTF-8';
  return 'application/octet-stream';
}

function normalizeThemeUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';

  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return '';
    if (url.username || url.password || url.search || url.hash) return '';

    const parts = url.pathname.split('/').filter(Boolean);
    const ref = parts[3];
    if (
      parts.length < 4 ||
      parts[2] !== 'tree' ||
      !/^[A-Za-z0-9._-]+$/.test(parts[0]) ||
      !/^[A-Za-z0-9._-]+$/.test(parts[1]) ||
      !/^[A-Za-z0-9._-]+$/.test(ref) ||
      parts.some(part => part === '.' || part === '..' || /[%\\]/.test(part))
    ) {
      return '';
    }

    return `https://github.com/${parts.join('/')}`;
  } catch (_) {
    return '';
  }
}

function parseThemeUrl(themeUrl) {
  const normalized = normalizeThemeUrl(themeUrl);
  if (!normalized) return null;

  const url = new URL(normalized);
  const parts = url.pathname.split('/').filter(Boolean);
  const owner = parts[0];
  const repo = parts[1];
  const ref = parts[3];
  const themePathParts = parts.slice(4);
  const encodedThemePath = [owner, repo, ref, ...themePathParts]
    .map(part => encodeURIComponent(part))
    .join('/');

  return {
    themeUrl: normalized,
    ref,
    rawBase: `https://raw.githubusercontent.com/${encodedThemePath}`,
    cacheBase: `https://cfsm-theme-cache.local/${encodedThemePath}`
  };
}

function isCommitRef(ref) {
  return /^[a-f0-9]{40}$/i.test(ref);
}

function getThemeWorkerCacheTtl(parsedTheme) {
  return isCommitRef(parsedTheme.ref) ? THEME_COMMIT_CACHE_TTL_SECONDS : THEME_ASSET_CACHE_TTL_SECONDS;
}

function getThemeAssetBrowserCacheControl(parsedTheme) {
  if (isCommitRef(parsedTheme.ref)) {
    return IMMUTABLE_ASSET_CACHE_CONTROL;
  }
  return `public, max-age=${THEME_ASSET_CACHE_TTL_SECONDS}`;
}

function getCookie(request, name) {
  const cookie = request.headers.get('Cookie') || '';
  for (const part of cookie.split(';')) {
    const [key, ...valueParts] = part.trim().split('=');
    if (key === name) {
      return valueParts.join('=');
    }
  }
  return '';
}

function getPreviewThemeUrlFromCookie(request) {
  const value = getCookie(request, PREVIEW_COOKIE);
  if (!value) return '';
  try {
    return normalizeThemeUrl(decodeURIComponent(value));
  } catch (_) {
    return '';
  }
}

function buildPreviewCookie(request, themeUrl) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${PREVIEW_COOKIE}=${encodeURIComponent(themeUrl)}; Max-Age=${THEME_ASSET_CACHE_TTL_SECONDS}; Path=/; SameSite=Lax${secure}`;
}

function buildClearPreviewCookie(request) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${PREVIEW_COOKIE}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

async function checkPreviewAuth(request, env, settings) {
  const token = getCookie(request, PREVIEW_AUTH_COOKIE);
  if (!token) return false;

  try {
    const authRequest = {
      headers: {
        get: (key) => {
          if (String(key).toLowerCase() === 'authorization') {
            return `Bearer ${decodeURIComponent(token)}`;
          }
          return request.headers.get(key);
        }
      }
    };
    return await checkAuth(authRequest, env, settings);
  } catch (_) {
    return false;
  }
}

function getPreviewThemeUrlFromQuery(url) {
  if (!url.searchParams.has('theme_url')) return '';
  return normalizeThemeUrl(url.searchParams.get('theme_url'));
}

function normalizeAssetPath(pathname) {
  const raw = pathname.slice('/assets/'.length);
  if (!raw) return '';

  try {
    const decoded = decodeURIComponent(raw);
    if (decoded.includes('\\')) return '';
    const parts = decoded.split('/').filter(Boolean);
    if (parts.length === 0 || parts.some(part => part === '.' || part === '..')) return '';
    return parts.map(part => encodeURIComponent(part)).join('/');
  } catch (_) {
    return '';
  }
}

function normalizeThemeAssetUrls(html) {
  return html.replace(/\b(src|href)=(["'])\.?\/?assets\//gi, '$1=$2/assets/');
}

function stripBrowserCacheHeaders(response) {
  const headers = new Headers(response.headers);
  headers.delete('Cache-Control');
  headers.delete('CDN-Cache-Control');
  headers.delete('Pragma');
  headers.delete('Expires');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function fetchWithCache(rawUrl, contentType, workerCacheUrl, workerCacheTtl = THEME_ASSET_CACHE_TTL_SECONDS) {
  const cacheKey = new Request(workerCacheUrl || rawUrl, { method: 'GET' });
  const cache = typeof caches !== 'undefined' ? caches.default : null;

  if (cache) {
    const cached = await cache.match(cacheKey);
    if (cached) {
      return stripBrowserCacheHeaders(cached);
    }
  }

  const originResponse = await fetch(rawUrl, {
    headers: { 'User-Agent': 'CFSM-Theme-Proxy' }
  });

  if (!originResponse.ok) {
    return new Response('Theme file not found', {
      status: originResponse.status,
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
    });
  }

  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Cache-Control', `public, max-age=${workerCacheTtl}`);
  headers.set('CDN-Cache-Control', `public, max-age=${workerCacheTtl}`);
  headers.set('X-Content-Type-Options', 'nosniff');

  const etag = originResponse.headers.get('ETag');
  if (etag) headers.set('ETag', etag);

  const response = new Response(originResponse.body, {
    status: 200,
    headers
  });

  if (cache) {
    await cache.put(cacheKey, response.clone()).catch(() => {});
  }

  return stripBrowserCacheHeaders(response);
}

async function serveThemeAsset(request, themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  const url = new URL(request.url);
  const assetPath = normalizeAssetPath(url.pathname);

  if (!parsedTheme || !assetPath) {
    return new Response('Not Found', {
      status: 404,
      headers: {
        'Content-Type': 'text/plain;charset=UTF-8',
        'X-CFSM-Theme-Asset': '1'
      }
    });
  }

  const contentType = getContentType(assetPath);
  const response = await fetchWithCache(
    `${parsedTheme.rawBase}/assets/${assetPath}`,
    contentType,
    `${parsedTheme.cacheBase}/assets/${assetPath}`,
    getThemeWorkerCacheTtl(parsedTheme)
  );
  const headers = new Headers(response.headers);
  headers.set('X-CFSM-Theme-Asset', '1');
  if (response.ok) {
    headers.set('Cache-Control', getThemeAssetBrowserCacheControl(parsedTheme));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

async function loadThemeIndex(themeUrl) {
  const parsedTheme = parseThemeUrl(themeUrl);
  if (!parsedTheme) return null;

  const response = await fetchWithCache(
    `${parsedTheme.rawBase}/index.html`,
    'text/html;charset=UTF-8',
    `${parsedTheme.cacheBase}/index.html`,
    getThemeWorkerCacheTtl(parsedTheme)
  );

  if (!response.ok) return null;
  return normalizeThemeAssetUrls(await response.text());
}

function buildHtmlResponse(html, settings, request, env = {}, previewThemeUrl = '') {
  const rendered = injectAppearanceSettings(html, settings, env);
  const headers = new Headers({
    'Content-Type': 'text/html;charset=UTF-8',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': rendered.csp
  });

  if (previewThemeUrl) {
    headers.append('Set-Cookie', buildPreviewCookie(request, previewThemeUrl));
  } else if (getPreviewThemeUrlFromCookie(request)) {
    headers.append('Set-Cookie', buildClearPreviewCookie(request));
  }

  return new Response(rendered.html, { headers });
}

function buildThemeIndexErrorResponse() {
  return new Response('Theme index.html is unavailable', {
    status: 502,
    headers: {
      'Content-Type': 'text/plain;charset=UTF-8',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function buildPreviewUnauthorizedResponse(request, isAsset = false) {
  const headers = new Headers({
    'Content-Type': 'text/plain;charset=UTF-8',
    'X-Content-Type-Options': 'nosniff',
    'Set-Cookie': buildClearPreviewCookie(request)
  });

  if (isAsset) {
    headers.set('X-CFSM-Theme-Asset', '1');
  }

  return new Response('Theme preview requires admin login', {
    status: 401,
    headers
  });
}

function resolveThemeUrlForAsset(request, settings) {
  const url = new URL(request.url);
  const queryThemeUrl = getPreviewThemeUrlFromQuery(url);
  if (queryThemeUrl) {
    return { themeUrl: queryThemeUrl, preview: true };
  }

  const cookieThemeUrl = getPreviewThemeUrlFromCookie(request);
  if (cookieThemeUrl) {
    return { themeUrl: cookieThemeUrl, preview: true };
  }

  return {
    themeUrl: normalizeThemeUrl(settings?.theme_url),
    preview: false
  };
}

function shouldUseBuiltinFrontend(path) {
  return path === '/admin' || path.startsWith('/admin/');
}

export async function serveFrontend(request, env, settings = null) {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!settings) {
    settings = await loadSettings(env.DB);
  }

  if (request.method === 'GET' && path.startsWith('/assets/')) {
    const resolvedTheme = resolveThemeUrlForAsset(request, settings);
    if (!resolvedTheme.themeUrl) {
      return new Response('Not Found', {
        status: 404,
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
      });
    }
    if (resolvedTheme.preview && !await checkPreviewAuth(request, env, settings)) {
      return buildPreviewUnauthorizedResponse(request, true);
    }
    return serveThemeAsset(request, resolvedTheme.themeUrl);
  }

  const previewThemeUrl = getPreviewThemeUrlFromQuery(url);
  const configuredThemeUrl = normalizeThemeUrl(settings.theme_url);
  const effectiveThemeUrl = previewThemeUrl || configuredThemeUrl;

  if (previewThemeUrl && !await checkPreviewAuth(request, env, settings)) {
    return buildPreviewUnauthorizedResponse(request);
  }

  if (!shouldUseBuiltinFrontend(path) && effectiveThemeUrl) {
    const themeHtml = await loadThemeIndex(effectiveThemeUrl);
    if (themeHtml) {
      return buildHtmlResponse(themeHtml, settings, request, env, previewThemeUrl);
    }
    return buildThemeIndexErrorResponse();
  }

  const files = await loadFrontendFiles(env);
  const html = files['dashboard.html'];

  if (html) {
    return buildHtmlResponse(html, settings, request, env);
  }

  return new Response('Frontend not available. Please build the frontend first with `npm run build:frontend`.', {
    status: 503,
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' }
  });
}
