// Engine Sound Lab 3D engine: a sectioned engine built from the layout and driven by the
// DSP's crank angle. The crank throws come from the firing angles and the bank angles, so the
// geometry is the firing order: a cross-plane V8 grows a cross-plane crank, a 60° V6 split pins,
// a boxer opposed throws, a radial one pin for nine rods. Castings are cut open along the plane
// through the crank and each bank's bores; moving parts are drawn whole, as in a cutaway.
//
// Conventions: the crank axis is X. An angle about X is measured from +Y toward +Z (three.js
// rotation.x). A cylinder's axis sits at angle tau; its crank pin at body angle psi = tau - a,
// where a is its firing angle, so at crank angle theta = a the pin points up the bore (TDC).
import * as THREE from "./lib/three/three.module.min.js";
import { OrbitControls } from "./lib/three/OrbitControls.js";
import { RoomEnvironment } from "./lib/three/RoomEnvironment.js";

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

// Proportions in bores (bore = 1). The data carries no bore/stroke, so every engine is square.
const DIM = {
  crank: 0.5,            // crank radius, half the stroke
  rod: 1.65,             // connecting rod, centre to centre
  rodRadial: 2.6,        // a radial's rods are long so nine barrels fit round the case
  compression: 0.32,     // wrist pin to crown
  skirt: 0.62,           // crown to skirt bottom
  pitch: 1.3,            // bore spacing along the crank
  pitchFlat: 1.5,
  vStagger: 0.34,        // a V's second bank sits one rod width along the crank
  flatStagger: 0.62,     // a boxer's opposed cylinders each have their own throw
  head: 0.5, cover: 0.5,
  valveAngle: 20 * DEG, valveLift: 0.1,
  journal: 0.22, pin: 0.17, pinWidth: 0.28, web: 0.13, counterweight: 0.72,
};

// Valve events in degrees after the firing TDC: [opens, closes] within the cycle.
const VALVE_EVENTS = {
  4: { intake: [340, 590], exhaust: [130, 380] },
  2: { exhaust: [95, 255] },   // uniflow two-stroke: ports in, poppet valves out
};

// Where the camera looks from, per family (direction from the engine to the camera).
const VIEW = {
  inline: [0.28, 0.34, 0.9], v: [0.3, 0.5, 0.82], flat: [0.28, 0.86, 0.45],
  radial: [0.92, 0.22, 0.32], rotary: [0.78, 0.3, 0.55],
};

const ROTARY = { R: 1, e: 0.15, width: 0.62, pitch: 0.92, plate: 0.2 };

export function createEngine3D(container, { colors = {} } = {}) {
  const canvas = document.createElement("canvas");
  canvas.className = "engine3d-canvas";
  container.prepend(canvas);
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.localClippingEnabled = true;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.75;
  pmrem.dispose();

  scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x2a2420, 0.6));
  const key = new THREE.DirectionalLight(0xfff4e6, 2.4);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.bias = -0.0005;
  key.shadow.normalBias = 0.02;
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x9db8ff, 0.9);
  scene.add(rim);
  const flameLights = [0, 1].map(() => {
    const l = new THREE.PointLight(0xff8a2a, 0, 0, 2);
    scene.add(l);
    return l;
  });
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(80, 80), new THREE.ShadowMaterial({ opacity: 0.32 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  const camera = new THREE.PerspectiveCamera(28, 2, 0.05, 400);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = false;   // scrolling the page must not zoom: enabled once the view is clicked
  canvas.style.touchAction = "pan-y"; // a vertical swipe still scrolls the page on a phone

  let engine = null, fit = null, dirty = true, visible = true, lastGlow = 0;
  let exhaustHeat = 0;

  canvas.addEventListener("pointerdown", () => { controls.enableZoom = true; });
  canvas.addEventListener("pointerleave", () => { controls.enableZoom = false; });
  canvas.addEventListener("dblclick", () => { resetView(); });
  controls.addEventListener("change", () => { dirty = true; });

  const labelLayer = document.createElement("div");
  labelLayer.className = "engine3d-labels";
  container.append(labelLayer);

  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  const io = new IntersectionObserver((e) => { visible = e[0].isIntersecting; if (visible) dirty = true; });
  io.observe(container);

  function resize() {
    const w = Math.max(1, container.clientWidth), h = Math.max(1, container.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    if (fit) frameCamera(false);
    dirty = true;
  }

  function resetView() { if (fit) frameCamera(true); dirty = true; }

  // Place the camera so the whole engine fits, looking from the family's view direction:
  // move in or out until the box's projected corners fill the frame.
  function frameCamera(resetDirection) {
    const { center, corners, view } = fit;
    const dir = resetDirection || !controls.target.equals(center)
      ? new THREE.Vector3(...view).normalize()
      : camera.position.clone().sub(controls.target).normalize();
    controls.target.copy(center);
    let dist = fit.radius / Math.sin(camera.fov * DEG / 2);
    const p = new THREE.Vector3();
    for (let it = 0; it < 6; it++) {
      camera.position.copy(center).addScaledVector(dir, dist);
      camera.lookAt(center); camera.updateMatrixWorld(); camera.updateProjectionMatrix();
      let m = 0;
      for (const c of corners) { p.copy(c).project(camera); m = Math.max(m, Math.abs(p.x), Math.abs(p.y) * 1.08); }
      dist *= m / 0.86;   // projected size goes as 1/distance: aim the corners at 86% of the frame
    }
    camera.position.copy(center).addScaledVector(dir, dist);
    camera.near = dist / 50; camera.far = dist * 6;
    camera.updateProjectionMatrix();
    controls.minDistance = dist * 0.35; controls.maxDistance = dist * 2.2;
    controls.update();
  }

  function setLayout(info, settings) {
    if (engine) { scene.remove(engine.root); engine.dispose(); }
    labelLayer.textContent = "";
    engine = info.family === "rotary" ? buildRotary(info, colors) : buildPistonEngine(info, settings, colors);
    scene.add(engine.root);
    engine.root.updateMatrixWorld(true);
    // Fit to what is drawn: a cut casting's box would count the half that was cut away.
    // The camera is fitted to the corners of each part's own box, which follow the silhouette.
    const box = new THREE.Box3(), corners = [], pb = new THREE.Box3();
    engine.root.traverse((o) => {
      if (!o.isMesh) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      if (ms.some((m) => m.clippingPlanes?.length) || ms.every((m) => !m.visible) || o.material.blending === THREE.AdditiveBlending) return;
      pb.setFromObject(o); box.union(pb);
      for (let i = 0; i < 8; i++) corners.push(new THREE.Vector3(i & 1 ? pb.max.x : pb.min.x, i & 2 ? pb.max.y : pb.min.y, i & 4 ? pb.max.z : pb.min.z));
    });
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    ground.position.y = new THREE.Box3().setFromObject(engine.root).min.y - 0.01;
    key.position.copy(sphere.center).add(new THREE.Vector3(0.6, 1.6, 1.0).multiplyScalar(sphere.radius * 2.2));
    key.target.position.copy(sphere.center);
    const sc = key.shadow.camera, r = sphere.radius * 1.4;
    sc.left = -r; sc.right = r; sc.top = r; sc.bottom = -r; sc.near = 0.1; sc.far = sphere.radius * 6;
    sc.updateProjectionMatrix();
    rim.position.copy(sphere.center).add(new THREE.Vector3(-1, 0.6, -1.2).multiplyScalar(sphere.radius * 2));
    fit = { center: box.getCenter(new THREE.Vector3()), corners, radius: sphere.radius, view: VIEW[info.family] || VIEW.inline };
    frameCamera(true);
    engine.labels = engine.labels.map((l) => {
      const el = document.createElement("span");
      el.className = `engine3d-label${l.bank ? " b1" : ""}`;
      el.textContent = l.text;
      labelLayer.append(el);
      return { ...l, el };
    });
    dirty = true;
  }

  const v = new THREE.Vector3();
  // One animation frame: theta is the crank (or eccentric shaft) angle in degrees, glowOf(cyl)
  // the combustion glow 0..1 of each cylinder, load 0..1 drives the exhaust heat.
  function frame({ theta, glowOf, load = 0, dt = 0.016, moving = false }) {
    if (!engine || !visible) return;
    const target = Math.max(0, Math.min(1, (load - 0.2) / 0.8));
    exhaustHeat += (target - exhaustHeat) * (1 - Math.exp(-dt / (target > exhaustHeat ? 2.5 : 7)));
    let glowSum = 0;
    for (const l of engine.labels) glowSum += glowOf(l.cyl);
    const changed = controls.update();
    if (!(dirty || moving || changed || glowSum > 0.01 || lastGlow > 0.01 || Math.abs(exhaustHeat - engine.exhaustShown) > 0.004)) return;
    lastGlow = glowSum;
    engine.update(theta, glowOf, exhaustHeat);
    engine.exhaustShown = exhaustHeat;
    // The two hottest chambers each get a real light, so the flame lights the parts around it.
    const hot = engine.flamePoints().sort((p, q) => q.g - p.g);
    flameLights.forEach((l, i) => {
      const p = hot[i];
      if (p && p.g > 0.02) { l.position.copy(p.pos); l.intensity = p.g * fit.radius * 0.8; } else l.intensity = 0;
    });
    renderer.render(scene, camera);
    const w = container.clientWidth, h = container.clientHeight;
    for (const l of engine.labels) {
      v.copy(l.pos).project(camera);
      const on = v.z < 1 && Math.abs(v.x) < 1.05 && Math.abs(v.y) < 1.05;
      l.el.style.display = on ? "" : "none";
      if (on) {
        l.el.style.transform = `translate(${((v.x + 1) / 2 * w).toFixed(1)}px, ${((1 - v.y) / 2 * h).toFixed(1)}px) translate(-50%, -50%)`;
        l.el.style.setProperty("--heat", glowOf(l.cyl).toFixed(2));
      }
    }
    dirty = false;
  }

  function dispose() {
    ro.disconnect(); io.disconnect(); controls.dispose();
    if (engine) engine.dispose();
    renderer.dispose();
  }

  resize();
  return { setLayout, frame, resetView, dispose };
}

// ---- shared parts ------------------------------------------------------------------------

function makeKit(colors) {
  const geoms = [], mats = [];
  const g = (geom) => { geoms.push(geom); return geom; };
  const m = (mat) => { mats.push(mat); return mat; };
  const std = (o) => m(new THREE.MeshStandardMaterial(o));
  const ds = THREE.DoubleSide;
  const base = {
    alloy: std({ color: 0xb7bcc3, metalness: 0.55, roughness: 0.5, side: ds }),
    alloyDark: std({ color: 0x7c828b, metalness: 0.6, roughness: 0.55, side: ds }),
    liner: std({ color: 0x9da4ad, metalness: 0.85, roughness: 0.28, side: ds }),
    piston: std({ color: 0xdadde2, metalness: 0.85, roughness: 0.22, side: ds }),
    steel: std({ color: 0x9aa0a8, metalness: 0.95, roughness: 0.26 }),
    forged: std({ color: 0x6f757e, metalness: 0.92, roughness: 0.34 }),
    dark: std({ color: 0x34383e, metalness: 0.85, roughness: 0.42 }),
    valve: std({ color: 0xc9cdd3, metalness: 0.95, roughness: 0.2 }),
    ceramic: std({ color: 0xf2f0ea, metalness: 0, roughness: 0.35 }),
    mark: std({ color: 0xffffff, metalness: 0, roughness: 0.5, emissive: 0x666666 }),
    hidden: m(new THREE.MeshBasicMaterial({ visible: false })),
    cover: [colors.a || "#e0a040", colors.b || "#5b84e8"].map((c) => std({ color: c, metalness: 0.35, roughness: 0.5, side: ds })),
    header: std({ color: 0x77716b, metalness: 0.85, roughness: 0.42, emissive: 0x000000 }),
  };
  // A casting cut open by a plane: the clipped copy is cached per material and plane.
  const clipCache = new Map();
  const clip = (mat, plane) => {
    if (!plane) return mat;
    const k = `${mat.uuid}:${plane.normal.toArray().join()}:${plane.constant}`;
    if (!clipCache.has(k)) {
      const c = m(mat.clone());
      c.clippingPlanes = [plane]; c.clipShadows = true;
      clipCache.set(k, c);
    }
    return clipCache.get(k);
  };
  const flame = () => m(new THREE.MeshBasicMaterial({ color: 0xffa64d, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, side: ds }));
  const mesh = (geom, mat, shadows = true) => {
    const o = new THREE.Mesh(geom, mat);
    o.castShadow = shadows; o.receiveShadow = shadows;
    return o;
  };
  const dispose = () => { geoms.forEach((x) => x.dispose()); mats.forEach((x) => x.dispose()); };
  return { g, base, clip, flame, mesh, dispose };
}

const v2 = (x, y) => new THREE.Vector2(x, y);
function lathe(points, segs = 40) { return new THREE.LatheGeometry(points.map(([r, y]) => v2(r, y)), segs); }

// A cylinder lying along X.
function cylX(r, len, segs = 32) {
  const geom = new THREE.CylinderGeometry(r, r, len, segs);
  geom.rotateZ(Math.PI / 2);
  return geom;
}

// Extrude a 2D shape along X, centred on x = 0. Shape +Y stays +Y and shape +X becomes +Z, so a
// shape point at angle a from +Y (toward +X) lies at rotation.x angle a.
function extrudeX(shape, depth, bevel = 0) {
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth, curveSegments: 24, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 2,
  });
  geom.translate(0, 0, -depth / 2);
  geom.rotateY(-Math.PI / 2);
  return geom;
}

function circlePath(path, cx, cy, r, ccw = false) { path.absarc(cx, cy, r, 0, TAU, ccw); return path; }
function hole(cx, cy, r) { return circlePath(new THREE.Path(), cx, cy, r, true); }

// A toothed circle (gear) as polygon points.
function gearPoints(rRoot, rTip, teeth) {
  const pts = [];
  for (let j = 0; j < teeth; j++) {
    const a = j * TAU / teeth, p = TAU / teeth;
    for (const [f, r] of [[0, rRoot], [0.22, rTip], [0.5, rTip], [0.72, rRoot]]) {
      pts.push(v2(Math.sin(a + f * p) * r, Math.cos(a + f * p) * r));
    }
  }
  return pts;
}

// Convex hull (monotone chain) of points.
function hull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q); }
  for (const q of p.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}
const circlePts = (cx, cy, r, n = 24) => Array.from({ length: n }, (_, i) => v2(cx + Math.sin(i * TAU / n) * r, cy + Math.cos(i * TAU / n) * r));

// A crank web: a boss round the pin (shape +Y) and a counterweight opposite it.
function webShape(r) {
  const s = new THREE.Shape(), cw = DIM.counterweight, boss = DIM.pin + 0.1, span = 72 * DEG;
  for (let i = 0; i <= 18; i++) {
    const t = -span + 2 * span * i / 18;
    const x = Math.sin(t) * cw, y = -Math.cos(t) * cw;
    i ? s.lineTo(x, y) : s.moveTo(x, y);
  }
  s.lineTo(boss, r);
  s.absarc(0, r, boss, 0, Math.PI, false);
  s.closePath();
  return s;
}

// A connecting rod along shape +Y: big end at 0, small end at L.
function rodShape(L, bigEnd = true) {
  const s = new THREE.Shape(), bigR = DIM.pin + 0.1, smallR = 0.15;
  if (bigEnd) s.absarc(0, 0, bigR, 130 * DEG, 50 * DEG, false);
  else { s.moveTo(-0.11, 0.25); s.lineTo(0.11, 0.25); }
  s.lineTo(Math.cos(-25 * DEG) * smallR, L + Math.sin(-25 * DEG) * smallR);
  s.absarc(0, L, smallR, -25 * DEG, 205 * DEG, false);
  s.closePath();
  if (bigEnd) s.holes.push(hole(0, 0, DIM.pin));
  s.holes.push(hole(0, L, 0.075));
  return s;
}

function camLobeShape(base, lift) {
  const s = new THREE.Shape(), n = 64;
  for (let i = 0; i < n; i++) {
    const a = i * TAU / n, d = Math.abs(((a + Math.PI) % TAU) - Math.PI); // angle from the nose
    const r = base + (d < 62 * DEG ? lift * Math.cos(d / 62 * Math.PI / 2) ** 2 : 0);
    const x = Math.sin(a) * r, y = Math.cos(a) * r;
    i ? s.lineTo(x, y) : s.moveTo(x, y);
  }
  s.closePath();
  return s;
}

// Valve lift (0..1) at cycle phase c (degrees after the cylinder's firing TDC).
function liftAt(c, [open, close], cycle) {
  let d = ((c - open) % cycle + cycle) % cycle;
  const dur = close - open;
  return d < dur ? Math.sin(Math.PI * d / dur) ** 2 : 0;
}

// The plane through the crank axis that contains a cylinder axis at angle tau, oriented to cut
// away the half toward the viewer. Returns [three.js clipping plane, side toward the viewer].
function cutPlane(tau, view) {
  const n = new THREE.Vector3(0, -Math.sin(tau), Math.cos(tau));
  const toward = Math.sign(n.y * view[1] + n.z * view[2]) || 1;
  return [new THREE.Plane(n.multiplyScalar(-toward), 0), toward];
}

// ---- piston engines: inline, V, flat, radial ------------------------------------------

function buildPistonEngine(info, settings, colors) {
  const kit = makeKit(colors), { g, base, clip, mesh } = kit;
  const fam = info.family, radial = fam === "radial", n = info.cylinders;
  const view = VIEW[fam] || VIEW.inline;
  const r = DIM.crank, L = radial ? DIM.rodRadial : DIM.rod, ch = DIM.compression;
  const D = r + L + ch + 0.02;                     // deck height above the crank axis
  const linerBottom = radial ? 1.62 : L - r + ch - DIM.skirt + 0.1;
  const strokes = info.twoStroke ? 2 : 4, cycle = info.cycle;
  const events = info.valves ? VALVE_EVENTS[strokes] : {};
  const camRatio = 360 / cycle;
  const V = (info.bankAngle || 0) * DEG;
  const tauOf = (cyl, bank) => radial ? (cyl - 1) * TAU / n : fam === "flat" ? (bank ? 90 : -90) * DEG : fam === "v" ? (bank ? V / 2 : -V / 2) : 0;
  const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

  const cyls = info.firing.map(([cyl, a, bank]) => {
    const tau = tauOf(cyl, bank);
    return { cyl, a, bank: radial ? 0 : bank, tau, psi: wrap(tau - a * DEG) };
  });

  // Throws along the crank: one per cylinder inline, a pair per throw in a V or boxer (sharing a
  // pin when their pin angles agree), all on one pin in a radial.
  const slots = [];
  if (radial) slots.push(cyls);
  else if (info.banks === 1) cyls.slice().sort((p, q) => p.cyl - q.cyl).forEach((c) => slots.push([c]));
  else {
    const A = cyls.filter((c) => c.bank === 0).sort((p, q) => p.cyl - q.cyl);
    const B = cyls.filter((c) => c.bank === 1).sort((p, q) => p.cyl - q.cyl);
    for (const c of A) {
      let j = B.findIndex((b) => Math.abs(wrap(b.psi - c.psi)) < 0.02);
      if (j < 0) j = 0;
      slots.push(B.length ? [c, B.splice(j, 1)[0]] : [c]);
    }
    B.forEach((b) => slots.push([b]));
  }
  const pitch = fam === "flat" ? DIM.pitchFlat : DIM.pitch;
  const stagger = fam === "flat" ? DIM.flatStagger : DIM.vStagger;
  slots.forEach((slot, k) => {
    const xc = (k - (slots.length - 1) / 2) * pitch;
    slot.forEach((c, i) => { c.x = radial ? 0 : xc + (slot.length > 1 ? (i - 0.5) * stagger : 0); });
  });
  const xs = cyls.map((c) => c.x), xMin = Math.min(...xs), xMax = Math.max(...xs);

  const root = new THREE.Group();
  const crank = new THREE.Group();
  root.add(crank);

  // ---- crankshaft
  const webGeom = g(extrudeX(webShape(r), DIM.web, 0.015));
  const pinGeom = g(cylX(DIM.pin, DIM.pinWidth + 0.02));
  const journal = (x0, x1) => {
    if (x1 - x0 < 0.01) return;
    const j = mesh(g(cylX(DIM.journal, x1 - x0)), base.steel);
    j.position.x = (x0 + x1) / 2; crank.add(j);
  };
  let prevEnd = (radial ? -0.3 : xMin - 0.5) - 0.55;
  const crankStart = prevEnd;
  for (const slot of slots) {
    const lo = Math.min(...slot.map((c) => c.x)) - DIM.pinWidth / 2, hi = Math.max(...slot.map((c) => c.x)) + DIM.pinWidth / 2;
    const w0 = lo - DIM.web / 2, w1 = hi + DIM.web / 2;
    journal(prevEnd, w0 - DIM.web / 2);
    for (const [x, c] of [[w0, slot[0]], [w1, slot[slot.length - 1]]]) {
      const w = mesh(webGeom, base.forged);
      w.position.x = x; w.rotation.x = c.psi; crank.add(w);
    }
    const pins = radial ? [slot[0]] : slot;
    pins.forEach((c, i) => {
      const p = mesh(pinGeom, base.steel);
      p.position.set(radial ? 0 : c.x, Math.cos(c.psi) * r, Math.sin(c.psi) * r);
      crank.add(p);
      const nxt = pins[i + 1];
      if (nxt && Math.abs(wrap(nxt.psi - c.psi)) > 0.02) {
        // Split pins: a thin flying web joins the two offset pins.
        const pts = [...circlePts(Math.sin(c.psi) * r, Math.cos(c.psi) * r, DIM.pin + 0.07), ...circlePts(Math.sin(nxt.psi) * r, Math.cos(nxt.psi) * r, DIM.pin + 0.07)];
        const fw = mesh(g(extrudeX(new THREE.Shape(hull(pts)), 0.06)), base.forged);
        fw.position.x = (c.x + nxt.x) / 2; crank.add(fw);
      }
    });
    prevEnd = w1 + DIM.web / 2;
  }
  const crankEnd = (radial ? 0.3 : xMax + 0.5) + 0.55;
  journal(prevEnd, crankEnd);
  if (!radial) {
    // Flywheel with its ring gear at the back, damper pulley at the front.
    const fwShape = new THREE.Shape(gearPoints(1.22, 1.28, 96));
    for (let i = 0; i < 6; i++) fwShape.holes.push(hole(Math.sin(i * TAU / 6) * 0.45, Math.cos(i * TAU / 6) * 0.45, 0.05));
    const fw = mesh(g(extrudeX(fwShape, 0.14)), base.dark);
    fw.position.x = crankStart - 0.08; crank.add(fw);
    const mark = mesh(g(new THREE.BoxGeometry(0.02, 0.16, 0.05)), base.mark, false);
    mark.position.set(crankStart - 0.16, 1.05, 0); crank.add(mark);
    const pulley = mesh(g(lathe([[0, -0.11], [0.52, -0.11], [0.52, -0.07], [0.47, -0.05], [0.52, -0.03], [0.52, 0.01], [0.47, 0.03], [0.52, 0.05], [0.52, 0.11], [0, 0.11]], 48)), base.dark);
    pulley.geometry.rotateZ(Math.PI / 2);
    pulley.position.x = crankEnd + 0.1; crank.add(pulley);
    const pmark = mesh(g(new THREE.BoxGeometry(0.02, 0.1, 0.04)), base.mark, false);
    pmark.position.set(crankEnd + 0.22, 0.45, 0); crank.add(pmark);
  } else {
    // A radial's master rod hub rides the single pin; the articulated rods hang off it.
    const hub = mesh(g(cylX(0.36, 0.3)), base.forged);
    root.add(hub);
    root.userData.hub = hub;
  }

  // ---- crankcase
  const casePlane = radial ? new THREE.Plane(new THREE.Vector3(-1, 0, 0), 0) : (() => {
    const n = new THREE.Vector3(0, view[1], view[2]).normalize();
    return new THREE.Plane(n.negate(), 0);
  })();
  const len = xMax - xMin + 1.4;
  if (radial) {
    const cc = mesh(g(lathe([[0.3, -0.75], [1.7, -0.75], [1.75, -0.6], [1.75, 0.6], [1.7, 0.75], [0.3, 0.75]], 72)), clip(base.alloyDark, casePlane));
    cc.geometry.rotateZ(Math.PI / 2); root.add(cc);
    const rear = mesh(g(lathe([[0, -0.4], [1.15, -0.4], [1.15, 0.4], [0, 0.4]], 64)), base.alloyDark);
    rear.geometry.rotateZ(Math.PI / 2); rear.position.x = -1.15; root.add(rear);
  } else {
    const flat = fam === "flat";
    const hy = flat ? 0.8 : 1.0, hz = flat ? 1.0 : fam === "v" ? 1.15 : 0.9;
    const box = g(new THREE.BoxGeometry(len, flat ? 2 * hy : hy + 0.75, 2 * hz));
    box.translate(0, flat ? 0 : (0.75 - hy) / 2, 0);
    root.add(mesh(box, clip(base.alloy, casePlane)));
    const pan = g(new THREE.BoxGeometry(len - 0.3, 0.55, 2 * hz - 0.35));
    pan.translate(0, -hy - 0.275, 0);
    root.add(mesh(pan, clip(base.alloyDark, casePlane)));
  }

  // ---- shared geometry of a cylinder
  const linerGeom = g(radial ? lathe(finProfile(0.5, 0.56, 0.8, linerBottom, D, 0.1)) : lathe([[0.5, linerBottom], [0.58, linerBottom], [0.58, D], [0.5, D], [0.5, linerBottom]], 48));
  const pistonGeom = g(lathe([[0, ch], [0.47, ch], [0.485, ch - 0.025], [0.485, ch - DIM.skirt], [0.455, ch - DIM.skirt], [0.455, ch - 0.16], [0, ch - 0.16]], 40));
  const ringGeom = g(new THREE.TorusGeometry(0.487, 0.011, 6, 40)).rotateX(Math.PI / 2);
  const wristGeom = g(cylX(0.1, 0.78, 20));
  const rodGeom = g(extrudeX(rodShape(L, !radial), 0.22, 0.015));
  const flameGeom = g(new THREE.CylinderGeometry(0.47, 0.47, 1, 32, 1, true)).translate(0, 0.5, 0);
  const valveGeom = (headR) => g(lathe([[0, 0], [headR, 0], [headR + 0.008, 0.012], [0.05, 0.07], [0.03, 0.11], [0.028, 0.46], [0.075, 0.46], [0.075, 0.56], [0, 0.56]], 24));
  const valveGeoms = { intake: valveGeom(0.165), exhaust: valveGeom(0.145) };
  const lobeGeom = g(extrudeX(camLobeShape(0.12, DIM.valveLift), 0.11));
  const plugGeom = g(lathe([[0, 0], [0.05, 0], [0.05, 0.2], [0.085, 0.2], [0.085, 0.36], [0.06, 0.36], [0.06, 0.62], [0.03, 0.66], [0, 0.66]], 6));
  const plugTop = g(lathe([[0, 0.36], [0.062, 0.36], [0.062, 0.6], [0.035, 0.64], [0, 0.64]], 24));
  const va = radial ? 26 * DEG : DIM.valveAngle;
  const camDist = 0.68;

  // Banks (one per bank; one per cylinder for a radial): castings, cams and headers.
  const bankDefs = new Map();
  for (const c of cyls) {
    const key = radial ? `r${c.cyl}` : `b${c.bank}`;
    if (!bankDefs.has(key)) {
      const [plane, toward] = radial ? [casePlane, 1] : cutPlane(c.tau, view);
      const frame = new THREE.Group(); frame.rotation.x = c.tau; root.add(frame);
      // Exhaust leaves on the far side, so the cut faces the viewer and the headers stay visible.
      bankDefs.set(key, { key, tau: c.tau, bank: c.bank, plane, exSide: radial ? 1 : -toward, frame, cyls: [] });
    }
    bankDefs.get(key).cyls.push(c);
  }

  const headers = [];
  for (const b of bankDefs.values()) {
    const { frame, plane, exSide } = b;
    const bx = b.cyls.map((c) => c.x), b0 = Math.min(...bx) - pitch / 2 + 0.05, b1 = Math.max(...bx) + pitch / 2 - 0.05;
    const blen = radial ? 1.2 : b1 - b0, bxc = radial ? 0 : (b0 + b1) / 2;
    const cover = base.cover[b.bank];
    if (radial) {
      // Finned barrel and head of an air-cooled radial cylinder.
      const headG = g(lathe([...finProfile(0.5, 0.62, 0.8, D, D + 0.62, 0.11), [0.3, D + 0.7], [0, D + 0.7]]));
      frame.add(mesh(headG, clip(base.alloyDark, plane)));
      const rocker = mesh(g(new THREE.BoxGeometry(0.34, 0.26, 1.1)), clip(cover, plane));
      rocker.position.set(0, D + 0.82, 0); frame.add(rocker);
    } else {
      const walls = (y0, y1, hz, mat, top) => {
        const geom = g(new THREE.BoxGeometry(blen, y1 - y0, 2 * hz));
        geom.translate(bxc, (y0 + y1) / 2, 0);
        const none = base.hidden, cm = clip(mat, plane);
        frame.add(mesh(geom, [cm, cm, top ? cm : none, none, cm, cm]));
      };
      walls(0.55, D, 0.8, base.alloy, false);
      walls(D, D + DIM.head, 0.85, base.alloy, false);
      // A cover whose lid faces the viewer goes open-topped, or the lid hides that bank's cams.
      const facing = Math.cos(b.tau) * view[1] + Math.sin(b.tau) * view[2];
      if (info.valves) walls(D + DIM.head, D + DIM.head + DIM.cover, 0.82, cover, facing < 0.6 * Math.hypot(view[1], view[2]));
    }

    // Camshafts: one per valve side, turning at half crank speed in a four-stroke.
    b.cams = [];
    if (!radial) {
      for (const [kind, ev] of Object.entries(events)) {
        const side = kind === "exhaust" ? exSide : -exSide;
        const cam = new THREE.Group();
        cam.position.set(0, D + 0.05 + camDist * Math.cos(va), side * (0.2 + camDist * Math.sin(va)));
        frame.add(cam);
        const shaft = mesh(g(cylX(0.07, blen - 0.1, 16)), base.steel);
        shaft.position.x = bxc; cam.add(shaft);
        const towardValve = side * va + Math.PI;
        const peak = (ev[0] + ev[1]) / 2;
        for (const c of b.cyls) for (const dx of [-0.2, 0.2]) {
          const lobe = mesh(lobeGeom, base.steel);
          lobe.position.x = c.x + dx;
          lobe.rotation.x = towardValve - (c.a + peak) * camRatio * DEG;
          cam.add(lobe);
        }
        b.cams.push(cam);
      }
    }

    // Exhaust headers: one primary per cylinder into a collector at the back of the bank.
    const s = exSide, xColl = radial ? 0 : b1 + 0.55;
    for (const c of b.cyls) {
      const pts = radial
        ? [[0, D + 0.3, s * 0.62], [0, D + 0.28, s * 0.95], [-0.5, D - 0.1, s * 1.05], [-1.1, D - 0.6, s * 1.0]]
        : [[c.x, D + 0.28, s * 0.84], [c.x, D + 0.22, s * 1.2], [c.x + (xColl - c.x) * 0.3, D - 0.55, s * 1.42], [xColl, 0.55, s * 1.42]];
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
      frame.add(mesh(g(new THREE.TubeGeometry(curve, 32, 0.105, 12)), base.header));
    }
    if (!radial) {
      const coll = new THREE.CatmullRomCurve3([[xColl, 0.6, s * 1.42], [xColl + 0.25, 0.15, s * 1.42], [xColl + 0.45, -0.6, s * 1.3]].map((p) => new THREE.Vector3(...p)));
      frame.add(mesh(g(new THREE.TubeGeometry(coll, 16, 0.17, 14)), base.header));
    }
    headers.push(b);
  }

  // Per cylinder: liner, piston, rod, valves, plug and flame, in a frame along the bore.
  const labels = [];
  for (const c of cyls) {
    const b = bankDefs.get(radial ? `r${c.cyl}` : `b${c.bank}`);
    const cg = new THREE.Group(); cg.position.x = c.x; cg.rotation.x = c.tau; root.add(cg);
    c.frame = cg;
    cg.add(mesh(linerGeom, clip(base.liner, b.plane)));
    const piston = new THREE.Group();
    piston.add(mesh(pistonGeom, base.piston));
    for (const y of [ch - 0.06, ch - 0.11]) { const ring = mesh(ringGeom, base.dark, false); ring.position.y = y; piston.add(ring); }
    piston.add(mesh(wristGeom, base.forged));
    cg.add(piston); c.piston = piston;
    const rod = mesh(rodGeom, base.forged); cg.add(rod); c.rod = rod;
    const flame = mesh(flameGeom, kit.flame(), false); flame.renderOrder = 2; cg.add(flame); c.flame = flame;
    c.valves = [];
    for (const [kind, ev] of Object.entries(events)) {
      const side = kind === "exhaust" ? b.exSide : -b.exSide;
      for (const dx of radial ? [0] : [-0.2, 0.2]) {
        const vg = new THREE.Group();
        vg.position.set(dx, D + 0.05, side * (radial ? 0.22 : 0.2));
        vg.rotation.x = side * va;
        const valve = mesh(valveGeoms[kind], base.valve);
        vg.add(valve); cg.add(vg);
        c.valves.push({ valve, ev });
      }
    }
    if (settings.fuel !== "diesel") {
      const plug = new THREE.Group();
      plug.add(mesh(plugGeom, base.steel), mesh(plugTop, base.ceramic));
      plug.position.y = D + (radial ? 0.35 : 0.3);
      if (radial) { plug.rotation.x = 0.55; plug.position.z = -0.2; }
      cg.add(plug);
    }
    labels.push({ cyl: c.cyl, bank: c.bank, text: String(c.cyl), local: new THREE.Vector3(0, D + (radial ? 1.25 : info.valves ? DIM.head + DIM.cover + 0.3 : DIM.head + 0.35), 0), frame: cg });
  }
  root.updateMatrixWorld(true);
  for (const l of labels) l.pos = l.frame.localToWorld(l.local.clone());

  const hub = root.userData.hub;
  const flamePos = new THREE.Vector3();
  let glowCache = [];
  function update(theta, glowOf, heat) {
    crank.rotation.x = theta * DEG;
    if (hub) hub.position.set(0, Math.cos(cyls[0].psi + theta * DEG) * r, Math.sin(cyls[0].psi + theta * DEG) * r);
    glowCache = [];
    for (const c of cyls) {
      const phi = (theta - c.a) * DEG;
      const sy = r * Math.cos(phi), sz = r * Math.sin(phi);
      const yp = sy + Math.sqrt(L * L - sz * sz);
      c.piston.position.y = yp;
      c.rod.position.set(0, sy, sz);
      c.rod.rotation.x = Math.atan2(-sz, yp - sy);
      const phase = ((theta - c.a) % cycle + cycle) % cycle;
      for (const { valve, ev } of c.valves) valve.position.y = -DIM.valveLift * liftAt(phase, ev, cycle);
      const gl = glowOf(c.cyl), crown = yp + ch;
      c.flame.material.opacity = Math.min(1, gl) * 0.85;
      c.flame.material.color.setRGB(1, 0.45 + 0.35 * gl, 0.15 + 0.3 * gl * gl);
      c.flame.position.y = crown;
      c.flame.scale.y = Math.max(0.01, D + 0.06 - crown);
      c.flame.visible = gl > 0.01;
      if (gl > 0.02) glowCache.push({ g: gl, pos: c.frame.localToWorld(flamePos.set(0, (crown + D) / 2, 0).clone()) });
    }
    for (const b of headers) for (const cam of b.cams) cam.rotation.x = theta * camRatio * DEG;
    setHeaderHeat(base.header, heat);
  }

  return {
    root, labels, exhaustShown: -1, update,
    flamePoints: () => glowCache,
    dispose: kit.dispose,
  };
}

// A lathe profile of an air-cooled barrel: fins every `step` between y0 and y1.
function finProfile(inner, root, tip, y0, y1, step) {
  const pts = [[inner, y0], [root, y0]];
  for (let y = y0 + step * 0.35; y < y1 - step * 0.4; y += step) {
    pts.push([root, y], [tip, y + 0.012], [tip, y + 0.03], [root, y + 0.042]);
  }
  pts.push([root, y1], [inner, y1], [inner, y0]);
  return pts;
}

// Primaries go dull red, then orange, as sustained load heats them.
function setHeaderHeat(mat, heat) {
  const h = Math.max(0, heat);
  mat.emissive.setRGB(0.75 * h ** 1.8, 0.12 * h ** 2.8, 0.02 * h ** 3);
}

// ---- Wankel rotary -------------------------------------------------------------------------

function buildRotary(info, colors) {
  const kit = makeKit(colors), { g, base, mesh, clip } = kit;
  const { R, e, width, pitch, plate } = ROTARY;
  const view = VIEW.rotary;
  const cut = new THREE.Plane(new THREE.Vector3(0, view[1], view[2]).normalize().negate(), 0);
  const housingMat = clip(base.alloy, cut), plateMat = clip(base.alloyDark, cut);
  const root = new THREE.Group();
  const rotors = info.firing.map(([cyl, a]) => ({ cyl, a })).sort((p, q) => p.cyl - q.cyl);
  const n = rotors.length;
  // Rotor 1 at the front (+X), toward the viewer; the front side plate is cut away.
  rotors.forEach((rt, i) => { rt.x = ((n - 1) / 2 - i) * pitch; });
  const xFront = rotors[0].x + width / 2 + 0.04, xBack = rotors[n - 1].x - width / 2 - 0.04;

  // The housing's bore is the epitrochoid the apexes trace.
  const trochoid = (a, k = 0) => v2((e * Math.sin(3 * a) + (R + k) * Math.sin(a)), (e * Math.cos(3 * a) + (R + k) * Math.cos(a)));
  const outline = (s, hy, hz, rad) => {
    s.moveTo(-hz + rad, -hy); s.lineTo(hz - rad, -hy); s.quadraticCurveTo(hz, -hy, hz, -hy + rad);
    s.lineTo(hz, hy - rad); s.quadraticCurveTo(hz, hy, hz - rad, hy); s.lineTo(-hz + rad, hy);
    s.quadraticCurveTo(-hz, hy, -hz, hy - rad); s.lineTo(-hz, -hy + rad); s.quadraticCurveTo(-hz, -hy, -hz + rad, -hy);
    return s;
  };
  const housingShape = outline(new THREE.Shape(), 1.55, 1.3, 0.4);
  const bore = new THREE.Path(Array.from({ length: 144 }, (_, i) => trochoid(i * TAU / 144, 0.02)));
  bore.closePath();
  housingShape.holes.push(bore);
  for (const [zz, yy] of [[1.05, 1.15], [-1.05, 1.15], [1.05, -1.15], [-1.05, -1.15], [1.12, 0], [-1.12, 0]]) housingShape.holes.push(hole(zz, yy, 0.07));
  const housingGeom = g(extrudeX(housingShape, width + 0.06));
  const plateShape = outline(new THREE.Shape(), 1.55, 1.3, 0.4);
  plateShape.holes.push(hole(0, 0, 0.2));
  const plateGeom = g(extrudeX(plateShape, plate));

  // Rotor: three convex flanks; the internal gear rides on the rear face.
  const rotorShape = new THREE.Shape();
  for (let k = 0; k < 3; k++) {
    const a0 = k * TAU / 3, a1 = (k + 1) * TAU / 3, am = (a0 + a1) / 2, cr = 0.66 * R;
    const p0 = v2(Math.sin(a0) * R, Math.cos(a0) * R), p1 = v2(Math.sin(a1) * R, Math.cos(a1) * R);
    if (!k) rotorShape.moveTo(p0.x, p0.y);
    rotorShape.quadraticCurveTo(Math.sin(am) * cr, Math.cos(am) * cr, p1.x, p1.y);
  }
  rotorShape.holes.push(hole(0, 0, 0.4));
  const rotorGeom = g(extrudeX(rotorShape, width, 0.01));
  const ringShape = new THREE.Shape(); circlePath(ringShape, 0, 0, 0.56);
  const ringHole = new THREE.Path(gearPoints(0.45, 0.415, 30)); ringHole.closePath();
  ringShape.holes.push(ringHole);
  const ringGeom = g(extrudeX(ringShape, 0.08));
  const statShape = new THREE.Shape(gearPoints(0.28, 0.31, 20)); statShape.holes.push(hole(0, 0, 0.19));
  const statGeom = g(extrudeX(statShape, 0.08));
  const sealGeom = g(new THREE.BoxGeometry(width, 0.05, 0.05));
  const lobeGeom = g(cylX(0.38, width - 0.04, 40));
  const plugGeom = g(lathe([[0, 0], [0.05, 0], [0.05, 0.25], [0.085, 0.25], [0.085, 0.42], [0.06, 0.42], [0.06, 0.66], [0, 0.7]], 6)).rotateX(-Math.PI / 2);
  const flameGeom = g(new THREE.SphereGeometry(1, 24, 12));

  const shaft = new THREE.Group(); root.add(shaft);
  const sh = mesh(g(cylX(0.19, xFront - xBack + 1.4)), base.steel);
  sh.position.x = (xFront + xBack) / 2 - 0.1; shaft.add(sh);
  const fwShape = new THREE.Shape(gearPoints(1.3, 1.36, 100));
  for (let i = 0; i < 6; i++) fwShape.holes.push(hole(Math.sin(i * TAU / 6) * 0.45, Math.cos(i * TAU / 6) * 0.45, 0.05));
  const fw = mesh(g(extrudeX(fwShape, 0.14)), base.dark); fw.position.x = xBack - plate - 0.45; shaft.add(fw);
  const mark = mesh(g(new THREE.BoxGeometry(0.02, 0.16, 0.05)), base.mark, false); mark.position.set(xBack - plate - 0.53, 1.12, 0); shaft.add(mark);

  // The rear side plate, then a housing per rotor with an intermediate plate behind it.
  const rearPlate = mesh(plateGeom, plateMat); rearPlate.position.x = xBack - plate / 2; root.add(rearPlate);
  const labels = [];
  for (const [i, rt] of rotors.entries()) {
    const h = mesh(housingGeom, housingMat); h.position.x = rt.x; root.add(h);
    if (i < n - 1) { const p = mesh(plateGeom, plateMat); p.position.x = rt.x - width / 2 - plate / 2 - 0.03; root.add(p); }
    const stat = mesh(statGeom, base.steel); stat.position.x = rt.x - width / 2 + 0.04; root.add(stat);
    // The shaft's eccentric lobe for this rotor; TDC at the plugs when the lobe points to -Z.
    rt.beta = (-rt.a - 90) * DEG;
    const lobe = mesh(lobeGeom, base.steel);
    lobe.position.set(rt.x, Math.cos(rt.beta) * e, Math.sin(rt.beta) * e); shaft.add(lobe);
    const rotor = new THREE.Group();
    rotor.add(mesh(rotorGeom, base.forged));
    const ring = mesh(ringGeom, base.steel); ring.position.x = -width / 2 + 0.04; rotor.add(ring);
    for (let k = 0; k < 3; k++) {
      const seal = mesh(sealGeom, base.dark, false);
      seal.position.set(0, Math.cos(k * TAU / 3) * (R - 0.01), Math.sin(k * TAU / 3) * (R - 0.01));
      rotor.add(seal);
    }
    rotor.position.x = rt.x; root.add(rotor); rt.rotor = rotor;
    for (const dy of [-0.2, 0.2]) {
      const p = mesh(plugGeom, base.steel); p.position.set(rt.x, dy, -(R - e) - 0.08); root.add(p);
    }
    const fl = mesh(flameGeom, kit.flame(), false); fl.renderOrder = 2;
    fl.position.set(rt.x, 0, -(R - e) + 0.08); fl.scale.set(width * 0.42, 0.55, 0.09); root.add(fl); rt.flame = fl;
    // Peripheral exhaust port on the far side of the housing.
    const curve = new THREE.CatmullRomCurve3([[rt.x, -0.55, 0.95], [rt.x, -0.6, 1.5], [rt.x - 0.2, -1.2, 1.7], [xBack - 0.8, -1.5, 1.7]].map((p) => new THREE.Vector3(...p)));
    root.add(mesh(g(new THREE.TubeGeometry(curve, 32, 0.14, 12)), base.header));
    labels.push({ cyl: rt.cyl, bank: 0, text: `R${rt.cyl}`, pos: new THREE.Vector3(rt.x, 1.85, 0) });
  }

  const fpos = new THREE.Vector3();
  let glowCache = [];
  function update(theta, glowOf, heat) {
    shaft.rotation.x = theta * DEG;
    glowCache = [];
    for (const rt of rotors) {
      const th = theta * DEG + rt.beta;   // this rotor's eccentric angle
      rt.rotor.position.set(rt.x, Math.cos(th) * e, Math.sin(th) * e);
      rt.rotor.rotation.x = th / 3;       // the rotor turns at a third of shaft speed
      const gl = glowOf(rt.cyl);
      rt.flame.material.opacity = Math.min(1, gl) * 0.9;
      rt.flame.material.color.setRGB(1, 0.45 + 0.35 * gl, 0.15 + 0.3 * gl * gl);
      rt.flame.visible = gl > 0.01;
      if (gl > 0.02) glowCache.push({ g: gl, pos: fpos.copy(rt.flame.position).clone() });
    }
    setHeaderHeat(base.header, heat);
  }
  return { root, labels, exhaustShown: -1, update, flamePoints: () => glowCache, dispose: kit.dispose };
}
