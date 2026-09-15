const browserApi = globalThis.browser ?? globalThis.chrome;
const VALIDATION_ALARM = "tvms-validate-token";
let migration = null;
let validated = null;

// Migrate on startup and before reads, even if the options page is never opened.
function migrateCredentials() {
  if (migration) return migration;
  migration = (async () => {
    const synced = await browserApi.storage.sync.get({ helixToken: "" });
    if (!synced.helixToken) return;
    const local = await browserApi.storage.local.get({ helixToken: "" });
    if (!local.helixToken) await browserApi.storage.local.set({ helixToken: synced.helixToken });
    await browserApi.storage.sync.remove("helixToken");
  })().finally(() => { migration = null; });
  return migration;
}

async function loadCredentials() {
  await migrateCredentials();
  const [synced, local] = await Promise.all([
    browserApi.storage.sync.get({ helixClientId: "" }),
    browserApi.storage.local.get({ helixToken: "" })
  ]);
  return {
    clientId: String(synced.helixClientId ?? "").trim(),
    token: String(local.helixToken ?? "").trim().replace(/^Bearer\s+/i, "")
  };
}

async function requestJson(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(url, { headers, signal: controller.signal });
    return { status: response.status, ok: response.ok, payload: response.ok ? await response.json() : null };
  } catch {
    throw new Error(controller.signal.aborted ? "Twitch request timed out; try again" : "Twitch API unavailable; try again");
  } finally {
    clearTimeout(timer);
  }
}

async function validateCredentials(clientId, token, force = false) {
  if (typeof clientId !== "string" || typeof token !== "string" || !clientId.trim() || !token.trim()) {
    return { ok: false, error: "Enter both a Client ID and OAuth token" };
  }
  clientId = clientId.trim();
  token = token.trim().replace(/^Bearer\s+/i, "");
  if (!(await canUseApiData())) return { ok: false, error: "Allow API data access in settings" };
  if (!force && validated?.clientId === clientId && validated.token === token && Date.now() < validated.until) {
    return validated.result;
  }
  try {
    const response = await requestJson("https://id.twitch.tv/oauth2/validate", { Authorization: `OAuth ${token}` });
    let result;
    if (response.status === 401) result = { ok: false, error: "OAuth token expired or invalid; replace it in settings" };
    else if (!response.ok) return { ok: false, error: `Token validation returned ${response.status}; try again` };
    else if (typeof response.payload?.client_id !== "string") return { ok: false, error: "Invalid Twitch validation response; try again" };
    else if (response.payload.client_id !== clientId) result = { ok: false, error: "Client ID does not match this OAuth token" };
    else if (!Number.isFinite(response.payload.expires_in) || response.payload.expires_in <= 0) result = { ok: false, error: "OAuth token expired or invalid; replace it in settings" };
    else result = { ok: true };
    if (!(await canUseApiData())) return { ok: false, error: "Allow API data access in settings" };
    const lifetime = result.ok ? Math.min(3600000, response.payload.expires_in * 1000) : 60000;
    validated = { clientId, token, result, until: Date.now() + lifetime };
    return result;
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

// Load optional official metadata without exposing credentials to the page script.
async function loadMutedSegments(videoId) {
  if (typeof videoId !== "string" || !/^\d+$/.test(videoId)) return { ok: false, error: "invalid VOD ID" };
  const { clientId, token } = await loadCredentials();
  if (!clientId || !token) return { ok: false, error: null };
  const validation = await validateCredentials(clientId, token);
  if (!validation.ok) return validation;
  if (!(await canUseApiData())) return { ok: false, error: "Allow API data access in settings" };
  try {
    const response = await requestJson(`https://api.twitch.tv/helix/videos?id=${encodeURIComponent(videoId)}`, {
      "Client-Id": clientId,
      Authorization: `Bearer ${token}`
    });
    if (response.status === 401) {
      validated = null;
      return { ok: false, error: "OAuth token expired or invalid; replace it in settings" };
    }
    if (!response.ok) return { ok: false, error: `official API returned ${response.status}` };
    const video = response.payload?.data?.[0];
    if (!video) return { ok: false, error: "VOD metadata unavailable" };
    if (video.muted_segments != null && !Array.isArray(video.muted_segments)) {
      return { ok: false, error: "Invalid Twitch muted metadata" };
    }
    return { ok: true, source: "helix", segments: video.muted_segments ?? [] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function canUseApiData() {
  if (!browserApi.permissions?.getAll) return true;
  const permissions = await browserApi.permissions.getAll();
  return !Array.isArray(permissions.data_collection) ||
    ["authenticationInfo", "browsingActivity"].every((type) => permissions.data_collection.includes(type));
}

async function maintainCredentials() {
  const { clientId, token } = await loadCredentials();
  if (!clientId || !token || !(await canUseApiData())) {
    validated = null;
    await browserApi.alarms.clear(VALIDATION_ALARM);
    return;
  }
  // Alarms survive MV3 worker suspension; recreate only when absent.
  if (!(await browserApi.alarms.get(VALIDATION_ALARM))) {
    await browserApi.alarms.create(VALIDATION_ALARM, { periodInMinutes: 60 });
  }
  await validateCredentials(clientId, token);
}

function handleMessage(message, sender, sendResponse) {
  let request;
  if (message?.type === "tvms-load-muted-segments") request = loadMutedSegments(message.videoId);
  else if (message?.type === "tvms-validate-credentials" && sender?.url === browserApi.runtime.getURL("options.html")) {
    request = validateCredentials(message.clientId, message.token, true);
  } else if (message?.type === "tvms-migrate-credentials" && sender?.url === browserApi.runtime.getURL("options.html")) {
    request = migrateCredentials().then(() => ({ ok: true }));
  } else return;
  request.then(sendResponse, () => sendResponse({ ok: false, error: "official API unavailable" }));
  return true;
}

if (globalThis.__TVMS_TEST__) {
  Object.assign(globalThis.__TVMS_TEST__, { loadMutedSegments, handleMessage, migrateCredentials, validateCredentials, maintainCredentials });
} else {
  browserApi.runtime.onMessage.addListener(handleMessage);
  browserApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === VALIDATION_ALARM) void maintainCredentials().catch(() => {});
  });
  browserApi.storage.onChanged.addListener((changes, area) => {
    if ((area === "sync" && "helixClientId" in changes) || (area === "local" && "helixToken" in changes)) {
      validated = null;
      void maintainCredentials().catch(() => {});
    }
  });
  browserApi.permissions.onAdded.addListener(() => { void maintainCredentials().catch(() => {}); });
  browserApi.permissions.onRemoved.addListener(() => { void maintainCredentials().catch(() => {}); });
  void maintainCredentials().catch(() => {});
}
