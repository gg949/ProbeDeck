import assert from 'node:assert/strict';
import {
  estimateDurableObjectsBillableRequests,
  summarizeDurableObjectsUsage
} from '../src/handlers/admin.js';
import {
  isValidThemeOptions,
  saveThemeOptions
} from '../src/utils/settings.js';

function makeSettingsDb(initialRows = {}) {
  const store = new Map(Object.entries(initialRows));
  const calls = [];
  return {
    store,
    calls,
    prepare(sql) {
      calls.push({ type: 'prepare', sql });
      const statement = {
        params: [],
        bind(...params) {
          statement.params = params;
          return statement;
        },
        async first() {
          calls.push({ type: 'first', sql, params: statement.params });
          throw new Error('saveThemeOptions should not read appearance_options before writing');
        },
        async run() {
          calls.push({ type: 'run', sql, params: statement.params });
          if (/INSERT INTO settings/.test(sql) && /json_set/.test(sql)) {
            const themeOptions = JSON.parse(statement.params[0]);
            let existing = {};
            try {
              const parsed = JSON.parse(store.get('appearance_options') || '{}');
              existing = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
            } catch (_) {
              existing = {};
            }
            store.set('appearance_options', JSON.stringify({
              ...existing,
              theme_options: themeOptions
            }));
          }
          return { success: true };
        }
      };
      return statement;
    }
  };
}

assert.equal(estimateDurableObjectsBillableRequests(0), 0);
assert.equal(estimateDurableObjectsBillableRequests(1), 1);
assert.equal(estimateDurableObjectsBillableRequests(20), 1);
assert.equal(estimateDurableObjectsBillableRequests(21), 2);
assert.equal(estimateDurableObjectsBillableRequests(100), 5);
assert.equal(estimateDurableObjectsBillableRequests('101'), 6);

assert.equal(estimateDurableObjectsBillableRequests({
  httpRequests: 12,
  hibernationWakeups: 20,
  inboundWebSocketMessages: 21,
  outboundWebSocketMessages: 1000
}), 34);

const usage = summarizeDurableObjectsUsage([
  { dimensions: { type: 'fetch' }, sum: { requests: 10 } },
  { dimensions: { type: 'websocket_message' }, sum: { requests: 21 } },
  { dimensions: { type: 'webSocketHibernation' }, sum: { requests: 20 } }
], [
  { sum: { inboundWebsocketMsgCount: 39, outboundWebsocketMsgCount: 100 } },
  { sum: { inboundWebsocketMsgCount: '1', outboundWebsocketMsgCount: '20' } }
]);

assert.deepEqual(usage, {
  httpRequests: 10,
  hibernationWakeups: 41,
  inboundWebSocketMessages: 40,
  outboundWebSocketMessages: 120,
  rawRequests: 51,
  billableRequests: 53
});

assert.equal(isValidThemeOptions({}), true);
assert.equal(isValidThemeOptions({ layout: 'compact' }), true);
assert.equal(isValidThemeOptions([]), false);
assert.equal(isValidThemeOptions(null), false);
assert.equal(isValidThemeOptions('{"layout":"compact"}'), false);

const themeOptionsDb = makeSettingsDb({
  appearance_options: JSON.stringify({
    site_title: 'Keep Title',
    csp_api: 'https://api.example.com',
    theme_options: { old: true }
  }),
  site_options: JSON.stringify({
    is_public: 'false',
    theme_url: 'https://github.com/example/theme/tree/main'
  })
});

const savedAppearanceOptions = await saveThemeOptions(themeOptionsDb, {
  layout: 'compact',
  color: 'green'
});

assert.deepEqual(savedAppearanceOptions, {
  layout: 'compact',
  color: 'green'
});
assert.deepEqual(JSON.parse(themeOptionsDb.store.get('appearance_options')), {
  site_title: 'Keep Title',
  csp_api: 'https://api.example.com',
  theme_options: {
    layout: 'compact',
    color: 'green'
  }
});
assert.deepEqual(JSON.parse(themeOptionsDb.store.get('site_options')), {
  is_public: 'false',
  theme_url: 'https://github.com/example/theme/tree/main'
});
assert.equal(themeOptionsDb.calls.some(call => call.type === 'first'), false);
assert.equal(themeOptionsDb.calls.some(call => call.type === 'run' && /\$\.theme_options/.test(call.sql)), true);

console.log('admin usage tests passed');
