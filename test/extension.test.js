const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

function loadContent() {
  let now = 1000;
  let sample = 255;

  class AudioContextMock {
    constructor() {
      this.state = "running";
      this.destination = {};
    }

    createMediaElementSource() {
      return { connect() {} };
    }

    createAnalyser() {
      return {
        fftSize: 1024,
        connect() {},
        getByteTimeDomainData(samples) {
          samples.fill(sample);
        }
      };
    }

    resume() {
      this.state = "running";
      return Promise.resolve();
    }

    close() {
      this.state = "closed";
      return Promise.resolve();
    }
  }

  const context = {
    __TVMS_TEST__: {},
    browser: {
      permissions: { getAll: async () => ({}) },
      storage: {
        sync: { get: async (defaults) => defaults, set: async () => {}, remove: async () => {} },
        local: { get: async (defaults) => defaults, set: async () => {}, remove: async () => {} }
      }
    },
    document: {
      contains: () => true,
      getElementById: () => null,
      querySelector: () => null
    },
    getComputedStyle: (element) => element.style,
    location: { href: "https://www.twitch.tv/videos/123", pathname: "/videos/123" },
    AudioContext: AudioContextMock,
    clearTimeout() {},
    console,
    performance: { now: () => now },
    setInterval() {},
    setTimeout() { return 1; }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context);
  return {
    api: context.__TVMS_TEST__,
    setNow(value) {
      now = value;
    },
    setSample(value) {
      sample = value;
    }
  };
}

function setPlaybackState(api, video, source, segments) {
  Object.assign(api.state, {
    videoId: "123",
    video,
    source,
    segments,
    metadataError: null,
    lastSkip: null,
    ignoredSegmentRanges: [],
    manualWatchRange: null,
    manualSkipAction: null,
    suppressUntil: 0,
    timelineMuteStartedAt: null,
    lastDomScanAt: Date.now(),
    audio: null
  });
}

test("normalizes segments and clamps persisted settings", () => {
  const { api } = loadContent();
  const segments = api.normalizeSegments([
    { offset: "5", duration: "4" },
    { offset: 0, duration: 0 },
    { offset: "bad", duration: 2 }
  ]);
  assert.equal(JSON.stringify(segments), JSON.stringify([{ offset: 5, duration: 4, end: 9 }]));

  const settings = api.normalizeSettings({
    enabled: 0,
    skipPaddingSeconds: -4,
    silenceThreshold: 1
  });
  assert.equal(settings.enabled, false);
  assert.equal(settings.skipPaddingSeconds, 0);
  assert.equal(settings.silenceThreshold, 0.05);

  const merged = api.mergeSegments([
    { offset: 0, duration: 10 },
    { offset: 10.5, duration: 5 }
  ]);
  assert.equal(merged.length, 2);
});

test("metadata skip, Undo, and manual re-skip preserve the original destination", () => {
  const { api } = loadContent();
  const video = { currentTime: 10, duration: 100, paused: false, seeking: false, muted: false, volume: 1 };
  setPlaybackState(api, video, "helix", [{ offset: 5, duration: 15, end: 20 }]);

  api.tick();
  assert.equal(video.currentTime, 20.35);
  assert.equal(api.state.lastSkip.from, 10);

  api.undoLastSkip();
  assert.equal(video.currentTime, 9.75);
  assert.equal(api.state.ignoredSegmentRanges.length, 1);
  video.currentTime = 12;
  api.tick();
  assert.equal(video.currentTime, 12);

  api.skipManualWatchRange();
  assert.equal(video.currentTime, 20.35);
  assert.equal(api.state.manualSkipAction, null);

  api.state.manualWatchRange = { offset: 0, end: 5 };
  api.state.manualSkipAction = { to: 10 };
  assert.equal(api.isInManualWatchWindow(6), false);
  assert.equal(api.state.manualSkipAction, null);
});

test("timeline markers require nearby confirmed silence", () => {
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 100, duration: 300, paused: false, seeking: false, muted: false, volume: 1 };
  const segment = { offset: 100, duration: 100, end: 200 };
  setPlaybackState(api, video, "timeline", [segment]);

  runtime.setSample(255);
  api.tick();
  assert.equal(video.currentTime, 100);

  runtime.setSample(128);
  runtime.setNow(1000);
  video.currentTime = 99.9;
  api.tick();
  assert.equal(api.state.timelineMuteStartedAt, null);
  video.currentTime = 100;
  api.tick();
  assert.equal(video.currentTime, 100);
  runtime.setNow(2600);
  api.tick();
  assert.equal(video.currentTime, 200.35);

  setPlaybackState(api, video, "timeline", [segment]);
  video.currentTime = 50;
  runtime.setNow(5000);
  api.tick();
  assert.equal(video.currentTime, 50);
});

test("parses Twitch timeline markers positioned with logical CSS properties", () => {
  const { api } = loadContent();
  api.state.video = { duration: 1000 };
  const marker = {
    style: { insetInlineStart: "7.5%", left: "", width: "2%" }
  };
  const segment = api.segmentFromMarkerStyles(marker);
  assert.equal(JSON.stringify(segment), JSON.stringify({ offset: 75, duration: 20, end: 95 }));
});

test("options reject empty and out-of-range numeric values", () => {
  const context = { __TVMS_TEST__: {}, browser: {}, console };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "options.js"), "utf8"), context);
  const coerce = context.__TVMS_TEST__.coerceValue;
  const input = { type: "number", value: "", min: "0", max: "5" };

  assert.equal(coerce(input, 0.35), null);
  input.value = "-1";
  assert.equal(coerce(input, 0.35), null);
  input.value = "2.5";
  assert.equal(coerce(input, 0.35), 2.5);
});

test("options migrate and keep OAuth tokens out of sync storage", async () => {
  const synced = { enabled: false, helixClientId: "client", helixToken: "old-token" };
  const local = {};
  let dataCollection = [];
  let requested = null;
  let removed = null;
  const storage = (values) => ({
    get: async (defaults) => ({ ...defaults, ...values }),
    set: async (updates) => Object.assign(values, updates),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  });
  const context = {
    __TVMS_TEST__: {},
    browser: {
      permissions: {
        getAll: async () => ({ data_collection: dataCollection }),
        request: async (permission) => {
          requested = permission;
          dataCollection = [...permission.data_collection];
          return true;
        },
        remove: async (permission) => {
          removed = permission;
          dataCollection = [];
          return true;
        }
      },
      storage: { sync: storage(synced), local: storage(local) }
    },
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "options.js"), "utf8"), context);

  const settings = await context.__TVMS_TEST__.loadSettings();
  assert.equal(settings.helixToken, "old-token");
  assert.equal(local.helixToken, "old-token");
  assert.equal("helixToken" in synced, false);

  await context.__TVMS_TEST__.saveSettings({ helixClientId: "new-client", helixToken: "new-token" });
  assert.equal(synced.helixClientId, "new-client");
  assert.equal("helixToken" in synced, false);
  assert.equal(local.helixToken, "new-token");
  assert.equal(Number.isFinite(local.helixCredentialRevision), true);

  await context.__TVMS_TEST__.saveSettings({ helixToken: "" });
  assert.equal("helixToken" in local, false);

  assert.equal(await context.__TVMS_TEST__.ensureAuthenticationPermission("token"), true);
  assert.equal(JSON.stringify(requested), JSON.stringify({ data_collection: ["authenticationInfo", "browsingActivity"] }));
  await context.__TVMS_TEST__.clearAuthenticationPermission();
  assert.equal(JSON.stringify(removed), JSON.stringify(requested));
});

test("reset waits for a focused field save and removes the token", async () => {
  const synced = {};
  const local = {};
  const listeners = {};
  const storage = (values) => ({
    get: async (defaults) => ({ ...defaults, ...values }),
    set: async (updates) => Object.assign(values, updates),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  });
  const classList = { toggle() {} };
  const elements = {
    enabled: { type: "checkbox", checked: true },
    helixClientId: { type: "text", value: "" },
    helixToken: { type: "password", value: "" },
    skipPaddingSeconds: { type: "number", value: "0.35", min: "0", max: "5" },
    silenceThreshold: { type: "number", value: "0.004", min: "0.001", max: "0.05" },
    reset: {},
    status: { textContent: "", classList }
  };
  for (const [id, element] of Object.entries(elements)) {
    element.addEventListener = (type, listener) => {
      listeners[`${id}:${type}`] = listener;
    };
    element.reportValidity = () => true;
  }

  const context = {
    __TVMS_TEST__: {},
    browser: {
      permissions: { getAll: async () => ({}) },
      storage: { sync: storage(synced), local: storage(local) }
    },
    document: { getElementById: (id) => elements[id] },
    clearTimeout() {},
    setTimeout() { return 1; },
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "options.js"), "utf8"), context);
  await context.__TVMS_TEST__.init();

  elements.helixToken.value = "fake-token";
  listeners["helixToken:change"]();
  await listeners["reset:click"]();

  assert.equal("helixToken" in local, false);
  assert.equal(synced.enabled, true);
  assert.equal(elements.status.textContent, "Defaults restored");
});

test("background validates VOD IDs and enforces optional Firefox token consent", async () => {
  let allowed = false;
  let clientId = "";
  let token = "";
  let requestedUrl = null;
  const context = {
    __TVMS_TEST__: {},
    browser: {
      permissions: { getAll: async () => ({ data_collection: allowed ? ["authenticationInfo", "browsingActivity"] : [] }) },
      storage: {
        sync: { get: async () => ({ helixClientId: clientId }) },
        local: { get: async () => ({ helixToken: token }) }
      }
    },
    fetch: async (url) => {
      requestedUrl = url;
      return { ok: true, json: async () => ({ data: [{ muted_segments: [{ offset: 5, duration: 3 }] }] }) };
    },
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);

  assert.equal((await context.__TVMS_TEST__.loadMutedSegments("bad")).error, "invalid VOD ID");
  assert.equal(JSON.stringify(await context.__TVMS_TEST__.loadMutedSegments("123")), JSON.stringify({ ok: false, error: null }));
  assert.equal(requestedUrl, null);

  clientId = "client";
  token = "token";
  assert.equal((await context.__TVMS_TEST__.loadMutedSegments("123")).error, "API data permission required");
  assert.equal(requestedUrl, null);

  allowed = true;
  const result = await context.__TVMS_TEST__.loadMutedSegments("123");
  assert.equal(result.ok, true);
  assert.equal(JSON.stringify(result.segments), JSON.stringify([{ offset: 5, duration: 3 }]));
  assert.match(requestedUrl, /videos\?id=123$/);

  const response = await new Promise((resolve) => {
    assert.equal(context.__TVMS_TEST__.handleMessage({ type: "tvms-load-muted-segments", videoId: "123" }, null, resolve), true);
  });
  assert.equal(response.ok, true);
  assert.equal(context.__TVMS_TEST__.handleMessage({ type: "other" }, null, () => {}), undefined);
});

test("release manifests and assets stay aligned", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const source = fs.readFileSync(path.join(root, "content.js"), "utf8");
  assert.doesNotMatch(source, /gql\.twitch\.tv|mutedSegments|maybeFallbackSkip/);

  for (const file of ["manifest.json", "manifest.chrome.json"]) {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
    assert.equal(manifest.version, pkg.version);
    assert.deepEqual(manifest.content_scripts[0].matches, ["https://www.twitch.tv/*"]);
    for (const script of manifest.content_scripts) {
      for (const asset of [...(script.js ?? []), ...(script.css ?? [])]) {
        assert.equal(fs.existsSync(path.join(root, asset)), true, `${file}: missing ${asset}`);
      }
    }
    assert.equal(fs.existsSync(path.join(root, manifest.options_ui.page)), true);
    const backgroundAssets = manifest.background.scripts ?? [manifest.background.service_worker];
    for (const asset of backgroundAssets) assert.equal(fs.existsSync(path.join(root, asset)), true);
    for (const asset of Object.values(manifest.icons)) assert.equal(fs.existsSync(path.join(root, asset)), true);
  }

  const firefox = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const chrome = JSON.parse(fs.readFileSync(path.join(root, "manifest.chrome.json"), "utf8"));
  assert.equal(chrome.minimum_chrome_version, "99");
  assert.equal(firefox.browser_specific_settings.gecko.strict_min_version, "142.0");
  assert.equal("gecko_android" in firefox.browser_specific_settings, false);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.required, ["none"]);
  assert.deepEqual(firefox.browser_specific_settings.gecko.data_collection_permissions.optional, ["authenticationInfo", "browsingActivity"]);
});
