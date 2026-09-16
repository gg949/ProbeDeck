function parseAllowedOrigins(corsAllowedOrigins) {
  if (!corsAllowedOrigins || corsAllowedOrigins.trim() === '') {
    return [];
  }
  return corsAllowedOrigins
    .split(',')
    .map(o => o.trim())
    .filter(o => o !== '');
}

export function getCorsAllowedOrigins(env) {
  return parseAllowedOrigins(env.CORS_ALLOWED_ORIGINS);
}

export function isOriginAllowed(origin, allowedOrigins) {
  if (!origin || allowedOrigins.length === 0) {
    return false;
  }
  return allowedOrigins.includes(origin);
}

export function createCorsHeaders(origin, allowedOrigins) {
  const headers = new Headers();
  
  if (isOriginAllowed(origin, allowedOrigins)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Vary', 'Origin');
  }
  
  return headers;
}

export function createOptionsResponse(request, allowedOrigins) {
  const origin = request.headers.get('Origin');
  const headers = createCorsHeaders(origin, allowedOrigins);
  
  const requestMethod = request.headers.get('Access-Control-Request-Method');
  if (requestMethod) {
    headers.set('Access-Control-Allow-Methods', requestMethod);
  }
  
  const requestHeaders = request.headers.get('Access-Control-Request-Headers');
  if (requestHeaders) {
    headers.set('Access-Control-Allow-Headers', requestHeaders);
  }
  
  headers.set('Access-Control-Max-Age', '86400');
  headers.set('Content-Length', '0');
  
  return new Response(null, {
    status: 204,
    headers
  });
}

export function applyCors(response, request, allowedOrigins) {
  const origin = request.headers.get('Origin');
  if (!isOriginAllowed(origin, allowedOrigins)) {
    return response;
  }
  
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Access-Control-Allow-Origin', origin);
  newHeaders.set('Access-Control-Allow-Credentials', 'true');
  
  const vary = newHeaders.get('Vary') || '';
  if (!vary.includes('Origin')) {
    newHeaders.set('Vary', vary ? `${vary}, Origin` : 'Origin');
  }
  
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}