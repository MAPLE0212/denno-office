// マイページ：パーツでキャラを作る画面
// 部品と組み立ては /parts.js（characters/_parts.js をサーバが包んだもの）。オフィスと同じ材質で 3D に出す。
// window.PartsMaker.open() で開く。保存したら "parts-saved" を window に送る（me.html がキャラ一覧を読み直す）
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/addons/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";
import makeParts from "/parts.js";

const $ = (id) => document.getElementById(id);
const myId = (location.pathname.match(/^\/me\/([\w-]+)/) || [])[1];

// ---- キャラ共通の材質（office.html と同じ） ----
const ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]), 3, 1);
ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
const toon = (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: ramp });
const rampSoft = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255, 235, 235, 235, 255, 255, 255, 255, 255]), 3, 1);
rampSoft.minFilter = rampSoft.magFilter = THREE.NearestFilter; rampSoft.needsUpdate = true;
const outlineUniforms = { thickness: { value: 0.005 } };
function outlineMat(c, boost = 1.7) {
  return new THREE.ShaderMaterial({
    uniforms: { thickness: outlineUniforms.thickness, color: { value: new THREE.Color(c).multiplyScalar(boost) } },
    vertexShader: `uniform float thickness; void main(){ vec3 p = position + normal * thickness; gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
    fragmentShader: `uniform vec3 color; void main(){ gl_FragColor = vec4(color,1.0); }`,
    side: THREE.BackSide,
  });
}
const { PARTS, PARTS_PALETTE, PARTS_DEFAULT, build } = makeParts({ THREE, toon, outlineMat, ramp, rampSoft, outlineUniforms });

// 作成画面のならび：どのタブに、どの部品と色を出すか
const GROUPS = [
  { id: "hair", label: "髪", rows: [["style", "hair", "髪型"], ["color", "hairColor", "髪の色"], ["style", "hat", "帽子"], ["color", "hatColor", "帽子の色（ベレー帽）"]] },
  { id: "face", label: "顔", rows: [["style", "brows", "まゆげ"], ["color", "eyeColor", "目の色"]] },
  { id: "top", label: "服", rows: [["style", "top", "服"], ["color", "topColor", "服の色"], ["color", "subColor", "中に着る服の色"], ["style", "acc", "小物"], ["color", "accColor", "小物の色"]] },
  { id: "bottom", label: "ズボン・くつ", rows: [["style", "bottom", "ズボン"], ["color", "bottomColor", "ズボンの色"], ["style", "shoes", "くつ"], ["color", "shoesColor", "くつの色"]] },
];

let recipe = { ...PARTS_DEFAULT };
let editing = null; // 直しているキャラ { id: "parts/p001", label }
let group = "hair";
let pose = "stand";

// ---- 3D ----
const stage = $("makerStage");
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
stage.append(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1124);
const camera = new THREE.PerspectiveCamera(30, 1, 0.02, 30);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.minDistance = 0.6; controls.maxDistance = 4;
controls.maxPolarAngle = Math.PI * 0.495;
scene.add(new THREE.HemisphereLight(0xe8ecff, 0x3a2f66, 1.6));
const key = new THREE.DirectionalLight(0xffffff, 1.6);
key.position.set(1.2, 2.5, 2);
scene.add(key);
const floor = new THREE.Mesh(new THREE.CircleGeometry(2, 48), new THREE.MeshStandardMaterial({ color: 0x0d1430, roughness: 1 }));
floor.rotation.x = -Math.PI / 2; scene.add(floor);
const grid = new THREE.GridHelper(4, 20, 0x4a6cff, 0x22337a);
grid.position.y = 0.002; grid.material.transparent = true; grid.material.opacity = 0.5; scene.add(grid);
// 座りポーズ用の椅子
const furn = new THREE.MeshStandardMaterial({ color: 0x18213d, roughness: 0.85 });
const edge = new THREE.LineBasicMaterial({ color: new THREE.Color(0x9fc0ff).multiplyScalar(1.5) });
const chair = new THREE.Group(); scene.add(chair);
[[0.24, 0.03, 0.22, 0, 0.233, -0.02], [0.24, 0.22, 0.025, 0, 0.36, -0.13]].forEach((a) => {
  const g = new THREE.BoxGeometry(a[0], a[1], a[2]), m = new THREE.Mesh(g, furn);
  m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edge)); m.position.set(a[3], a[4], a[5]); chair.add(m);
});
const post = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.22, 8), furn); post.position.set(0, 0.11, -0.02); chair.add(post);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.9, 0.5, 0.97);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let J = null;
function disposeTree(o) {
  o.traverse((n) => {
    if (n.geometry) n.geometry.dispose();
    if (n.material) (Array.isArray(n.material) ? n.material : [n.material]).forEach((m) => m.dispose());
  });
}
function rebuild() {
  if (J) { scene.remove(J.root); disposeTree(J.root); }
  J = build(recipe);
  scene.add(J.root);
}
function setView() {
  chair.visible = pose === "sit";
  if (pose === "stand") { controls.target.set(0, 0.48, 0); camera.position.set(0.55, 0.7, 1.75); }
  else { controls.target.set(0, 0.45, 0); camera.position.set(0.75, 0.85, 1.5); }
}

// ポーズ（キャラの html と同じ寸法）
function applyPose(t) {
  const r = (g, x = 0, y = 0, z = 0) => g.rotation.set(x, y, z);
  const breathe = Math.sin(t * 1.8) * 0.006;
  if (pose === "stand") {
    J.root.position.set(0, 0, 0);
    r(J.thighL); r(J.thighR); r(J.kneeL); r(J.kneeR);
    r(J.chest);
    r(J.shL, 0, 0, -0.12 + Math.sin(t * 1.6) * 0.02); r(J.shR, 0, 0, 0.12 - Math.sin(t * 1.6) * 0.02);
    r(J.elL, -0.15); r(J.elR, -0.15);
    r(J.neck); r(J.head, 0.04, Math.sin(t * 0.5) * 0.15, Math.sin(t * 0.9) * 0.04);
  } else {
    J.root.position.set(0, 0, -0.02);
    const swing = Math.sin(t * 2.2) * 0.12;
    r(J.thighL, -1.5, 0, 0.05); r(J.thighR, -1.5, 0, -0.05);
    r(J.kneeL, 1.35 + swing); r(J.kneeR, 1.35 - swing);
    r(J.chest, 0.06);
    r(J.shL, -0.25, 0, -0.08); r(J.shR, -0.25, 0, 0.08);
    r(J.elL, -0.9, 0, -0.2); r(J.elR, -0.9, 0, 0.2);
    r(J.neck, 0.02); r(J.head, -0.02, Math.sin(t * 0.45) * 0.25, Math.sin(t * 0.8) * 0.06);
  }
  J.hips.position.y = 0.295 + breathe * 0.3;
  J.chest.scale.y = 1 + breathe;
  J.braidL.rotation.set(Math.sin(t * 1.3) * 0.05, 0, -0.05); J.braidR.rotation.set(Math.sin(t * 1.3 + 1) * 0.05, 0, 0.05);
}

function resize() {
  const w = stage.clientWidth, h = stage.clientHeight;
  if (!w || !h) return;
  renderer.setSize(w, h, false); composer.setSize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);

const clock = new THREE.Clock();
let blinkT = 2, running = false;
function frame() {
  if (!running) return;
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  applyPose(t);
  blinkT -= dt;
  J.eyes.forEach((e) => { e.scale.y = blinkT < 0.12 ? 0.003 : 0.0185; });
  if (blinkT < 0) blinkT = 2 + Math.random() * 3;
  controls.update();
  composer.render();
  requestAnimationFrame(frame);
}

// マイページ用の写真：正面から上半身を撮る（立ちポーズ、まばたきなし）
function snapshot() {
  const size = 320;
  const prev = { pose, pos: camera.position.clone(), target: controls.target.clone(), aspect: camera.aspect, chair: chair.visible };
  pose = "stand"; chair.visible = false;
  applyPose(0);
  J.head.rotation.set(0.04, 0, 0);
  J.eyes.forEach((e) => { e.scale.y = 0.0185; });
  camera.position.set(0.14, 0.64, 1.6); controls.target.set(0, 0.6, 0);
  camera.aspect = 1; camera.updateProjectionMatrix(); camera.lookAt(controls.target);
  const pr = renderer.getPixelRatio(), old = new THREE.Vector2();
  renderer.getSize(old);
  renderer.setPixelRatio(1); renderer.setSize(size, size, false); composer.setSize(size, size);
  composer.render();
  const url = renderer.domElement.toDataURL("image/png");
  renderer.setPixelRatio(pr); renderer.setSize(old.x, old.y, false); composer.setSize(old.x, old.y);
  pose = prev.pose; chair.visible = prev.chair;
  camera.position.copy(prev.pos); controls.target.copy(prev.target); camera.aspect = prev.aspect; camera.updateProjectionMatrix();
  return url;
}

// ---- 選ぶところ ----
const hex = (n) => "#" + n.toString(16).padStart(6, "0");
const labelOf = (k) => (PARTS[k].find((o) => o.id === recipe[k]) || {}).label || "";

function renderTabs() {
  $("makerTabs").replaceChildren(...GROUPS.map((g) => {
    const b = document.createElement("button");
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(g.id === group));
    b.textContent = g.label;
    b.addEventListener("click", () => { group = g.id; renderTabs(); renderRows(); });
    return b;
  }));
}

function renderRows() {
  const g = GROUPS.find((x) => x.id === group);
  $("makerRows").replaceChildren(...g.rows.map(([kind, k, label]) => {
    const row = document.createElement("div");
    row.className = "mrow";
    const h = document.createElement("div");
    h.className = "mlabel";
    h.textContent = label;
    const box = document.createElement("div");
    box.className = kind === "style" ? "mopts" : "mswatches";
    if (kind === "style") {
      for (const o of PARTS[k]) {
        const b = document.createElement("button");
        b.className = "chip";
        b.textContent = o.label;
        b.setAttribute("aria-pressed", String(recipe[k] === o.id));
        b.addEventListener("click", () => set(k, o.id));
        box.append(b);
      }
    } else {
      for (const c of PARTS_PALETTE[k]) {
        const b = document.createElement("button");
        b.className = "swatch";
        b.style.background = hex(c);
        b.setAttribute("aria-label", hex(c));
        b.setAttribute("aria-pressed", String(recipe[k] === c));
        b.addEventListener("click", () => set(k, c));
        box.append(b);
      }
      const free = document.createElement("label");
      free.className = "swatch free";
      free.title = "好きな色";
      const inp = document.createElement("input");
      inp.type = "color";
      inp.value = hex(recipe[k]);
      inp.setAttribute("aria-label", `${label}（好きな色）`);
      if (!PARTS_PALETTE[k].includes(recipe[k])) { free.style.background = hex(recipe[k]); free.setAttribute("aria-pressed", "true"); }
      inp.addEventListener("input", () => set(k, parseInt(inp.value.slice(1), 16), true));
      free.append(inp);
      box.append(free);
    }
    row.append(h, box);
    return row;
  }));
}

function set(k, v, quiet = false) {
  recipe = { ...recipe, [k]: v };
  rebuild();
  if (!quiet) renderRows();
}

function random() {
  const r = (a) => a[Math.floor(Math.random() * a.length)];
  recipe = {};
  for (const k of Object.keys(PARTS)) recipe[k] = r(PARTS[k]).id;
  if (Math.random() < 0.7) recipe.hat = "none";
  for (const k of Object.keys(PARTS_PALETTE)) recipe[k] = r(PARTS_PALETTE[k]);
  rebuild(); renderRows();
}

function feature() {
  const parts = [labelOf("hair") + "の髪"];
  if (recipe.hat !== "none") parts.push(labelOf("hat"));
  parts.push(labelOf("top"), labelOf("bottom"), recipe.shoes !== "plain" ? labelOf("shoes") : "", recipe.acc !== "none" ? labelOf("acc") : "");
  return parts.filter(Boolean).join("、");
}

async function save() {
  const label = $("makerName").value.trim();
  if ([...label].length > 20) { Denno.toast("名前は20文字まで", true); return; }
  $("makerSave").disabled = true;
  try {
    const body = { by: myId, label, feature: feature(), recipe, image: snapshot() };
    const url = editing ? `/api/${editing.id}` : "/api/parts"; // editing.id は "parts/p001"
    const res = await fetch(url, { method: editing ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `エラー (${res.status})`);
    await Denno.patch(myId, { character: json.id });
    Denno.toast(editing ? "直してこの子にしました" : "できました。この子にしました");
    close();
    window.dispatchEvent(new CustomEvent("parts-saved", { detail: { id: json.id } }));
  } catch (e) {
    Denno.toast(e.message, true);
  } finally {
    $("makerSave").disabled = false;
  }
}

function open(chara) {
  editing = chara && chara.recipe ? { id: chara.id, label: chara.label } : null;
  recipe = { ...PARTS_DEFAULT, ...(chara && chara.recipe ? chara.recipe : {}) };
  $("makerTitle").textContent = editing ? `${editing.label} を直す` : "パーツでキャラを作る";
  $("makerName").value = editing ? editing.label : "";
  $("maker").hidden = false;
  group = "hair";
  renderTabs(); renderRows();
  rebuild(); setView(); resize();
  if (!running) { running = true; clock.getDelta(); requestAnimationFrame(frame); }
  $("maker").scrollIntoView({ behavior: "smooth", block: "start" });
}

function close() {
  $("maker").hidden = true;
  running = false;
}

document.querySelectorAll("[data-mpose]").forEach((b) => b.addEventListener("click", () => {
  pose = b.dataset.mpose;
  setView();
  document.querySelectorAll("[data-mpose]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
}));
$("makerRandom").addEventListener("click", random);
$("makerSave").addEventListener("click", save);
$("makerCancel").addEventListener("click", close);

window.PartsMaker = { open, close };
window.__view = { camera, controls }; // キャラの html と同じく、外から視点を動かして確かめるため
window.dispatchEvent(new Event("parts-maker-ready"));
