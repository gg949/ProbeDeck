export async function notifyAgentConfigChanged(env, serverId) {
  const normalizedServerId = String(serverId || '').trim();
  if (!normalizedServerId || !env?.METRICS_BROADCASTER) return null;

  const id = env.METRICS_BROADCASTER.idFromName('global');
  const stub = env.METRICS_BROADCASTER.get(id);
  return stub.fetch('http://internal/agent-config-changed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ serverId: normalizedServerId })
  });
}

export async function notifyAgentReportModeChanged(env) {
  if (!env?.METRICS_BROADCASTER) return null;

  const id = env.METRICS_BROADCASTER.idFromName('global');
  const stub = env.METRICS_BROADCASTER.get(id);
  return stub.fetch('http://internal/agent-config-changed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentReportModeChanged: true })
  });
}

export function scheduleAgentConfigChanged(env, ctx, serverId) {
  const promise = notifyAgentConfigChanged(env, serverId).catch(e => {
    console.warn('[agent-config] notify change failed:', e?.message || e);
    return null;
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  }

  return promise;
}

export function scheduleAgentReportModeChanged(env, ctx) {
  const promise = notifyAgentReportModeChanged(env).catch(e => {
    console.warn('[agent-config] notify report mode change failed:', e?.message || e);
    return null;
  });

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(promise);
  }

  return promise;
}
