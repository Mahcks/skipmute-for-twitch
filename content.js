(() => {
  const DEFAULT_SETTINGS = {
    enabled: true,
    skipPaddingSeconds: 0.35,
    silenceThreshold: 0.004
  };

  const browserApi = globalThis.browser ?? globalThis.chrome;
  const state = {
    settings: { ...DEFAULT_SETTINGS },
    videoId: null,
    video: null,
    segments: [],
    source: "none",
    metadataError: null,
    lastSkip: null,
    ignoredSegmentRanges: [],
    manualWatchRange: null,
    manualSkipAction: null,
    lastToastTimer: null,
    toastAction: null,
    lastRenderSignature: "",
    suppressUntil: 0,
    lastDomScanAt: 0,
    hydrationId: 0,
    seekId: 0,
    audio: null,
    timelineMuteStartedAt: null,
    silenceSample: null,
    audioStatus: null,
    videoSrc: null,
    videoSrcObject: null
  };

  // Page lifecycle and settings

  async function init() {
    try {
      state.settings = await loadSettings();
    } catch {
      state.metadataError = "settings unavailable";
    }
    createOverlay();
    attachOverlayToPlayer();
    watchUrlChanges();
    for (const type of ["pointerdown", "keydown"]) {
      document.addEventListener(type, cancelSeekRecoveryOnInput, true);
    }
    setInterval(tick, 500);
    setInterval(attachOverlayToPlayer, 2000);
    void hydrateForCurrentPage();

    browserApi.storage.onChanged?.addListener((changes, area) => {
      if (area !== "sync" && area !== "local") return;
      let reloadMetadata = false;
      for (const [key, change] of Object.entries(changes)) {
        if (area === "sync" && key in DEFAULT_SETTINGS) {
          state.settings[key] = change.newValue ?? DEFAULT_SETTINGS[key];
        }
        reloadMetadata ||= (area === "sync" && key === "helixClientId") ||
          (area === "local" && (key === "helixToken" || key === "helixCredentialRevision"));
      }
      state.settings = normalizeSettings(state.settings);
      resetSilenceConfirmation();
      renderOverlay();
      if (reloadMetadata) void hydrateForCurrentPage(true);
    });
  }

  async function loadSettings() {
    return normalizeSettings(await storageGet(browserApi.storage.sync, DEFAULT_SETTINGS));
  }

  function saveSetting(key, value) {
    state.settings[key] = value;
    resetSilenceConfirmation();
    void storageSet(browserApi.storage.sync, { [key]: value }).catch(() => {
      showToast("Setting could not be saved", null);
    });
  }

  function normalizeSettings(settings) {
    return {
      ...DEFAULT_SETTINGS,
      ...settings,
      enabled: Boolean(settings.enabled),
      skipPaddingSeconds: clampNumber(settings.skipPaddingSeconds, 0, 5, DEFAULT_SETTINGS.skipPaddingSeconds),
      silenceThreshold: clampNumber(settings.silenceThreshold, 0.001, 0.05, DEFAULT_SETTINGS.silenceThreshold)
    };
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? clamp(number, min, max) : fallback;
  }

  function getVideoIdFromUrl() {
    return location.pathname.match(/^\/videos\/(\d+)\/?$/)?.[1] ?? null;
  }

  function watchUrlChanges() {
    let previous = location.href;
    // Twitch swaps VODs with client-side navigation, so page-load events are not enough.
    setInterval(() => {
      if (location.href === previous) return;
      previous = location.href;
      void hydrateForCurrentPage();
    }, 700);
  }

  async function hydrateForCurrentPage(force = false) {
    const videoId = getVideoIdFromUrl();
    refreshVideo();

    if (!force && videoId === state.videoId && state.segments.length) return;
    const hydrationId = ++state.hydrationId;
    state.seekId++;
    if (videoId !== state.videoId) releaseAudio();

    if (!videoId) {
      resetSilenceConfirmation();
      hideToast();
      state.videoId = null;
      state.segments = [];
      state.source = "none";
      state.metadataError = null;
      state.lastSkip = null;
      state.manualWatchRange = null;
      state.manualSkipAction = null;
      state.suppressUntil = 0;
      renderOverlay();
      return;
    }

    hideToast();
    state.videoId = videoId;
    state.segments = [];
    state.source = "loading";
    state.metadataError = null;
    state.lastSkip = null;
    state.ignoredSegmentRanges = [];
    state.manualWatchRange = null;
    state.manualSkipAction = null;
    state.suppressUntil = 0;
    resetSilenceConfirmation();
    state.lastDomScanAt = 0;
    renderOverlay();

    const result = await loadMutedSegments(videoId);
    // Ignore metadata that finished loading after the user moved to another VOD.
    if (getVideoIdFromUrl() !== videoId || state.videoId !== videoId || state.hydrationId !== hydrationId) return;

    resetSilenceConfirmation();
    state.segments = normalizeSegments(result.segments);
    state.source = result.source;
    state.metadataError = result.error ?? null;
    if (state.segments.length === 0) {
      state.lastDomScanAt = 0;
      refreshSegmentsFromTimeline();
    }
    renderOverlay();
  }

  // Segment loading and playback loop

  async function loadMutedSegments(videoId) {
    try {
      const result = await browserApi.runtime.sendMessage({ type: "tvms-load-muted-segments", videoId });
      return result?.ok ? result : { ok: true, source: "none", segments: [], error: result?.error ?? null };
    } catch {
      return { ok: true, source: "none", segments: [], error: "official API unavailable" };
    }
  }

  function normalizeSegments(segments) {
    return (Array.isArray(segments) ? segments : [])
      .filter((segment) => segment !== null && typeof segment === "object")
      .map((segment) => ({
        offset: Number(segment.offset),
        duration: Number(segment.duration),
        end: Number(segment.offset) + Number(segment.duration)
      }))
      .filter((segment) => Number.isFinite(segment.offset) && segment.offset >= 0 &&
        Number.isFinite(segment.duration) && segment.duration > 0 && Number.isFinite(segment.end))
      .sort((a, b) => a.offset - b.offset);
  }

  function tick() {
    refreshVideo();
    if (!isCurrentVideo()) {
      resetSilenceConfirmation();
      return;
    }
    if (state.segments.length === 0 || state.source === "timeline") {
      refreshSegmentsFromTimeline();
    }
    renderOverlay();

    if (!state.settings.enabled || Date.now() < state.suppressUntil || state.video.paused ||
        state.video.seeking || state.video.readyState < 3) {
      resetSilenceConfirmation();
      return;
    }

    const current = state.video.currentTime;
    if (isInManualWatchWindow(current)) {
      resetSilenceConfirmation();
      return;
    }
    clearIgnoredSegmentIfNeeded(current);
    const segment = state.segments.find((item) => current >= item.offset && current < item.end);
    if (segment && state.source !== "timeline") {
      if (isIgnoredSegment(segment)) return;
      skipTo(segment.end + state.settings.skipPaddingSeconds, segment);
      return;
    }

    const segmentForAudio = getNearbyTimelineSegment(current);
    if (!segmentForAudio || isIgnoredSegment(segmentForAudio) || !isPlaybackSilent()) {
      resetSilenceConfirmation();
      return;
    }
    const now = performance.now();
    const previous = state.silenceSample;
    const elapsed = previous ? (now - previous.at) / 1000 : 0;
    const progress = previous ? current - previous.time : 0;
    const key = `${segmentForAudio.offset}:${segmentForAudio.end}`;
    // Polling gaps, buffering, and scrubbing cannot count as observed silence.
    if (!previous || previous.key !== key || elapsed <= 0 || elapsed > 1 || progress <= 0 ||
        Math.abs(progress - elapsed * state.video.playbackRate) > 0.35) {
      state.timelineMuteStartedAt = now;
    }
    state.silenceSample = { at: now, time: current, key };
    if ((now - state.timelineMuteStartedAt) / 1000 >= 1.5) {
      skipTo(segmentForAudio.end + state.settings.skipPaddingSeconds, segmentForAudio);
    }
  }

  function resetSilenceConfirmation() {
    state.timelineMuteStartedAt = null;
    state.silenceSample = null;
  }

  // Twitch timeline marker detection

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

    const scanRoot = getPlayerScanRoot();
    const tracks = scanRoot.querySelectorAll('[data-a-target="player-seekbar"] .seekbar-bar');
    const candidates = [];
    for (const track of tracks) {
      for (const element of track.querySelectorAll('[data-test-selector="seekbar-segment__segment"]')) {
        const style = getComputedStyle(element);
        if (!isMutedMarkerColor(style.backgroundColor)) continue;
        const segment = segmentFromMarkerStyles(element, track);
        if (segment) candidates.push(segment);
      }
    }
    return mergeSegments(candidates);
  }

  function getPlayerScanRoot() {
    return state.video.closest('[data-a-target="video-player"], .video-player') ??
      state.video.closest('[data-a-target*="player"], [class*="player"], [class*="Player"]') ??
      state.video.parentElement ?? document.body;
  }

  function isMutedMarkerColor(color) {
    const match = color?.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
    if (!match) return false;

    const red = Number(match[1]);
    const green = Number(match[2]);
    const blue = Number(match[3]);
    return red >= 150 && green <= 95 && blue <= 125;
  }

  function segmentFromMarkerStyles(element, track) {
    if (!track || !track.contains(element)) return null;
    if (getComputedStyle(track).position === "static") return null;
    const style = getComputedStyle(element);
    if (style.position !== "absolute") return null;
    // Percentages must refer to the seekbar, never a nested partial-width container.
    let container = element.parentElement;
    while (container && container !== track && getComputedStyle(container).position === "static") {
      container = container.parentElement;
    }
    if (container !== track) {
      const rect = container?.getBoundingClientRect();
      const trackRect = track.getBoundingClientRect();
      if (!rect || trackRect.width <= 0 || Math.abs(rect.left - trackRect.left) > 1 ||
          Math.abs(rect.width - trackRect.width) > 1) return null;
    }
    // Twitch currently positions markers with logical CSS; left remains a fallback.
    const leftRatio = readPercentRatio(element.style.insetInlineStart || element.style.left || style.insetInlineStart || style.left);
    const rawWidthRatio = readPercentRatio(element.style.width || style.width);
    const widthRatio = rawWidthRatio == null || leftRatio == null ? null : Math.min(rawWidthRatio, 1 - leftRatio);
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
    const ratio = Number(match[1]) / 100;
    return ratio >= 0 && ratio <= 1 ? ratio : null;
  }

  function mergeSegments(segments) {
    const sorted = normalizeSegments(segments);
    const merged = [];

    for (const segment of sorted) {
      const previous = merged[merged.length - 1];
      // Keep short rendering seams inside one muted range without swallowing audible gaps.
      if (!previous || segment.offset > previous.end + 0.25) {
        merged.push({ ...segment });
      } else {
        previous.end = Math.max(previous.end, segment.end);
        previous.duration = previous.end - previous.offset;
      }
    }

    return merged;
  }

  // Playback control and Undo

  function skipTo(targetTime, segment = null) {
    if (!isCurrentVideo()) return;
    const from = state.video.currentTime;
    const duration = Number.isFinite(state.video.duration) ? state.video.duration : targetTime;
    const to = Math.min(targetTime, duration);
    if (to <= from + 0.5) return;

    state.lastSkip = {
      from,
      to,
      ignoredRange: buildIgnoredRange(from, to, segment)
    };
    resetSilenceConfirmation();
    seekVideo(to, from);
    showToast(`Skipped ${formatTime(from)} to ${formatTime(to)}`, "undo");
    renderOverlay();
  }

  function isCurrentVideo() {
    return Boolean(state.videoId && state.video && document.contains(state.video) &&
      getVideoIdFromUrl() === state.videoId && (state.video.currentSrc ?? "") === state.videoSrc &&
      (state.video.srcObject ?? null) === state.videoSrcObject);
  }

  function cancelSeekRecoveryOnInput(event) {
    if (!event.isTrusted || event.target?.closest?.("#tvms-root")) return;
    state.seekId++;
    resetSilenceConfirmation();
  }

  function seekVideo(targetTime, staleTime, recoverUndo = false) {
    if (!isCurrentVideo() || !Number.isFinite(targetTime)) return;
    resetSilenceConfirmation();
    const video = state.video;
    const videoId = state.videoId;
    const src = video.currentSrc;
    const srcObject = video.srcObject;
    const seekId = ++state.seekId;
    const retryIfOverwritten = () => {
      if (!isCurrentVideo() || state.seekId !== seekId || state.video !== video || state.videoId !== videoId ||
          video.currentSrc !== src || video.srcObject !== srcObject) return;
      // Twitch can finish an older seek after Undo; only correct that known stale destination.
      if (Math.abs(video.currentTime - targetTime) > 1 && Math.abs(video.currentTime - staleTime) < 3) {
        video.currentTime = targetTime;
      }
    };

    if (recoverUndo) {
      video.addEventListener?.("seeked", retryIfOverwritten, { once: true });
      setTimeout(retryIfOverwritten, 750);
    }
    video.currentTime = targetTime;
  }

  function getNearbyTimelineSegment(currentTime) {
    if (state.source !== "timeline") return null;

    return state.segments.find((segment) => {
      return currentTime >= segment.offset && currentTime < segment.end;
    });
  }

  function isPlaybackSilent() {
    const level = getAudioLevel();
    if (level == null) return false;
    return level <= state.settings.silenceThreshold;
  }

  function getAudioLevel() {
    if (state.video.muted || state.video.volume === 0) {
      state.audioStatus = "audio verification paused: player muted";
      return null;
    }
    try {
      if (state.video.currentSrc && new URL(state.video.currentSrc, location.href).origin !== location.origin &&
          state.video.crossOrigin == null) {
        state.audioStatus = "audio verification unavailable for cross-origin media";
        return null;
      }
      if (!state.audio) {
        const AudioContext = globalThis.AudioContext ?? globalThis.webkitAudioContext;
        const capture = state.video.captureStream ?? state.video.mozCaptureStream;
        if (!AudioContext || !capture) {
          state.audioStatus = "audio verification unavailable in this browser";
          return null;
        }
        // Retain each resource immediately so partial setup failures can release it.
        state.audio = { stream: capture.call(state.video), context: null, source: null, track: null };
        state.audio.context = new AudioContext();
        state.audio.analyser = state.audio.context.createAnalyser();
        state.audio.analyser.fftSize = 1024;
        state.audio.samples = new Float32Array(state.audio.analyser.fftSize);
      }
      const audio = state.audio;
      if (audio.context.state !== "running") {
        state.audioStatus = "audio verification waiting for playback permission";
        if (audio.context.state === "suspended") void audio.context.resume().catch(() => {});
        return null;
      }
      const track = audio.stream.getAudioTracks().find((item) => item.readyState === "live");
      if (!track || track.muted || !track.enabled) {
        state.audioStatus = "audio verification waiting for an audio track";
        return null;
      }
      if (audio.track !== track) {
        audio.source?.disconnect();
        audio.source = audio.context.createMediaStreamSource(new MediaStream([track]));
        audio.source.connect(audio.analyser);
        audio.track = track;
        // Capture observes source audio without rerouting or changing native playback.
        state.audioStatus = "audio verification warming up";
        return null;
      }
      audio.analyser.getFloatTimeDomainData(audio.samples);
      let sum = 0;
      for (const sample of audio.samples) sum += sample * sample;
      state.audioStatus = null;
      return Math.sqrt(sum / audio.samples.length);
    } catch {
      releaseAudio();
      state.audioStatus = "audio verification unavailable";
      return null;
    }
  }

  function undoLastSkip() {
    if (!state.lastSkip || !isCurrentVideo()) return;
    state.suppressUntil = Date.now() + 5000;
    rememberIgnoredRange(state.lastSkip.ignoredRange);
    state.manualWatchRange = {
      offset: Math.max(0, state.lastSkip.from - 5),
      end: state.lastSkip.to + 2
    };
    state.manualSkipAction = { to: state.lastSkip.to };
    const to = Math.max(0, state.lastSkip.from - 0.25);
    seekVideo(to, state.lastSkip.to, true);
    showToast(`Returned to ${formatTime(to)}`, "skip");
    state.lastSkip = null;
    renderOverlay();
  }

  function skipManualWatchRange() {
    if (!isCurrentVideo() || !state.manualSkipAction) return;

    const to = Math.min(state.manualSkipAction.to, state.video.duration);
    if (Number.isFinite(to) && to > state.video.currentTime) {
      seekVideo(to, state.video.currentTime);
      showToast(`Skipped to ${formatTime(to)}`, null);
    }

    state.manualWatchRange = null;
    state.manualSkipAction = null;
    state.lastSkip = null;
    renderOverlay();
  }

  // Twitch player controls

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
        <div class="tvms-toast-text" role="status" aria-live="polite" aria-atomic="true"></div>
        <button type="button" class="tvms-toast-action">Undo</button>
      </div>
    `;

    const toggle = root.querySelector(".tvms-toggle");
    const action = root.querySelector(".tvms-action");
    const toastAction = root.querySelector(".tvms-toast-action");

    [toggle, action, toastAction].forEach((button) => {
      ["pointerdown", "mousedown", "pointerup", "mouseup"].forEach((eventName) => {
        button.addEventListener(eventName, stopControlEventPropagation);
      });
    });

    toggle.addEventListener("click", (event) => {
      stopControlEvent(event);
      saveSetting("enabled", !state.settings.enabled);
      renderOverlay();
    });
    action.addEventListener("click", handlePrimaryActionClick);
    toastAction.addEventListener("click", handleToastActionClick);

    document.documentElement.append(root);
    state.lastRenderSignature = "";
    renderOverlay();
  }

  function attachOverlayToPlayer() {
    // Twitch frequently rebuilds the player DOM, so the control must be reattached safely.
    if (!document.getElementById("tvms-root")) createOverlay();
    const root = document.getElementById("tvms-root");
    if (!root) return;

    const anchor = state.videoId ? findPlayerControlAnchor() : null;
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
      timeline: `timeline markers${state.audioStatus ? `; ${state.audioStatus}` : ""}`,
      loading: "loading metadata",
      none: state.metadataError ?? "no muted metadata"
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
      state.metadataError ?? "",
      state.audioStatus ?? "",
      completedCount,
      count,
      actionState.enabled ? actionState.label : "none"
    ].join("|");

    // tick() runs twice a second; avoid rewriting an unchanged Twitch control tree.
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

  function hideToast() {
    clearTimeout(state.lastToastTimer);
    state.lastToastTimer = null;
    state.toastAction = null;
    document.querySelector("#tvms-root .tvms-toast")?.classList.remove("tvms-visible");
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

  function stopControlEventPropagation(event) {
    event.stopPropagation();
  }

  // Undo guardrails

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
      state.manualSkipAction = null;
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
      end: range.end + 2,
      duration: range.end + 2 - Math.max(0, range.offset - 2)
    };
    state.ignoredSegmentRanges.push(padded);
    state.ignoredSegmentRanges = mergeSegments(state.ignoredSegmentRanges).slice(-6);
  }

  // Browser integration

  function handleMediaSourceChange() {
    refreshVideo(true);
  }

  function releaseAudio() {
    if (!state.audio) return;
    state.audio.source?.disconnect();
    for (const track of state.audio.stream.getTracks()) track.stop();
    if (state.audio.context) void state.audio.context.close().catch(() => {});
    state.audio = null;
  }

  function refreshVideo(force = false) {
    const video = document.querySelector("video");
    const src = video?.currentSrc ?? "";
    const srcObject = video?.srcObject ?? null;
    if (!force && video === state.video && src === state.videoSrc && srcObject === state.videoSrcObject) return;
    if (video !== state.video) {
      for (const event of ["loadstart", "emptied"]) {
        state.video?.removeEventListener?.(event, handleMediaSourceChange);
        video?.addEventListener?.(event, handleMediaSourceChange);
      }
    }
    state.seekId++;
    resetSilenceConfirmation();
    releaseAudio();
    state.audioStatus = null;
    state.video = video;
    state.videoSrc = src;
    state.videoSrcObject = srcObject;
    state.lastDomScanAt = 0;
    if (state.source === "timeline") state.segments = [];
    state.ignoredSegmentRanges = [];
    state.lastSkip = null;
    state.manualWatchRange = null;
    state.manualSkipAction = null;
  }

  function storageGet(storage, defaults) {
    // Firefox returns promises; older Chrome APIs use callbacks.
    const result = storage.get(defaults);
    if (result?.then) return result;
    return new Promise((resolve) => storage.get(defaults, resolve));
  }

  function storageSet(storage, values) {
    const result = storage.set(values);
    if (result?.then) return result;
    return new Promise((resolve) => storage.set(values, resolve));
  }

  // Tests opt into these hooks before evaluating the content script.
  if (globalThis.__TVMS_TEST__) {
    Object.assign(globalThis.__TVMS_TEST__, {
      state,
      cancelSeekRecoveryOnInput,
      extractTimelineMutedSegments,
      getAudioLevel,
      getVideoIdFromUrl,
      hydrateForCurrentPage,
      refreshVideo,
      normalizeSettings,
      normalizeSegments,
      mergeSegments,
      segmentFromMarkerStyles,
      tick,
      undoLastSkip,
      skipManualWatchRange,
      isInManualWatchWindow,
      getActionState
    });
  } else {
    void init();
  }
})();
