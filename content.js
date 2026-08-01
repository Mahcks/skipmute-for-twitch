(() => {
  const TWITCH_WEB_CLIENT_ID = "kimne78kx3ncx6brgo4mv6wki5h1ko";
  const DEFAULT_SETTINGS = {
    enabled: true,
    useGraphql: true,
    useSilenceFallback: false,
    helixClientId: "",
    helixToken: "",
    skipPaddingSeconds: 0.35,
    silenceConfirmSeconds: 3,
    silenceThreshold: 0.004,
    fallbackSeekStepSeconds: 8
  };

  const browserApi = globalThis.browser ?? globalThis.chrome;
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    videoId: null,
    video: null,
    segments: [],
    source: "none",
    lastSkip: null,
    ignoredSegmentRanges: [],
    manualWatchRange: null,
    manualSkipAction: null,
    lastToastTimer: null,
    toastAction: null,
    lastRenderSignature: "",
    suppressUntil: 0,
    lastDomScanAt: 0,
    audio: null,
    silenceStartedAt: null,
    timelineMuteStartedAt: null,
    fallbackSkipping: false
  };

  init();

  async function init() {
    state.settings = await loadSettings();
    createOverlay();
    attachOverlayToPlayer();
    watchUrlChanges();
    setInterval(tick, 500);
    setInterval(attachOverlayToPlayer, 2000);
    void hydrateForCurrentPage();

    browserApi.storage.onChanged?.addListener((changes, area) => {
      if (area !== "sync") return;
      for (const [key, change] of Object.entries(changes)) {
        state.settings[key] = change.newValue ?? DEFAULT_SETTINGS[key];
      }
      renderOverlay();
    });
  }

  function loadSettings() {
    return storageGet(DEFAULT_SETTINGS).then((items) => ({ ...DEFAULT_SETTINGS, ...items }));
  }

  function saveSetting(key, value) {
    state.settings[key] = value;
    void storageSet({ [key]: value });
  }

  function getVideoIdFromUrl() {
    return location.pathname.match(/^\/videos\/(\d+)/)?.[1] ?? null;
  }

  function watchUrlChanges() {
    let previous = location.href;
    setInterval(() => {
      if (location.href === previous) return;
      previous = location.href;
      void hydrateForCurrentPage();
    }, 700);
  }

  async function hydrateForCurrentPage() {
    const videoId = getVideoIdFromUrl();
    state.video = document.querySelector("video");

    if (!videoId) {
      state.videoId = null;
      state.segments = [];
      state.source = "none";
      renderOverlay();
      return;
    }

    if (videoId === state.videoId && state.segments.length) return;
    state.videoId = videoId;
    state.segments = [];
    state.source = "loading";
    state.lastSkip = null;
    state.ignoredSegmentRanges = [];
    state.manualWatchRange = null;
    state.manualSkipAction = null;
    state.silenceStartedAt = null;
    renderOverlay();

    const result = await loadMutedSegments(videoId);
    if (state.videoId !== videoId) return;

    state.segments = normalizeSegments(result.segments);
    state.source = result.source;
    if (state.segments.length === 0) {
      refreshSegmentsFromTimeline();
    }
    renderOverlay();
  }

  async function loadMutedSegments(videoId) {
    const helix = await fetchHelixSegments(videoId);
    if (helix.ok) return helix;

    if (state.settings.useGraphql) {
      const graphql = await fetchGraphqlSegments(videoId);
      if (graphql.ok) return graphql;
    }

    return { ok: true, source: "none", segments: [] };
  }

  async function fetchHelixSegments(videoId) {
    const clientId = state.settings.helixClientId.trim();
    const token = state.settings.helixToken.trim().replace(/^Bearer\s+/i, "");
    if (!clientId || !token) return { ok: false };

    try {
      const response = await fetch(`https://api.twitch.tv/helix/videos?id=${encodeURIComponent(videoId)}`, {
        headers: {
          "Client-Id": clientId,
          Authorization: `Bearer ${token}`
        }
      });
      if (!response.ok) return { ok: false };
      const payload = await response.json();
      const video = payload?.data?.[0];
      return {
        ok: true,
        source: "helix",
        segments: video?.muted_segments ?? []
      };
    } catch {
      return { ok: false };
    }
  }

  async function fetchGraphqlSegments(videoId) {
    try {
      const response = await fetch("https://gql.twitch.tv/gql", {
        method: "POST",
        headers: {
          "Client-Id": TWITCH_WEB_CLIENT_ID,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          operationName: "TvmsVideoMutedSegments",
          variables: { videoID: videoId },
          query: `
            query TvmsVideoMutedSegments($videoID: ID!) {
              video(id: $videoID) {
                id
                lengthSeconds
                mutedSegments {
                  offset
                  duration
                }
              }
            }
          `
        })
      });
      if (!response.ok) return { ok: false };
      const payload = await response.json();
      if (payload?.errors?.length) return { ok: false };
      const segments = payload?.data?.video?.mutedSegments;
      if (!Array.isArray(segments)) return { ok: false };
      return { ok: true, source: "graphql", segments };
    } catch {
      return { ok: false };
    }
  }

  function normalizeSegments(segments) {
    return (segments ?? [])
      .map((segment) => ({
        offset: Number(segment.offset),
        duration: Number(segment.duration),
        end: Number(segment.offset) + Number(segment.duration)
      }))
      .filter((segment) => Number.isFinite(segment.offset) && Number.isFinite(segment.duration) && segment.duration > 0)
      .sort((a, b) => a.offset - b.offset);
  }

  function tick() {
    if (!state.video || !document.contains(state.video)) {
      state.video = document.querySelector("video");
      state.audio = null;
    }

    if (!state.videoId || !state.video) return;
    if (state.segments.length === 0 || state.source === "timeline") {
      refreshSegmentsFromTimeline();
    }
    renderOverlay();

    if (!state.settings.enabled) return;
    if (Date.now() < state.suppressUntil || state.video.paused || state.video.seeking) return;

    const current = state.video.currentTime;
    if (isInManualWatchWindow(current)) return;
    clearIgnoredSegmentIfNeeded(current);
    const segment = state.segments.find((item) => current >= item.offset && current < item.end);
    if (segment) {
      if (isIgnoredSegment(segment)) return;
      skipTo(segment.end + state.settings.skipPaddingSeconds, segment.offset, "metadata", segment);
      return;
    }

    const nearTimelineSegment = getNearbyTimelineSegment(current);
    if (nearTimelineSegment && isPlaybackSilent()) {
      if (isIgnoredSegment(nearTimelineSegment)) return;
      state.timelineMuteStartedAt ??= performance.now();
      if ((performance.now() - state.timelineMuteStartedAt) / 1000 >= 1.5) {
        skipTo(
          nearTimelineSegment.end + state.settings.skipPaddingSeconds,
          nearTimelineSegment.offset,
          "timeline",
          nearTimelineSegment
        );
        return;
      }
    } else {
      state.timelineMuteStartedAt = null;
    }

    if (state.segments.length === 0 && state.settings.useSilenceFallback) {
      void maybeFallbackSkip();
    }
  }

  function refreshSegmentsFromTimeline() {
    const now = Date.now();
    if (now - state.lastDomScanAt < 5000) return;
    state.lastDomScanAt = now;

    const segments = extractTimelineMutedSegments();
    if (segments.length === 0) return;

    state.segments = segments;
    state.source = "timeline";
    renderOverlay();
  }

  function extractTimelineMutedSegments() {
    if (!state.video || !Number.isFinite(state.video.duration) || state.video.duration <= 0) {
      return [];
    }

    const videoRect = state.video.getBoundingClientRect();
    const scanRoot = getPlayerScanRoot();
    const candidates = Array.from(scanRoot.querySelectorAll('[style*="background"], [style*="background-color"], [style*="left"], [style*="width"]'))
      .filter((element) => {
        if (!(element instanceof HTMLElement)) return false;
        if (element.closest("#tvms-root")) return false;

        const rect = element.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2 || rect.width > window.innerWidth) return false;
        if (!isNearPlayerControls(rect, videoRect)) return false;

        const style = getComputedStyle(element);
        return isMutedMarkerColor(style.backgroundColor) || isMutedMarkerColor(style.borderColor);
      })
      .map((element) => segmentFromMarkerElement(element, videoRect))
      .filter(Boolean);

    return mergeSegments(candidates);
  }

  function getPlayerScanRoot() {
    return (
      state.video.closest('[data-a-target*="player"], [class*="player"], [class*="Player"]') ??
      state.video.parentElement ??
      document.body
    );
  }

  function isNearPlayerControls(rect, videoRect) {
    const overlapsVideoHorizontally = rect.right > videoRect.left && rect.left < videoRect.right;
    const nearVideoBottom = rect.top >= videoRect.top && rect.bottom <= videoRect.bottom + 80;
    const likelySeekbarHeight = rect.height <= 28;
    return overlapsVideoHorizontally && nearVideoBottom && likelySeekbarHeight;
  }

  function isMutedMarkerColor(color) {
    const match = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return false;

    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return red >= 150 && green <= 95 && blue <= 125;
  }

  function segmentFromMarkerElement(element, videoRect) {
    const styleSegment = segmentFromMarkerStyles(element);
    if (styleSegment) return styleSegment;

    const markerRect = element.getBoundingClientRect();
    const trackRect = findTimelineTrackRect(element, markerRect, videoRect);
    if (!trackRect) return null;

    const leftRatio = clamp((markerRect.left - trackRect.left) / trackRect.width, 0, 1);
    const widthRatio = clamp(markerRect.width / trackRect.width, 0, 1 - leftRatio);
    const duration = widthRatio * state.video.duration;
    if (duration < 0.75) return null;

    return {
      offset: leftRatio * state.video.duration,
      duration,
      end: (leftRatio + widthRatio) * state.video.duration
    };
  }

  function segmentFromMarkerStyles(element) {
    const leftRatio = readPercentRatio(element.style.left || getComputedStyle(element).left);
    const widthRatio = readPercentRatio(element.style.width || getComputedStyle(element).width);
    if (leftRatio == null || widthRatio == null || widthRatio <= 0) return null;

    const duration = widthRatio * state.video.duration;
    if (duration < 0.75) return null;

    return {
      offset: leftRatio * state.video.duration,
      duration,
      end: (leftRatio + widthRatio) * state.video.duration
    };
  }

  function readPercentRatio(value) {
    const match = String(value).trim().match(/^(-?\d+(?:\.\d+)?)%$/);
    if (!match) return null;
    return clamp(Number(match[1]) / 100, 0, 1);
  }

  function findTimelineTrackRect(element, markerRect, videoRect) {
    let parent = element.parentElement;
    let best = null;

    while (parent && parent !== document.body) {
      const rect = parent.getBoundingClientRect();
      const containsMarker =
        markerRect.left >= rect.left - 1 &&
        markerRect.right <= rect.right + 1 &&
        markerRect.top >= rect.top - 8 &&
        markerRect.bottom <= rect.bottom + 8;

      if (containsMarker && rect.width >= 160 && rect.width <= videoRect.width + 40 && rect.height <= 48) {
        best = rect;
      }

      parent = parent.parentElement;
    }

    if (best) return best;

    const fallbackTracks = Array.from(document.querySelectorAll('[data-a-target*="seek"], [data-a-target*="progress"]'))
      .map((item) => item.getBoundingClientRect())
      .filter((rect) => {
        return (
          rect.width >= 160 &&
          rect.height <= 48 &&
          markerRect.left >= rect.left - 1 &&
          markerRect.right <= rect.right + 1
        );
      })
      .sort((a, b) => a.height - b.height);

    return fallbackTracks[0] ?? null;
  }

  function mergeSegments(segments) {
    const sorted = normalizeSegments(segments);
    const merged = [];

    for (const segment of sorted) {
      const previous = merged[merged.length - 1];
      if (!previous || segment.offset > previous.end + 1) {
        merged.push({ ...segment });
      } else {
        previous.end = Math.max(previous.end, segment.end);
        previous.duration = previous.end - previous.offset;
      }
    }

    return merged;
  }

  function skipTo(targetTime, skippedFrom, reason, segment = null) {
    const from = state.video.currentTime;
    const duration = Number.isFinite(state.video.duration) ? state.video.duration : targetTime;
    const to = Math.min(targetTime, duration);
    if (to <= from + 0.5) return;

    state.lastSkip = {
      from,
      to,
      originalSegmentStart: skippedFrom,
      reason,
      ignoredRange: buildIgnoredRange(from, to, segment)
    };
    state.video.currentTime = to;
    showToast(`Skipped ${formatTime(from)} to ${formatTime(to)}`, "undo");
    renderOverlay();
  }

  function getNearbyTimelineSegment(currentTime) {
    if (state.source !== "timeline") return null;

    const earlyWindowSeconds = Math.min(300, Math.max(45, state.video.duration * 0.03));
    return state.segments.find((segment) => {
      return currentTime >= segment.offset - earlyWindowSeconds && currentTime < segment.end;
    });
  }

  function isPlaybackSilent() {
    if (state.video.muted || state.video.volume === 0) return true;

    const level = getAudioLevel();
    if (level == null) return false;
    return level <= state.settings.silenceThreshold;
  }

  async function maybeFallbackSkip() {
    if (state.fallbackSkipping) return;

    const level = getAudioLevel();
    if (level == null) return;

    if (level > state.settings.silenceThreshold) {
      state.silenceStartedAt = null;
      return;
    }

    state.silenceStartedAt ??= performance.now();
    const silentFor = (performance.now() - state.silenceStartedAt) / 1000;
    if (silentFor < state.settings.silenceConfirmSeconds) return;

    state.fallbackSkipping = true;
    const startedAt = state.video.currentTime;
    const step = Math.max(2, state.settings.fallbackSeekStepSeconds);

    try {
      for (let next = state.video.currentTime + step; next < state.video.duration; next += step) {
        state.video.currentTime = next;
        await wait(700);
        const nextLevel = getAudioLevel();
        if (nextLevel != null && nextLevel > state.settings.silenceThreshold) {
          skipTo(next, startedAt, "silence");
          return;
        }
      }
    } finally {
      state.silenceStartedAt = null;
      state.fallbackSkipping = false;
    }
  }

  function getAudioLevel() {
    try {
      if (!state.audio) {
        const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        if (!AudioContext) return null;
        const context = new AudioContext();
        const source = context.createMediaElementSource(state.video);
        const analyser = context.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
        analyser.connect(context.destination);
        state.audio = {
          context,
          analyser,
          samples: new Uint8Array(analyser.fftSize)
        };
      }

      if (state.audio.context.state === "suspended") {
        void state.audio.context.resume();
      }

      state.audio.analyser.getByteTimeDomainData(state.audio.samples);
      let sum = 0;
      for (const sample of state.audio.samples) {
        const centered = (sample - 128) / 128;
        sum += centered * centered;
      }
      return Math.sqrt(sum / state.audio.samples.length);
    } catch {
      return null;
    }
  }

  function undoLastSkip() {
    if (!state.lastSkip || !state.video) return;
    state.suppressUntil = Date.now() + 5000;
    rememberIgnoredRange(state.lastSkip.ignoredRange);
    state.manualWatchRange = {
      offset: Math.max(0, state.lastSkip.from - 5),
      end: state.lastSkip.to + 2
    };
    state.manualSkipAction = {
      to: state.lastSkip.to,
      label: `Skip to ${formatTime(state.lastSkip.to)}`
    };
    state.video.currentTime = Math.max(0, state.lastSkip.from - 0.25);
    showToast(`Returned to ${formatTime(state.video.currentTime)}`, "skip");
    state.lastSkip = null;
    renderOverlay();
  }

  function skipManualWatchRange() {
    if (!state.video || !state.manualSkipAction) return;

    const to = Math.min(state.manualSkipAction.to + state.settings.skipPaddingSeconds, state.video.duration);
    if (Number.isFinite(to) && to > state.video.currentTime) {
      state.video.currentTime = to;
      showToast(`Skipped to ${formatTime(to)}`, null);
    }

    state.manualWatchRange = null;
    state.manualSkipAction = null;
    state.lastSkip = null;
    renderOverlay();
  }

  function createOverlay() {
    if (document.getElementById("tvms-root")) return;

    const root = document.createElement("div");
    root.id = "tvms-root";
    root.className = "tvms-detached";
    root.innerHTML = `
      <div class="tvms-panel">
        <button type="button" class="tvms-toggle" title="Toggle muted segment skipping" aria-label="Toggle muted segment skipping">
          <span class="tvms-dot" aria-hidden="true"></span>
          <span class="tvms-label">Muted skip</span>
          <span class="tvms-count">0</span>
        </button>
        <button type="button" class="tvms-action" title="Undo last skip" aria-label="Undo last skip">Undo</button>
      </div>
      <div class="tvms-toast">
        <div class="tvms-toast-text"></div>
        <button type="button" class="tvms-toast-action">Undo</button>
      </div>
    `;

    const toggle = root.querySelector(".tvms-toggle");
    const action = root.querySelector(".tvms-action");
    const toastAction = root.querySelector(".tvms-toast-action");

    [toggle, action, toastAction].forEach((button) => {
      button.addEventListener("pointerdown", stopControlEvent);
      button.addEventListener("mousedown", stopControlEvent);
    });

    toggle.addEventListener("click", (event) => {
      stopControlEvent(event);
      saveSetting("enabled", !state.settings.enabled);
      renderOverlay();
    });
    action.addEventListener("click", handlePrimaryActionClick);
    toastAction.addEventListener("click", handleToastActionClick);

    document.documentElement.append(root);
    renderOverlay();
  }

  function attachOverlayToPlayer() {
    const root = document.getElementById("tvms-root");
    if (!root) return;

    const anchor = findPlayerControlAnchor();
    if (anchor?.row && anchor?.after) {
      if (root.parentElement !== anchor.row || root.previousElementSibling !== anchor.after) {
        anchor.after.insertAdjacentElement("afterend", root);
      }
      root.classList.add("tvms-inline");
      root.classList.remove("tvms-detached");
      return;
    }

    if (root.parentElement !== document.documentElement) {
      document.documentElement.append(root);
    }
    root.classList.add("tvms-detached");
    root.classList.remove("tvms-inline");
  }

  function findPlayerControlAnchor() {
    const clipButton =
      document.querySelector('[data-a-target="player-clip-button"]') ??
      document.querySelector('[data-a-target*="clip"]');
    const settingsButton =
      document.querySelector('[data-a-target="player-settings-button"]') ??
      document.querySelector('[data-a-target*="settings"]');
    const fullscreenButton =
      document.querySelector('[data-a-target="player-fullscreen-button"]') ??
      document.querySelector('[data-a-target*="fullscreen"]');

    if (isUsableControlAnchor(clipButton)) {
      return {
        row: findControlRow(clipButton, settingsButton ?? fullscreenButton),
        after: findCompactControlWrapper(clipButton)
      };
    }

    if (isUsableControlAnchor(settingsButton)) {
      return {
        row: findControlRow(settingsButton, fullscreenButton),
        after: findCompactControlWrapper(settingsButton)
      };
    }

    return null;
  }

  function isUsableControlAnchor(element) {
    if (!(element instanceof HTMLElement)) return false;
    if (element.closest("#tvms-root")) return false;

    const rect = element.getBoundingClientRect();
    if (rect.width < 16 || rect.height < 16) return false;

    const videoRect = state.video?.getBoundingClientRect();
    if (!videoRect) return false;

    const overlapsVideoHorizontally = rect.right > videoRect.left && rect.left < videoRect.right;
    const inBottomControls = rect.top >= videoRect.bottom - 95 && rect.bottom <= videoRect.bottom + 35;
    return overlapsVideoHorizontally && inBottomControls;
  }

  function findControlRow(primary, secondary) {
    let node = primary.parentElement;

    while (node && node !== document.body) {
      const rect = node.getBoundingClientRect();
      const containsSecondary = !secondary || node.contains(secondary);
      if (containsSecondary && rect.width >= 120 && rect.width <= 620 && rect.height >= 30 && rect.height <= 72) {
        return node;
      }
      node = node.parentElement;
    }

    return primary.parentElement;
  }

  function findCompactControlWrapper(element) {
    let node = element;
    while (node.parentElement && node.parentElement !== document.body) {
      const rect = node.parentElement.getBoundingClientRect();
      if (rect.width > 72 || rect.height > 56) return node;
      node = node.parentElement;
    }
    return element;
  }

  function renderOverlay() {
    const root = document.getElementById("tvms-root");
    if (!root) return;

    const count = state.segments.length;
    const completedCount = getCompletedSegmentCount();
    const sourceLabel = {
      helix: "official API",
      graphql: "Twitch metadata",
      timeline: "timeline markers",
      loading: "loading metadata",
      none: state.settings.useSilenceFallback ? "silence fallback ready" : "no muted metadata"
    }[state.source] ?? state.source;

    const toggle = root.querySelector(".tvms-toggle");
    const label = root.querySelector(".tvms-label");
    const countNode = root.querySelector(".tvms-count");
    const statusText = state.videoId
      ? `${completedCount}/${count} muted segment${count === 1 ? "" : "s"} passed - ${sourceLabel}`
      : "Open a Twitch VOD";
    const actionState = getActionState();
    const renderSignature = [
      state.videoId ?? "",
      state.settings.enabled ? "1" : "0",
      state.source,
      completedCount,
      count,
      actionState.enabled ? actionState.label : "none"
    ].join("|");

    if (renderSignature === state.lastRenderSignature) return;
    state.lastRenderSignature = renderSignature;

    label.textContent = state.settings.enabled ? "Muted skip" : "Muted skip off";
    countNode.textContent = `${completedCount}/${count}`;
    countNode.hidden = count === 0;
    toggle.style.setProperty("--tvms-progress", count > 0 ? `${Math.round((completedCount / count) * 100)}%` : "0%");
    toggle.title = statusText;
    toggle.setAttribute("aria-label", `${statusText}. Click to ${state.settings.enabled ? "turn off" : "turn on"}.`);
    toggle.classList.toggle("tvms-disabled", !state.settings.enabled);

    const action = root.querySelector(".tvms-action");
    action.textContent = actionState.label;
    action.title = actionState.title;
    action.setAttribute("aria-label", actionState.title);
    action.disabled = !actionState.enabled;
    action.classList.toggle("tvms-ready", actionState.enabled);
  }

  function showToast(message, actionType) {
    const root = document.getElementById("tvms-root");
    if (!root) return;

    const toast = root.querySelector(".tvms-toast");
    const button = root.querySelector(".tvms-toast-action");
    root.querySelector(".tvms-toast-text").textContent = message;
    state.toastAction = actionType;
    button.hidden = !actionType;
    button.textContent = actionType === "skip" ? "Skip" : "Undo";
    button.title = actionType === "skip" ? "Skip this muted section again" : "Undo last skip";
    toast.classList.add("tvms-visible");

    clearTimeout(state.lastToastTimer);
    state.lastToastTimer = setTimeout(() => {
      toast.classList.remove("tvms-visible");
    }, 9000);
  }

  function formatTime(totalSeconds) {
    const value = Math.max(0, Math.floor(totalSeconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    const seconds = value % 60;
    if (hours > 0) {
      return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
    }
    return `${minutes}:${String(seconds).padStart(2, "0")}`;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function getCompletedSegmentCount() {
    const currentTime = state.video?.currentTime ?? 0;
    return state.segments.filter((segment) => currentTime >= segment.end).length;
  }

  function handlePrimaryActionClick(event) {
    stopControlEvent(event);
    runPrimaryAction();
  }

  function handleToastActionClick(event) {
    stopControlEvent(event);
    if (state.toastAction === "skip") {
      skipManualWatchRange();
      return;
    }
    if (state.toastAction === "undo") {
      undoLastSkip();
    }
  }

  function runPrimaryAction() {
    if (state.manualSkipAction) {
      skipManualWatchRange();
      return;
    }
    undoLastSkip();
  }

  function getActionState() {
    if (state.manualSkipAction) {
      return {
        enabled: true,
        label: "Skip",
        title: "Skip this muted section again"
      };
    }

    if (state.lastSkip) {
      return {
        enabled: true,
        label: "Undo",
        title: "Undo last skip"
      };
    }

    return {
      enabled: false,
      label: "Undo",
      title: "No skip to undo"
    };
  }

  function stopControlEvent(event) {
    event.preventDefault();
    event.stopPropagation();
  }

  function isIgnoredSegment(segment) {
    if (state.ignoredSegmentRanges.length === 0) return false;

    const tolerance = 3;
    return state.ignoredSegmentRanges.some((range) => {
      return segment.offset <= range.end + tolerance && segment.end >= range.offset - tolerance;
    });
  }

  function clearIgnoredSegmentIfNeeded(currentTime) {
    if (state.ignoredSegmentRanges.length === 0) return;

    state.ignoredSegmentRanges = state.ignoredSegmentRanges.filter((range) => {
      return currentTime >= range.offset - 10 && currentTime < range.end + 3;
    });
  }

  function isInManualWatchWindow(currentTime) {
    if (!state.manualWatchRange) return false;

    if (currentTime >= state.manualWatchRange.offset && currentTime < state.manualWatchRange.end) {
      return true;
    }

    if (currentTime >= state.manualWatchRange.end) {
      state.manualWatchRange = null;
    }
    return false;
  }

  function buildIgnoredRange(from, to, segment) {
    if (segment) {
      return {
        offset: Math.min(from, segment.offset),
        end: Math.max(to, segment.end)
      };
    }

    return {
      offset: Math.min(from, to),
      end: Math.max(from, to)
    };
  }

  function rememberIgnoredRange(range) {
    if (!range || !Number.isFinite(range.offset) || !Number.isFinite(range.end)) return;

    const padded = {
      offset: Math.max(0, range.offset - 2),
      end: range.end + 2
    };
    state.ignoredSegmentRanges.push(padded);
    state.ignoredSegmentRanges = mergeSegments(state.ignoredSegmentRanges).slice(-6);
  }

  function storageGet(defaults) {
    const result = browserApi.storage.sync.get(defaults);
    if (result?.then) return result;
    return new Promise((resolve) => browserApi.storage.sync.get(defaults, resolve));
  }

  function storageSet(values) {
    const result = browserApi.storage.sync.set(values);
    if (result?.then) return result;
    return new Promise((resolve) => browserApi.storage.sync.set(values, resolve));
  }
})();
