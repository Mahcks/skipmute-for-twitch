const path = require("node:path");
const { chromium } = require("playwright");

// External canary; replace with an owned muted Highlight if the broadcaster removes it.
const vodUrl = "https://www.twitch.tv/videos/1766753076";

async function main() {
  const extensionPath = path.resolve("dist/chrome");
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`
    ]
  });
  const page = context.pages()[0];

  try {
    await context.route("**/*", (route) =>
      route.request().resourceType() === "media" ? route.abort() : route.continue()
    );
    await page.goto(vodUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const video = page.locator("video").first();
    await video.waitFor({ state: "attached", timeout: 60_000 });
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

    console.log(`SkipMute detected a muted segment on ${vodUrl}`);
  } catch (error) {
    await page.screenshot({ path: "live-smoke-failure.png", fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
