const assert = require("node:assert/strict");
const { generateKeyPairSync, verify } = require("node:crypto");
const test = require("node:test");

test("Chrome publishing signs OAuth correctly and publishes only after a successful upload", async () => {
  const { publishChrome } = await import("../scripts/publish-chrome.mjs");
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const env = {
    CWS_SERVICE_ACCOUNT_JSON: JSON.stringify({ type: "service_account", client_email: "ci@example.test",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }) }),
    CWS_PUBLISHER_ID: "publisher-id", CWS_EXTENSION_ID: "joigloedgnkomhlekekfopbbeanlkcnp"
  };
  const zip = Buffer.from("test package");
  for (const outcome of ["SUCCEEDED", "UPLOAD_SUCCEEDED", "FAILED", "timeout", "http-error"]) {
    const calls = [];
    let polls = 0;
    const fetcher = async (url, options) => {
      calls.push(url);
      assert.ok(options.signal instanceof AbortSignal);
      let payload;
      if (url.endsWith("/token")) {
        const [header, body, signature] = options.body.get("assertion").split(".");
        const claims = JSON.parse(Buffer.from(body, "base64url"));
        assert.equal(claims.iss, "ci@example.test");
        assert.equal(claims.aud, "https://oauth2.googleapis.com/token");
        assert.equal(claims.scope, "https://www.googleapis.com/auth/chromewebstore");
        assert.equal(claims.exp - claims.iat, 3600);
        assert.ok(verify("RSA-SHA256", Buffer.from(`${header}.${body}`), publicKey, Buffer.from(signature, "base64url")));
        payload = { access_token: "fake-token" };
      } else {
        assert.equal(options.headers.Authorization, "Bearer fake-token");
        if (url.endsWith(":upload")) {
          assert.equal(options.body, zip);
          assert.equal(options.method, "POST");
          if (outcome === "http-error") return { ok: false, status: 403 };
          payload = { uploadState: "UPLOAD_IN_PROGRESS" };
        } else if (url.endsWith(":fetchStatus")) {
          polls++;
          payload = { lastAsyncUploadState: outcome === "timeout" ? "IN_PROGRESS" : outcome };
        } else {
          assert.ok(url.endsWith(":publish"));
          assert.deepEqual(JSON.parse(options.body), { publishType: "DEFAULT_PUBLISH" });
          payload = { state: "PENDING_REVIEW" };
        }
      }
      return { ok: true, json: async () => payload };
    };
    const result = publishChrome(env, zip, fetcher, async () => {});
    if (outcome.endsWith("SUCCEEDED")) {
      assert.equal((await result).state, "PENDING_REVIEW");
      assert.equal(calls.filter(url => url.endsWith(":publish")).length, 1);
    } else {
      await assert.rejects(result, /upload/i);
      assert.equal(calls.some(url => url.endsWith(":publish")), false);
    }
    if (outcome === "timeout") assert.equal(polls, 30);
  }
  await assert.rejects(publishChrome({}, zip), /Missing CWS_SERVICE_ACCOUNT_JSON/);
  await assert.rejects(publishChrome({ ...env, CWS_SERVICE_ACCOUNT_JSON: "invalid" }, zip), /complete service-account JSON/);
});
