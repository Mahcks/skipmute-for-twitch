const path = require("node:path");
const { chromium } = require("playwright");

// External canary; replace with an owned muted Highlight if the broadcaster removes it.
const vodUrl = process.env.LIVE_SMOKE_VOD_URL || "https://www.twitch.tv/videos/2484712193";
if (!/^https:\/\/www\.twitch\.tv\/videos\/\d+(?:[?#].*)?$/.test(vodUrl)) throw new Error("LIVE_SMOKE_VOD_URL must be a Twitch VOD URL");

function getVodStatus() {
  if (document.body?.innerText.includes("that content is unavailable")) return "unavailable";
  const video = document.querySelector("video");
  // Twitch briefly creates a video even when the VOD has been removed.
  return video?.readyState >= 3 && Number.isFinite(video.duration) && video.duration > 0
    ? "playable" : null;
}

async function main() {
  const extensionPath = path.resolve("dist/chrome");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    locale: "en-US",
    viewport: { width: 1280, height: 800 },
    args: [
      "--mute-audio",
      "--autoplay-policy=no-user-gesture-required",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const page = context.pages()[0];

  try {
    await page.goto(vodUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const status = await page.waitForFunction(getVodStatus, null, { timeout: 60_000 });
    if (await status.jsonValue() === "unavailable") {
      throw new Error(`Twitch VOD is unavailable: ${vodUrl}. Set LIVE_SMOKE_VOD_URL to a playable VOD with a muted interval.`);
    }

    const video = page.locator("video").first();
    const box = await video.boundingBox();
    if (!box) throw new Error("Twitch video is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 20);

    const control = page.locator("#tvms-root.tvms-inline .tvms-toggle");
    await control.waitFor({ state: "visible", timeout: 30_000 });
    if ((await control.textContent())?.trim().startsWith("Muted skip") !== true) {
      throw new Error("SkipMute player control has unexpected content");
    }

    await page.locator("#tvms-root .tvms-count:not([hidden])").waitFor({
      state: "visible",
      timeout: 30_000
    });

    console.log(`Live DOM check passed: SkipMute detected a muted segment on ${vodUrl}`);
    await page.waitForFunction(() => {
      const video = document.querySelector("video");
      return video?.readyState >= 3 && Number.isFinite(video.duration);
    }, null, { timeout: 60_000 });
    const segment = await page.evaluate(() => {
      const duration = document.querySelector("video").duration;
      for (const marker of document.querySelectorAll('[data-a-target="player-seekbar"] .seekbar-bar [data-test-selector="seekbar-segment__segment"]')) {
        const rgb = getComputedStyle(marker).backgroundColor.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        const left = marker.style.insetInlineStart || marker.style.left;
        const width = marker.style.width;
        if (!rgb || +rgb[1] < 150 || +rgb[2] > 95 || +rgb[3] > 125 || !left.endsWith("%") || !width.endsWith("%")) continue;
        const start = parseFloat(left) / 100 * duration;
        const end = start + parseFloat(width) / 100 * duration;
        if (Number.isFinite(start) && end - start >= 10 && end < duration - 2) return { start, end };
      }
      return null;
    });
    if (!segment) throw new Error("Live playback check requires a detected muted range at least 10 seconds long");
    await video.evaluate((element, start) => {
      element.pause(); element.muted = false; element.volume = 1; element.currentTime = start + 1;
    }, segment.start);
    await page.waitForFunction(start => {
      const video = document.querySelector("video");
      return !video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - start - 1) < 2;
    }, segment.start, { timeout: 30_000 });
    for (let attempt = 0; attempt < 3; attempt++) {
      try { await video.evaluate(element => element.play()); break; }
      catch (error) {
        if (!error.message.includes("AbortError") || attempt === 2) throw error;
        await page.waitForTimeout(500);
      }
    }
    const started = Date.now();
    await page.waitForFunction(start => {
      const video = document.querySelector("video");
      return !video.paused && video.currentTime > start + 1.2;
    }, segment.start, { timeout: 15_000 });
    await page.waitForFunction(end => document.querySelector("video").currentTime >= end, segment.end, { timeout: 20_000 });
    // The Undo action proves an extension seek occurred, rather than natural playback reaching the end.
    const action = page.locator("#tvms-root .tvms-action");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height - 25);
    await action.filter({ hasText: "Undo" }).click();
    await page.waitForFunction(end => document.querySelector("video").currentTime < end - 2, segment.end, { timeout: 5000 });
    await action.filter({ hasText: "Skip" }).click();
    await page.waitForFunction(end => document.querySelector("video").currentTime >= end, segment.end, { timeout: 5000 });
    console.log(JSON.stringify({ check: "live-playback", vodUrl, skipUndoReskip: "passed",
      elapsedMs: Date.now() - started, metadataStatus: await control.getAttribute("title") }));
  } catch (error) {
    await page.screenshot({ path: "live-smoke-failure.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

module.exports = { getVodStatus };
if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
