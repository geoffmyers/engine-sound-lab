// Headless smoke test in a Chromium reached over the DevTools protocol: load the page, fail on console or page
// errors, start the engine, hold the throttle, check the tachometer readout climbs, check the
// page never scrolls sideways, and save screenshots (desktop + phone, light + dark).
// Usage: node tests/smoke.mjs [url] [outDir]
//   Serve the site first (python3 -m http.server 8000), start Chromium with
//   --remote-debugging-port=9222, and set CDP_URL if it listens elsewhere. AudioWorklet needs a
//   secure context: over plain HTTP on anything but localhost the page uses its ScriptProcessor fallback.
//   url "disk" loads the working copy with no server (scripts/disk-origin.mjs), for a remote browser.
import { chromium } from "playwright-core";
import { serveFromDisk } from "../scripts/disk-origin.mjs";
let url = process.argv[2] || "http://localhost:8000/";
const out = process.argv[3] || ".";
const browser = await chromium.connectOverCDP(process.env.CDP_URL || "http://localhost:9222");
let failed = false;
const rpmOf = (page) => page.$eval("#roRpm", el => parseInt(el.textContent.replace(/[^0-9]/g, ""), 10));
for (const [label, viewport, scheme] of [
  ["desktop-light", { width: 1280, height: 900 }, "light"],
  ["desktop-dark", { width: 1280, height: 900 }, "dark"],
  ["phone-light", { width: 390, height: 844 }, "light"],
]) {
  const ctx = await browser.newContext({ viewport, colorScheme: scheme, ignoreHTTPSErrors: true });
  if (process.argv[2] === "disk") url = await serveFromDisk(ctx);
  const page = await ctx.newPage();
  const errors = [];
  page.on("console", m => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", e => errors.push(String(e)));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.check("#coldStart");
  await page.click("#ignition");
  await page.waitForTimeout(2500);
  const idle = await rpmOf(page);
  await page.keyboard.down("Space");
  await page.waitForTimeout(700);
  const revving = await rpmOf(page);
  await page.screenshot({ path: `${out}/smoke-${label}.png`, fullPage: true });
  await page.keyboard.up("Space");
  // Every listening position applies without errors and shows its basis.
  const bases = [];
  for (const id of ["front", "bay", "cabin", "dry", "rear"]) {
    await page.click(`label[for="persp-${id}"]`);
    await page.waitForTimeout(150);
    bases.push(await page.$eval("#perspectiveNote .basis", el => el.textContent));
  }
  // A turbo boxer in Drive: pull away (automatic shifting), gain speed, then brake.
  // Through the picker, as a visitor would: open it, search, click the card.
  await page.click("#presetBtn");
  await page.fill("#pickerSearch", "boxer turbo");
  await page.click('.pcard[data-id="boxer-turbo"]');
  await page.keyboard.press("3");
  await page.waitForTimeout(1500);
  await page.keyboard.down("Space");
  await page.waitForTimeout(6500);
  const kmh = () => page.$eval("#roSpeed", el => parseInt(el.textContent, 10));
  const drive = await page.evaluate(() => ({ gear: document.getElementById("roGear").textContent, boost: document.getElementById("roBoost").textContent }));
  drive.kmh = await kmh();
  await page.keyboard.up("Space");
  if (label === "desktop-light") await page.screenshot({ path: `${out}/smoke-drive.png` });
  await page.keyboard.down("b");
  await page.waitForTimeout(1500);
  drive.braked = await kmh();
  await page.keyboard.up("b");
  // A downshift the car is going too fast for is refused with a message.
  await page.keyboard.down("Space"); await page.waitForTimeout(2500); await page.keyboard.up("Space");
  // Q, not ArrowDown: focus is on a radio group here, where arrows rightly move the selection.
  drive.before = await page.evaluate(() => ({ gear: window.engineState.gear, kmh: Math.round(window.engineState.speedKmh), mode: window.engineState.mode, focus: document.activeElement.id }));
  for (let i = 0; i < 4; i++) { await page.keyboard.press("q"); await page.waitForTimeout(120); }
  drive.after = await page.evaluate(() => ({ gear: window.engineState.gear, kmh: Math.round(window.engineState.speedKmh) }));
  await page.waitForTimeout(300);
  drive.toast = await page.$eval("#toast", el => el.hidden ? "" : el.textContent);
  // Real presets: a radial aircraft engine (no Drive, sources shown) and a two-stroke.
  await page.click("#presetBtn");
  const pickerInfo = await page.evaluate(() => ({
    groups: [...document.querySelectorAll("#pickerTabs button")].map(b => b.firstChild.textContent),
    cards: document.querySelectorAll("#pickerGrid .pcard").length,
  }));
  await page.click('#pickerTabs button[data-cat="aircraft"]');
  await page.click('.pcard[data-id="pw-r1340-wasp"]');
  await page.waitForTimeout(1200);
  const real = await page.evaluate(() => ({
    driveDisabled: document.getElementById("mode-drive").disabled,
    spec: document.getElementById("presetSpec").textContent,
    picture: document.getElementById("presetBtnImg").naturalWidth,
    button: document.getElementById("presetBtnName").textContent,
  }));
  Object.assign(real, pickerInfo);
  if (label === "desktop-light") await page.screenshot({ path: `${out}/smoke-radial.png` });
  await page.evaluate(() => window.choosePreset("ktm-250-sx"));
  await page.keyboard.down("Space"); await page.waitForTimeout(800); await page.keyboard.up("Space");
  real.twoStrokeRpm = await page.evaluate(() => Math.round(window.engineState.rpm));
  const info = await page.evaluate(() => ({
    hScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    state: document.getElementById("roState").textContent,
    order: document.getElementById("roOrder").textContent,
    worklet: window.isSecureContext && !!window.AudioWorkletNode,
    hidden: [...document.querySelectorAll("#turboSub,#scSub,#holdField")].map(e => getComputedStyle(e).display),
  }));
  const ok = errors.length === 0 && !info.hScroll && bases.length === 5 && idle > 300 && revving > idle + 500 && /Too fast/.test(drive.toast) &&
    real.driveDisabled && /Sources:/.test(real.spec) && real.picture > 0 && real.groups.length >= 5 && real.twoStrokeRpm > 2000 &&
    parseInt(drive.gear) >= 2 && drive.kmh > 60 && drive.braked < drive.kmh - 25 && parseFloat(drive.boost) > 0.3;
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}: idle ${idle} rpm, on throttle ${revving} rpm, state ${info.state}, order ${info.order}, hScroll ${info.hScroll}, worklet ${info.worklet}, bases ${bases.join("/")}, drive gear ${drive.gear} at ${drive.kmh} km/h, boost ${drive.boost}, braked to ${drive.braked} km/h, real presets ${JSON.stringify({ ...real, spec: real.spec.slice(0, 60) })}, toast "${drive.toast}" (before ${JSON.stringify(drive.before)} after ${JSON.stringify(drive.after)}), panels ${info.hidden}`);
  for (const e of errors) console.log("     error:", e);
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
