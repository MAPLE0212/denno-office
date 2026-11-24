// 電脳オフィス サーバ（マイページ + オフィス表示）
//
// 在席・ひとりごと・キャラ設定を1か所で持ち、ブラウザ・StopWatch・Dial に同じデータを配る。
// 依存パッケージなし（Node.js 18 以上）。状態は data/state.json、名簿・カード・Dial は data/registry.json（registry.js）に保存する。
//
//   node server.js                  → http://<この Mac の IP>:8080/（固定席）
//   SEAT_MODE=free node server.js   → フリーアドレス
//   PORT=3000 RESET_AT=21:30 node server.js
//
// 席の決め方（SEAT_MODE）
//   fixed（既定）固定席：席は名簿で一人ずつ決まっている。カードをかざすと在席 / 不在。Dial は「全体用」か「〇〇さん専用」
//   free         フリーアドレス：その日に座る席を、机の Dial にカード・席の NFC タグにスマホ・マイページの席の図で決める。
//                Dial は「机」。毎晩のリセットで全員の席が空く。名簿の席は「いつもの席」（席を選ばずに在席にするとそこに座る）
//
// 画面
//   /          オフィス（島6席の様子を Three.js で。キャラは /charas.js）
//   /me        マイページ（自分を選ぶ）
//   /me/<id>   マイページ（在席・ひとりごと・キャラ・カード。フリーアドレスでは席の図も。パーツでキャラを作る画面もここ）
//   /join      はじめての人の登録（名前・席・カード）
//   /admin     管理（Dial の役割、メンバーの名前・席・カード）
//   /tap/<席>  NFC タグ用（フリーアドレス）。スマホでタッチすると、その席に座る / 席を離れる。/tap はタグに書く URL の一覧
// API
//   GET   /api/state            全員の状態
//   GET   /api/characters       キャラ一覧（characters/<作成者>/characters.json から）
//   PATCH /api/members/<id>     { seat?: "A1" | null（フリーアドレス）, present?, comment?: {text, duration か until・timer} | null, back?, originals?, lang?: "ja" | "en" | "zh", character?: "maple/c01" | null }
//   POST  /api/members/<id>/tap { seat: "A1" }  席に座る / 戻る / 帰る（フリーアドレス。NFC タグ）→ { action: "sit" | "back" | "leave", state }
//   POST  /api/members/<id>/card { code }  Dial に出た番号で、カードをその人のものにする / DELETE で外す
//   GET   /api/codes/<番号>     Dial に出た 4 桁の番号の確認 → { dialRole, usedBy }
//   POST  /api/register         { name, seat?, code? }  登録 → { id }
//   PATCH /api/admin/members/<id> { name?, seat?, card?: null } / DELETE で名簿から消す
//   GET   /api/dials            Dial の一覧 / PATCH /api/dials/<mac> { role?, owner?, seat?, label? } / DELETE で一覧から消す
//   POST  /api/card             { mac, uid }  Dial にカードがかざされた（返事はタブ区切り 1 行。tapCard を見る）
//   GET   /api/events           状態が変わるたびに "state" を送る（Server-Sent Events）
//   GET   /api/device           StopWatch / Dial 用の軽い形式（1行1席のタブ区切り。#t 行は時間のひとことの残り秒）
//   POST  /api/parts            パーツで作ったキャラを足す { by, label, feature, recipe, image }
//   PUT   /api/parts/<id>       パーツで作ったキャラを直す（作った人だけ）
const http = require("http");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");

const PORT = Number(process.env.PORT || 8080);
const RESET_AT = process.env.RESET_AT || "22:00"; // 毎晩この時刻に全員を不在に戻す（押し忘れ対策）
const CHARACTERS_DIR = process.env.CHARACTERS_DIR || path.join(__dirname, "..", "characters");
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data", "state.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// 席の決め方。fixed（固定席）か free（フリーアドレス）
const SEAT_MODE = (process.env.SEAT_MODE || "fixed").trim().toLowerCase();
if (!["fixed", "free"].includes(SEAT_MODE)) {
  console.error(`SEAT_MODE は fixed（固定席）か free（フリーアドレス）です（今は "${process.env.SEAT_MODE}"）`);
  process.exit(1);
}
const FREE = SEAT_MODE === "free";

// 席（島1つ・6席）。A が手前の列、B が奥の列
const SEAT_CODES = ["A1", "A2", "A3", "B1", "B2", "B3"];

// 名簿・カード・Dial（registry.js）。最初の起動だけ members.json（無ければ members.example.json のサンプル）から名簿を作る
const { createRegistry } = require("./registry");
const registry = createRegistry({
  dataDir: path.dirname(DATA_FILE),
  seedFiles: ["members.json", "members.example.json"].map((f) => path.join(__dirname, f)),
  seats: SEAT_CODES,
  mode: SEAT_MODE,
  onChange() { syncMembers(); save(); broadcast(); },
});
// ひとりごとの定型文（マイページで見出しごとに並ぶ。気温・予定・声かけは Dial のジャンルと同じ文）
const PRESET_GROUPS = [
  { label: "いま", items: ["集中モード", "休憩中", "会議中"] },
  { label: "気温", items: ["寒い", "ちょっと寒い", "ちょっと暑い", "暑い"] },
  { label: "予定", items: ["午後から会議", "定時で帰ります", "明日はお休み"] },
  { label: "声かけ", items: ["話しかけOK", "手が空いてます", "雑談したい", "あとで返事します"] },
];
const PRESETS = PRESET_GROUPS.flatMap((g) => g.items);
const ORIGINALS_MAX = 10; // オリジナル（マイページで登録する自分の定型文）の数
const DURATIONS = [
  { id: "30m", label: "30分" },
  { id: "2h", label: "2時間" },
  { id: "today", label: "今日中" },
];
const COMMENT_MAX = 20;

// ---------- キャラ一覧 ----------

// キャラは作成者ごとのフォルダ characters/<作成者>/ にある（マイページでは作成者ごとのタブになる）。
//   characters/<作成者>/characters.json  { author: "表示名", characters: [{ id: "c01", feature: "紺髪おさげ、…", label?, wip? }] }
//   characters/<作成者>/<id>.html, <id>_front.png
// キャラの ID は "<作成者>/<id>"（例 "maple/c01"）。characters/local/ は git に入らない自分用のフォルダで、タブの先頭に出す。
// CHARACTER_AUTHORS=maple,local のように書くと、その作成者のキャラだけを使う。
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ID_RE = /^([a-z0-9][a-z0-9_-]{0,31})\/([a-z0-9][a-z0-9_-]{0,31})$/;
const AUTHORS_ALLOWED = (process.env.CHARACTER_AUTHORS || "").split(",").map((s) => s.trim()).filter(Boolean);

function charaFile(id, suffix) {
  const [, author, name] = id.match(ID_RE);
  return path.join(CHARACTERS_DIR, author, `${name}${suffix}`);
}

function authorDirs() {
  let dirs = [];
  try { dirs = fs.readdirSync(CHARACTERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {}
  dirs = dirs.filter((d) => NAME_RE.test(d) && (!AUTHORS_ALLOWED.length || AUTHORS_ALLOWED.includes(d))).sort();
  return [...dirs.filter((d) => d === "local"), ...dirs.filter((d) => d !== "local")];
}

// 全員分の characters.json を読む。ファイルが更新されても毎回読み直す。
function loadCharacters() {
  const list = [];
  for (const author of authorDirs()) {
    if (author === PARTS_AUTHOR) continue; // パーツで作ったキャラ用の名前なので、フォルダは使わない
    let doc;
    try { doc = JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, author, "characters.json"), "utf8")); } catch { continue; }
    const authorName = String(doc.author || (author === "local" ? "自分用" : author));
    for (const e of Array.isArray(doc.characters) ? doc.characters : []) {
      if (!e || !NAME_RE.test(e.id)) continue;
      const id = `${author}/${e.id}`;
      const feature = String(e.feature || "");
      list.push({
        id,
        name: e.id,
        author,
        authorName,
        label: e.label || feature.split("、")[0] || e.id,
        feature,
        status: e.wip ? "制作中" : "完成",
        available: !e.wip,
        image: fs.existsSync(charaFile(id, "_front.png")) ? `/img/chars/${id}.png` : null,
      });
    }
  }
  for (const p of loadParts()) {
    if (!NAME_RE.test(p.id)) continue;
    list.push({
      id: `${PARTS_AUTHOR}/${p.id}`,
      name: p.id,
      author: PARTS_AUTHOR,
      authorName: "パーツで作成",
      label: p.label,
      feature: p.feature || "",
      status: "完成",
      available: true,
      image: fs.existsSync(partsImageFile(p.id)) ? `/img/chars/${PARTS_AUTHOR}/${p.id}.png?v=${p.updatedAt}` : null,
      by: p.by,
      recipe: p.recipe,
    });
  }
  return list;
}

// ---------- パーツで作ったキャラ ----------

// マイページの「パーツで作る」で作ったキャラは、作成者 "parts" のキャラとして並ぶ（ID は "parts/p001"）。
// 中身は部品の選び方（レシピ）だけで、組み立ては characters/_parts.js。保存先は data/ の下（git に入らない）。
//   data/parts.json      { characters: [{ id, label, feature, recipe, by, createdAt, updatedAt }] }
//   data/parts/<id>.png  マイページ用の写真（作成画面で撮ったもの）
const PARTS_AUTHOR = "parts";
const PARTS_LIB = path.join(CHARACTERS_DIR, "_parts.js");
const PARTS_FILE = path.join(path.dirname(DATA_FILE), "parts.json");
const PARTS_IMG_DIR = path.join(path.dirname(DATA_FILE), "parts");
const PARTS_MAX = 500;
const RECIPE_STYLES = ["hair", "hat", "top", "bottom", "shoes", "brows", "acc"];
const RECIPE_COLORS = ["hairColor", "topColor", "subColor", "bottomColor", "shoesColor", "eyeColor", "hatColor", "accColor"];

function loadParts() {
  try { return JSON.parse(fs.readFileSync(PARTS_FILE, "utf8")).characters || []; } catch { return []; }
}

function saveParts(list) {
  fs.mkdirSync(path.dirname(PARTS_FILE), { recursive: true });
  const tmp = PARTS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ characters: list }, null, 2));
  fs.renameSync(tmp, PARTS_FILE);
}

// 届いたレシピから、知っている項目だけを取り出す（部品の id が知らないものなら組み立て側で既定に戻る）
function cleanRecipe(r) {
  if (!r || typeof r !== "object") return null;
  const out = {};
  for (const k of RECIPE_STYLES) if (typeof r[k] === "string" && /^[a-z0-9-]{1,20}$/.test(r[k])) out[k] = r[k];
  for (const k of RECIPE_COLORS) if (Number.isInteger(r[k]) && r[k] >= 0 && r[k] <= 0xffffff) out[k] = r[k];
  return out;
}

// 作成画面で撮った写真（data:image/png;base64,...）を保存する。無い・おかしいときは何もしない
function savePartsImage(id, dataUrl) {
  const m = typeof dataUrl === "string" && dataUrl.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return;
  const buf = Buffer.from(m[1], "base64");
  if (buf.length > 400 * 1024 || buf.readUInt32BE(0) !== 0x89504e47) return;
  fs.mkdirSync(PARTS_IMG_DIR, { recursive: true });
  fs.writeFileSync(path.join(PARTS_IMG_DIR, `${id}.png`), buf);
}

function partsImageFile(name) { return path.join(PARTS_IMG_DIR, `${name}.png`); }

// POST（id なし）なら足す、PUT（id あり）なら直す。[状態コード, エラー or 保存したキャラ]
function savePartsChara(body, id) {
  const recipe = cleanRecipe(body.recipe);
  if (!recipe) return [400, "レシピがありません"];
  const by = String(body.by || "");
  if (!state.members[by]) return [400, "作った人が分かりません"];
  const label = String(body.label || "").replace(/\s+/g, " ").trim().slice(0, 20) || "パーツの子";
  const feature = String(body.feature || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const list = loadParts();
  const now = Date.now();
  let c;
  if (id) {
    c = list.find((x) => x.id === id);
    if (!c) return [404, "そのキャラはいません"];
    if (c.by !== by) return [403, "作った人だけが直せます"];
    Object.assign(c, { label, feature, recipe, updatedAt: now });
  } else {
    if (list.length >= PARTS_MAX) return [400, "これ以上は作れません"];
    const n = list.reduce((a, x) => Math.max(a, Number(x.id.slice(1)) || 0), 0) + 1;
    c = { id: `p${String(n).padStart(3, "0")}`, label, feature, recipe, by, createdAt: now, updatedAt: now };
    list.push(c);
  }
  savePartsImage(c.id, body.image);
  saveParts(list);
  return [200, c];
}

// 作成者フォルダにする前の ID（"c01"）を、同じ名前のキャラの新しい ID（"maple/c01"）に直す
function migrateCharacterId(cid) {
  if (!cid || cid.includes("/")) return cid;
  const c = loadCharacters().find((x) => x.name === cid);
  return c ? c.id : null;
}

// 3D オフィス用：完成したキャラの <id>.html から、キャラを組み立てる部分（const C = { 〜 // ---- set:）を
// 切り出して1つの ES モジュールにする。
// 共通の材質（toon・輪郭など）は呼び出し側から渡す。
function charasModule() {
  const parts = [];
  for (const c of loadCharacters()) {
    if (!c.available || c.author === PARTS_AUTHOR) continue;
    let src;
    try { src = fs.readFileSync(charaFile(c.id, ".html"), "utf8"); } catch { continue; }
    const a = src.indexOf("const C = {"), b = src.indexOf("// ---- set:");
    if (a < 0 || b < a) continue;
    parts.push(`charas[${JSON.stringify(c.id)}] = () => {\n${src.slice(a, b)}\nreturn makeChara();\n};`);
  }
  // パーツで作ったキャラは最後に（キャラ未設定の席に出す仮キャラの並びが変わらないように）
  const made = loadParts().filter((p) => NAME_RE.test(p.id));
  if (made.length) {
    parts.push(`const makePartsChara = (() => {\n${partsLib()}\nreturn makePartsChara;\n})();`);
    for (const p of made) parts.push(`charas[${JSON.stringify(`${PARTS_AUTHOR}/${p.id}`)}] = () => makePartsChara(${JSON.stringify(p.recipe)});`);
  }
  return [
    "// characters/<作成者>/<id>.html から server.js が自動で組み立てたキャラ一覧",
    "export default function makeCharas({ THREE, toon, outlineMat, ramp, rampSoft, outlineUniforms }) {",
    "const charas = {};",
    ...parts,
    "return charas;",
    "}",
  ].join("\n");
}

function partsLib() {
  try { return fs.readFileSync(PARTS_LIB, "utf8"); } catch { return "const PARTS = {}; const PARTS_PALETTE = {}; const PARTS_DEFAULT = {}; function makePartsChara() { return null; }"; }
}

// マイページの作成画面用：部品の一覧と組み立てを1つの ES モジュールにする
function partsModule() {
  return [
    "// characters/_parts.js から server.js が組み立てた、パーツでキャラを作るための部品",
    "export default function makeParts({ THREE, toon, outlineMat, ramp, rampSoft, outlineUniforms }) {",
    partsLib(),
    "return { PARTS, PARTS_PALETTE, PARTS_DEFAULT, build: makePartsChara };",
    "}",
  ].join("\n");
}

// ---------- StopWatch 用のはんこ（tools/bake_chara.py が焼く、席ごとの差分スプライト） ----------

const SPRITES_DIR = path.join(__dirname, "sprites");
const TOOLS_DIR = path.join(__dirname, "..", "tools");
const OFFICE_SEATS = ["B1", "B2", "B3", "A1", "A2", "A3"]; // 3D オフィスで仮キャラを決める並び

// 3D に出せる完成キャラ（<id>.html があるもの）。タブの順、その中は characters.json の順
function chara3dIds() {
  return loadCharacters()
    .filter((c) => c.available && (c.author === PARTS_AUTHOR || fs.existsSync(charaFile(c.id, ".html"))))
    .map((c) => c.id);
}

// キャラを最後に直した時刻（秒）。焼き直すかどうかの判断に使う
function charaEditedAt(cid) {
  const [author, name] = cid.split("/");
  if (author === PARTS_AUTHOR) { const p = loadParts().find((x) => x.id === name); return p ? p.updatedAt / 1000 : 0; }
  return fs.statSync(charaFile(cid, ".html")).mtimeMs / 1000;
}

// StopWatch に出すキャラ。未設定の人は 3D オフィスと同じく、席ごとに決まった完成キャラ
function displayCharacter(m, ids) {
  if (m.character && ids.includes(m.character.id)) return m.character.id;
  const i = OFFICE_SEATS.indexOf(m.seat);
  return ids.length && i >= 0 ? ids[i % ids.length] : "";
}

// 焼いた日時（まだ焼いていなければ 0）。StopWatch / Dial はこれが変わったら取り直す
function spriteVersion(cid) {
  try { return JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, cid, "meta.json"), "utf8")).bakedAt || 0; } catch { return 0; }
}

// Dial 用（240x240）のはんこが6席そろっているか。Dial 対応より前に焼いたキャラには無い
function hasDialSprites(cid) {
  return SEAT_CODES.every((s) => fs.existsSync(path.join(SPRITES_DIR, cid, "dial", `${s}.bin`)));
}

// まだ焼いていない（または <id>.html が焼いた後に直された）完成キャラを焼く。tools/.venv が無ければ何もしない
let baking = false;
function bakeMissing() {
  const py = path.join(TOOLS_DIR, ".venv", "bin", "python");
  if (baking || !fs.existsSync(py)) return;
  const todo = chara3dIds().filter((cid) => {
    const v = spriteVersion(cid);
    return !v || charaEditedAt(cid) > v || !hasDialSprites(cid);
  });
  if (!todo.length) return;
  baking = true;
  console.log(`StopWatch 用にキャラを焼きます: ${todo.join(" ")}`);
  const child = spawn(py, ["bake_chara.py", ...todo], { cwd: TOOLS_DIR, env: { ...process.env, DENNO_SERVER: `http://localhost:${PORT}` } });
  const log = (d) => String(d).split("\n").filter(Boolean).forEach((l) => console.log(`  [bake] ${l}`));
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("exit", (code) => {
    baking = false;
    console.log(code === 0 ? "焼き上がりました" : `焼けませんでした（終了コード ${code}）`);
    if (code === 0) broadcast();
  });
}

// ---------- 状態 ----------

function freshMember() {
  // seat: フリーアドレスで今日座っている席（座っていなければ null。夜のリセットで空く）。固定席では使わない（席は名簿）
  // present: 席にいるか（フリーアドレスで false かつ seat があれば「離席中」。席は取ったまま）
  // back: 戻る時刻 "HH:MM"（不在タグに出す。在席に戻るか夜のリセットで消える） / originals: オリジナルの定型文
  return { seat: null, present: false, comment: null, back: null, originals: [], character: null, updatedAt: null };
}

function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
  s.members = s.members || {};
  const taken = new Set();
  for (const info of registry.members()) {
    const old = s.members[info.id] || {};
    const x = s.members[info.id] = { ...freshMember(), ...old };
    x.character = migrateCharacterId(x.character);
    if (!FREE) { x.seat = null; continue; }
    // フリーアドレスの前の保存（seat が無い）：在席だった人はいつもの席に座らせる
    if (!("seat" in old)) x.seat = x.present ? info.seat : null;
    if (!SEAT_CODES.includes(x.seat) || taken.has(x.seat)) x.seat = null;
    if (x.seat) taken.add(x.seat);
    else x.present = false;
  }
  if (!s.lastResetAt) s.lastResetAt = lastResetBoundary(Date.now());
  return s;
}

let state = loadState();
let saveTimer = null;

// 登録・削除のあとで、状態を名簿に合わせる（増えた人は不在から、消えた人の状態は捨てる）
function syncMembers() {
  const ids = new Set(registry.members().map((m) => m.id));
  for (const id of ids) if (!state.members[id]) state.members[id] = freshMember();
  for (const id of Object.keys(state.members)) if (!ids.has(id)) delete state.members[id];
}

// 今それぞれの人が座っている席 { id: "A1" | null }。
// 固定席は名簿の席（同じ席に2人いれば先の人。モードを切り替えたあとに起こりうる）、フリーアドレスは今日の席
function seatMap() {
  const out = {}, taken = new Set();
  for (const info of registry.members()) {
    const s = FREE ? state.members[info.id].seat : info.seat;
    out[info.id] = s && !taken.has(s) ? s : null;
    if (out[info.id]) taken.add(s);
  }
  return out;
}

// その席にいま座っている人の id（いなければ null）
function seatHolder(seat, map = seatMap()) {
  return Object.keys(map).find((id) => map[id] === seat) || null;
}

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    const tmp = DATA_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, DATA_FILE);
  }, 200);
}

// 直近の RESET_AT（今日の RESET_AT を過ぎていなければ昨日の分）
function lastResetBoundary(now) {
  const [h, mi] = RESET_AT.split(":").map(Number);
  const d = new Date(now);
  d.setHours(h, mi, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}

function nextResetBoundary(now) {
  const t = lastResetBoundary(now);
  const d = new Date(t);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

// "HH:MM" → now より後でいちばん近いその時刻（ms）。形がおかしければ null
function clockToTime(hhmm, now) {
  const mt = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ""));
  if (!mt || +mt[1] > 23 || +mt[2] > 59) return null;
  const d = new Date(now);
  d.setHours(+mt[1], +mt[2], 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

const TIMER_KINDS = ["focus", "rest", "meeting", "out"];
// Dial の言葉（マイページで人ごとに選ぶ。個人用の Dial は持ち主、机の Dial は座っている人の言葉。全体用は日本語）
const LANGS = [
  { id: "ja", label: "日本語" },
  { id: "en", label: "English" },
  { id: "zh", label: "中文（简体）" },
];

function commentUntil(duration, now) {
  if (duration === "30m") return now + 30 * 60 * 1000;
  if (duration === "2h") return now + 2 * 60 * 60 * 1000;
  return nextResetBoundary(now); // 今日中 = 次の夜のリセットまで
}

// 期限切れのひとりごとを消し、夜のリセット時刻を過ぎていたら全員を不在に戻す。変化があれば true
function tick(now = Date.now()) {
  let changed = false;
  for (const m of Object.values(state.members)) {
    if (m.comment && m.comment.until <= now) { m.comment = null; changed = true; }
  }
  const boundary = lastResetBoundary(now);
  if (state.lastResetAt < boundary) {
    for (const m of Object.values(state.members)) {
      if (m.present) { m.present = false; changed = true; }
      if (m.seat) { m.seat = null; changed = true; }
      if (m.back) { m.back = null; changed = true; }
    }
    state.lastResetAt = boundary;
    save();
    console.log(`[${new Date(now).toLocaleString("ja-JP")}] 夜のリセット：${FREE ? "全員の席を空けました" : "全員を不在にしました"}`);
  }
  if (changed) save();
  return changed;
}

function publicState() {
  const chars = Object.fromEntries(loadCharacters().map((c) => [c.id, c]));
  const seats = seatMap();
  return {
    mode: SEAT_MODE,
    resetAt: RESET_AT,
    commentMax: COMMENT_MAX,
    presets: PRESETS,
    presetGroups: PRESET_GROUPS,
    originalsMax: ORIGINALS_MAX,
    durations: DURATIONS,
    langs: LANGS,
    seats: SEAT_CODES,
    desks: FREE ? registry.deskSeats() : [], // フリーアドレスで Dial が置いてある机
    members: registry.members().map((info) => {
      const m = state.members[info.id];
      const c = m.character && chars[m.character];
      return {
        id: info.id,
        name: info.name,
        seat: seats[info.id],                   // 今座っている席（固定席は自分の席。席が無い・重なった人は null）
        homeSeat: FREE ? info.seat : null,      // フリーアドレスの「いつもの席」
        sample: !!info.sample,
        card: info.card,
        present: m.present,
        comment: m.comment,
        back: m.back,
        originals: m.originals,
        lang: m.lang || "ja",
        character: c ? { id: c.id, label: c.label, image: c.image } : null,
        updatedAt: m.updatedAt,
      };
    }),
  };
}

// ---------- 更新 ----------

const nameOf = (id) => { const info = registry.member(id); return info ? info.name : ""; };

function applyPatch(id, body) {
  const m = state.members[id];
  if (!m) return [404, "そのメンバーはいません"];
  const now = Date.now();
  const next = {}; // 全部チェックしてからまとめて反映する

  if ("seat" in body) {
    if (!FREE) return [400, "固定席では、席は管理（/admin）で変えます"];
    if (body.seat === null) {
      Object.assign(next, { seat: null, present: false, back: null }); // 帰る：席を空ける
    } else {
      if (!SEAT_CODES.includes(body.seat)) return [400, "その席はありません"];
      const who = seatHolder(body.seat);
      if (who && who !== id) return [409, `${nameOf(who)}さんが座っています`];
      Object.assign(next, { seat: body.seat, present: true }); // 座る
    }
  }
  if ("present" in body) {
    if (typeof body.present !== "boolean") return [400, "present は true / false"];
    next.present = body.present;
    // フリーアドレスで席が無いまま在席にする：いつもの席が空いていればそこに座る
    if (FREE && body.present && !(next.seat ?? m.seat)) {
      const info = registry.member(id);
      const home = info && info.seat;
      if (!home || seatHolder(home)) return [400, "先に座る席を選んでください"];
      next.seat = home;
    }
  }
  if ("comment" in body) {
    if (body.comment === null) {
      next.comment = null;
    } else {
      const text = String((body.comment && body.comment.text) || "").replace(/\s+/g, " ").trim();
      if (!text) return [400, "ひとりごとが空です"];
      if ([...text].length > COMMENT_MAX) return [400, `ひとりごとは${COMMENT_MAX}文字まで`];
      // until: "HH:MM"（Dial の 集中 〜15:30 など。その時刻に消える）。無ければ duration
      const at = "until" in body.comment ? clockToTime(body.comment.until, now) : null;
      if ("until" in body.comment && !at) return [400, "until は HH:MM"];
      const duration = at ? "until" : DURATIONS.some((d) => d.id === body.comment.duration) ? body.comment.duration : "2h";
      next.comment = { text, duration, until: at || commentUntil(duration, now), at: now };
      // timer: Dial の時間のひとこと（集中・休憩・会議・外出）。Dial のタイマー画面で残り時間を出す
      if (at && TIMER_KINDS.includes(body.comment.timer)) next.comment.timer = body.comment.timer;
    }
  }
  if ("back" in body) {
    if (body.back === null) next.back = null;
    else if (clockToTime(body.back, now)) next.back = String(body.back).padStart(5, "0");
    else return [400, "back は HH:MM"];
  }
  if ("originals" in body) {
    if (!Array.isArray(body.originals)) return [400, "originals は文の配列"];
    const list = [];
    for (const o of body.originals) {
      const text = String(o || "").replace(/\s+/g, " ").trim();
      if (!text) continue;
      if ([...text].length > COMMENT_MAX) return [400, `オリジナルは${COMMENT_MAX}文字まで`];
      if (!list.includes(text)) list.push(text);
    }
    if (list.length > ORIGINALS_MAX) return [400, `オリジナルは${ORIGINALS_MAX}個まで`];
    next.originals = list;
  }
  if ("lang" in body) {
    if (!LANGS.some((l) => l.id === body.lang)) return [400, "言葉は ja / en / zh"];
    next.lang = body.lang;
  }
  if ("character" in body) {
    if (body.character === null) {
      next.character = null;
    } else {
      const c = loadCharacters().find((x) => x.id === body.character);
      if (!c) return [400, "そのキャラはいません"];
      if (!c.available) return [400, "そのキャラはまだ準備中です"];
      next.character = c.id;
    }
  }
  if (next.present ?? m.present) next.back = null; // 在席なら戻り時刻はいらない
  if (FREE && !(next.seat ?? m.seat) && next.present) return [400, "先に座る席を選んでください"];
  Object.assign(m, next, { updatedAt: now });
  save();
  broadcast();
  return [200, null];
}

// フリーアドレスで、その席にタッチした（机の Dial にカード・席の NFC タグにスマホ）。"sit" | "back" | "leave"
//   その席にもう座っていて在席 → 帰る（席が空く） / 座っていて離席中 → 戻る / ほかの席・席なし → この席に座る
//   その席に別の人がいれば、帰るのを忘れた人として席を空ける
function tapSeat(id, seat) {
  const m = state.members[id];
  const now = Date.now();
  let action;
  if (m.seat === seat && m.present) {
    Object.assign(m, { seat: null, present: false, back: null });
    action = "leave";
  } else if (m.seat === seat) {
    Object.assign(m, { present: true, back: null });
    action = "back";
  } else {
    const who = seatHolder(seat);
    if (who && who !== id) Object.assign(state.members[who], { seat: null, present: false, back: null, updatedAt: now });
    Object.assign(m, { seat, present: true, back: null });
    action = "sit";
  }
  m.updatedAt = now;
  save();
  broadcast();
  return action;
}

// Dial にカードがかざされた。Dial に返す1行（タブ区切り）の中身 [種類, ...]
//   code 1234          未登録のカード（/join かマイページでこの番号を入れる）
//   固定席      in / out 名前           在席にした / 不在にした
//               deny 持ち主の名前       ほかの人専用の Dial
//   フリーアドレス sit 名前 席 / back 名前 席 / leave 名前 席   座った / 離席から戻った / 帰った（席が空いた）
//               nodesk 名前             この Dial の机がまだ決まっていない（/admin で決める）
function tapCard(mac, uid) {
  registry.seen(mac);
  const dial = registry.dialInfo(mac);
  const who = registry.memberOfCard(uid);
  let out;
  if (!FREE && dial.role === "personal" && (!who || who.id !== dial.owner.id)) out = ["deny", dial.owner.name];
  else if (!who || !state.members[who.id]) out = ["code", registry.issueCode(uid, mac)];
  else if (FREE) out = dial.role === "desk" ? [tapSeat(who.id, dial.seat), who.name, dial.seat] : ["nodesk", who.name];
  else {
    const present = !state.members[who.id].present;
    applyPatch(who.id, { present });
    out = [present ? "in" : "out", who.name];
  }
  console.log(`[card] Dial ${mac.slice(-4)}（${dial.role}${dial.seat ? " " + dial.seat : ""}）→ ${out[0]} ${out[1] || ""}`);
  return out;
}

// ---------- Server-Sent Events ----------

const clients = new Set();

function broadcast() {
  const data = `event: state\ndata: ${JSON.stringify(publicState())}\n\n`;
  for (const res of clients) res.write(data);
}

setInterval(() => { if (tick()) broadcast(); }, 15 * 1000);
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25 * 1000);

// ---------- HTTP ----------

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

function sendJson(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(obj));
}

function sendText(res, code, text) {
  res.writeHead(code, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
  res.end(text + "\n");
}

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": buf.length });
    res.end(buf);
  });
}

function readBody(req, max = 10000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > max) req.destroy(); });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const p = decodeURIComponent(url.pathname);

  if (p === "/api/state" && req.method === "GET") { tick(); return sendJson(res, 200, publicState()); }
  if (p === "/api/characters" && req.method === "GET") return sendJson(res, 200, loadCharacters());

  // StopWatch 用：JSON を読まずに済むよう、1行1席のタブ区切りテキストで返す
  //   席 \t id \t 在席(1/0) \t 名前 \t ひとりごと \t キャラ \t はんこの版（0 = まだ焼いていない）
  //   ?board=dial のときは Dial 用のはんこの版（Dial 用が無ければ 0 にして、端末はファームの絵で描く）
  //   8列目は戻る時刻（"16:00"、無ければ空）。だれもいない席は id と名前が空の行（端末は空いた机として描く）
  //   席の行のあとに、席と関係ない行を足す（古いファームは読み飛ばす）
  //     #now \t サーバの時計（その日の 0 時からの秒）
  //     #mode \t fixed | free（席の決め方。端末は不在の札を「不在」か「離席」にする）
  //     #o \t 席 \t オリジナルの文（1つ1行）
  //     #dial \t 役割 \t 席 \t 持ち主の名前 \t 言葉（?mac= を付けて来た Dial だけ。registry.js の dialInfo）
  //        役割 none / shared / personal（席 = 持ち主の席）/ desk（席 = 置いた机）
  if (p === "/api/device" && req.method === "GET") {
    tick();
    const clean = (s) => String(s || "").replace(/[\t\r\n]+/g, " ");
    const ids = chara3dIds();
    const dial = url.searchParams.get("board") === "dial";
    const ver = (cid) => (!cid || (dial && !hasDialSprites(cid)) ? 0 : spriteVersion(cid));
    const members = publicState().members;
    const lines = SEAT_CODES.map((seat) => {
      const m = members.find((x) => x.seat === seat);
      if (!m) return [seat, "", 0, "", "", "", 0, ""].join("\t");
      const cid = displayCharacter(m, ids);
      return [m.seat, m.id, m.present ? 1 : 0, clean(m.name), clean(m.comment && m.comment.text), cid, ver(cid), clean(m.back)].join("\t");
    });
    const d = new Date();
    lines.push(`#now\t${d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()}`);
    lines.push(`#mode\t${SEAT_MODE}`);
    for (const m of members) if (m.seat) for (const o of m.originals || []) lines.push(`#o\t${m.seat}\t${clean(o)}`);
    // #t 席 種類 残り秒 全体の秒：時間のひとこと（Dial のタイマー画面）
    const nowMs = Date.now();
    for (const m of members) {
      const c = m.seat && m.comment;
      if (!c || !c.timer || !(c.until > nowMs)) continue;
      lines.push(["#t", m.seat, c.timer, Math.round((c.until - nowMs) / 1000), Math.round((c.until - (c.at || nowMs)) / 1000)].join("\t"));
    }
    const mac = registry.cleanMac(url.searchParams.get("mac"));
    if (registry.isMac(mac)) {
      registry.seen(mac);
      const info = registry.dialInfo(mac);
      // 5 列目は言葉：個人用は持ち主、机は座っている人。全体用・未設定は ja
      const who = info.role === "personal" ? info.owner && info.owner.id : info.role === "desk" && FREE ? seatHolder(info.seat) : null;
      const st = who && state.members[who];
      lines.push(["#dial", info.role, info.seat || "", clean(info.owner && info.owner.name), (st && st.lang) || "ja"].join("\t"));
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(lines.join("\n") + "\n");
  }

  if (p === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
    tick();
    res.write(`event: state\ndata: ${JSON.stringify(publicState())}\n\n`);
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  const mm = p.match(/^\/api\/members\/([\w-]+)$/);
  if (mm && req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    const [code, error] = applyPatch(mm[1], body || {});
    return sendJson(res, code, error ? { error } : publicState());
  }

  // NFC タグ（/tap/<席>）からのタッチ。フリーアドレスだけ
  const tm = p.match(/^\/api\/members\/([\w-]+)\/tap$/);
  if (tm && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    if (!FREE) return sendJson(res, 400, { error: "席へのタッチはフリーアドレス（SEAT_MODE=free）のときだけ使えます" });
    if (!state.members[tm[1]]) return sendJson(res, 404, { error: "そのメンバーはいません" });
    const seat = body && body.seat;
    if (!SEAT_CODES.includes(seat)) return sendJson(res, 400, { error: "その席はありません" });
    const action = tapSeat(tm[1], seat);
    console.log(`[tap] ${seat} ${nameOf(tm[1])} → ${action}`);
    return sendJson(res, 200, { action, state: publicState() });
  }

  // Dial にカードがかざされた。返事は Dial が読みやすいようにタブ区切りの1行
  if (p === "/api/card" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return sendText(res, 400, "ng\tJSON が読めません"); }
    const mac = registry.cleanMac(body && body.mac);
    const uid = String((body && body.uid) || "").toUpperCase().replace(/[^0-9A-F]/g, "");
    if (!registry.isMac(mac) || uid.length < 8 || uid.length > 20) return sendText(res, 400, "ng\tmac か uid がおかしい");
    return sendText(res, 200, tapCard(mac, uid).map((x) => String(x).replace(/[\t\r\n]+/g, " ")).join("\t"));
  }

  // カードを結ぶ（Dial に出た番号）/ 外す
  const cm = p.match(/^\/api\/members\/([\w-]+)\/card$/);
  if (cm && (req.method === "POST" || req.method === "DELETE")) {
    let error;
    if (req.method === "DELETE") error = registry.unlinkCard(cm[1]);
    else {
      let body;
      try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
      error = registry.linkCard(cm[1], body && body.code);
    }
    if (error) return sendJson(res, 400, { error });
    return sendJson(res, 200, publicState());
  }

  // 番号の確認（/join とマイページ）
  const codem = p.match(/^\/api\/codes\/(\d{4})$/);
  if (codem && req.method === "GET") {
    const info = registry.checkCode(codem[1]);
    if (!info) return sendJson(res, 404, { error: "その番号は見つかりません（10 分で切れます。もう一度カードをかざしてください）" });
    return sendJson(res, 200, info);
  }

  if (p === "/api/register" && req.method === "POST") {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    const [code, out] = registry.register(body || {});
    return sendJson(res, code, code === 200 ? out : { error: out });
  }

  // 管理：名前・席を直す / 消す
  const am = p.match(/^\/api\/admin\/members\/([\w-]+)$/);
  if (am && req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    const [code, error] = registry.editMember(am[1], body || {});
    return sendJson(res, code, error ? { error } : { ok: true });
  }
  if (am && req.method === "DELETE") {
    return registry.removeMember(am[1]) ? sendJson(res, 200, { ok: true }) : sendJson(res, 404, { error: "そのメンバーはいません" });
  }

  // 管理：Dial
  if (p === "/api/dials" && req.method === "GET") return sendJson(res, 200, registry.dialList());
  const dm = p.match(/^\/api\/dials\/([0-9a-f]{12})$/);
  if (dm && req.method === "PATCH") {
    let body;
    try { body = await readBody(req); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    const [code, error] = registry.editDial(dm[1], body || {});
    return sendJson(res, code, error ? { error } : registry.dialList());
  }
  if (dm && req.method === "DELETE") {
    return registry.removeDial(dm[1]) ? sendJson(res, 200, registry.dialList()) : sendJson(res, 404, { error: "その Dial はありません" });
  }

  const pm = p.match(/^\/api\/parts(?:\/([a-z0-9][a-z0-9_-]{0,31}))?$/);
  if (pm && (req.method === "POST" && !pm[1] || req.method === "PUT" && pm[1])) {
    let body;
    try { body = await readBody(req, 600 * 1024); } catch { return sendJson(res, 400, { error: "JSON が読めません" }); }
    const [code, out] = savePartsChara(body || {}, pm[1]);
    if (code !== 200) return sendJson(res, code, { error: out });
    broadcast();
    bakeMissing();
    return sendJson(res, 200, { id: `${PARTS_AUTHOR}/${out.id}` });
  }

  if (p === "/parts.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(partsModule());
  }

  if (p === "/charas.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(charasModule());
  }

  const sp = p.match(/^\/sprites\/([a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9_-]*)\/(dial\/)?([AB][1-3])\.bin$/);
  if (sp && ID_RE.test(sp[1])) return sendFile(res, path.join(SPRITES_DIR, sp[1], sp[2] ? "dial" : "", `${sp[3]}.bin`));

  const im = p.match(/^\/img\/chars\/(.+)\.png$/);
  if (im && ID_RE.test(im[1])) {
    const [author, name] = im[1].split("/");
    return sendFile(res, author === PARTS_AUTHOR ? partsImageFile(name) : charaFile(im[1], "_front.png"));
  }

  if (p === "/") return sendFile(res, path.join(PUBLIC_DIR, "office.html"));
  if (p === "/me" || /^\/me\/[\w-]+$/.test(p)) return sendFile(res, path.join(PUBLIC_DIR, "me.html"));
  if (p === "/join") return sendFile(res, path.join(PUBLIC_DIR, "join.html"));
  if (p === "/admin") return sendFile(res, path.join(PUBLIC_DIR, "admin.html"));
  if (p === "/tap" || /^\/tap\/[A-Z0-9]+$/.test(p)) return sendFile(res, path.join(PUBLIC_DIR, "tap.html"));
  if (p === "/desks") { res.writeHead(302, { Location: "/admin" }); return res.end(); } // 前の「机の Dial」の画面は管理にまとめた

  // public/ 以下の静的ファイル
  const file = path.normalize(path.join(PUBLIC_DIR, p));
  if (file.startsWith(PUBLIC_DIR + path.sep)) return sendFile(res, file);
  res.writeHead(404); res.end("not found");
});

tick();
server.on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  console.error(`ポート ${PORT} はほかのプログラムが使っています（サーバがもう起動しているかもしれません）。`);
  console.error(`  使っているもの:  lsof -i :${PORT}`);
  console.error(`  止めるには:      kill $(lsof -tiTCP:${PORT} -sTCP:LISTEN)`);
  console.error(`  別のポートで:    PORT=${PORT + 1} node server/server.js`);
  process.exit(1);
});
server.listen(PORT, "0.0.0.0", () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal).map((i) => i.address);
  console.log("電脳オフィス サーバを起動しました");
  console.log(`  この Mac:  http://localhost:${PORT}/`);
  for (const ip of ips) console.log(`  社内LAN:   http://${ip}:${PORT}/`);
  console.log(`  席の決め方: ${FREE ? "フリーアドレス（SEAT_MODE=free）" : "固定席（SEAT_MODE=fixed）"}`);
  console.log(`  夜のリセット: 毎日 ${RESET_AT}（${FREE ? "全員の席を空ける" : "全員を不在に戻す"}）`);
  console.log(`  登録: http://localhost:${PORT}/join　管理: http://localhost:${PORT}/admin${FREE ? `　NFC タグの URL: http://<社内LAN のアドレス>:${PORT}/tap` : ""}`);
  // StopWatch 用のはんこ：起動時と、その後10分ごとに新しく完成したキャラを焼く
  bakeMissing();
  setInterval(bakeMissing, 10 * 60 * 1000);
});
