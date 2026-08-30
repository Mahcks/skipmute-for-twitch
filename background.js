const browserApi = globalThis.browser ?? globalThis.chrome;

async function loadMutedSegments(videoId) {
  if (!/^\d+$/.test(String(videoId))) return { ok: false, error: "invalid VOD ID" };

  const [synced, local] = await Promise.all([
    storageGet(browserApi.storage.sync, { helixClientId: "" }),
    storageGet(browserApi.storage.local, { helixToken: "" })
  ]);
  const clientId = String(synced.helixClientId ?? "").trim();
  const token = String(local.helixToken ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!clientId || !token) return { ok: false, error: null };
  if (!(await canUseApiData())) return { ok: false, error: "API data permission required" };

  try {
    const response = await fetch(`https://api.twitch.tv/helix/videos?id=${encodeURIComponent(videoId)}`, {
      headers: {
        "Client-Id": clientId,
        Authorization: `Bearer ${token}`
      }
    });
    if (!response.ok) return { ok: false, error: `official API returned ${response.status}` };
    const payload = await response.json();
    return { ok: true, source: "helix", segments: payload?.data?.[0]?.muted_segments ?? [] };
  } catch {
    return { ok: false, error: "official API unavailable" };
  }
}

async function canUseApiData() {
  if (!browserApi.permissions?.getAll) return true;
  const permissions = await browserApi.permissions.getAll();
  return !Array.isArray(permissions.data_collection) ||
    ["authenticationInfo", "browsingActivity"].every((type) => permissions.data_collection.includes(type));
}

function storageGet(storage, defaults) {
  const result = storage.get(defaults);
  if (result?.then) return result;
  return new Promise((resolve) => storage.get(defaults, resolve));
}

function handleMessage(message, _sender, sendResponse) {
  if (message?.type !== "tvms-load-muted-segments") return;
  loadMutedSegments(message.videoId).then(sendResponse, () => {
    sendResponse({ ok: false, error: "official API unavailable" });
  });
  return true;
}

if (globalThis.__TVMS_TEST__) {
  Object.assign(globalThis.__TVMS_TEST__, { loadMutedSegments, handleMessage });
} else {
  browserApi.runtime.onMessage.addListener(handleMessage);
}
