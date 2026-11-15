// Engine Sound Lab page controller: settings and controls, the audio graph, and the
// instruments (tachometer, cylinder map, firing timeline, spectrum).
import { buildConfig, settingsFromPreset, layoutInfo, firingHz } from "./engine-config.js";
import { renderScenario, encodeWav } from "./render.js";

const STORE_KEY = "engine-sound-lab:v1";
const $ = (id) => document.getElementById(id);
const fmtInt = (v) => Math.round(v).toLocaleString("en-US");

const data = await (await fetch("engine-data.json")).json();

// ---- settings ------------------------------------------------------------------
function loadStored() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY) || "null"); } catch { return null; }
}
function store() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify({ settings, mode })); } catch { /* storage blocked */ }
}
const presetById = Object.fromEntries(data.presets.map(p => [p.id, p]));
const saved = loadStored();
let settings = saved?.settings && data.layouts[saved.settings.layout]
  ? saved.settings
  : settingsFromPreset(data, presetById[data.defaults.preset]);
let mode = saved?.mode || "free";

// ---- populate selects ------------------------------------------------------------
function fillSelect(sel, items) {
  sel.innerHTML = "";
  for (const [value, label, group] of items) {
    let parent = sel;
    if (group) {
      parent = [...sel.querySelectorAll("optgroup")].find(g => g.label === group);
      if (!parent) { parent = document.createElement("optgroup"); parent.label = group; sel.append(parent); }
    }
    const o = document.createElement("option"); o.value = value; o.textContent = label; parent.append(o);
  }
}
const FAMILY = { inline: "Inline", v: "V and L", flat: "Flat (boxer)", rotary: "Rotary" };
// Presets grouped by category (engine-data.json "presetCategories"), in that order.
{
  const cats = data.presetCategories || {};
  const order = Object.keys(cats);
  const items = data.presets.map(p => [p.id, p.label, cats[p.category || "generic"] || "Other"]);
  items.sort((a, b) => order.indexOf(Object.keys(cats).find(k => cats[k] === a[2])) - order.indexOf(Object.keys(cats).find(k => cats[k] === b[2])));
  fillSelect($("preset"), [["custom", "Custom build"], ...items]);
}
fillSelect($("layout"), Object.entries(data.layouts).map(([id, L]) => [id, L.label, FAMILY[L.family]]));
fillSelect($("intake"), Object.entries(data.intakes).map(([id, v]) => [id, v.label]));
fillSelect($("muffler"), Object.entries(data.mufflers).map(([id, v]) => [id, v.label]));
fillSelect($("scType"), Object.entries(data.superchargers).map(([id, v]) => [id, v.label]));
fillSelect($("scenario"), Object.entries(data.scenarios).map(([id, v]) => [id, v.label]));
fillSelect($("vehicle"), [...Object.entries(data.drivetrain.vehicles).map(([id, v]) => [id, v.label, v.group || "Generic"]), ["none", "None: no wheels (tool, aircraft, generator)", "Generic"]]);
fillSelect($("transmission"), Object.entries(data.transmissions).map(([id, v]) => [id, v.label]));
for (const [k, v] of Object.entries({ vehicle: "car", transmission: "manual", gearCut: "helical", shiftMode: "auto", revMatch: true })) {
  if (settings[k] === undefined) settings[k] = v;
}
for (const k of Object.keys(data.defaults.mix)) if (settings.mix[k] === undefined) settings.mix[k] = data.defaults.mix[k];
// Listening positions as a segmented control, from engine-data.json.
for (const [id, v] of Object.entries(data.perspectives)) {
  const r = document.createElement("input");
  r.type = "radio"; r.name = "perspective"; r.id = `persp-${id}`; r.value = id; r.dataset.key = "perspective";
  const l = document.createElement("label"); l.htmlFor = r.id; l.textContent = v.label;
  $("perspectiveSeg").append(r, l);
}
if (!settings.perspective || !data.perspectives[settings.perspective]) settings.perspective = data.defaults.perspective;
$("scenario").value = "pull";

// ---- value formatting for the sheet ---------------------------------------------------
const words = (v, list) => list[Math.min(list.length - 1, Math.floor(v * list.length))];
const FORMAT = {
  displacement: v => +v < 1 ? `${Math.round(v * 1000)} cc` : `${(+v).toFixed(+v < 10 ? 2 : 1)} L`,
  idleRpm: v => `${fmtInt(v)}`,
  redline: v => `${fmtInt(v)}`,
  inertia: v => words((v - 0.2) / 1.8, ["very light", "light", "medium", "heavy", "very heavy"]),
  camLope: v => words(v, ["mild", "street", "sport", "lumpy", "race"]),
  pops: v => v <= 0 ? "off" : words(v, ["rare", "some", "lots", "pop-bang"]),
  boost: v => `${(+v).toFixed(2)} bar`,
  turboSize: v => words(v, ["small", "medium", "large", "huge"]),
  scRatio: v => `${(+v).toFixed(2)}:1`,
  pipeLength: v => `${(+v).toFixed(1)} m`,
};
const getKey = (k) => k.startsWith("mix.") ? settings.mix[k.slice(4)] : settings[k];
function setKey(k, v) { if (k.startsWith("mix.")) settings.mix[k.slice(4)] = v; else settings[k] = v; }

function syncControls() {
  for (const el of document.querySelectorAll("[data-key]")) {
    const v = getKey(el.dataset.key);
    if (el.type === "radio") el.checked = el.value === v;
    else if (el.type === "checkbox") el.checked = !!v;
    else el.value = v;
  }
  syncOutputs();
  $("preset").value = settings.preset && presetById[settings.preset] ? settings.preset : "custom";
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
  syncVisibility();
}
function syncOutputs() {
  for (const out of document.querySelectorAll("output[data-for]")) {
    const el = $(out.dataset.for), k = el.dataset.key;
    const f = FORMAT[k];
    out.textContent = f ? f(el.value) : `${Math.round(el.value * 100)} %`;
  }
}
function presetSpec() {
  const p = presetById[settings.preset];
  const el = $("presetSpec"); el.textContent = "";
  if (!p || !p.spec) { el.hidden = true; return; }
  el.hidden = false;
  el.append(p.spec);
  if (p.sources && p.sources.length) {
    el.append(" Sources: ");
    p.sources.forEach((u, i) => {
      const a = document.createElement("a"); a.href = u; a.target = "_blank"; a.rel = "noopener";
      try { a.textContent = new URL(u).hostname.replace(/^www\./, ""); } catch { a.textContent = `source ${i + 1}`; }
      el.append(a); if (i < p.sources.length - 1) el.append(", ");
    });
    el.append(".");
  }
}

function syncVisibility() {
  presetSpec();
  const noWheels = settings.vehicle === "none";
  $("mode-drive").disabled = noWheels;
  for (const id of ["upshift", "downshift"]) $(id).disabled = noWheels;
  const V = data.perspectives[settings.perspective];
  const note = $("perspectiveNote"); note.textContent = "";
  const tag = document.createElement("span"); tag.className = "basis"; tag.dataset.b = V.basis; tag.textContent = V.basis;
  note.append(tag, V.note);
  const asp = settings.aspiration;
  $("boostSub").hidden = asp === "na";
  $("turboSub").hidden = asp !== "turbo";
  $("scSub").hidden = asp !== "supercharger";
  const info = layoutInfo(data, settings.layout, settings);
  const routing = $("routing");
  routing.disabled = info.banks < 2;
  $("routingNote").textContent = info.banks < 2
    ? "This layout has one exhaust manifold, so routing does not apply."
    : settings.routing === "dual" ? "Each bank has its own pipe: left speaker bank A, right speaker bank B."
    : settings.routing === "xpipe" ? "The X-pipe lets each bank's pulses cross into the other pipe, smoothing the beat."
    : "Both banks merge into one pipe.";
  $("fuel-diesel").disabled = info.rotary;
  const manualBox = settings.transmission === "manual";
  $("revMatch").disabled = !manualBox;
  $("revMatchNote").textContent = manualBox ? "Blip the throttle on downshifts" : "This gearbox always blips on downshifts";
  $("transmissionNote").textContent = settings.transmission === "manual"
    ? "Upshift: clutch out, lever through the synchro, clunk, clutch in."
    : settings.transmission === "sequential"
      ? "Upshift: ignition cut and the dog ring slams across, no clutch. Downshift: automatic blip."
      : "Upshift: ignition cut and a quick clutch handover. Downshift: automatic blip.";
  $("holdField").hidden = mode !== "dyno";
  const hold = $("holdRpm");
  hold.min = Math.round(settings.idleRpm / 50) * 50;
  hold.max = settings.redline;
  $("modeHint").innerHTML = mode === "free"
    ? "Press the pedal (higher = more throttle) or hold <kbd>Space</kbd>. The engine revs freely in neutral."
    : mode === "dyno"
      ? "The dyno holds the engine at the set speed; the throttle sets the load. Sweep the speed to hear one engine across its range."
      : settings.shiftMode === "auto"
        ? "In a car. Press the throttle to pull away; it shifts up at the limiter, and off the throttle it shifts down the moment the lower gear fits under the redline. The paddles still work. Brake with the left pedal or B."
        : "In a car, shifting by hand: shift up into 1st (&uarr; or E), pull away, shift at will. Too-fast downshifts are refused. Brake with the left pedal or B.";
}

// ---- audio --------------------------------------------------------------------------
let ctx = null, node = null, analyser = null;
let snap = { rpm: 0, state: "off", boost: 0, omega: 0, gear: 0, speedKmh: 0, clutch: 1, throttle: 0, phi: 0, fired: [], limiter: false, dfco: false };
let snapAt = performance.now();
const heat = {};

async function ensureAudio() {
  if (ctx) { if (ctx.state !== "running") await ctx.resume(); return true; }
  try {
    ctx = new AudioContext({ latencyHint: "interactive" });
    analyser = ctx.createAnalyser();
    analyser.fftSize = 8192; analyser.smoothingTimeConstant = 0.6;
    const onState = (s) => {
      for (const c of s.fired) heat[c] = 1;
      snap = s; snapAt = performance.now();
      window.engineState = s; // read by tests/smoke.mjs
      updateReadouts();
    };
    if (ctx.audioWorklet) {
      await ctx.audioWorklet.addModule(new URL("engine-worklet.js", import.meta.url));
      node = new AudioWorkletNode(ctx, "engine-processor", {
        numberOfInputs: 0, outputChannelCount: [2],
        processorOptions: { config: buildConfig(data, settings), seed: 11 },
      });
      node.port.onmessage = (e) => onState(e.data);
      node.connect(analyser);
    } else {
      // No AudioWorklet (an insecure origin or an old browser): run the same DSP on the main
      // thread through a ScriptProcessorNode. Slightly more latency, same sound.
      const { EngineDSP } = await import("./engine-dsp.js");
      const dsp = new EngineDSP(ctx.sampleRate, 11);
      dsp.setConfig(buildConfig(data, settings));
      const sp = ctx.createScriptProcessor(1024, 0, 2);
      sp.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < L.length; i += 128) {
          dsp.process(L.subarray(i, i + 128), R.subarray(i, i + 128), Math.min(128, L.length - i));
          const s = dsp.snapshot();
          if (s) onState(s);
        }
      };
      node = { port: { postMessage: (m) => dsp.handle(m) } };
      sp.connect(analyser);
      ctx._keep = sp; // keep the node alive
    }
    analyser.connect(ctx.destination);
    sendControl();
    return true;
  } catch (err) {
    toast("This browser could not start the audio engine. Try a current Chrome, Edge, Firefox or Safari.");
    console.warn(err);
    ctx = null; node = null;
    return false;
  }
}

function sendConfig() {
  store();
  if (node) node.port.postMessage({ type: "config", config: buildConfig(data, settings) });
  drawStatic();
}
let pedal = 0, brakePedal = 0, keyBrake = 0;
function throttleNow() { return Math.max(pedal, +$("throttle").value, keyThrottle); }
function brakeNow() { return Math.max(brakePedal, keyBrake); }
function sendControl() {
  const thr = throttleNow(), brk = brakeNow();
  $("pedalFill").style.height = `${thr * 100}%`;
  $("pedal").setAttribute("aria-valuenow", Math.round(thr * 100));
  $("brakeFill").style.height = `${brk * 100}%`;
  $("brakePedal").setAttribute("aria-valuenow", Math.round(brk * 100));
  if (node) node.port.postMessage({ type: "control", throttle: thr, brake: brk, mode, holdRpm: +$("holdRpm").value });
}
// Braking or shifting only means something in a car: switch to Drive first.
function ensureDrive() {
  if (settings.vehicle === "none") { toast("This engine has no wheels to drive. Choose a vehicle under Transmission."); return false; }
  if (mode === "drive") return true;
  mode = "drive";
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
  syncVisibility(); sendControl(); store();
  toast("Switched to Drive.");
  return true;
}
function shift(dir) {
  if (!ensureDrive()) return;
  if (node) node.port.postMessage({ type: "shift", dir });
}
$("upshift").addEventListener("click", () => shift("up"));
$("downshift").addEventListener("click", () => shift("down"));

// ---- controls ------------------------------------------------------------------------
document.addEventListener("input", (e) => {
  const el = e.target;
  if (el.dataset && el.dataset.key) {
    let v = el.type === "range" ? +el.value : el.type === "checkbox" ? el.checked : el.value;
    setKey(el.dataset.key, v);
    const listener = ["perspective", "coldStart", "shiftMode", "revMatch"].includes(el.dataset.key);
    if (!el.dataset.key.startsWith("mix.") && !listener) settings.preset = "custom";
    // A hand-picked layout has no published firing order: use the layout's own.
    if (el.dataset.key === "layout") { delete settings.firingOrder; delete settings.banks; }
    if (el.dataset.key === "vehicle" && v === "none" && mode === "drive") {
      mode = "free"; for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode; sendControl();
    }
    if (el.dataset.key === "idleRpm" && settings.redline < v + 1500) { settings.redline = v + 1500; $("redline").value = settings.redline; }
    syncOutputs(); syncVisibility();
    $("preset").value = settings.preset === "custom" ? "custom" : settings.preset;
    sendConfig();
  }
  if (el.id === "throttle") { $("throttleOut").textContent = `${Math.round(el.value * 100)} %`; sendControl(); }
  if (el.id === "holdRpm") { $("holdRpmOut").textContent = `${fmtInt(el.value)} rpm`; sendControl(); }
});
document.addEventListener("change", (e) => {
  const el = e.target;
  if (el.name === "mode") { mode = el.value; syncVisibility(); sendControl(); store(); }
  if (el.type === "radio" && el.dataset.key) syncVisibility();
});
$("preset").addEventListener("change", (e) => {
  const p = presetById[e.target.value];
  if (!p) return;
  settings = settingsFromPreset(data, p, settings.mix, { perspective: settings.perspective, coldStart: settings.coldStart, shiftMode: settings.shiftMode, revMatch: settings.revMatch });
  if (settings.vehicle === "none" && mode === "drive") {
    mode = "free";
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
    sendControl();
  }
  syncControls(); sendConfig();
  if (mode === "dyno") { $("holdRpm").value = Math.round(settings.redline * 0.45 / 50) * 50; $("holdRpmOut").textContent = `${fmtInt($("holdRpm").value)} rpm`; sendControl(); }
});

$("ignition").addEventListener("click", async () => {
  const running = snap.state === "running" || snap.state === "cranking";
  if (!running) {
    if (!(await ensureAudio())) return;
    node.port.postMessage({ type: "config", config: buildConfig(data, settings) });
    node.port.postMessage({ type: "start" });
  } else if (node) {
    node.port.postMessage({ type: "stop" });
  }
});

// Pedal: press height sets throttle, like pressing further down.
const pedalEl = $("pedal");
function pedalFrom(e) {
  const r = pedalEl.getBoundingClientRect();
  pedal = Math.min(1, Math.max(0.15, 1 - (e.clientY - r.top) / r.height + 0.12));
  sendControl();
}
pedalEl.addEventListener("pointerdown", async (e) => {
  pedalEl.setPointerCapture(e.pointerId);
  pedalFrom(e);
  if (!ctx || snap.state === "off") { if (await ensureAudio()) node.port.postMessage({ type: "start" }); }
});
pedalEl.addEventListener("pointermove", (e) => { if (pedalEl.hasPointerCapture(e.pointerId)) pedalFrom(e); });
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) pedalEl.addEventListener(ev, () => { pedal = 0; sendControl(); });

const brakeEl = $("brakePedal");
function brakeFrom(e) {
  const r = brakeEl.getBoundingClientRect();
  brakePedal = Math.min(1, Math.max(0.15, 1 - (e.clientY - r.top) / r.height + 0.12));
  sendControl();
}
brakeEl.addEventListener("pointerdown", (e) => { brakeEl.setPointerCapture(e.pointerId); if (ensureDrive()) brakeFrom(e); });
brakeEl.addEventListener("pointermove", (e) => { if (brakeEl.hasPointerCapture(e.pointerId)) brakeFrom(e); });
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) brakeEl.addEventListener(ev, () => { brakePedal = 0; sendControl(); });

let keyThrottle = 0;
// Sliders and radio groups use the arrow keys themselves; letters still shift there.
function arrowsOwned(t) { return t && (t.type === "range" || t.type === "radio"); }
function typing(t) { return t && (t.tagName === "SELECT" || (t.tagName === "INPUT" && t.type !== "radio" && t.type !== "range")); }
window.addEventListener("keydown", async (e) => {
  if (typing(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.code === "Space") {
    e.preventDefault(); // Space is always the throttle, never "press the focused button"
    if (!e.repeat) { keyThrottle = 1; sendControl(); }
  } else if (e.key === "b" || e.key === "B") {
    if (!e.repeat && ensureDrive()) { keyBrake = 1; sendControl(); }
  } else if (e.key === "e" || e.key === "E" || (e.key === "ArrowUp" && !arrowsOwned(e.target))) {
    e.preventDefault(); if (!e.repeat) shift("up");
  } else if (e.key === "q" || e.key === "Q" || (e.key === "ArrowDown" && !arrowsOwned(e.target))) {
    e.preventDefault(); if (!e.repeat) shift("down");
  } else if (e.key === "i" || e.key === "I") { $("ignition").click(); }
  else if (["1", "2", "3"].includes(e.key) && e.target.type !== "range") {
    mode = ["free", "dyno", "drive"][+e.key - 1];
    for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === mode;
    syncVisibility(); sendControl(); store();
  }
});
window.addEventListener("keyup", (e) => {
  if (e.code === "Space" && !typing(e.target)) { e.preventDefault(); keyThrottle = 0; sendControl(); }
  if (e.key === "b" || e.key === "B") { keyBrake = 0; sendControl(); }
});
window.addEventListener("blur", () => { keyThrottle = 0; pedal = 0; keyBrake = 0; brakePedal = 0; sendControl(); });

// ---- offline render -----------------------------------------------------------------
let lastUrl = null;
$("renderBtn").addEventListener("click", () => {
  const id = $("scenario").value, sc = data.scenarios[id];
  $("renderNote").textContent = "Rendering…";
  setTimeout(() => {
    const t0 = performance.now();
    const r = renderScenario(data, settings, id, 44100);
    const blob = new Blob([encodeWav(r.L, r.R, 44100)], { type: "audio/wav" });
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(blob);
    const a = $("renderAudio"); a.src = lastUrl; a.hidden = false;
    const name = `${(settings.preset !== "custom" ? settings.preset : settings.layout)}-${id}.wav`.toLowerCase();
    const dl = $("downloadLink"); dl.href = lastUrl; dl.download = name; dl.hidden = false;
    $("renderNote").textContent = `${sc.seconds} s rendered in ${((performance.now() - t0) / 1000).toFixed(1)} s`;
  }, 30);
});

// ---- instruments --------------------------------------------------------------------
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
let COL = {};
function readColors() {
  COL = { glass: css("--glass"), glass2: css("--glass-2"), ink: css("--glass-ink"), dim: css("--glass-dim"),
    grid: css("--glass-grid"), a: css("--bank-a"), b: css("--bank-b"), red: css("--redline"), accent: css("--accent") };
}
readColors();
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readColors);

function fitCanvas(c) {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.max(1, Math.round(c.clientWidth * dpr)), h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  const g = c.getContext("2d"); g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return [g, c.clientWidth, c.clientHeight];
}

const STATE_LABEL = { off: "OFF", cranking: "CRANKING", stopping: "SHUTTING DOWN" };
function updateReadouts() {
  const info = layoutInfo(data, settings.layout, settings);
  $("roRpm").textContent = `${fmtInt(snap.rpm)} rpm`;
  $("roFire").textContent = `${firingHz(info, snap.rpm).toFixed(0)} Hz`;
  $("roThr").textContent = `${Math.round(snap.throttle * 100)} %`;
  $("roBoost").textContent = settings.aspiration === "na" ? "n/a" : `${snap.boost >= 0 ? "+" : ""}${snap.boost.toFixed(2)} bar`;
  const gearTxt = mode !== "drive" ? "N" : snap.gear ? String(snap.gear) : "N";
  $("roGear").textContent = settings.vehicle === "none" ? "none" : mode !== "drive" ? "N" : `${gearTxt}${snap.shifting ? " · shifting" : ""}`;
  const kmh = snap.speedKmh || 0;
  $("roSpeed").textContent = `${Math.round(kmh)} km/h`;
  $("roClutch").textContent = mode !== "drive" ? "engaged" : (snap.clutch ?? 1) > 0.97 ? "engaged" : (snap.clutch ?? 1) < 0.03 ? "disengaged" : "slipping";
  $("gearBig").textContent = gearTxt;
  $("speedBig").textContent = `${Math.round(kmh)} km/h · ${Math.round(kmh / 1.609)} mph`;
  if (snap.refused) toast(snap.refused);
  let s = snap.state, label = STATE_LABEL[s];
  if (s === "running") {
    if (snap.limiter) { s = "limiter"; label = "REV LIMITER"; }
    else if (snap.dfco) { s = "cut"; label = "FUEL CUT"; }
    else if (snap.throttle < 0.03 && snap.rpm < settings.idleRpm * 1.3) { s = "idle"; label = "IDLE"; }
    else label = "ON THROTTLE";
  }
  const chip = $("roState"); chip.dataset.s = s; chip.textContent = label;
  const on = snap.state === "running" || snap.state === "cranking";
  $("ignition").setAttribute("aria-pressed", String(on));
  $("ignitionText").textContent = on ? "Stop engine" : "Start engine";
}

function drawTach(g, W, H) {
  const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 6;
  const top = Math.ceil(settings.redline * 1.08 / 1000) * 1000;
  const step = top > 12000 ? 2000 : 1000;
  const a0 = Math.PI * 0.75, a1 = Math.PI * 2.25;
  const ang = (rpm) => a0 + (a1 - a0) * Math.min(rpm, top) / top;
  g.clearRect(0, 0, W, H);
  g.fillStyle = COL.glass2; g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();
  // Redline arc
  g.strokeStyle = COL.red; g.lineWidth = 7; g.beginPath(); g.arc(cx, cy, R - 12, ang(settings.redline), a1); g.stroke();
  // Ticks
  g.font = `600 ${Math.round(R * 0.11)}px "JetBrains Mono", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
  for (let r = 0; r <= top; r += step / 2) {
    const a = ang(r), major = r % step === 0;
    const r1 = R - 6, r2 = R - (major ? 22 : 14);
    g.strokeStyle = r >= settings.redline ? COL.red : COL.ink; g.lineWidth = major ? 2.5 : 1.2;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.lineTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2); g.stroke();
    if (major) { g.fillStyle = COL.ink; g.fillText(String(r / 1000), cx + Math.cos(a) * (R - 38), cy + Math.sin(a) * (R - 38)); }
  }
  g.fillStyle = COL.dim; g.font = `500 ${Math.round(R * 0.075)}px "Archivo", sans-serif`;
  g.fillText("×1000 r/min", cx, cy + R * 0.32);
  // Boost arc (forced induction only)
  if (settings.aspiration !== "na") {
    const mb = Math.max(settings.boost, 0.3), f = Math.max(0, Math.min(1, snap.boost / mb));
    g.strokeStyle = COL.grid; g.lineWidth = 5; g.beginPath(); g.arc(cx, cy, R * 0.52, Math.PI * 0.85, Math.PI * 2.15); g.stroke();
    g.strokeStyle = COL.b; g.beginPath(); g.arc(cx, cy, R * 0.52, Math.PI * 0.85, Math.PI * 0.85 + Math.PI * 1.3 * f); g.stroke();
    g.fillStyle = COL.dim; g.fillText(`boost ${snap.boost.toFixed(2)} bar`, cx, cy + R * 0.48);
  }
  // Needle, eased toward the reported speed
  const a = ang(needleRpm);
  g.strokeStyle = COL.accent; g.lineWidth = 3.5; g.lineCap = "round";
  g.beginPath(); g.moveTo(cx - Math.cos(a) * 14, cy - Math.sin(a) * 14); g.lineTo(cx + Math.cos(a) * (R - 18), cy + Math.sin(a) * (R - 18)); g.stroke();
  g.fillStyle = COL.ink; g.beginPath(); g.arc(cx, cy, 7, 0, Math.PI * 2); g.fill();
  g.font = `600 ${Math.round(R * 0.15)}px "JetBrains Mono", monospace`;
  g.fillText(fmtInt(needleRpm), cx, cy + R * 0.7);
}

// Crank angle between snapshots, advanced locally so the pistons move smoothly.
function phiNow() {
  const info = layoutInfo(data, settings.layout, settings);
  const dt = (performance.now() - snapAt) / 1000;
  return (snap.phi + snap.rpm / 60 * 360 * Math.min(dt, 0.1)) % info.cycle;
}

function drawEngine(g, W, H) {
  const info = layoutInfo(data, settings.layout, settings);
  g.clearRect(0, 0, W, H);
  const phi = phiNow();
  const banks = [0, 1].map(b => info.firing.filter(f => f[2] === b).sort((x, y) => x[0] - y[0]));
  const colorOf = (bank) => bank ? COL.b : COL.a;
  const glow = (cyl) => heat[cyl] || 0;

  if (info.family === "radial") {
    // Cylinders around the crankcase, pistons moving out and in along their own radius.
    const n = info.cylinders, cx = W / 2, cy = H / 2, R0 = Math.min(H * 0.15, W * 0.1), len = Math.min(H * 0.24, W * 0.2);
    g.fillStyle = COL.glass2; g.beginPath(); g.arc(cx, cy, R0, 0, Math.PI * 2); g.fill();
    for (const [cyl, angle] of info.firing) {
      const a = -Math.PI / 2 + (cyl - 1) * Math.PI * 2 / n;
      const ux = Math.cos(a), uy = Math.sin(a), vx = -uy, vy = ux, w = Math.min(14, len * 0.35);
      const corner = (r, s) => [cx + ux * r + vx * s, cy + uy * r + vy * s];
      g.beginPath(); for (const [r, sgn] of [[R0, -1], [R0 + len, -1], [R0 + len, 1], [R0, 1]]) g.lineTo(...corner(r, sgn * w));
      g.closePath(); g.fillStyle = glowMix(COL.a, 0.15 + 0.85 * glow(cyl), 1); g.fill();
      g.strokeStyle = glowMix(COL.a, 0.4 + 0.6 * glow(cyl)); g.lineWidth = 1.2; g.stroke();
      const travel = (1 - Math.cos((phi - angle) * Math.PI / 180)) / 2;
      const pr = R0 + len * (0.82 - 0.55 * travel);
      g.strokeStyle = COL.ink; g.lineWidth = 4; g.beginPath(); g.moveTo(...corner(pr, -w * 0.8)); g.lineTo(...corner(pr, w * 0.8)); g.stroke();
      g.fillStyle = COL.ink; g.font = `600 10px "JetBrains Mono", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(cyl), ...corner(R0 + len + 9, 0));
    }
    return;
  }
  if (info.family === "rotary") {
    const n = info.cylinders, rr = Math.min(H * 0.38, W / (n * 2.6));
    info.firing.forEach(([cyl, angle], i) => {
      const cx = W / 2 + (i - (n - 1) / 2) * rr * 2.5, cy = H / 2;
      g.fillStyle = COL.glass2; g.beginPath(); g.ellipse(cx, cy, rr * 1.1, rr * 0.92, 0, 0, Math.PI * 2); g.fill();
      g.strokeStyle = glowMix(colorOf(0), glow(cyl)); g.lineWidth = 2; g.stroke();
      // The rotor turns at one third of the eccentric shaft speed.
      const rot = ((phi - angle) / 3) * Math.PI / 180;
      g.fillStyle = glowMix(colorOf(0), 0.25 + 0.75 * glow(cyl));
      g.beginPath();
      for (let k = 0; k < 3; k++) { const a = rot + k * Math.PI * 2 / 3; g.lineTo(cx + Math.cos(a) * rr * 0.8, cy + Math.sin(a) * rr * 0.8); }
      g.closePath(); g.fill();
      g.fillStyle = COL.ink; g.font = `600 12px "JetBrains Mono", monospace`; g.textAlign = "center"; g.fillText(`R${cyl}`, cx, cy + rr * 1.1 + 14);
    });
    return;
  }

  const rows = info.banks === 2 ? banks : [banks[0]];
  const maxN = Math.max(...rows.map(r => r.length));
  const cw = Math.min(54, (W - 40) / (maxN + (info.banks === 2 ? 0.5 : 0)));
  const ch = info.banks === 2 ? H * 0.36 : H * 0.62;
  const crankY = info.banks === 2 ? H / 2 : H * 0.84;
  g.strokeStyle = COL.dim; g.lineWidth = 2;
  g.beginPath(); g.moveTo(16, crankY); g.lineTo(W - 16, crankY); g.stroke();
  rows.forEach((row, b) => {
    row.forEach(([cyl, angle], i) => {
      const off = info.banks === 2 && info.family === "v" && b === 1 ? cw * 0.5 : 0;
      const x = W / 2 + (i - (maxN - 1) / 2) * cw + off - cw * 0.42;
      const up = info.banks === 1 || b === 0;
      const y0 = up ? crankY - ch - 6 : crankY + 6;
      const w = cw * 0.84;
      // Bore
      g.fillStyle = COL.glass2; g.fillRect(x, y0, w, ch);
      g.strokeStyle = glowMix(colorOf(b), 0.35 + 0.65 * glow(cyl)); g.lineWidth = 1.5; g.strokeRect(x + 0.5, y0 + 0.5, w - 1, ch - 1);
      // Piston position: top dead centre at the firing angle and 360° after it.
      const th = (phi - angle) * Math.PI / 180;
      const travel = (1 - Math.cos(th)) / 2; // 0 at TDC, 1 at BDC
      const pis = ch * 0.22, room = ch - pis - 8;
      const py = up ? y0 + 4 + room * travel : y0 + ch - 4 - pis - room * travel;
      // Combustion glow above the piston
      const gl = glow(cyl);
      if (gl > 0.02) {
        g.fillStyle = glowMix(colorOf(b), gl, 0.85);
        if (up) g.fillRect(x + 2, y0 + 2, w - 4, py - y0 - 2); else g.fillRect(x + 2, py + pis, w - 4, y0 + ch - (py + pis) - 2);
      }
      g.fillStyle = COL.ink; g.fillRect(x + 3, py, w - 6, pis);
      g.fillStyle = COL.glass; g.font = `600 11px "JetBrains Mono", monospace`; g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText(String(cyl), x + w / 2, py + pis / 2);
    });
    if (info.banks === 2) {
      g.fillStyle = colorOf(b); g.font = `600 11px "Archivo", sans-serif`; g.textAlign = "left";
      g.fillText(b === 0 ? "BANK A" : "BANK B", 4, b === 0 ? crankY - ch / 2 : crankY + ch / 2);
    }
  });
}
function glowMix(hex, t, alpha = 1) {
  const c = parseInt(hex.slice(1), 16), base = parseInt(COL.glass2.slice(1), 16);
  const ch = (v, s) => (v >> s) & 255;
  const mix = (s) => Math.round(ch(base, s) + (ch(c, s) - ch(base, s)) * Math.max(0, Math.min(1, t)));
  return `rgba(${mix(16)},${mix(8)},${mix(0)},${alpha})`;
}

function drawTimeline(g, W, H) {
  const info = layoutInfo(data, settings.layout, settings);
  g.clearRect(0, 0, W, H);
  const x0 = 34, x1 = W - 20, cyc = info.cycle;
  const X = (a) => x0 + (x1 - x0) * a / cyc;
  const rows = info.banks;
  const rowY = (b) => rows === 1 ? H * 0.42 : H * (0.26 + 0.34 * b);
  g.font = `500 10px "JetBrains Mono", monospace`; g.textBaseline = "middle";
  // Degree grid
  for (let a = 0; a <= cyc; a += 90) {
    g.strokeStyle = COL.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(X(a), 6); g.lineTo(X(a), H - 16); g.stroke();
    g.fillStyle = COL.dim; g.textAlign = "center"; g.fillText(`${a}°`, X(a), H - 7);
  }
  for (let b = 0; b < rows; b++) {
    g.fillStyle = b ? COL.b : COL.a; g.textAlign = "left";
    g.fillText(rows === 1 ? "" : b ? "B" : "A", 6, rowY(b));
    g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(x0, rowY(b)); g.lineTo(x1, rowY(b)); g.stroke();
  }
  for (const [cyl, angle, bank] of info.firing) {
    const y = rowY(rows === 1 ? 0 : bank), x = X(angle), gl = heat[cyl] || 0;
    g.fillStyle = glowMix(bank ? COL.b : COL.a, 0.45 + 0.55 * gl);
    g.beginPath(); g.arc(x, y, 9, 0, Math.PI * 2); g.fill();
    g.fillStyle = COL.glass; g.textAlign = "center"; g.font = `600 10px "JetBrains Mono", monospace`;
    g.fillText(String(cyl), x, y + 0.5);
  }
  const p = phiNow();
  g.strokeStyle = COL.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(p), 4); g.lineTo(X(p), H - 16); g.stroke();
}

const specBuf = new Float32Array(4096), waveBuf = new Float32Array(2048);
function drawSpectrum(g, W, H) {
  g.clearRect(0, 0, W, H);
  const fLo = 20, fHi = 12000, top = H * 0.68;
  const fx = (f) => Math.log(f / fLo) / Math.log(fHi / fLo) * W;
  g.font = `500 10px "JetBrains Mono", monospace`; g.textAlign = "center"; g.textBaseline = "alphabetic";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    g.strokeStyle = COL.grid; g.beginPath(); g.moveTo(fx(f), 0); g.lineTo(fx(f), top); g.stroke();
    g.fillStyle = COL.dim; g.fillText(f >= 1000 ? `${f / 1000}k` : String(f), fx(f), top + 12);
  }
  const info = layoutInfo(data, settings.layout, settings);
  const fire = firingHz(info, snap.rpm);
  if (fire > fLo) {
    g.strokeStyle = COL.accent; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(fx(fire), 0); g.lineTo(fx(fire), top); g.stroke(); g.setLineDash([]);
    $("specNote").textContent = `firing ${fire.toFixed(0)} Hz (dashed)`;
  } else $("specNote").textContent = "";
  if (!analyser) return;
  analyser.getFloatFrequencyData(specBuf);
  const binHz = ctx.sampleRate / analyser.fftSize;
  g.beginPath(); g.moveTo(0, top);
  for (let x = 0; x <= W; x += 2) {
    const f = fLo * Math.pow(fHi / fLo, x / W), i = Math.min(specBuf.length - 1, Math.round(f / binHz));
    const db = Math.max(-110, Math.min(-10, specBuf[i]));
    g.lineTo(x, top - (db + 110) / 100 * top);
  }
  g.lineTo(W, top); g.closePath();
  g.fillStyle = glowMix(COL.a, 0.4, 0.9); g.fill();
  analyser.getFloatTimeDomainData(waveBuf);
  const wy = top + 22, wh = H - wy - 2;
  g.strokeStyle = COL.ink; g.lineWidth = 1; g.beginPath();
  for (let i = 0; i < waveBuf.length; i += 2) { const x = i / waveBuf.length * W, y = wy + wh / 2 - waveBuf[i] * wh / 2; i ? g.lineTo(x, y) : g.moveTo(x, y); }
  g.stroke();
}

// Static text that changes only with the layout.
function drawStatic() {
  const info = layoutInfo(data, settings.layout, settings);
  $("layoutName").textContent = `${info.label} · ${FORMAT.displacement(settings.displacement)}`;
  $("roOrder").textContent = info.order.join("-");
  const even = info.intervals.every(v => v === info.intervals[0]);
  let note = even
    ? `Fires every <b>${info.intervals[0]}°</b> of ${info.rotary ? "shaft" : "crank"} rotation`
    : `Uneven firing: <b>${info.intervals.join("-")}°</b>`;
  if (info.banks === 2) {
    const bi = info.bankIntervals.map(v => v.join("-"));
    const bankEven = info.bankIntervals.every(v => v.every(x => x === v[0]));
    note += `. Bank A fires at <b>${bi[0]}°</b>, bank B at <b>${bi[1]}°</b>` + (bankEven ? ", so each pipe hears an even beat." : ": each bank's own pulses are uneven, which is where the burble comes from.");
  } else note += ".";
  $("firingNotes").innerHTML = note;
}

let needleRpm = 0, lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000); lastFrame = now;
  needleRpm += (snap.rpm - needleRpm) * (1 - Math.exp(-dt / 0.04));
  for (const k in heat) heat[k] *= Math.exp(-dt / 0.07);
  const t = fitCanvas($("tach")); drawTach(...t);
  const e = fitCanvas($("engine")); drawEngine(...e);
  const l = fitCanvas($("timeline")); drawTimeline(...l);
  const s = fitCanvas($("spectrum")); drawSpectrum(...s);
  requestAnimationFrame(frame);
}

function toast(msg) {
  const t = $("toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, 6000);
}

syncControls();
drawStatic();
updateReadouts();
requestAnimationFrame(frame);
