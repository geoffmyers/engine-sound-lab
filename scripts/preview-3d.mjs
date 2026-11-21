// Screenshot the page from the working copy in a GPU browser reached over CDP, with no server
// (scripts/disk-origin.mjs). Use it to check the 3D engine: WebGL needs a GPU browser.
// Usage: CDP_URL=http://host:port node scripts/preview-3d.mjs <preset> <out.png> [options]
//   --width 1280 --height 1000   viewport
//   --dark                       dark colour scheme
//   --slow                       press Slow motion
//   --hold 800                   hold the throttle this many ms before the shot (0 = idle)
//   --panel                      shoot only the 3D panel
//   --picker [category]          open the preset picker (on a category tab) and shoot the window
//   --orbit dx                   drag the 3D view sideways by dx pixels first
import { chromium } from "playwright-core";
import { serveFromDisk } from "./disk-origin.mjs";

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const flag = (k) => args.includes(`--${k}`);
const [preset, out] = args;
if (!preset || !out) { console.error("usage: preview-3d.mjs <preset> <out.png> [options]"); process.exit(2); }

const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://localhost:9222");
const ctx = await browser.newContext({
  viewport: { width: +opt("width", 1280), height: +opt("height", 1000) },
  colorScheme: flag("dark") ? "dark" : "light", deviceScaleFactor: 1,
});
const url = await serveFromDisk(ctx);
const p = await ctx.newPage();
const logs = [];
p.on("console", (m) => { if (["error", "warning"].includes(m.type())) logs.push(`${m.type()}: ${m.text()}`); });
p.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await p.goto(url, { waitUntil: "networkidle" });
await p.evaluate(() => { try { localStorage.clear(); } catch {} });
await p.reload({ waitUntil: "networkidle" });
await p.waitForFunction(() => document.getElementById("engine3d")?.dataset.state, null, { timeout: 15000 });
await p.evaluate((id) => window.choosePreset(id), preset);
await p.click("#ignition");
await p.waitForTimeout(2500);
if (flag("slow")) await p.click("#slowMo");
const dx = +opt("orbit", 0);
if (dx) {
  const b = await p.locator("#engine3d canvas").boundingBox();
  await p.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await p.mouse.down(); await p.mouse.move(b.x + b.width / 2 + dx, b.y + b.height / 2 - dx / 4, { steps: 12 }); await p.mouse.up();
  await p.waitForTimeout(600);
}
const hold = +opt("hold", 800);
if (hold) { await p.keyboard.down("Space"); await p.waitForTimeout(hold); }
const fps = await p.evaluate(() => new Promise((done) => {
  let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 2000) requestAnimationFrame(tick); else done(Math.round(n / (performance.now() - t0) * 1000)); };
  requestAnimationFrame(tick);
}));
if (flag("picker")) {
  await p.click("#presetBtn");
  const cat = opt("picker", "");
  if (cat && !cat.startsWith("--")) await p.click(`#pickerTabs button[data-cat="${cat}"]`);
  await p.waitForTimeout(1500);
  await p.screenshot({ path: out });
} else await p.locator(flag("panel") ? "#engine3d" : ".cluster").screenshot({ path: out });
if (hold) await p.keyboard.up("Space");
console.log(JSON.stringify({ fps, state: await p.evaluate(() => document.getElementById("engine3d").dataset.state), logs }, null, 1));
await ctx.close();
await browser.close();
