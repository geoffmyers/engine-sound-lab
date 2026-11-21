// Capture the README screenshots from the running page, with the engine running.
// Usage: node scripts/capture-screenshots.mjs [url] [outDir]
//   Serve the site (python3 -m http.server 8000) and start Chromium with
//   --remote-debugging-port=9222 (or set CDP_URL). Over plain HTTP anywhere but localhost the
//   page falls back from AudioWorklet to a ScriptProcessor; the pictures are the same.
//   url "disk" loads the working copy with no server (scripts/disk-origin.mjs), for a remote
//   GPU browser: the 3D engine needs WebGL.
import { chromium } from "playwright-core";
import { serveFromDisk } from "./disk-origin.mjs";

let url = process.argv[2] || "http://localhost:8000/";
const out = process.argv[3] || "docs/screenshots";
const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://localhost:9222");

async function page(viewport, scheme) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, ignoreHTTPSErrors: true, deviceScaleFactor: 1 });
  if (process.argv[2] === "disk") url = await serveFromDisk(ctx);
  const p = await ctx.newPage();
  await p.goto(url, { waitUntil: "networkidle" });
  await p.evaluate(() => { try { localStorage.clear(); } catch {} });
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForFunction(() => document.getElementById("engine3d")?.dataset.state, null, { timeout: 20000 });
  return { ctx, p };
}
const hold = async (p, key, ms) => { await p.keyboard.down(key); await p.waitForTimeout(ms); };

// 1. The BMW S65 V8 revving, behind the car.
{
  const { ctx, p } = await page({ width: 1280, height: 1000 }, "light");
  await p.evaluate((id) => window.choosePreset(id), "bmw-s65");
  await p.click("#ignition"); await p.waitForTimeout(2500);
  await hold(p, "Space", 650);
  await p.screenshot({ path: `${out}/desktop.png` });
  await p.keyboard.up("Space"); await ctx.close();
}
// 2. A Porsche 911 GT3 pulling in Drive, heard from the driver's seat.
{
  const { ctx, p } = await page({ width: 1280, height: 1000 }, "dark");
  await p.evaluate((id) => window.choosePreset(id), "porsche-911-gt3-992");
  await p.click('label[for="persp-cabin"]');
  await p.click("#ignition"); await p.waitForTimeout(2500);
  await p.keyboard.press("3"); await p.waitForTimeout(400);
  await hold(p, "Space", 4200);
  await p.screenshot({ path: `${out}/drive.png` });
  await p.keyboard.up("Space"); await ctx.close();
}
// 3. A nine-cylinder radial aircraft engine, with its spec and sources.
{
  const { ctx, p } = await page({ width: 1280, height: 1000 }, "light");
  await p.evaluate((id) => window.choosePreset(id), "pw-r1340-wasp");
  await p.click("#ignition"); await p.waitForTimeout(3000);
  await hold(p, "Space", 1500);
  await p.screenshot({ path: `${out}/radial.png` });
  await p.keyboard.up("Space"); await ctx.close();
}
// 4. A phone, dark theme, a flat-plane V8 at speed.
{
  const { ctx, p } = await page({ width: 390, height: 844 }, "dark");
  await p.evaluate((id) => window.choosePreset(id), "ferrari-458-italia");
  await p.click("#ignition"); await p.waitForTimeout(2500);
  await hold(p, "Space", 700);
  await p.screenshot({ path: `${out}/phone.png` });
  await p.keyboard.up("Space"); await ctx.close();
}
await browser.close();
console.log(`screenshots written to ${out}`);
