const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { chromium, firefox } = require("playwright");

// Real browser media: installed Chromium extension; Firefox production initialization
// with only the extension storage/message boundary stubbed.
const root = path.resolve(__dirname, "..");
const sampleRate = 16000;
const seconds = 40;
const wav = Buffer.alloc(44 + sampleRate * seconds * 2);
wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4);
wav.write("WAVEfmt ", 8); wav.writeUInt32LE(16, 16);
wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(sampleRate, 24); wav.writeUInt32LE(sampleRate * 2, 28);
wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
for (let i = 0; i < sampleRate * seconds; i++) {
  const t = i / sampleRate;
  wav.writeInt16LE(t >= 8 && t < 22 ? 0 : Math.round(Math.sin(t * Math.PI * 880) * 16000), 44 + i * 2);
}

const html = `<!doctype html><html><head><link rel="stylesheet" href="/content.css">
<style>.player{position:relative;width:640px;height:360px}video{width:640px;height:360px}.controls{position:absolute;bottom:0;right:0;display:flex;height:40px;width:400px}button{min-width:32px;height:32px}[data-a-target="player-seekbar"]{position:absolute;bottom:42px;width:100%;height:8px}.seekbar-bar{position:relative;width:100%;height:8px}.marker{position:absolute;left:20%;width:35%;height:8px;background:rgb(200,0,0)}</style></head><body>
<button id="play" onclick="document.querySelector('video').play()">Play</button>
<div class="player"><video src="/media.wav" preload="auto"></video>
<div data-a-target="player-seekbar"><div class="seekbar-bar"><div data-test-selector="seekbar-segment__segment" class="marker" style="left:20%;width:35%;background:rgb(200,0,0)"></div></div></div>
<div class="controls"><button data-a-target="player-clip-button">Clip</button><button data-a-target="player-settings-button">Settings</button><button data-a-target="player-fullscreen-button">Full</button></div></div>
<script>
const settings = {}; const listeners = [];
window.chrome = {storage:{sync:{get:async defaults=>({...defaults,...settings}),set:async values=>{Object.assign(settings,values);listeners.forEach(fn=>fn(Object.fromEntries(Object.entries(values).map(([k,v])=>[k,{newValue:v}])),"sync"));}},onChanged:{addListener:fn=>listeners.push(fn)}},runtime:{sendMessage:async()=>({ok:true,source:"none",segments:[]})}};
window.seeks = [];
document.addEventListener("seeking", event=>window.seeks.push(event.target.currentTime),true);
</script></body></html>`;

async function main() {
  const extension = fs.mkdtempSync(path.join(os.tmpdir(), "skipmute-browser-"));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.chrome.json"), "utf8"));
  // Exercise Chromium's isolated extension world against the local fixture host.
  manifest.content_scripts[0].matches = ["http://127.0.0.1/*"];
  manifest.host_permissions.push("http://127.0.0.1/*");
  for (const file of ["background.js", "content.js", "content.css", "options.html", "options.css", "options.js", "icons"]) {
    fs.cpSync(path.join(root, file), path.join(extension, file), { recursive: true });
  }
  fs.writeFileSync(path.join(extension, "manifest.json"), JSON.stringify(manifest));
  let configureScript = "";
  const server = http.createServer((req, res) => {
    if (req.url === "/gql") {
      res.writeHead(503);
      res.end();
      return;
    }
    if (req.url === "/media.wav") {
      const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
      const start = range ? Number(range[1]) : 0;
      const end = range?.[2] ? Math.min(Number(range[2]), wav.length - 1) : wav.length - 1;
      res.writeHead(range ? 206 : 200, { "Content-Type": "audio/wav", "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1, ...(range ? { "Content-Range": `bytes ${start}-${end}/${wav.length}` } : {}) });
      res.end(wav.subarray(start, end + 1));
      return;
    }
    const asset = { "/content.js": "text/javascript", "/content.css": "text/css" }[req.url];
    const body = asset ? fs.readFileSync(path.join(root, req.url.slice(1))) : html.replace("</body>", `<script>${configureScript}</script></body>`);
    res.writeHead(200, { "Content-Type": req.url === "/media.wav" ? "audio/wav" : asset ?? "text/html", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  // Keep timeline regression fixtures independent of Twitch's metadata service.
  fs.writeFileSync(path.join(extension, "background.js"), fs.readFileSync(path.join(root, "background.js"), "utf8")
    .replace("https://gql.twitch.tv/gql", `http://127.0.0.1:${server.address().port}/gql`));
  try {
    for (const [name, engine] of Object.entries({ chromium, firefox })) {
      // Silence browser output, preserving media volume and analyser samples.
      const browser = name === "chromium"
        ? await engine.launchPersistentContext("", { channel: "chromium", args: ["--mute-audio", "--autoplay-policy=no-user-gesture-required", `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] })
        : await engine.launch({ firefoxUserPrefs: { "media.volume_scale": "0.0", "media.autoplay.default": 0, "media.autoplay.block-webaudio": false } });
      const page = await browser.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      const result = { browser: name, noSkipCases: 0, expectedSkipCases: 0, falseSkips: 0, missedSkips: 0, skipLatencyMs: [] };
      const fresh = async (configure = () => {}, staleOverlay = "") => {
        configureScript = `document.body.insertAdjacentHTML("beforeend", ${JSON.stringify(staleOverlay)}); (${configure.toString()})();`;
        await page.goto(`http://127.0.0.1:${server.address().port}/videos/123`);
        await page.waitForFunction(() => document.querySelector("video").readyState >= 3);
        if (name === "firefox") await page.addScriptTag({ url: "/content.js" });
        await page.waitForSelector("#tvms-root.tvms-inline");
      };
      const playAt = async (time) => {
        await page.evaluate(time => { document.querySelector("video").currentTime = time; }, time);
        await page.waitForFunction(time => { const video = document.querySelector("video"); return !video.seeking && Math.abs(video.currentTime - time) < 0.2; }, time);
        await page.evaluate(() => { window.seeks = []; });
        await page.click("#play");
      };
      const noSkip = async (label, configure, time = 8.2) => {
        await fresh(configure);
        await playAt(time);
        await page.waitForTimeout(3500);
        const actual = await page.locator("video").evaluate(video => video.currentTime);
        const seeks = await page.evaluate(() => window.seeks);
        if (seeks.length) result.falseSkips++;
        assert.deepEqual(seeks, [], `${name}: ${label}: unexpected seeking`);
        assert.ok(actual > time + 1 && actual < time + 6, `${name}: ${label}: expected continuous playback, got ${actual}`);
        result.noSkipCases++;
      };
      try {
        await noSkip("audible content inside marker", () => { const marker = document.querySelector(".marker"); marker.style.left = "0%"; marker.style.width = "55%"; }, 1);
        await noSkip("low-volume audible content", () => { document.querySelector("video").volume = 0.01; const marker = document.querySelector(".marker"); marker.style.left = "0%"; marker.style.width = "55%"; }, 1);
        await noSkip("user-muted player", () => { document.querySelector("video").muted = true; });
        await noSkip("zero volume", () => { document.querySelector("video").volume = 0; });
        await noSkip("red decoration outside timeline", () => { document.querySelector(".player").append(document.querySelector(".marker")); });
        await noSkip("cross-origin audible audio cannot be verified", () => { document.querySelector("video").src = `http://localhost:${location.port}/media.wav`; const marker = document.querySelector(".marker"); marker.style.left = "0%"; marker.style.width = "55%"; }, 1);

        // Add-on reloads can leave a visible control whose original handlers are gone.
        const staleOverlay = await page.locator("#tvms-root").evaluate(root => {
          const clone = root.cloneNode(true);
          clone.dataset.staleControl = "true";
          return clone.outerHTML;
        });
        await fresh(() => {}, staleOverlay);
        assert.equal(await page.locator("[data-stale-control]").count(), 0, `${name}: stale control must be replaced`);
        await playAt(8.2);
        const started = Date.now();
        try { await page.waitForFunction(() => document.querySelector("video").currentTime >= 22, null, { timeout: 8000 }); }
        catch (error) { result.missedSkips++; throw error; }
        result.skipLatencyMs.push(Date.now() - started);
        result.expectedSkipCases++;
        await page.locator(".tvms-action").click();
        await page.waitForFunction(() => document.querySelector("video").currentTime < 18);
        await page.waitForTimeout(2200);
        assert.ok(await page.locator("video").evaluate(video => video.currentTime < 20), `${name}: Undo must remain inside muted range`);
        await page.locator(".tvms-action").click();
        await page.waitForFunction(() => document.querySelector("video").currentTime >= 22);

        // A replaced media element on a new VOD must receive fresh detection and audio tracking.
        await page.evaluate(() => {
          const old = document.querySelector("video"); old.pause(); window.originalVideo = old;
          const replacement = old.cloneNode(); old.replaceWith(replacement);
          history.pushState({}, "", "/videos/456");
        });
        await page.waitForFunction(() => document.querySelector("video").readyState >= 3);
        await page.waitForTimeout(1000);
        await playAt(8.2);
        const replacementStarted = Date.now();
        try { await page.waitForFunction(() => document.querySelector("video").currentTime >= 22, null, { timeout: 8000 }); }
        catch (error) { result.missedSkips++; throw error; }
        result.skipLatencyMs.push(Date.now() - replacementStarted);
        result.expectedSkipCases++;
        await page.evaluate(() => {
          const current = document.querySelector("video"); current.pause();
          current.replaceWith(window.originalVideo);
          history.pushState({}, "", "/videos/789");
        });
        await page.waitForTimeout(1000);
        await playAt(8.2);
        const reusedStarted = Date.now();
        try { await page.waitForFunction(() => document.querySelector("video").currentTime >= 22, null, { timeout: 8000 }); }
        catch (error) { result.missedSkips++; throw error; }
        result.skipLatencyMs.push(Date.now() - reusedStarted);
        result.expectedSkipCases++;
        assert.deepEqual(errors, [], `${name}: browser errors`);
      } catch (error) {
        console.error(JSON.stringify(await page.evaluate(() => {
          const video = document.querySelector("video");
          return { time: video?.currentTime, paused: video?.paused, seeking: video?.seeking,
            readyState: video?.readyState, status: document.querySelector(".tvms-toggle")?.title,
            seeks: window.seeks };
        })));
        throw error;
      } finally {
        console.log(JSON.stringify(result));
        await browser.close();
      }
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(extension, { recursive: true, force: true });
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
