import { sign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// Google service-account OAuth + Chrome Web Store v2; no publishing dependencies.
export async function publishChrome(env, zip, fetcher = fetch, wait = sleep) {
  for (const key of ["CWS_SERVICE_ACCOUNT_JSON", "CWS_PUBLISHER_ID", "CWS_EXTENSION_ID"]) {
    if (!env[key]?.trim()) throw new Error(`Missing ${key}; see README automatic publishing setup`);
  }
  if (!/^[a-p]{32}$/.test(env.CWS_EXTENSION_ID)) throw new Error("Invalid CWS_EXTENSION_ID");
  let account;
  try {
    account = JSON.parse(env.CWS_SERVICE_ACCOUNT_JSON);
    if (account.type !== "service_account" || !account.client_email || !account.private_key) throw new Error();
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON must be the complete service-account JSON key");
  }
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const issued = Math.floor(Date.now() / 1000);
  const claims = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: account.client_email, scope: "https://www.googleapis.com/auth/chromewebstore",
    aud: "https://oauth2.googleapis.com/token", iat: issued, exp: issued + 3600
  })}`;
  let assertion;
  try {
    assertion = `${claims}.${sign("RSA-SHA256", Buffer.from(claims), account.private_key).toString("base64url")}`;
  } catch {
    throw new Error("CWS_SERVICE_ACCOUNT_JSON contains an invalid private key");
  }
  const request = async (url, options, operation) => {
    const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(60000) });
    // Do not log credential-bearing response bodies or request headers.
    if (!response.ok) throw new Error(`${operation} failed (HTTP ${response.status}); check store access and dashboard`);
    return response.json();
  };
  const credentials = await request("https://oauth2.googleapis.com/token", {
    method: "POST", body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion })
  }, "Google authentication");
  if (!credentials.access_token) throw new Error("Google authentication returned no access token");
  const headers = { Authorization: `Bearer ${credentials.access_token}` };
  const item = `publishers/${encodeURIComponent(env.CWS_PUBLISHER_ID)}/items/${env.CWS_EXTENSION_ID}`;
  const base = `https://chromewebstore.googleapis.com/v2/${item}`;
  const uploaded = await request(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/zip" }, body: zip
  }, "Chrome upload");
  // Some API examples use UPLOAD_ prefixes; the current enum uses bare names.
  const stateOf = (state) => String(state).replace(/^UPLOAD_/, "");
  let state = stateOf(uploaded.uploadState);
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < 30; attempt++) {
    await wait(10000);
    const status = await request(`${base}:fetchStatus`, { headers }, "Chrome upload status");
    state = stateOf(status.lastAsyncUploadState);
  }
  if (state !== "SUCCEEDED") throw new Error("Chrome upload did not complete successfully; inspect the store dashboard before retrying");
  return request(`${base}:publish`, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH" })
  }, "Chrome submission");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const zip = await readFile(new URL("../dist/twitch-vod-muted-skipper-chrome.zip", import.meta.url));
    const result = await publishChrome(process.env, zip);
    console.log(`Chrome submission accepted; state: ${result.state ?? "unknown"}. Store review may still be pending.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
