const DEFAULT_SETTINGS = {
  enabled: true,
  helixClientId: "",
  helixToken: "",
  skipPaddingSeconds: 0.35,
  silenceThreshold: 0.004
};

const browserApi = globalThis.browser ?? globalThis.chrome;
const fields = Object.keys(DEFAULT_SETTINGS);
let lastStatusTimer = null;
let pendingSave = Promise.resolve();
let dataConsentSupported = false;

// Form lifecycle

async function init() {
  const status = document.getElementById("status");
  const saveCredentials = document.getElementById("save-credentials");
  saveCredentials.disabled = true;

  for (const field of fields) {
    const input = document.getElementById(field);
    if (!input || field === "helixClientId" || field === "helixToken") continue;

    input.addEventListener("change", () => {
      // Serialize writes so Reset cannot race a focused field's change event.
      pendingSave = pendingSave.then(async () => {
        const value = coerceValue(input, DEFAULT_SETTINGS[field]);
        if (value == null) {
          input.reportValidity();
          showStatus(status, "Enter a value within the allowed range", true);
          return;
        }

        try {
          await saveSettings({ [field]: value });
          showStatus(status, "Saved");
        } catch {
          showStatus(status, "Could not save this setting", true);
        }
      });
    });
  }

  saveCredentials.addEventListener("click", () => {
    const clientId = document.getElementById("helixClientId").value.trim();
    const token = document.getElementById("helixToken").value.trim().replace(/^Bearer\s+/i, "");
    if (token && !clientId) {
      showStatus(status, "Enter a Client ID for this token", true);
      return;
    }
    // Firefox requires request() in this synchronous click stack, before any await.
    let permission;
    try {
      permission = Promise.resolve(ensureAuthenticationPermission(token));
    } catch {
      showStatus(status, "Could not request API data access; try again", true);
      return;
    }
    // Attach rejection handling now, even if an earlier setting write is pending.
    permission = permission.catch(() => false);
    saveCredentials.disabled = true;
    pendingSave = pendingSave.then(async () => {
      try {
        if (!(await permission)) {
          showStatus(status, "API access was declined; credentials were not changed", true);
          return;
        }
        if (token) {
          showStatus(status, "Checking Twitch credentials…");
          const result = await browserApi.runtime.sendMessage({ type: "tvms-validate-credentials", clientId, token });
          if (!result?.ok) {
            showStatus(status, `${result?.error ?? "Could not validate credentials; try again"}. Saved credentials were not changed.`, true);
            return;
          }
        }
        await saveSettings({ helixClientId: clientId, helixToken: token });
        if (!token) await clearAuthenticationPermission();
        showStatus(status, token ? "API credentials verified and saved" : "API token removed");
      } catch {
        showStatus(status, "Could not save API credentials; try again", true);
      } finally {
        saveCredentials.disabled = false;
      }
    });
  });

  document.getElementById("reset").addEventListener("click", async () => {
    try {
      await pendingSave;
      await saveSettings(DEFAULT_SETTINGS);
      await clearAuthenticationPermission();
      populateSettings(DEFAULT_SETTINGS);
      showStatus(status, "Defaults restored");
    } catch {
      showStatus(status, "Could not restore defaults", true);
    }
  });

  try {
    const settings = await loadSettings();
    const permissions = browserApi.permissions?.getAll ? await browserApi.permissions.getAll() : {};
    dataConsentSupported = Array.isArray(permissions.data_collection);
    populateSettings(settings);
    saveCredentials.disabled = false;
    if (settings.helixToken && !(await hasAuthenticationPermission())) {
      showStatus(status, "Firefox permission required: click Save API credentials", true);
    }
  } catch {
    showStatus(status, "Could not load saved settings", true);
  }
}

// Validation and persistence

function populateSettings(settings) {
  for (const field of fields) {
    const input = document.getElementById(field);
    if (!input) continue;
    if (input.type === "checkbox") {
      input.checked = Boolean(settings[field]);
    } else {
      input.value = settings[field];
    }
  }
}

function coerceValue(input, defaultValue) {
  if (input.type === "checkbox") return input.checked;
  if (typeof defaultValue === "number") {
    if (input.value.trim() === "") return null;
    const value = Number(input.value);
    const min = input.min === "" ? -Infinity : Number(input.min);
    const max = input.max === "" ? Infinity : Number(input.max);
    return Number.isFinite(value) && value >= min && value <= max ? value : null;
  }
  return input.value.trim();
}

async function loadSettings() {
  await migrateCredentials();
  const [synced, local] = await Promise.all([
    storageGet(browserApi.storage.sync, DEFAULT_SETTINGS),
    storageGet(browserApi.storage.local, { helixToken: "" })
  ]);
  return { ...DEFAULT_SETTINGS, ...synced, helixToken: local.helixToken || "" };
}

async function migrateCredentials() {
  const result = await browserApi.runtime.sendMessage({ type: "tvms-migrate-credentials" });
  if (!result?.ok) throw new Error("Could not migrate saved credentials");
}

async function saveSettings(values) {
  if ("helixToken" in values) await migrateCredentials();
  const synced = {};
  const local = {};
  for (const [key, value] of Object.entries(values)) {
    // Credentials stay on this device while ordinary preferences can sync.
    (key === "helixToken" ? local : synced)[key] = value;
  }
  const removeToken = local.helixToken === "";
  if (removeToken) delete local.helixToken;
  if ("helixToken" in values) local.helixCredentialRevision = Date.now();

  await Promise.all([
    Object.keys(synced).length ? storageSet(browserApi.storage.sync, synced) : Promise.resolve(),
    Object.keys(local).length ? storageSet(browserApi.storage.local, local) : Promise.resolve(),
    removeToken ? storageRemove(browserApi.storage.local, "helixToken") : Promise.resolve()
  ]);
  if ("helixToken" in values) await storageRemove(browserApi.storage.sync, "helixToken");
}

// Firefox data-collection consent

function ensureAuthenticationPermission(token) {
  if (!token || !dataConsentSupported) return true;
  return browserApi.permissions.request({ data_collection: ["authenticationInfo"] });
}

async function hasAuthenticationPermission() {
  if (!browserApi.permissions?.getAll) return true;
  const permissions = await browserApi.permissions.getAll();
  if (!Array.isArray(permissions.data_collection)) return true;
  return ["authenticationInfo", "browsingActivity"].every((type) => permissions.data_collection.includes(type));
}

async function clearAuthenticationPermission() {
  if (!browserApi.permissions?.getAll || !browserApi.permissions.remove) return;
  try {
    const permissions = await browserApi.permissions.getAll();
    const dataCollection = ["authenticationInfo"]
      .filter((type) => permissions.data_collection?.includes(type));
    if (dataCollection.length) {
      await browserApi.permissions.remove({ data_collection: dataCollection });
    }
  } catch {
    // The token is already cleared; consent can still be removed later in Firefox settings.
  }
}

function showStatus(status, message, isError = false) {
  clearTimeout(lastStatusTimer);
  status.textContent = message;
  status.classList.toggle("error", isError);
  if (isError) return;
  lastStatusTimer = setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 2400);
}

// Firefox uses promises; older Chrome extension APIs use callbacks.
function storageGet(storage, defaults) {
  const result = storage.get(defaults);
  if (result?.then) return result;
  return new Promise((resolve) => storage.get(defaults, resolve));
}

function storageSet(storage, values) {
  const result = storage.set(values);
  if (result?.then) return result;
  return new Promise((resolve) => storage.set(values, resolve));
}

function storageRemove(storage, keys) {
  const result = storage.remove(keys);
  if (result?.then) return result;
  return new Promise((resolve) => storage.remove(keys, resolve));
}

// Tests opt into these hooks before evaluating the options script.
if (globalThis.__TVMS_TEST__) {
  Object.assign(globalThis.__TVMS_TEST__, {
    init,
    coerceValue,
    loadSettings,
    saveSettings,
    ensureAuthenticationPermission,
    clearAuthenticationPermission
  });
} else {
  void init();
}
