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
const fields = Object.keys(DEFAULT_SETTINGS);
const status = document.getElementById("status");
const reset = document.getElementById("reset");

storageGet(DEFAULT_SETTINGS).then((settings) => {
  for (const field of fields) {
    const input = document.getElementById(field);
    if (!input) continue;
    if (input.type === "checkbox") {
      input.checked = Boolean(settings[field]);
    } else {
      input.value = settings[field];
    }
  }
});

for (const field of fields) {
  const input = document.getElementById(field);
  if (!input) continue;

  input.addEventListener("input", () => {
    const value = coerceValue(input, DEFAULT_SETTINGS[field]);
    storageSet({ [field]: value }).then(() => {
      showStatus("Saved");
    });
  });
}

reset.addEventListener("click", () => {
  storageSet(DEFAULT_SETTINGS).then(() => {
    for (const field of fields) {
      const input = document.getElementById(field);
      if (!input) continue;
      if (input.type === "checkbox") {
        input.checked = Boolean(DEFAULT_SETTINGS[field]);
      } else {
        input.value = DEFAULT_SETTINGS[field];
      }
    }
    showStatus("Defaults restored");
  });
});

function coerceValue(input, defaultValue) {
  if (input.type === "checkbox") return input.checked;
  if (typeof defaultValue === "number") {
    const value = Number(input.value);
    return Number.isFinite(value) ? value : defaultValue;
  }
  return input.value.trim();
}

function showStatus(message) {
  status.textContent = message;
  setTimeout(() => {
    status.textContent = "";
  }, 1400);
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
