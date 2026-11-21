// Draw every preset's picker picture from the page's own 3D engine, in a GPU browser over CDP
// (the picture every preset falls back to, and the only one a public clone has).
// Usage: CDP_URL=http://host:port node scripts/render-engine-thumbs.mjs [id ...]
// Writes img/presets/<id>.png; scripts/convert-renders.py turns them into .webp.
import { chromium } from "playwright-core";
import { readFileSync } from "node:fs";
import { serveFromDisk } from "./disk-origin.mjs";

const root = new URL("..", import.meta.url);
const data = JSON.parse(readFileSync(new URL("engine-data.json", root), "utf8"));
const ids = process.argv.slice(2).length ? process.argv.slice(2) : data.presets.map((p) => p.id);
const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://localhost:9222");
const ctx = await browser.newContext({ viewport: { width: 1000, height: 800 }, colorScheme: "dark", deviceScaleFactor: 2 });
const url = await serveFromDisk(ctx);
const p = await ctx.newPage();
await p.goto(url, { waitUntil: "networkidle" });
await p.waitForFunction(() => document.getElementById("engine3d")?.dataset.state === "ready", null, { timeout: 20000 });
// A bare 16:10 stage: no labels, button or hint.
await p.addStyleTag({ content: `#engine3d { position: fixed !important; left: 0; top: 0; width: 480px !important; height: 300px !important; z-index: 99; border-radius: 0 }
  .engine3d-labels, .engine3d-btn, .engine3d-note { display: none !important; }` });
for (const id of ids) {
  await p.evaluate((pid) => window.choosePreset(pid), id);
  await p.waitForTimeout(900);
  await p.locator("#engine3d").screenshot({ path: new URL(`img/presets/${id}.png`, root).pathname });
  console.log(id);
}
await ctx.close();
await browser.close();
