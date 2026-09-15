const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");

// Extension scripts expose test hooks when this object exists before evaluation.
function loadContent() {
  let now = 1000;
  let sample = 255;
  let timers = [];

  class AudioContextMock {
    constructor() {
      this.state = "running";
      this.destination = {};
    }

    createMediaStreamSource() {
      return { connect() {}, disconnect() {} };
    }

    createAnalyser() {
      return {
        fftSize: 1024,
        connect() {},
        getFloatTimeDomainData(samples) {
          samples.fill((sample - 128) / 128);
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
      querySelector: () => context.__TVMS_TEST__.state.video
    },
    getComputedStyle: (element) => element.style,
    location: { href: "https://www.twitch.tv/videos/123", pathname: "/videos/123", origin: "https://www.twitch.tv" },
    URL,
    AudioContext: AudioContextMock,
    MediaStream: class { constructor(tracks) { this.tracks = tracks; } },
    clearTimeout() {},
    console,
    performance: { now: () => now },
    setInterval() {},
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    }
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "content.js"), "utf8"), context);
  return {
    api: context.__TVMS_TEST__,
    context,
    setNow(value) {
      now = value;
    },
    setSample(value) {
      sample = value;
    },
    runTimeouts() {
      const callbacks = timers;
      timers = [];
      callbacks.forEach((callback) => callback());
    }
  };
}

function setPlaybackState(api, video, source, segments) {
  const track = { readyState: "live", muted: false, enabled: true, stop() {} };
  Object.assign(video, { readyState: 4, playbackRate: 1, currentSrc: "fixture",
    captureStream: () => ({ getAudioTracks: () => [track], getTracks: () => [track] }) });
  Object.assign(api.state, {
    videoId: "123",
    video,
    videoSrc: video.currentSrc,
    source,
    segments,
    metadataError: null,
    lastSkip: null,
    ignoredSegmentRanges: [],
    manualWatchRange: null,
    manualSkipAction: null,
    suppressUntil: 0,
    timelineMuteStartedAt: null,
    silenceSample: null,
    lastDomScanAt: Date.now(),
    audio: null
  });
}

// Content script

test("normalizes segments and clamps persisted settings", () => {
  const { api } = loadContent();
  const segments = api.normalizeSegments([
    { offset: "5", duration: "4" },
    { offset: 0, duration: 0 },
    { offset: "bad", duration: 2 },
    { offset: -1, duration: 10 },
    { offset: Number.MAX_VALUE, duration: Number.MAX_VALUE },
    null,
    false
  ]);
  assert.equal(JSON.stringify(segments), JSON.stringify([{ offset: 5, duration: 4, end: 9 }]));
  assert.equal(api.normalizeSegments({ offset: 5, duration: 4 }).length, 0);

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
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 10, duration: 100, paused: false, seeking: false, muted: false, volume: 1 };
  setPlaybackState(api, video, "helix", [{ offset: 5, duration: 15, end: 20 }]);

  api.tick();
  assert.equal(video.currentTime, 20.35);
  assert.equal(api.state.lastSkip.from, 10);

  api.undoLastSkip();
  assert.equal(video.currentTime, 9.75);
  assert.equal(api.state.ignoredSegmentRanges.length, 1);

  video.currentTime = 20.35;
  runtime.runTimeouts();
  assert.equal(video.currentTime, 9.75);

  video.currentTime = 12;
  api.tick();
  assert.equal(video.currentTime, 12);

  api.skipManualWatchRange();
  assert.equal(video.currentTime, 20.35);
  assert.equal(api.state.manualSkipAction, null);
  runtime.runTimeouts();
  assert.equal(video.currentTime, 20.35);

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
  for (let step = 1; step <= 3; step++) {
    runtime.setNow(1000 + step * 500);
    video.currentTime = 100 + step * 0.5;
    api.tick();
  }
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
    style: { position: "absolute", insetInlineStart: "7.5%", left: "", width: "2%" }
  };
  const track = { contains: () => true, style: { position: "relative" } };
  marker.parentElement = track;
  const segment = api.segmentFromMarkerStyles(marker, track);
  assert.equal(JSON.stringify(segment), JSON.stringify({ offset: 75, duration: 20, end: 95 }));
});

test("silence resets after pause, buffering, disable, seeking, and playhead discontinuities", () => {
  for (const interruption of ["paused", "seeking", "buffering", "disabled", "jump"]) {
    const runtime = loadContent();
    const { api } = runtime;
    const video = { currentTime: 100, duration: 300, paused: false, seeking: false, muted: false, volume: 1 };
    setPlaybackState(api, video, "timeline", [{ offset: 100, duration: 100, end: 200 }]);
    runtime.setSample(128);
    api.tick(); // Attach capture track; never classify an uninitialized analyser.
    runtime.setNow(1500);
    video.currentTime = 100.5;
    api.tick();
    if (interruption === "buffering") video.readyState = 2;
    else if (interruption === "disabled") api.state.settings.enabled = false;
    else if (interruption === "jump") video.currentTime = 160;
    else video[interruption] = true;
    runtime.setNow(2000);
    api.tick();
    video.paused = video.seeking = false;
    video.readyState = 4;
    api.state.settings.enabled = true;
    runtime.setNow(10000);
    video.currentTime += 0.5;
    const before = video.currentTime;
    api.tick();
    assert.equal(video.currentTime, before, interruption);
    assert.equal(api.state.timelineMuteStartedAt, 10000, interruption);
  }
});

test("user mute and zero volume cannot confirm silence; float samples preserve quiet audio", () => {
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 100, duration: 300, paused: false, seeking: false, muted: false, volume: 1 };
  setPlaybackState(api, video, "timeline", [{ offset: 100, duration: 100, end: 200 }]);
  runtime.setSample(128 + 0.0001 * 128);
  assert.equal(api.getAudioLevel(), null);
  assert.ok(Math.abs(api.getAudioLevel() - 0.0001) < 0.00000001);
  video.muted = true;
  assert.equal(api.getAudioLevel(), null);
  video.muted = false;
  video.volume = 0;
  assert.equal(api.getAudioLevel(), null);
  video.volume = 0.01;
  assert.ok(Math.abs(api.getAudioLevel() - 0.0001) < 0.00000001);
  api.state.audio.track.muted = true;
  assert.equal(api.getAudioLevel(), null);
});

test("navigation blocks automatic, Undo, re-skip and delayed recovery seeks", () => {
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 10, duration: 100, paused: false, seeking: false };
  setPlaybackState(api, video, "helix", [{ offset: 5, duration: 15, end: 20 }]);
  api.tick();
  api.undoLastSkip();
  runtime.context.location.pathname = "/videos/999";
  video.currentTime = 10;
  runtime.runTimeouts();
  api.tick();
  api.skipManualWatchRange();
  api.state.lastSkip = { from: 5, to: 20 };
  api.undoLastSkip();
  assert.equal(video.currentTime, 10);
});

test("trusted user input cancels Undo recovery and ordinary skip does not fight scrubbing", () => {
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 10, duration: 100, paused: false, seeking: false };
  setPlaybackState(api, video, "helix", [{ offset: 5, duration: 15, end: 20 }]);
  api.tick();
  video.currentTime = 10;
  runtime.runTimeouts();
  assert.equal(video.currentTime, 10);
  api.undoLastSkip();
  api.cancelSeekRecoveryOnInput({ isTrusted: true, target: { closest: () => null } });
  video.currentTime = 20.35;
  runtime.runTimeouts();
  assert.equal(video.currentTime, 20.35);
});

test("percentage markers require track ancestry and reject partial nested coordinate systems", () => {
  const { api } = loadContent();
  api.state.video = { duration: 1000 };
  const track = { contains: () => true, style: { position: "relative" }, getBoundingClientRect: () => ({ left: 0, width: 1000 }) };
  const nested = { style: { position: "relative" }, getBoundingClientRect: () => ({ left: 0, width: 100 }) };
  const marker = { parentElement: nested, style: { position: "absolute", left: "0%", width: "100%" } };
  assert.equal(api.segmentFromMarkerStyles(marker), null);
  assert.equal(api.segmentFromMarkerStyles(marker, track), null);
  marker.parentElement = track;
  marker.style.left = "-5%";
  assert.equal(api.segmentFromMarkerStyles(marker, track), null);
  marker.style.left = "0%";
  track.style.position = "static";
  assert.equal(api.segmentFromMarkerStyles(marker, track), null);
});

test("source replacement clears timeline and Undo state but preserves same-VOD API ranges", () => {
  const runtime = loadContent();
  const { api } = runtime;
  const video = { currentTime: 10, duration: 100, paused: false, seeking: false };
  setPlaybackState(api, video, "timeline", [{ offset: 5, duration: 15, end: 20 }]);
  api.state.ignoredSegmentRanges = [{ offset: 5, end: 20 }];
  video.srcObject = {};
  api.refreshVideo();
  assert.equal(api.state.segments.length, 0);
  assert.equal(api.state.ignoredSegmentRanges.length, 0);
  assert.equal(api.state.lastDomScanAt, 0);
  api.state.source = "helix";
  api.state.segments = [{ offset: 5, duration: 15, end: 20 }];
  video.srcObject = {};
  api.refreshVideo();
  assert.equal(api.state.segments.length, 1);
});

test("VOD paths must match fully and in-flight metadata cannot update a different page", async () => {
  const runtime = loadContent();
  const { api, context } = runtime;
  for (const pathname of ["/videos/123junk", "/videos/123/other", "/videos/"]) {
    context.location.pathname = pathname;
    assert.equal(api.getVideoIdFromUrl(), null);
  }
  context.location.pathname = "/videos/123/";
  assert.equal(api.getVideoIdFromUrl(), "123");
  let finish;
  context.browser.runtime = { sendMessage: () => new Promise((resolve) => { finish = resolve; }) };
  const pending = api.hydrateForCurrentPage();
  context.location.pathname = "/videos/999";
  finish({ ok: true, source: "helix", segments: [{ offset: 5, duration: 10 }] });
  await pending;
  assert.equal(api.state.segments.length, 0);
});

test("audio setup failures release captured tracks and partially created contexts", () => {
  const runtime = loadContent();
  const { api, context } = runtime;
  const video = { currentTime: 10, duration: 100, muted: false, volume: 1 };
  setPlaybackState(api, video, "timeline", []);
  let stopped = 0;
  let closed = 0;
  video.captureStream = () => ({ getTracks: () => [{ stop() { stopped++; } }] });
  context.AudioContext = class {
    createAnalyser() { throw new Error("Unavailable"); }
    close() { closed++; return Promise.resolve(); }
  };
  assert.equal(api.getAudioLevel(), null);
  assert.equal(api.state.audio, null);
  assert.equal(stopped, 1);
  assert.equal(closed, 1);
});

test("cross-origin media without CORS never creates an audio capture", () => {
  const { api } = loadContent();
  const video = { currentTime: 10, duration: 100, muted: false, volume: 1 };
  setPlaybackState(api, video, "timeline", []);
  video.currentSrc = "https://media.example.test/audio.wav";
  let captured = false;
  video.captureStream = () => { captured = true; throw new Error("Unexpected capture"); };
  assert.equal(api.getAudioLevel(), null);
  assert.equal(captured, false);
  assert.match(api.state.audioStatus, /cross-origin/);
});

// Options page

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
  const storage = (values) => ({
    get: async (defaults) => ({ ...defaults, ...values }),
    set: async (updates) => Object.assign(values, updates),
    remove: async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    }
  });
  const browser = { storage: { sync: storage(synced), local: storage(local) } };
  const backgroundContext = { __TVMS_TEST__: {}, browser };
  vm.runInNewContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), backgroundContext);
  browser.runtime = { sendMessage: async () => {
    await backgroundContext.__TVMS_TEST__.migrateCredentials();
    return { ok: true };
  } };
  const context = { __TVMS_TEST__: {}, browser, console };
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

});

test("reset waits for credential validation and removes the saved token", async () => {
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
    "save-credentials": {},
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
      runtime: { sendMessage: async () => ({ ok: true }) },
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

  elements.helixClientId.value = "fake-client";
  elements.helixToken.value = "fake-token";
  listeners["save-credentials:click"]();
  await listeners["reset:click"]();

  assert.equal("helixToken" in local, false);
  assert.equal(synced.enabled, true);
  assert.equal(elements.status.textContent, "Defaults restored");
});

// Background worker

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
      return { ok: true, status: 200, json: async () => url.includes("/oauth2/validate")
        ? { client_id: "client", expires_in: 3600 }
        : { data: [{ muted_segments: [{ offset: 5, duration: 3 }] }] } };
    },
    AbortController,
    setTimeout,
    clearTimeout,
    console
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(root, "background.js"), "utf8"), context);

  assert.equal((await context.__TVMS_TEST__.loadMutedSegments("bad")).error, "invalid VOD ID");
  assert.equal(JSON.stringify(await context.__TVMS_TEST__.loadMutedSegments("123")), JSON.stringify({ ok: false, error: null }));
  assert.equal(requestedUrl, null);

  clientId = "client";
  token = "token";
  assert.equal((await context.__TVMS_TEST__.loadMutedSegments("123")).error, "Allow API data access in settings");
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

// Release package invariants

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
