// 電脳オフィス サーバ（マイページ + オフィス表示）
//
// 在席・ひとりごと・キャラ設定を1か所で持ち、ブラウザ（今後は StopWatch も）に同じデータを配る。
// 依存パッケージなし（Node.js 18 以上）。状態は data/state.json に保存する。
//
//   node server.js            → http://<この Mac の IP>:8080/
//   PORT=3000 RESET_AT=21:30 node server.js
//
// 画面
//   /          オフィス（島6席の様子を Three.js で。キャラは /charas.js）
//   /me        マイページ（自分を選ぶ）
//   /me/<id>   マイページ（在席・ひとりごと・キャラ）
// API
//   GET   /api/state            全員の状態
//   GET   /api/characters       キャラ一覧（characters/characters.json から）
//   PATCH /api/members/<id>     { present?, comment?: {text, duration} | null, character?: "c01" | null }
//   GET   /api/events           状態が変わるたびに "state" を送る（Server-Sent Events）
//   GET   /api/device           StopWatch 用の軽い形式（1行1席のタブ区切り）
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

// メンバーは members.json（自分のオフィス用。無ければ members.example.json のサンプル）
const MEMBERS_FILE = ["members.json", "members.example.json"].map((f) => path.join(__dirname, f)).find((f) => fs.existsSync(f));
const MEMBERS = JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8"));
const PRESETS = ["集中モード", "寒い…", "暑い…", "午後から会議", "話しかけOK", "休憩中", "おなかすいた"];
const DURATIONS = [
  { id: "30m", label: "30分" },
  { id: "2h", label: "2時間" },
  { id: "today", label: "今日中" },
];
const COMMENT_MAX = 20;

// ---------- キャラ一覧 ----------

// characters.json（[{ id: "c01", feature: "紺髪おさげ、…", label?, wip? }]）を読む。ファイルが更新されても毎回読み直す。
function loadCharacters() {
  let entries = [];
  try { entries = JSON.parse(fs.readFileSync(path.join(CHARACTERS_DIR, "characters.json"), "utf8")); } catch { return []; }
  const list = [];
  for (const e of entries) {
    if (!e || !/^c\d{2}$/.test(e.id)) continue;
    const feature = String(e.feature || "");
    const hasImage = fs.existsSync(path.join(CHARACTERS_DIR, `${e.id}_front.png`));
    list.push({
      id: e.id,
      label: e.label || feature.split("、")[0] || e.id,
      feature,
      status: e.wip ? "制作中" : "完成",
      available: !e.wip,
      image: hasImage ? `/img/chars/${e.id}.png` : null,
    });
  }
  return list;
}

// 3D オフィス用：完成したキャラの cXX.html から、キャラを組み立てる部分（const C = { 〜 // ---- set:）を
// 切り出して1つの ES モジュールにする。
// 共通の材質（toon・輪郭など）は呼び出し側から渡す。
function charasModule() {
  const parts = [];
  for (const c of loadCharacters()) {
    if (!c.available) continue;
    let src;
    try { src = fs.readFileSync(path.join(CHARACTERS_DIR, `${c.id}.html`), "utf8"); } catch { continue; }
    const a = src.indexOf("const C = {"), b = src.indexOf("// ---- set:");
    if (a < 0 || b < a) continue;
    parts.push(`charas[${JSON.stringify(c.id)}] = () => {\n${src.slice(a, b)}\nreturn makeChara();\n};`);
  }
  return [
    "// characters/cXX.html から server.js が自動で組み立てたキャラ一覧",
    "export default function makeCharas({ THREE, toon, outlineMat, ramp, rampSoft, outlineUniforms }) {",
    "const charas = {};",
    ...parts,
    "return charas;",
    "}",
  ].join("\n");
}

// ---------- StopWatch 用のはんこ（tools/bake_chara.py が焼く、席ごとの差分スプライト） ----------

const SPRITES_DIR = path.join(__dirname, "sprites");
const TOOLS_DIR = path.join(__dirname, "..", "tools");
const OFFICE_SEATS = ["B1", "B2", "B3", "A1", "A2", "A3"]; // 3D オフィスで仮キャラを決める並び

// 3D に出せる完成キャラ（cXX.html があるもの）。characters.json の順
function chara3dIds() {
  return loadCharacters()
    .filter((c) => c.available && fs.existsSync(path.join(CHARACTERS_DIR, `${c.id}.html`)))
    .map((c) => c.id);
}

// StopWatch に出すキャラ。未設定の人は 3D オフィスと同じく、席ごとに決まった完成キャラ
function displayCharacter(m, ids) {
  if (m.character && ids.includes(m.character.id)) return m.character.id;
  const i = OFFICE_SEATS.indexOf(m.seat);
  return ids.length && i >= 0 ? ids[i % ids.length] : "";
}

// 焼いた日時（まだ焼いていなければ 0）。StopWatch はこれが変わったら取り直す
function spriteVersion(cid) {
  try { return JSON.parse(fs.readFileSync(path.join(SPRITES_DIR, cid, "meta.json"), "utf8")).bakedAt || 0; } catch { return 0; }
}

// まだ焼いていない（または cXX.html が焼いた後に直された）完成キャラを焼く。tools/.venv が無ければ何もしない
let baking = false;
function bakeMissing() {
  const py = path.join(TOOLS_DIR, ".venv", "bin", "python");
  if (baking || !fs.existsSync(py)) return;
  const todo = chara3dIds().filter((cid) => {
    const v = spriteVersion(cid);
    const edited = fs.statSync(path.join(CHARACTERS_DIR, `${cid}.html`)).mtimeMs / 1000;
    return !v || edited > v;
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
  return { present: false, comment: null, character: null, updatedAt: null };
}

function loadState() {
  let s = {};
  try { s = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch {}
  s.members = s.members || {};
  for (const m of MEMBERS) s.members[m.id] = { ...freshMember(), ...s.members[m.id] };
  if (!s.lastResetAt) s.lastResetAt = lastResetBoundary(Date.now());
  return s;
}

let state = loadState();
let saveTimer = null;

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
    }
    state.lastResetAt = boundary;
    save();
    console.log(`[${new Date(now).toLocaleString("ja-JP")}] 夜のリセット：全員を不在にしました`);
  }
  if (changed) save();
  return changed;
}

function publicState() {
  const chars = Object.fromEntries(loadCharacters().map((c) => [c.id, c]));
  return {
    resetAt: RESET_AT,
    commentMax: COMMENT_MAX,
    presets: PRESETS,
    durations: DURATIONS,
    members: MEMBERS.map((info) => {
      const m = state.members[info.id];
      const c = m.character && chars[m.character];
      return {
        ...info,
        present: m.present,
        comment: m.comment,
        character: c ? { id: c.id, label: c.label, image: c.image } : null,
        updatedAt: m.updatedAt,
      };
    }),
  };
}

// ---------- 更新 ----------

function applyPatch(id, body) {
  const m = state.members[id];
  if (!m) return [404, "そのメンバーはいません"];
  const now = Date.now();
  const next = {}; // 全部チェックしてからまとめて反映する

  if ("present" in body) {
    if (typeof body.present !== "boolean") return [400, "present は true / false"];
    next.present = body.present;
  }
  if ("comment" in body) {
    if (body.comment === null) {
      next.comment = null;
    } else {
      const text = String((body.comment && body.comment.text) || "").replace(/\s+/g, " ").trim();
      if (!text) return [400, "ひとりごとが空です"];
      if ([...text].length > COMMENT_MAX) return [400, `ひとりごとは${COMMENT_MAX}文字まで`];
      const duration = DURATIONS.some((d) => d.id === body.comment.duration) ? body.comment.duration : "2h";
      next.comment = { text, duration, until: commentUntil(duration, now), at: now };
    }
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
  Object.assign(m, next, { updatedAt: now });
  save();
  broadcast();
  return [200, null];
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

function sendFile(res, file) {
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Content-Length": buf.length });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => { raw += c; if (raw.length > 10000) req.destroy(); });
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
  if (p === "/api/device" && req.method === "GET") {
    tick();
    const clean = (s) => String(s || "").replace(/[\t\r\n]+/g, " ");
    const ids = chara3dIds();
    const lines = publicState().members.map((m) => {
      const cid = displayCharacter(m, ids);
      return [m.seat, m.id, m.present ? 1 : 0, clean(m.name), clean(m.comment && m.comment.text), cid, cid ? spriteVersion(cid) : 0].join("\t");
    });
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

  if (p === "/charas.js") {
    res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(charasModule());
  }

  const sp = p.match(/^\/sprites\/(c\d{2})\/([AB][1-3])\.bin$/);
  if (sp) return sendFile(res, path.join(SPRITES_DIR, sp[1], `${sp[2]}.bin`));

  const im = p.match(/^\/img\/chars\/(c\d{2})\.png$/);
  if (im) return sendFile(res, path.join(CHARACTERS_DIR, `${im[1]}_front.png`));

  if (p === "/") return sendFile(res, path.join(PUBLIC_DIR, "office.html"));
  if (p === "/me" || /^\/me\/[\w-]+$/.test(p)) return sendFile(res, path.join(PUBLIC_DIR, "me.html"));

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
  console.log(`  夜のリセット: 毎日 ${RESET_AT}（全員を不在に戻す）`);
  // StopWatch 用のはんこ：起動時と、その後10分ごとに新しく完成したキャラを焼く
  bakeMissing();
  setInterval(bakeMissing, 10 * 60 * 1000);
});
