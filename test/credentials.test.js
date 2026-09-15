const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
function storage(values) {
  return {
    get: async (defaults) => Object.fromEntries(Object.entries(defaults).map(([key, value]) => [key, values[key] ?? value])),
    set: async (updates) => Object.assign(values, updates),
    remove: async (keys) => { for (const key of [].concat(keys)) delete values[key]; }
  };
}
function background({ synced = {}, local = {}, consent = true, fetcher, clock = Date, timers = {} } = {}) {
  let permissions = consent;
  const requests = [];
  let alarm = null;
  const browser = {
    storage: { sync: storage(synced), local: storage(local) },
    permissions: { getAll: async () => ({ data_collection: permissions ? ['authenticationInfo', 'browsingActivity'] : [] }) },
    runtime: { getURL: (file) => `moz-extension://test/${file}` },
    alarms: {
      get: async () => alarm,
      create: (_name, value) => { alarm = value; },
      clear: async () => { alarm = null; }
    }
  };
  const context = {
    __TVMS_TEST__: {}, browser, Date: clock, AbortController, setTimeout, clearTimeout, ...timers,
    fetch: async (url, options) => {
      requests.push(url);
      if (fetcher) return fetcher(url, options);
      return { ok: true, status: 200, json: async () => url.includes('/validate')
        ? { client_id: 'client', expires_in: 7200 }
        : { data: [{ muted_segments: [{ offset: 5, duration: 3 }] }] } };
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return { api: context.__TVMS_TEST__, browser, requests, alarm: () => alarm, consent: (value) => { permissions = value; } };
}

test('background upgrades legacy credentials before metadata and preserves existing local token', async () => {
  const synced = { helixClientId: 'client', helixToken: 'fixture-legacy' };
  const local = {};
  const { api } = background({ synced, local });
  assert.equal((await api.loadMutedSegments('123')).ok, true);
  assert.equal(local.helixToken, 'fixture-legacy');
  assert.equal('helixToken' in synced, false);
  synced.helixToken = 'fixture-legacy';
  local.helixToken = 'fixture-new';
  await api.migrateCredentials();
  assert.equal(local.helixToken, 'fixture-new');
  assert.equal('helixToken' in synced, false);
});

test('failed local migration retains the synced token and can retry', async () => {
  const synced = { helixToken: 'fixture-legacy' };
  const local = {};
  const { api, browser } = background({ synced, local });
  browser.storage.local.set = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(api.migrateCredentials(), /storage unavailable/);
  assert.equal(synced.helixToken, 'fixture-legacy');
  browser.storage.local.set = storage(local).set;
  await api.migrateCredentials();
  assert.equal(local.helixToken, 'fixture-legacy');
});

test('validation blocks invalid/mismatched tokens and never sends video IDs without consent', async () => {
  for (const [status, payload, message] of [
    [401, {}, /expired or invalid/],
    [200, { client_id: 'different', expires_in: 3600 }, /does not match/],
    [200, { client_id: 'client', expires_in: 0 }, /expired or invalid/]
  ]) {
    const { api, requests } = background({
      synced: { helixClientId: 'client' }, local: { helixToken: 'fixture' },
      fetcher: async () => ({ ok: status === 200, status, json: async () => payload })
    });
    assert.match((await api.loadMutedSegments('123')).error, message);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].includes('/validate'));
  }
  const denied = background({ synced: { helixClientId: 'client' }, local: { helixToken: 'fixture' }, consent: false });
  assert.equal((await denied.api.loadMutedSegments('123')).ok, false);
  assert.equal(denied.requests.length, 0);
});

test('validation is refreshed hourly and alarms stop after consent removal', async () => {
  let now = 1000;
  const { api, requests, consent, alarm } = background({
    synced: { helixClientId: 'client' }, local: { helixToken: 'fixture' }, clock: { now: () => now }
  });
  await api.maintainCredentials();
  assert.equal(alarm().periodInMinutes, 60);
  await api.loadMutedSegments('123');
  assert.equal(requests.filter((url) => url.includes('/validate')).length, 1);
  now += 3600001;
  await api.maintainCredentials();
  assert.equal(requests.filter((url) => url.includes('/validate')).length, 2);
  consent(false);
  await api.maintainCredentials();
  assert.equal(alarm(), null);
});

test('request timeout aborts even a stalled response body and returns actionable error', async () => {
  let fireTimeout;
  const { api } = background({
    timers: { setTimeout: (fn) => { fireTimeout = fn; return 1; }, clearTimeout() {} },
    fetcher: async (_url, { signal }) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('aborted')));
        fireTimeout();
      })
    })
  });
  assert.match((await api.validateCredentials('client', 'fixture')).error, /timed out/);
});

test('credential validation messages are restricted to the options page', async () => {
  const { api, requests } = background();
  assert.equal(api.handleMessage({ type: 'tvms-validate-credentials', clientId: 'client', token: 'fixture' }, { url: 'https://www.twitch.tv/' }, () => {}), undefined);
  assert.equal(requests.length, 0);
});

function options({ granted = true } = {}) {
  const synced = {};
  const local = {};
  const listeners = {};
  let inClick = false;
  let permissionCalls = 0;
  const elements = {
    enabled: { type: 'checkbox', checked: true },
    helixClientId: { type: 'text', value: '' }, helixToken: { type: 'password', value: '' },
    skipPaddingSeconds: { type: 'number', value: '0.35', min: '0', max: '5' },
    silenceThreshold: { type: 'number', value: '0.004', min: '0.001', max: '0.05' },
    reset: {}, 'save-credentials': {}, status: { classList: { toggle() {}, remove() {} } }
  };
  for (const [id, input] of Object.entries(elements)) {
    input.addEventListener = (event, listener) => { listeners[`${id}:${event}`] = listener; };
    input.reportValidity = () => true;
  }
  const context = {
    __TVMS_TEST__: {}, document: { getElementById: (id) => elements[id] },
    setTimeout: () => 1, clearTimeout() {},
    browser: {
      storage: { sync: storage(synced), local: storage(local) },
      permissions: {
        getAll: async () => ({ data_collection: [] }),
        request: () => { assert.ok(inClick, 'permission request must run before the click handler yields'); permissionCalls++; return Promise.resolve(granted); },
        remove: async () => true
      },
      runtime: { sendMessage: async () => ({ ok: true }) }
    }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'options.js'), 'utf8'), context);
  return {
    api: context.__TVMS_TEST__, elements, synced, local, permissions: () => permissionCalls,
    async click(id) {
      inClick = true;
      const result = listeners[`${id}:click`]();
      inClick = false;
      await result;
      await vm.runInNewContext('pendingSave', context);
    }
  };
}

test('options request Firefox consent synchronously and persist only after validation', async () => {
  const page = options();
  await page.api.init();
  page.elements.helixClientId.value = 'client';
  page.elements.helixToken.value = 'fixture';
  await page.click('save-credentials');
  assert.equal(page.permissions(), 1);
  assert.equal(page.local.helixToken, 'fixture');
  assert.equal('helixToken' in page.synced, false);
  assert.match(page.elements.status.textContent, /verified and saved/);
  await page.click('reset');
  assert.equal('helixToken' in page.local, false);
});

test('declined Firefox consent preserves saved credentials and entered values', async () => {
  const page = options({ granted: false });
  await page.api.init();
  page.local.helixToken = 'fixture-existing';
  page.elements.helixClientId.value = 'client';
  page.elements.helixToken.value = 'fixture-replacement';
  await page.click('save-credentials');
  assert.equal(page.local.helixToken, 'fixture-existing');
  assert.equal(page.elements.helixToken.value, 'fixture-replacement');
  assert.match(page.elements.status.textContent, /declined/);
});

test('options save and reset wait for an already-running background migration', async () => {
  for (const token of ['fixture-new', '']) {
    const synced = { helixClientId: 'client', helixToken: 'fixture-legacy' };
    const local = {};
    const runtime = background({ synced, local });
    const getLocal = runtime.browser.storage.local.get;
    let release;
    let entered;
    const ready = new Promise((resolve) => { entered = resolve; });
    runtime.browser.storage.local.get = async (defaults) => {
      const snapshot = await getLocal(defaults);
      await new Promise((resolve) => { release = resolve; entered(); });
      return snapshot;
    };
    const migrating = runtime.api.migrateCredentials();
    await ready;
    runtime.browser.storage.local.get = getLocal;
    runtime.browser.runtime.sendMessage = (message) => new Promise((resolve) => {
      runtime.api.handleMessage(message, { url: runtime.browser.runtime.getURL('options.html') }, resolve);
    });
    const context = { __TVMS_TEST__: {}, browser: runtime.browser };
    vm.runInNewContext(fs.readFileSync(path.join(root, 'options.js'), 'utf8'), context);
    const saving = context.__TVMS_TEST__.saveSettings({ helixToken: token });
    await Promise.resolve();
    assert.equal(local.helixToken, undefined, 'save must wait for captured legacy token to finish migrating');
    release();
    await Promise.all([migrating, saving]);
    assert.equal(local.helixToken, token || undefined);
    assert.equal('helixToken' in synced, false);
  }
});

test('revoking consent during validation prevents the following metadata request', async () => {
  let release;
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const runtime = background({
    synced: { helixClientId: 'client' }, local: { helixToken: 'fixture' },
    fetcher: async () => ({ ok: true, status: 200, json: () => new Promise((resolve) => {
      release = () => resolve({ client_id: 'client', expires_in: 3600 });
      entered();
    }) })
  });
  const loading = runtime.api.loadMutedSegments('123');
  await ready;
  runtime.consent(false);
  release();
  assert.match((await loading).error, /Allow API data access/);
  assert.equal(runtime.requests.length, 1);
  assert.match((await runtime.api.validateCredentials('client', 'fixture')).error, /Allow API data access/);
  assert.equal(runtime.requests.length, 1);
});
