// キャラが電脳オフィスで動くかを確かめる（Pull Request のときは GitHub Actions でも走る）
//
// usage: node tools/check_chara.mjs                      … characters/ の全員
//        node tools/check_chara.mjs characters/alice     … その作成者のフォルダだけ（いくつでも書ける）
//        node tools/check_chara.mjs --stats              … 大きさなどの数字も出す
// needs: cd tools && npm install（three.js を使う）
//
// 確かめること
//   フォルダ   名前の形、characters.json の形、一覧と <id>.html が合っているか
//   目印       「const C = {」と「// ---- set:」が1つずつ、この順にあるか（サーバはこの間を切り出す）
//   安全       切り出す範囲に、ネットからの読み込み・ページの操作などが書かれていないか
//              （オフィスを開いた全員のブラウザで動くため。完全な検査ではないので、取り込む前に人が読むこと）
//   動き       makeChara() がエラーなく動き、オフィスのポーズに要る関節がそろっているか
//   大きさ     座ったときに机と椅子に収まる大きさか、部品が多すぎないか
//   光         StopWatch の小さな画面で光がにじみやすい色を使っていないか（注意だけ）
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import * as THREE from "three";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const CHARACTERS_DIR = path.join(ROOT, "characters");
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const JOINTS = ["root", "hips", "thighL", "thighR", "kneeL", "kneeR", "chest", "shL", "shR", "elL", "elR", "neck", "head", "braidL", "braidR"];
const MARK_A = "const C = {", MARK_B = "// ---- set:";

// 今いるキャラ（c01〜c15）の大きさに少し余裕を持たせた範囲。立ちポーズ・関節を回さない状態で測る
const LIMITS = {
  height: [0.6, 1.1],    // 足元から頭（髪・帽子・お団子込み）のてっぺんまで
  width: 0.6,            // 横幅（おさげ・袖・リュック込み）
  depth: 0.55,           // 奥行き
  triangles: 200000,     // 6人が座っても重くならない目安
};

// 切り出す範囲に書いてはいけないもの（コメントを除いて探す）
const FORBIDDEN = [
  [/\b(fetch|XMLHttpRequest|WebSocket|EventSource|navigator|sendBeacon)\b/, "ネットにつなぐ処理"],
  [/\b\w*Loader\b/, "ファイルの読み込み（three.js の Loader）"],
  [/\bimport\b|\brequire\b/, "ほかのファイルの読み込み"],
  [/\b(document|window|globalThis|location)\b/, "ページの操作"],
  [/\b(localStorage|sessionStorage|indexedDB|cookie|caches)\b/, "ブラウザへの保存"],
  [/\b(eval|Function|constructor|prototype|__proto__|Reflect|Proxy)\b/, "コードを組み立てて動かす処理"],
  [/\b(setTimeout|setInterval|requestAnimationFrame|postMessage|Worker|process)\b/, "あとから動く処理"],
];

const argv = process.argv.slice(2);
const showStats = argv.includes("--stats");
const targets = argv.filter((a) => !a.startsWith("--"));
let errorCount = 0, warnCount = 0;

function report(title, errors, warnings, stats) {
  errorCount += errors.length; warnCount += warnings.length;
  console.log(`${errors.length ? "✖" : warnings.length ? "△" : "✔"} ${title}`);
  for (const e of errors) console.log(`    エラー: ${e}`);
  for (const w of warnings) console.log(`    注意:   ${w}`);
  if (showStats && stats) console.log(`    ${stats}`);
}

// characters/<作成者>/<id>.html と同じ共通の材質（server/public/office.html と同じもの）
function sharedMaterials() {
  const ramp = new THREE.DataTexture(new Uint8Array([90, 90, 90, 255, 180, 180, 180, 255, 255, 255, 255, 255]), 3, 1);
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter; ramp.needsUpdate = true;
  const toon = (c) => new THREE.MeshToonMaterial({ color: c, gradientMap: ramp });
  const rampSoft = new THREE.DataTexture(new Uint8Array([200, 200, 200, 255, 235, 235, 235, 255, 255, 255, 255, 255]), 3, 1);
  rampSoft.minFilter = rampSoft.magFilter = THREE.NearestFilter; rampSoft.needsUpdate = true;
  const outlineUniforms = { thickness: { value: 0.005 } };
  const outlineColors = [];
  function outlineMat(c, boost = 1.7) {
    outlineColors.push(new THREE.Color(c));
    return new THREE.ShaderMaterial({
      uniforms: { thickness: outlineUniforms.thickness, color: { value: new THREE.Color(c).multiplyScalar(boost) } },
      side: THREE.BackSide,
    });
  }
  return { THREE, toon, outlineMat, ramp, rampSoft, outlineUniforms, outlineColors };
}

// コメントを消す（文字列の中はそのまま残す）
function stripComments(src) {
  return src.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || " ");
}

function checkHtml(id, file) {
  const errors = [], warnings = [];
  const src = fs.readFileSync(file, "utf8");

  const countA = src.split(MARK_A).length - 1, countB = src.split(MARK_B).length - 1;
  if (countA !== 1 || countB !== 1) {
    errors.push(`目印「${MARK_A}」と「${MARK_B}」は1つずつ書く（今は ${countA} つと ${countB} つ。コメントの中にも書かないこと）`);
    return report(id, errors, warnings);
  }
  const a = src.indexOf(MARK_A), b = src.indexOf(MARK_B);
  if (b < a) {
    errors.push(`「${MARK_B}」が「${MARK_A}」より前にある`);
    return report(id, errors, warnings);
  }
  const section = src.slice(a, b);

  // 切り出す範囲：URL と、書いてはいけない処理
  const urls = section.match(/\b(?:https?|wss?|data|blob):\/?\/?[^\s"'`)]*/g);
  if (urls) errors.push(`キャラ本体に URL がある: ${[...new Set(urls)].slice(0, 3).join(" ")}`);
  const code = stripComments(section);
  for (const [re, what] of FORBIDDEN) {
    const m = code.match(re);
    if (m) errors.push(`キャラ本体に${what}がある（「${m[0]}」）。キャラ本体では THREE と渡される材質だけを使う`);
  }
  // それ以外（キャラを見るページの部分）：読み込んでよいのは three.js と Google Fonts だけ
  const outside = src.slice(0, a) + src.slice(b);
  for (const u of new Set(outside.match(/https?:\/\/[^\s"'`)]+/g) || [])) {
    if (!/^https:\/\/(cdn\.jsdelivr\.net\/npm\/three@0\.160\.0\/|fonts\.googleapis\.com\/)/.test(u)) errors.push(`読み込んでよいのは three.js 0.160.0 と Google Fonts だけ: ${u}`);
  }
  if (errors.length) return report(id, errors, warnings); // 危ないかもしれないものは動かさない

  // 動かしてみる（vm の中で。グローバルには THREE と材質しか置かない）
  const shared = sharedMaterials();
  let J;
  try {
    J = vm.runInNewContext(`${section}\n;makeChara();`, { ...shared, Math, console: { log() {}, warn() {}, error() {} } }, { timeout: 5000, filename: file });
  } catch (e) {
    errors.push(`makeChara() が動かない: ${String(e && e.message || e).split("\n")[0]}`);
    return report(id, errors, warnings);
  }
  if (!J || typeof J !== "object") {
    errors.push("makeChara() は関節の一覧 J を return する");
    return report(id, errors, warnings);
  }

  // 関節
  for (const k of JOINTS) {
    if (!(J[k] instanceof THREE.Object3D)) errors.push(`J.${k} がない（おさげが無い子も braidL / braidR に空の joint を入れる）`);
  }
  if (errors.length) return report(id, errors, warnings);
  for (const k of JOINTS.slice(1)) {
    let p = J[k];
    while (p && p !== J.root) p = p.parent;
    if (!p) errors.push(`J.${k} が J.root の下につながっていない`);
  }
  if (Math.abs(J.hips.position.y - 0.295) > 1e-6) warnings.push(`J.hips の高さは 0.295 にする（今は ${J.hips.position.y.toFixed(3)}。オフィスでは 0.295 に置き直される）`);
  if (!Array.isArray(J.eyes)) errors.push("J.eyes は目のメッシュの配列にする（まばたきしない子は []）");
  else J.eyes.forEach((e, i) => {
    if (!(e instanceof THREE.Object3D)) errors.push(`J.eyes[${i}] がメッシュではない`);
    else if (Math.abs(e.scale.y - 0.0185) > 1e-4) errors.push(`J.eyes[${i}] の scale.y は 0.0185 にする（まばたきで 0.0185 ⇔ 0.003 に切り替わるため。今は ${e.scale.y}）`);
  });

  // 大きさ・部品の数・光
  J.root.updateMatrixWorld(true);
  const box = new THREE.Box3();
  let triangles = 0, overbright = 0;
  J.root.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
    if (o.material && o.material.type !== "ShaderMaterial") box.expandByObject(o, true);
    for (const m of [].concat(o.material || [])) {
      for (const c of [m.color, m.emissive]) if (c && Math.max(c.r, c.g, c.b) > 1.001) overbright++;
    }
  });
  const size = box.getSize(new THREE.Vector3());
  if (box.min.y < -0.03) errors.push(`足元が床より下に出ている（いちばん下が y=${box.min.y.toFixed(3)}。立ったとき足の裏が y=0）`);
  if (size.y < LIMITS.height[0] || size.y > LIMITS.height[1]) errors.push(`高さ ${size.y.toFixed(2)} は ${LIMITS.height[0]}〜${LIMITS.height[1]} にする（机と椅子に合わせるため）`);
  if (size.x > LIMITS.width) errors.push(`横幅 ${size.x.toFixed(2)} は ${LIMITS.width} 以下にする（隣の席にはみ出すため）`);
  if (size.z > LIMITS.depth) errors.push(`奥行き ${size.z.toFixed(2)} は ${LIMITS.depth} 以下にする（机や背もたれにめり込むため）`);
  if (triangles > LIMITS.triangles) errors.push(`三角形が ${Math.round(triangles)} 個ある（${LIMITS.triangles} 個まで。球の分割数を減らすと軽くなる）`);
  if (overbright) warnings.push(`明るさを 1 より上げた色が ${overbright} か所ある（multiplyScalar など）。StopWatch で光がにじみやすいので、焼いた見本で確かめる`);
  const whiteOutlines = shared.outlineColors.filter((c) => Math.min(c.r, c.g, c.b) > 0.85).length;
  if (whiteOutlines) warnings.push(`白に近い輪郭の色が ${whiteOutlines} か所ある。広い面に使うと StopWatch で光がにじみやすい`);

  report(id, errors, warnings, `高さ ${size.y.toFixed(3)} 横幅 ${size.x.toFixed(3)} 奥行き ${size.z.toFixed(3)} 三角形 ${Math.round(triangles)}`);
}

function checkAuthor(dir) {
  const author = path.basename(dir);
  const errors = [], warnings = [];
  if (!NAME_RE.test(author)) {
    report(`${author}/`, [`作成者のフォルダ名は 英小文字・数字・-・_ で 32 文字まで（先頭は英小文字か数字）`], []);
    return;
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(path.join(dir, "characters.json"), "utf8")); } catch (e) {
    report(`${author}/characters.json`, [fs.existsSync(path.join(dir, "characters.json")) ? `JSON として読めない: ${e.message}` : "characters.json がない"], []);
    return;
  }
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) errors.push(`{ "author": "表示名", "characters": [...] } の形にする`);
  else {
    if (typeof doc.author !== "string" || !doc.author.trim()) warnings.push(`"author"（タブに出る名前）がない`);
    if (!Array.isArray(doc.characters)) errors.push(`"characters" を配列にする`);
  }
  const list = (doc && Array.isArray(doc.characters)) ? doc.characters : [];
  const seen = new Set();
  const todo = [];
  for (const e of list) {
    if (!e || !NAME_RE.test(e.id)) { errors.push(`id ${JSON.stringify(e && e.id)} は 英小文字・数字・-・_ で 32 文字まで`); continue; }
    if (seen.has(e.id)) { errors.push(`id "${e.id}" が2回ある`); continue; }
    seen.add(e.id);
    if (!e.feature) warnings.push(`${e.id}: "feature"（マイページに出る説明）がない`);
    const html = path.join(dir, `${e.id}.html`);
    if (fs.existsSync(html)) todo.push([`${author}/${e.id}${e.wip ? "（準備中）" : ""}`, html]);
    else if (!e.wip) errors.push(`${e.id}: ${e.id}.html がない（作りかけなら "wip": true を付ける）`);
    if (!e.wip && !fs.existsSync(path.join(dir, `${e.id}_front.png`))) warnings.push(`${e.id}: ${e.id}_front.png がない（無くても動くが、マイページで顔が見えない）`);
  }
  for (const f of fs.readdirSync(dir)) {
    const full = path.join(dir, f);
    if (f === "characters.json" || f.startsWith(".")) continue;
    const m = f.match(/^(.+?)(_front\.png|\.html)$/);
    if (!m) warnings.push(`${f}: キャラのフォルダに置くのは characters.json と <id>.html、<id>_front.png だけ`);
    else if (!seen.has(m[1])) warnings.push(`${f}: characters.json に "${m[1]}" がない（一覧に足さないとオフィスに出ない）`);
    else if (fs.statSync(full).size > 2 * 1024 * 1024) warnings.push(`${f}: 2MB より大きい`);
  }
  report(`${author}/characters.json（${doc && doc.author || author}）`, errors, warnings);
  for (const [id, html] of todo) checkHtml(id, html);
}

const dirs = targets.length
  ? targets.map((t) => path.resolve(t))
  : fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith(".")).map((d) => path.join(CHARACTERS_DIR, d.name));
for (const d of dirs) {
  if (fs.existsSync(d) && fs.statSync(d).isFile()) {
    // キャラの html を1つだけ（雛形など）
    checkHtml(d.startsWith(CHARACTERS_DIR + path.sep) ? path.relative(CHARACTERS_DIR, d) : path.basename(d), d);
  } else if (fs.existsSync(d)) checkAuthor(d);
  else { report(d, ["フォルダがない"], []); }
}
console.log(errorCount ? `\nエラー ${errorCount} 件。直してからもう一度試してください。` : `\nOK${warnCount ? `（注意 ${warnCount} 件）` : ""}`);
process.exit(errorCount ? 1 : 0);
