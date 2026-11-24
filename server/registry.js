// 電脳オフィス 名簿（メンバー・カード・Dial）
//
// 固定席（SEAT_MODE=fixed）とフリーアドレス（SEAT_MODE=free）の両方で使う。保存先は data/registry.json（git に入らない）。
//   { members: [{ id, name, seat, card, sample?, createdAt }],
//     dials: { <mac>: { role, owner, seat, label, seenAt } } }
//   - members[].seat：固定席では「その人の席」（1 席に 1 人）。フリーアドレスでは「いつもの席」（無くてよい・重なってよい）
//   - card はカードの番号そのものではなく、番号から作った指紋（sha256）。ファイルを見てもカードの番号は分からない
//   - sample: true は members.example.json から入れたサンプルの人。本物の人が登録すると入れ替わる
//   - Dial の role：
//       固定席        "none"（未設定）/ "shared"（全体用）/ "personal"（owner の人専用）
//       フリーアドレス "none"（机が未設定）/ "desk"（seat の机に置いた Dial）
//     もう一方のモードの役割は消さずに持っておき、今のモードでは "none" として扱う（モードを戻すと元に戻る）
//
// 最初の起動で registry.json が無ければ、members.json（無ければ members.example.json をサンプルとして）から作る。
// カードは 4 桁の番号で人と結ぶ：未登録のカードを Dial にかざす → Dial に番号が出る → /join かマイページで番号を入れる。
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NAME_MAX = 20;
const LABEL_MAX = 20;
const CODE_TTL = 10 * 60 * 1000;  // 4 桁の番号の有効期限
const ONLINE_MS = 30 * 1000;      // これより最近に同期していれば「つながっている」
const ROLES = { fixed: ["none", "shared", "personal"], free: ["none", "desk"] };
const CODE_ERROR = "その番号は見つかりません（10 分で切れます。もう一度カードをかざしてください）";

function createRegistry({ dataDir, seedFiles, seats, mode, onChange }) {
  const FILE = path.join(dataDir, "registry.json");
  const fixed = mode === "fixed";
  const codes = new Map();  // "1234" → { card, mac, expires }
  let seenDirty = false;
  let reg = load();

  function load() {
    try {
      const r = JSON.parse(fs.readFileSync(FILE, "utf8"));
      return { members: Array.isArray(r.members) ? r.members : [], dials: r.dials || {} };
    } catch {}
    // 初回：手で書いた members.json があればそれを、無ければサンプルを入れる
    const [file, sample] = seedFiles.map((f) => [f, f.endsWith(".example.json")]).find(([f]) => fs.existsSync(f)) || [];
    let seed = [];
    try { seed = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    const r = {
      members: (Array.isArray(seed) ? seed : []).filter((m) => m && /^[\w-]+$/.test(m.id))
        .map((m) => ({ id: m.id, name: String(m.name || m.id), seat: seats.includes(m.seat) ? m.seat : null, card: null,
          ...(sample ? { sample: true } : {}), createdAt: Date.now() })),
      dials: {},
    };
    write(r);
    if (file) console.log(`名簿を ${path.basename(file)} から作りました（${FILE}）`);
    return r;
  }

  function write(r = reg) {
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(r, null, 2));
    fs.renameSync(tmp, FILE);
    seenDirty = false;
  }
  // Dial が同期しに来た時刻だけが変わったときは、1 分に 1 回まとめて書く
  setInterval(() => { if (seenDirty) write(); }, 60 * 1000).unref();

  function changed() { write(); onChange(); }

  const fingerprint = (uid) => crypto.createHash("sha256").update(`denno-card:${String(uid).toUpperCase()}`).digest("hex").slice(0, 32);
  const member = (id) => reg.members.find((m) => m.id === id);
  const byCard = (card) => reg.members.find((m) => m.card && m.card === card);
  const cleanName = (s) => String(s || "").replace(/\s+/g, " ").trim();
  const cleanMac = (s) => String(s || "").toLowerCase().replace(/[^0-9a-f]/g, "");
  const isMac = (mac) => /^[0-9a-f]{12}$/.test(mac);

  // ---------- 席 ----------

  // 固定席で、その席にいる人（サンプルも含む）
  const seatHolder = (seat) => reg.members.find((m) => m.seat === seat);

  // その席を使ってよいか：固定席なら空いている・サンプルの人がいる・自分の席。フリーアドレス（いつもの席）は重なってよい
  function seatOk(seat, exceptId) {
    if (seat === null) return !fixed;
    if (!seats.includes(seat)) return false;
    if (!fixed) return true;
    const h = seatHolder(seat);
    return !h || h.sample || h.id === exceptId;
  }

  // 本物の人が登録・席を変えたとき、サンプルの人をどかす。固定席はその席のサンプルだけ、フリーアドレスはサンプル全員
  function dropSamples(seat) {
    for (const m of [...reg.members]) if (m.sample && (!fixed || m.seat === seat)) removeMember(m.id, false);
  }

  // ---------- カード ----------

  function issueCode(uid, mac) {
    const card = fingerprint(uid);
    const now = Date.now();
    for (const [c, v] of codes) if (v.expires < now) codes.delete(c);
    for (const [c, v] of codes) if (v.card === card) { Object.assign(v, { mac, expires: now + CODE_TTL }); return c; }
    let c;
    do c = String(crypto.randomInt(10000)).padStart(4, "0"); while (codes.has(c));
    codes.set(c, { card, mac, expires: now + CODE_TTL });
    return c;
  }

  function useCode(code) {
    const v = codes.get(String(code || "").trim());
    return v && v.expires >= Date.now() ? v : null;
  }

  // /join・マイページで番号を確かめる
  function checkCode(code) {
    const v = useCode(code);
    if (!v) return null;
    const d = reg.dials[v.mac];
    const other = byCard(v.card);
    return { dialRole: d ? roleOf(d) : null, usedBy: other ? { id: other.id, name: other.name } : null };
  }

  // 番号で見つけたカードを人に付ける（前のカードは使えなくなる）。エラーなら文を返す
  function attachCard(m, code) {
    const v = useCode(code);
    if (!v) return CODE_ERROR;
    const other = byCard(v.card);
    if (other && other.id !== m.id) return `このカードはもう ${other.name} さんが使っています`;
    m.card = v.card;
    for (const [c, x] of codes) if (x.card === v.card) codes.delete(c);
    return null;
  }

  function linkCard(id, code) {
    const m = member(id);
    if (!m) return "そのメンバーはいません";
    const err = attachCard(m, code);
    if (err) return err;
    delete m.sample;
    changed();
    return null;
  }

  function unlinkCard(id) {
    const m = member(id);
    if (!m) return "そのメンバーはいません";
    m.card = null;
    changed();
    return null;
  }

  // ---------- メンバー ----------

  function nextId() {
    let n = 0;
    for (const m of reg.members) { const k = /^u(\d+)$/.exec(m.id); if (k) n = Math.max(n, Number(k[1])); }
    return `u${String(n + 1).padStart(3, "0")}`;
  }

  // /join から { name, seat, code? }。[状態コード, エラー or { id }]
  function register(body) {
    const name = cleanName(body.name);
    if (!name) return [400, "名前を入れてください"];
    if ([...name].length > NAME_MAX) return [400, `名前は${NAME_MAX}文字まで`];
    const seat = body.seat || null;
    if (fixed && !seat) return [400, "席を選んでください"];
    if (!seatOk(seat)) return [400, fixed ? "その席はもう使われています" : "その席はありません"];
    if (body.code) {
      const v = useCode(body.code);
      if (!v) return [400, CODE_ERROR];
      if (byCard(v.card)) return [400, `このカードはもう ${byCard(v.card).name} さんが使っています`];
    }
    dropSamples(seat);
    const m = { id: nextId(), name, seat, card: null, createdAt: Date.now() };
    reg.members.push(m);
    if (body.code) attachCard(m, body.code);
    changed();
    console.log(`登録: ${m.id} ${m.name}${seat ? `（${seat}）` : ""}`);
    return [200, { id: m.id }];
  }

  function removeMember(id, notify = true) {
    const i = reg.members.findIndex((m) => m.id === id);
    if (i < 0) return false;
    reg.members.splice(i, 1);
    for (const d of Object.values(reg.dials)) if (d.owner === id) Object.assign(d, { role: d.role === "personal" ? "none" : d.role, owner: null });
    if (notify) changed();
    return true;
  }

  // /admin から { name?, seat?, card?: null }
  function editMember(id, body) {
    const m = member(id);
    if (!m) return [404, "そのメンバーはいません"];
    if ("name" in body) {
      const name = cleanName(body.name);
      if (!name || [...name].length > NAME_MAX) return [400, `名前は1〜${NAME_MAX}文字`];
      m.name = name;
    }
    if ("seat" in body && (body.seat || null) !== m.seat) {
      const seat = body.seat || null;
      if (!seatOk(seat, id)) return [400, fixed ? "その席はもう使われています" : "その席はありません"];
      if (fixed) dropSamples(seat);
      m.seat = seat;
    }
    if (body.card === null) m.card = null;
    delete m.sample;  // 直した人はサンプルではなくなる
    changed();
    return [200, null];
  }

  // ---------- Dial ----------

  // 今のモードでの役割（もう一方のモードの役割は "none"。持ち主・机がいなくなったときも "none"）
  function roleOf(d) {
    if (!ROLES[mode].includes(d.role)) return "none";
    if (d.role === "personal" && !member(d.owner)) return "none";
    if (d.role === "desk" && !seats.includes(d.seat)) return "none";
    return d.role;
  }

  // /api/device?board=dial&mac=… と /api/card が来るたびに呼ぶ。初めての Dial なら覚える
  function seen(mac) {
    if (!isMac(mac)) return null;
    let d = reg.dials[mac];
    if (!d) {
      d = reg.dials[mac] = { role: "none", owner: null, seat: null, label: "", seenAt: Date.now() };
      write();
      console.log(`新しい Dial: ${mac}（/admin で役割を決めてください）`);
    } else {
      d.seenAt = Date.now();
      seenDirty = true;
    }
    return d;
  }

  // この Dial の役割 { role, seat, owner }。seat：個人用なら持ち主の席、机なら置いた机
  function dialInfo(mac) {
    const d = reg.dials[mac];
    const role = d ? roleOf(d) : "none";
    const o = role === "personal" ? member(d.owner) : null;
    return { role, seat: role === "desk" ? d.seat : o ? o.seat : null, owner: o ? { id: o.id, name: o.name } : null };
  }

  function dialList() {
    const now = Date.now();
    return Object.entries(reg.dials).map(([mac, d]) => {
      const info = dialInfo(mac);
      return { mac, role: info.role, owner: info.owner ? info.owner.id : null, ownerName: info.owner ? info.owner.name : null,
        seat: info.seat, label: d.label || "", seenAt: d.seenAt || null, online: now - (d.seenAt || 0) < ONLINE_MS };
    }).sort((a, b) => (a.seat || "~").localeCompare(b.seat || "~") || (b.seenAt || 0) - (a.seenAt || 0));
  }

  // /admin から { role?, owner?, seat?, label? }
  function editDial(mac, body) {
    const d = reg.dials[mac];
    if (!d) return [404, "その Dial はありません"];
    if ("label" in body) d.label = cleanName(body.label).slice(0, LABEL_MAX);
    if ("role" in body) {
      if (!ROLES[mode].includes(body.role)) return [400, "役割が分かりません"];
      if (body.role === "personal") {
        if (!member(body.owner)) return [400, "専用にする人を選んでください"];
        Object.assign(d, { role: "personal", owner: body.owner });
      } else if (body.role === "desk") {
        if (!seats.includes(body.seat)) return [400, "置いた机を選んでください"];
        // 同じ机にいた別の Dial は外す
        for (const x of Object.values(reg.dials)) if (x !== d && x.role === "desk" && x.seat === body.seat) Object.assign(x, { role: "none", seat: null });
        Object.assign(d, { role: "desk", seat: body.seat });
      } else if (fixed) {
        Object.assign(d, { role: body.role, owner: null });
      } else {
        Object.assign(d, { role: body.role, seat: null });
      }
    }
    changed();
    return [200, null];
  }

  function removeDial(mac) {
    if (!reg.dials[mac]) return false;
    delete reg.dials[mac];
    changed();
    return true;
  }

  return {
    cleanMac, isMac,
    // 画面に出す名簿（カードの指紋は出さない）。固定席は席の順
    members: () => [...reg.members]
      .sort((a, b) => (fixed ? (seats.indexOf(a.seat) + 1 || 99) - (seats.indexOf(b.seat) + 1 || 99) : 0))
      .map((m) => ({ id: m.id, name: m.name, seat: m.seat, card: !!m.card, ...(m.sample ? { sample: true } : {}) })),
    member: (id) => member(id),
    memberOfCard: (uid) => byCard(fingerprint(uid)) || null,
    issueCode, checkCode, linkCard, unlinkCard,
    register, editMember, removeMember: (id) => removeMember(id),
    seen, dialInfo, dialList, editDial, removeDial,
    // フリーアドレスで Dial を置いてある机
    deskSeats: () => [...new Set(Object.keys(reg.dials).map((mac) => dialInfo(mac)).filter((x) => x.role === "desk").map((x) => x.seat))],
  };
}

module.exports = { createRegistry };
