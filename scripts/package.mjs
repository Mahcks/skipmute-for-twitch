import { cpSync, copyFileSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const target = process.argv[2] ?? "firefox";
if (!new Set(["firefox", "chrome"]).has(target)) {
  console.error("Usage: node scripts/package.mjs <firefox|chrome>");
  process.exit(1);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");
const out = join(dist, target);
const zip = join(dist, `twitch-vod-muted-skipper-${target}.zip`);
const files = ["background.js", "content.js", "content.css", "options.html", "options.css", "options.js", "README.md", "PRIVACY.md"];

rmSync(out, { recursive: true, force: true });
rmSync(zip, { force: true });
mkdirSync(out, { recursive: true });
for (const file of files) copyFileSync(join(root, file), join(out, file));
cpSync(join(root, "icons"), join(out, "icons"), { recursive: true });
copyFileSync(join(root, target === "chrome" ? "manifest.chrome.json" : "manifest.json"), join(out, "manifest.json"));

// Use tools shipped with the operating system so packaging needs no npm dependencies.
const result = process.platform === "win32"
  ? spawnSync(
      "powershell",
      ["-NoProfile", "-Command", `Compress-Archive -Path '${out.replaceAll("'", "''")}\\*' -DestinationPath '${zip.replaceAll("'", "''")}' -Force`],
      { stdio: "inherit" }
    )
  : spawnSync("python3", ["-m", "zipfile", "-c", zip, "."], { cwd: out, stdio: "inherit" });

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`Created ${zip}`);
