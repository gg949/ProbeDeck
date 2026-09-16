const TURNSTILE_DOMAIN = 'https://challenges.cloudflare.com';
const INSIGHTS_DOMAIN = 'https://static.cloudflareinsights.com';
const FONTS_API_DOMAIN = 'https://fonts.googleapis.com';
const FONTS_STATIC_DOMAIN = 'https://fonts.gstatic.com';
const RAW_GITHUB_DOMAIN = 'https://raw.githubusercontent.com';
const DEFAULT_CONNECT_DOMAINS = [
  'https://api.github.com',
  'https://api.iconify.design',
  'https://api.unisvg.com',
  'https://api.simplesvg.com',
  'https://api.frankfurter.app',
  'https://api.frankfurter.dev',
  'https://open.er-api.com',
  'https://api.ip.sb',
  'https://ipwho.is',
  'https://api.ipapi.is',
  'https://ipapi.co',
  'https://api.vore.top'
];

const CSP_META_TAG_RE_GLOBAL = /<meta\b(?=[^>]*http-equiv=["']Content-Security-Policy["'])[^>]*>\s*/gi;
const API_BASE_META_TAG_RE = /<meta\b(?=[^>]*\bname=["']apiBase["'])[^>]*>/i;

export function stripCspMeta(html) {
  return html.replace(CSP_META_TAG_RE_GLOBAL, '');
}

function uniqueSources(sources) {
  return [...new Set(sources.filter(Boolean))];
}

function buildDirective(name, sources) {
  return `${name} ${uniqueSources(sources).join(' ')}`;
}

export function normalizeCspOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw || /[\s;"']/.test(raw)) return '';
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:') return '';
    if (url.username || url.password || url.search || url.hash) return '';
    if (url.pathname && url.pathname !== '/') return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

export function parseCspOrigins(value) {
  return [...new Set(String(value || '')
    .split(',')
    .map(normalizeCspOrigin)
    .filter(Boolean))];
}

export function buildApiDomainsWithWs(rawApiDomains) {
  const domains = [];
  for (const domain of [...new Set(rawApiDomains)]) {
    domains.push(domain);
    if (domain.startsWith('https://')) {
      domains.push(domain.replace('https://', 'wss://'));
    }
  }
  return domains;
}

export function buildCspHeader({ staticDomains = [], apiDomains = [] } = {}) {
  return [
    buildDirective('default-src', ["'self'"]),
    buildDirective('script-src', ["'self'", "'unsafe-inline'", TURNSTILE_DOMAIN, INSIGHTS_DOMAIN, ...staticDomains]),
    buildDirective('style-src', ["'self'", "'unsafe-inline'", TURNSTILE_DOMAIN, FONTS_API_DOMAIN, ...staticDomains]),
    buildDirective('img-src', ["'self'", TURNSTILE_DOMAIN, RAW_GITHUB_DOMAIN, ...staticDomains, 'data:']),
    buildDirective('font-src', ["'self'", TURNSTILE_DOMAIN, FONTS_STATIC_DOMAIN, ...staticDomains]),
    buildDirective('connect-src', ["'self'", TURNSTILE_DOMAIN, INSIGHTS_DOMAIN, RAW_GITHUB_DOMAIN, ...DEFAULT_CONNECT_DOMAINS, ...apiDomains]),
    buildDirective('frame-src', [TURNSTILE_DOMAIN]),
    buildDirective('frame-ancestors', ["'none'"]),
    buildDirective('form-action', ["'self'"]),
    buildDirective('object-src', ["'none'"]),
    buildDirective('base-uri', ["'self'"])
  ].join(';');
}

export function injectTitle(html, title) {
  if (!title) return html;
  return html.replace(/<title>.*?<\/title>/, `<title>${String(title).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}</title>`);
}

export function injectApiBase(html, apiBases) {
  if (!apiBases || apiBases.length === 0) return html;
  const content = Array.isArray(apiBases) ? apiBases.join(',') : String(apiBases);
  const meta = `<meta name="apiBase" content="${content.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`;
  if (API_BASE_META_TAG_RE.test(html)) {
    return html.replace(API_BASE_META_TAG_RE, meta);
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `${meta}\n</head>`);
  }
  return `${meta}\n${html}`;
}

function escapeCssUrl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/"/g, '\\"');
}

function buildBodyBackgroundRule(safeUrl) {
  return `body{background-image:url('${safeUrl}') !important;background-size:cover !important;background-attachment:fixed !important;background-position:center !important;background-repeat:no-repeat !important;}`;
}

function buildMobileFixedBackgroundRules(safeUrl) {
  return `body{position:relative;min-height:100vh;background-image:none !important;background-color:transparent !important;background-attachment:scroll !important;}body::after{content:"";position:fixed;top:0;left:0;width:100%;height:100vh;height:100lvh;pointer-events:none;z-index:-1;background-image:url('${safeUrl}') !important;background-size:cover !important;background-position:center !important;background-repeat:no-repeat !important;}html{background-color:var(--bg-primary,#0d1117) !important;}`;
}

export function buildBackgroundStyle(url, mobileUrl = '') {
  const desktop = String(url || '').trim();
  const mobile = String(mobileUrl || '').trim();
  if (!desktop && !mobile) return '';

  const rules = [];
  let mobileBackground = '';
  if (desktop) {
    const safe = escapeCssUrl(desktop);
    rules.push(buildBodyBackgroundRule(safe));
    mobileBackground = safe;
  }
  if (mobile) {
    mobileBackground = escapeCssUrl(mobile);
  }
  if (mobileBackground) {
    rules.push(`@media (max-width: 767px){${buildMobileFixedBackgroundRules(mobileBackground)}}`);
  }
  return `<style>${rules.join('')}</style>`;
}
