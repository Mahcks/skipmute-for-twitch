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

async function init() {
  const status = document.getElementById("status");

  for (const field of fields) {
    const input = document.getElementById(field);
    if (!input) continue;

    input.addEventListener("change", () => {
      pendingSave = pendingSave.then(async () => {
        const value = coerceValue(input, DEFAULT_SETTINGS[field]);
        if (value == null) {
          input.reportValidity();
          showStatus(status, "Enter a value within the allowed range", true);
          return;
        }

        try {
          if (field === "helixToken" && !(await ensureAuthenticationPermission(value))) {
            input.value = "";
            showStatus(status, "Token was not saved because permission was declined", true);
            return;
          }
          await saveSettings({ [field]: value });
          showStatus(status, "Saved");
        } catch {
          showStatus(status, "Could not save this setting", true);
        }
      });
    });
  }

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
    populateSettings(settings);
    if (settings.helixToken && !(await hasAuthenticationPermission())) {
      showStatus(status, "Firefox permission required: edit and save the token", true);
    }
  } catch {
    showStatus(status, "Could not load saved settings", true);
  }
}

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
  const [synced, local] = await Promise.all([
    storageGet(browserApi.storage.sync, DEFAULT_SETTINGS),
    storageGet(browserApi.storage.local, { helixToken: "" })
  ]);

  if (synced.helixToken) {
    if (!local.helixToken) await storageSet(browserApi.storage.local, { helixToken: synced.helixToken });
    await storageRemove(browserApi.storage.sync, "helixToken");
  }

  return { ...DEFAULT_SETTINGS, ...synced, helixToken: local.helixToken || synced.helixToken || "" };
}

async function saveSettings(values) {
  const synced = {};
  const local = {};
  for (const [key, value] of Object.entries(values)) {
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

async function ensureAuthenticationPermission(token) {
  if (!token || (await hasAuthenticationPermission())) return true;
  return browserApi.permissions.request({ data_collection: ["authenticationInfo", "browsingActivity"] });
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
    const dataCollection = ["authenticationInfo", "browsingActivity"]
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
  lastStatusTimer = setTimeout(() => {
    status.textContent = "";
    status.classList.remove("error");
  }, 2400);
}

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
