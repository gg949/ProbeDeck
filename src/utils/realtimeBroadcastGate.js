import { FRONTEND_REALTIME_ACTIVE_GRACE_MS } from './config.js';

let frontendActiveUntil = 0;

export function markFrontendRealtimeActive(now = Date.now()) {
  frontendActiveUntil = Math.max(frontendActiveUntil, now + FRONTEND_REALTIME_ACTIVE_GRACE_MS);
}

export function hasRecentFrontendRealtimeActivity(now = Date.now()) {
  return now <= frontendActiveUntil;
}
