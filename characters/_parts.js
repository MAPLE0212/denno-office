// パーツでキャラを作る（マイページの「パーツで作る」）
//
// maple のキャラ（c01・c02・c03・c05・c06・c07・c08・c09・c15）の髪型・帽子・服・ズボン・くつ・小物を部品にしたもの。
// レシピ（どの部品を選んで何色にしたか）から makePartsChara(recipe) で1体を組み立てる。
// サーバがこのファイルを /charas.js（オフィス）と /parts.js（マイページの作成画面）に埋め込む。
// キャラ本体と同じく、THREE と toon / outlineMat / ramp / rampSoft / outlineUniforms だけを使う。

// 選べる部品（id はレシピに入る。変えると、その id で作ったキャラは既定の部品に戻る）
const PARTS = {
  hair: [
    { id: "braids", label: "おさげ" },
    { id: "bob", label: "ボブ" },
    { id: "longbob", label: "外はねボブ" },
    { id: "buns", label: "おだんご" },
    { id: "short", label: "ショート" },
    { id: "spiky", label: "ツンツン" },
    { id: "flick", label: "はね毛" },
    { id: "wavy", label: "ウェーブロング" },
  ],
  hat: [
    { id: "none", label: "なし" },
    { id: "knit", label: "ニット帽" },
    { id: "beret", label: "ベレー帽" },
  ],
  top: [
    { id: "jacket", label: "Tシャツ＋ジャケット" },
    { id: "cardigan", label: "シャツ＋カーディガン" },
    { id: "shirt", label: "ボタンシャツ" },
    { id: "apron", label: "エプロンワンピース" },
    { id: "hoodie", label: "パーカー" },
    { id: "zip", label: "ジップパーカー" },
    { id: "knit", label: "ケーブルニット" },
    { id: "coat", label: "ダブルコート" },
    { id: "duffle", label: "ダッフルコート" },
  ],
  bottom: [
    { id: "long", label: "長ズボン" },
    { id: "cropped", label: "短めズボン" },
  ],
  shoes: [
    { id: "plain", label: "ふつう" },
    { id: "sneaker", label: "スニーカー" },
    { id: "boots", label: "ブーツ" },
  ],
  acc: [
    { id: "none", label: "なし" },
    { id: "backpack", label: "リュック" },
    { id: "scarf", label: "マフラー" },
  ],
  brows: [
    { id: "normal", label: "ふつう" },
    { id: "thick", label: "太め" },
    { id: "down", label: "たれ" },
    { id: "up", label: "きりっと" },
    { id: "none", label: "なし" },
  ],
};

// 色の見本（今いるキャラの色から）。マイページではこのほかに好きな色も選べる
const PARTS_PALETTE = {
  hairColor: [0x332f78, 0x1f5878, 0x237a55, 0x7a5ad8, 0x1f2244, 0x1d2531, 0x8a4a3a, 0xd9a24a, 0xe58fb6, 0xdfe4f2],
  topColor: [0x22346e, 0x9cc0d4, 0xa8cdf2, 0x3d7484, 0xb7a6f2, 0x4f6fc8, 0xe9a9e2, 0xf2d27a, 0xd06a6a, 0x2a2a3a],
  subColor: [0xeef1ff, 0xc9f5ee, 0x8ea6ee, 0xaebcf2, 0xf7d9e6, 0xfff1c9, 0x3a3f5a],
  bottomColor: [0x8a91a6, 0x232f6b, 0x1b1f2e, 0x262d4a, 0x4b3a8e, 0x232a47, 0x6b5a48, 0x9cc0d4],
  shoesColor: [0x2a2440, 0x86c8ea, 0x2a3550, 0x3f8f95, 0x262a4c, 0xb7c3f4, 0xf2f2f8, 0xd06a6a],
  eyeColor: [0x3a2432, 0x2c2638, 0x2a4a7a, 0x2f6a4a, 0x6a3a7a, 0x7a4a2a],
  hatColor: [0x463a96, 0xf7a2d2, 0x22346e, 0xd06a6a, 0xf2d27a, 0x2a2a3a, 0xeef1ff],
  accColor: [0x8cc6ff, 0x2a2f63, 0xf7a2d2, 0xf2d27a, 0xd06a6a, 0x7ee0b8, 0xeef1ff],
};

const PARTS_DEFAULT = {
  hair: "bob", hat: "none", top: "cardigan", bottom: "long", shoes: "plain", brows: "normal", acc: "none",
  hairColor: 0x1f5878, topColor: 0x9cc0d4, subColor: 0xc9f5ee, bottomColor: 0x232f6b, shoesColor: 0x86c8ea, eyeColor: 0x2c2638,
  hatColor: 0x463a96, accColor: 0x8cc6ff,
};

function makePartsChara(recipe) {
  const R0 = { ...PARTS_DEFAULT, ...(recipe || {}) };
  const pick = (k) => (PARTS[k].some((o) => o.id === R0[k]) ? R0[k] : PARTS_DEFAULT[k]);
  const col = (k) => (Number.isInteger(R0[k]) && R0[k] >= 0 && R0[k] <= 0xffffff ? R0[k] : PARTS_DEFAULT[k]);
  const style = { hair: pick("hair"), hat: pick("hat"), top: pick("top"), bottom: pick("bottom"), shoes: pick("shoes"), brows: pick("brows"), acc: pick("acc") };
  // 前髪はぱっつん。ツンツン・はね毛は毛束が、ウェーブロングは分けた前髪がその代わり
  style.bangs = { spiky: "none", flick: "none", wavy: "curtain" }[style.hair] || "blunt";

  const lighten = (c, t) => new THREE.Color(c).lerp(new THREE.Color(0xffffff), t).getHex();
  const darken = (c, t) => new THREE.Color(c).multiplyScalar(1 - t).getHex();
  // 輪郭の発光色：同じ色合いで鮮やかに。白っぽい・灰色っぽい色は青紫にする。
  // 緑や黄色は同じ明るさでも目にまぶしく、StopWatch の小さな画面で光がにじむので、
  // 見た目の明るさ（緑を重く数える）が c01 の髪の輪郭（0x9a86ff）くらいを超えないよう暗くする
  const glow = (c) => {
    const hsl = {};
    new THREE.Color(c).getHSL(hsl);
    if (hsl.s < 0.15) return 0x8fa4ff;
    const hx = new THREE.Color().setHSL(hsl.h, Math.min(0.9, hsl.s * 0.5 + 0.45), 0.6).getHex();
    const rgb = [hx >> 16, (hx >> 8) & 255, hx & 255];
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const k = Math.min(1, 0.5 / lum);
    return rgb.reduce((a, v) => (a << 8) | Math.round(v * k), 0);
  };

  const C = {
    skin: 0xfbe6e8, nose: 0xe39aab, cheek: 0xf59fb6, mouth: 0x9c4d60, tie: 0x8f6bff,
    hair: col("hairColor"), top: col("topColor"), sub: col("subColor"), pants: col("bottomColor"), shoes: col("shoesColor"), eye: col("eyeColor"),
    hat: col("hatColor"), acc: col("accColor"),
  };
  C.hairHi = lighten(C.hair, 0.3);
  const O = { hair: glow(C.hair), top: glow(C.top), sub: glow(C.sub), pants: glow(C.pants), shoes: glow(C.shoes), hat: glow(C.hat), acc: glow(C.acc), skin: 0xb9a8ff };

  function part(parent, geo, color, outline, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
    const m = new THREE.Mesh(geo, toon(color));
    m.position.set(...pos); m.rotation.set(...rot); m.scale.set(...scl);
    if (outline != null) m.add(new THREE.Mesh(geo, outlineMat(outline)));
    parent.add(m);
    return m;
  }
  // 頂点ごとに色を変える部品（パーカーとニット帽のグラデーション）
  function vcPart(parent, geo, fn, outline, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
    const p = geo.attributes.position, cs = [];
    for (let i = 0; i < p.count; i++) { const c = fn(p.getX(i), p.getY(i), p.getZ(i)); cs.push(c.r, c.g, c.b); }
    geo.setAttribute("color", new THREE.Float32BufferAttribute(cs, 3));
    const mat = toon(0xffffff); mat.vertexColors = true; mat.side = THREE.DoubleSide;
    const m = new THREE.Mesh(geo, mat);
    m.position.set(...pos); m.rotation.set(...rot); m.scale.set(...scl);
    if (outline != null) m.add(new THREE.Mesh(geo, outlineMat(outline)));
    parent.add(m);
    return m;
  }
  function joint(parent, x, y, z) { const g = new THREE.Group(); g.position.set(x, y, z); parent.add(g); return g; }
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, Math.max(0.001, len), 6, 16);
  const P = Math.PI;
  const V2 = (arr) => arr.map(([r, y]) => new THREE.Vector2(r, y));

  const root = new THREE.Group();
  const hips = joint(root, 0, 0.295, 0);
  const J = { root, hips };

  // ---- 脚とくつ ----
  part(hips, new THREE.SphereGeometry(0.075, 20, 14), C.pants, O.pants, [0, 0.005, 0], [0, 0, 0], [1.25, 0.7, 1]);
  for (const s of [-1, 1]) {
    const k = s < 0 ? "L" : "R";
    const thigh = joint(hips, s * 0.045, 0, 0);
    part(thigh, capsule(0.042, 0.06), C.pants, O.pants, [0, -0.065, 0]);
    const knee = joint(thigh, 0, -0.13, 0);
    if (style.bottom === "cropped") { // c06：すそを折った短めのズボンと足首
      part(knee, capsule(0.038, 0.035), C.pants, O.pants, [0, -0.045, 0]);
      part(knee, new THREE.CylinderGeometry(0.041, 0.041, 0.016, 16), C.pants, O.pants, [0, -0.082, 0]);
      part(knee, capsule(0.026, 0.03), C.skin, O.skin, [0, -0.1, 0]);
    } else {
      part(knee, capsule(0.038, 0.06), C.pants, O.pants, [0, -0.06, 0]);
    }
    const ankle = joint(knee, 0, -0.13, 0);
    if (style.shoes === "boots") { // c09：すねまでのブーツ（上を少し折り返す）
      part(knee, new THREE.CylinderGeometry(0.041, 0.04, 0.085, 20), C.shoes, O.shoes, [0, -0.1, 0.002]);
      part(knee, new THREE.TorusGeometry(0.039, 0.008, 8, 22), C.shoes, O.shoes, [0, -0.058, 0.002], [P / 2, 0, 0]);
    }
    if (style.shoes === "boots") {
      part(ankle, new THREE.SphereGeometry(0.047, 18, 12), C.shoes, O.shoes, [0, -0.01, 0.02], [0, 0, 0], [1, 0.78, 1.45]);
    } else if (style.shoes === "sneaker") { // c15：白い靴底
      part(ankle, new THREE.SphereGeometry(0.045, 18, 12), C.shoes, O.shoes, [0, -0.01, 0.02], [0, 0, 0], [1.02, 0.72, 1.45]);
      part(ankle, new THREE.CylinderGeometry(0.046, 0.046, 0.012, 20), lighten(C.shoes, 0.75), null, [0, -0.033, 0.02], [0, 0, 0], [1.02, 1, 1.45]);
    } else {
      part(ankle, new THREE.SphereGeometry(0.045, 18, 12), C.shoes, O.shoes, [0, -0.012, 0.02], [0, 0, 0], [1, 0.75, 1.45]);
    }
    J["thigh" + k] = thigh; J["knee" + k] = knee;
  }

  // ---- 服（下に着るものを体のベースにして、上着は殻としてかぶせる） ----
  const chest = joint(hips, 0, 0.02, 0);
  J.chest = chest;
  // 襟（c03 のボタンシャツ・c06 のエプロンの下のシャツ）
  function collar(color, outline) {
    const back = part(chest, new THREE.CylinderGeometry(0.054, 0.074, 0.032, 28, 1, true, P * 0.28, P * 1.44),
      color, outline, [0, 0.212, -0.002], [0, 0, 0], [1.05, 1, 0.95]);
    back.material.side = THREE.DoubleSide;
    for (const s of [-1, 1]) {
      const tri = new THREE.Shape();
      tri.moveTo(0, 0);
      tri.quadraticCurveTo(s * 0.04, 0.006, s * 0.068, 0.036);
      tri.lineTo(s * 0.044, -0.03);
      tri.closePath();
      const geo = new THREE.ExtrudeGeometry(tri, { depth: 0.005, bevelEnabled: true, bevelThickness: 0.0015, bevelSize: 0.0015, bevelSegments: 1 });
      part(chest, geo, color, outline, [0, 0.2, 0.074], [-0.5, s * 0.32, 0]);
    }
    part(chest, new THREE.CylinderGeometry(0.05, 0.056, 0.035, 18), color, outline, [0, 0.215, 0]);
  }
  // 前の開いた上着（c01 のジャケット・c02 のカーディガン）。Lathe の phi 0 が正面
  function openShell(pts, openDeg) {
    const OPEN = THREE.MathUtils.degToRad(openDeg);
    const geo = new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 48, OPEN, P * 2 - OPEN * 2);
    const m = part(chest, geo, C.top, O.top, [0, 0, 0], [0, 0, 0], [1.12, 1, 0.88]);
    m.material.side = THREE.DoubleSide;
    return OPEN;
  }
  // すその口をふさぐ裏地（座ってすそを前に倒したとき、中が見えないように）。脚はこの面を突き抜けて出る
  function hemLining(skirt, pts, color) {
    const hem = pts.reduce((a, v) => (v.y < a.y ? v : a), pts[0]);
    const r = Math.max(...pts.map((v) => v.x));
    const m = new THREE.Mesh(new THREE.CircleGeometry(r, 40), toon(darken(color, 0.35)));
    m.material.side = THREE.DoubleSide;
    m.rotation.x = P / 2;
    m.position.y = hem.y + 0.004;
    m.visible = false;
    skirt.add(m);
    return m;
  }
  // 袖：色・太さ・袖口
  let sleeve = { color: C.top, outline: O.top, x: 0.115, r1: 0.036, r2: 0.033, cuff: null, hand: -0.1 };

  if (style.top === "jacket") { // c01：白T＋前を開けたジャケット
    part(chest, capsule(0.095, 0.1), C.sub, O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.88]);
    part(chest, new THREE.TorusGeometry(0.046, 0.009, 10, 24), C.sub, O.top, [0, 0.214, 0.004], [P / 2, 0, 0]);
    const OPEN = openShell([[0.106, -0.06], [0.103, -0.02], [0.101, 0.05], [0.101, 0.13], [0.098, 0.165], [0.088, 0.195], [0.072, 0.217], [0.058, 0.228]], 24);
    [0.06, 0.0].forEach((y) => part(chest, new THREE.SphereGeometry(0.0075, 10, 8), darken(C.top, 0.45), null,
      [-0.101 * 1.12 * Math.sin(OPEN) - 0.008, y, 0.101 * 0.88 * Math.cos(OPEN) + 0.002], [0, 0, 0], [1, 1, 0.5]));
  } else if (style.top === "cardigan") { // c02：シャツ＋すそが少し広がるカーディガン
    part(chest, capsule(0.095, 0.1), C.sub, O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.88]);
    part(chest, new THREE.TorusGeometry(0.046, 0.009, 10, 24), C.sub, O.top, [0, 0.214, 0.004], [P / 2, 0, 0]);
    openShell([[0.116, -0.065], [0.11, -0.03], [0.103, 0.02], [0.101, 0.13], [0.098, 0.165], [0.088, 0.195], [0.072, 0.217], [0.058, 0.228]], 26);
  } else if (style.top === "shirt") { // c03：ボタンシャツ＋ベルト
    const btn = darken(C.top, 0.55);
    part(chest, capsule(0.095, 0.1), C.top, O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.88]);
    part(chest, new THREE.BoxGeometry(0.013, 0.17, 0.004), btn, null, [0, 0.1, 0.0855]);
    [0.145, 0.108, 0.071, 0.034].forEach((y) => part(chest, new THREE.SphereGeometry(0.0075, 10, 8), btn, null, [0.022, y, 0.083], [0, 0, 0], [1, 1, 0.5]));
    collar(C.top, O.top);
    part(chest, new THREE.CylinderGeometry(0.108, 0.108, 0.026, 28), darken(C.pants, 0.5), null, [0, 0.0, 0], [0, 0, 0], [1.12, 1, 0.9]);
    part(chest, new THREE.BoxGeometry(0.03, 0.02, 0.006), 0xc8d2e6, null, [0, 0.0, 0.098]);
    part(chest, new THREE.BoxGeometry(0.018, 0.01, 0.007), darken(C.pants, 0.5), null, [0, 0.0, 0.099]);
    sleeve.cuff = C.top;
  } else if (style.top === "apron") { // c06：襟付きシャツ＋エプロンワンピース
    part(chest, capsule(0.095, 0.1), C.sub, O.sub, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.88]);
    collar(C.sub, O.sub);
    const dot = lighten(C.top, 0.55);
    const bib = part(chest, new THREE.CylinderGeometry(0.1, 0.104, 0.15, 24, 1, true, -0.62, 1.24), C.top, O.top, [0, 0.085, 0.004], [0, 0, 0], [1.13, 1, 0.94]);
    bib.material.side = THREE.DoubleSide;
    part(chest, new THREE.CylinderGeometry(0.109, 0.109, 0.04, 28), C.top, O.top, [0, 0.01, 0], [0, 0, 0], [1.12, 1, 0.9]);
    for (const s of [-1, 1]) { // 肩ひも：胸当ての角から肩を越えて背中で交差
      const pts = [[s * 0.05, 0.155, 0.088], [s * 0.062, 0.2, 0.064], [s * 0.07, 0.218, 0.0], [s * 0.055, 0.19, -0.075], [-s * 0.02, 0.09, -0.093], [-s * 0.07, 0.025, -0.092]]
        .map((p) => new THREE.Vector3(...p));
      part(chest, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, 0.0085, 6), C.top, O.top);
      part(chest, new THREE.SphereGeometry(0.008, 10, 8), dot, null, [s * 0.05, 0.148, 0.093], [0, 0, 0], [1, 1, 0.5]);
    }
    const skirtPts = [[0.106, 0.04], [0.11, 0.0], [0.122, -0.04], [0.136, -0.08], [0.148, -0.11], [0.15, -0.118], [0.136, -0.12]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const skirt = part(hips, new THREE.LatheGeometry(skirtPts, 40), C.top, O.top, [0, 0, 0], [0, 0, 0], [1.1, 1, 0.92]);
    skirt.material.side = THREE.DoubleSide;
    // スカートの前の「データの雨」の点
    const dotMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(dot).multiplyScalar(0.9) });
    const rAt = (y) => { for (let i = 1; i < skirtPts.length; i++) { const a = skirtPts[i - 1], b = skirtPts[i]; if (y <= a.y && y >= b.y) return a.x + (b.x - a.x) * (a.y - y) / (a.y - b.y); } return 0.13; };
    let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let c = -4; c <= 4; c++) {
      const ang = c * 0.13 + 0.03;
      const n = 2 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const y = -0.025 - rnd() * 0.08;
        const d = new THREE.Mesh(new THREE.BoxGeometry(0.004, 0.009 + rnd() * 0.012, 0.002), dotMat);
        d.position.set(Math.sin(ang) * (rAt(y) + 0.002), y, Math.cos(ang) * (rAt(y) + 0.002));
        d.rotation.y = ang; d.rotation.x = -0.25;
        skirt.add(d);
      }
    }
    // 座ったら椅子を突き抜けないよう、スカートをひざの上にたたむ。
    // 前に倒すとすその口が正面を向くので、上下（倒したあとの奥行き）につぶし、口は裏地でふさぐ
    const lining = hemLining(skirt, skirtPts, C.top);
    skirt.onBeforeRender = () => {
      const sit = THREE.MathUtils.clamp(-J.thighL.rotation.x / 1.5, 0, 1);
      skirt.scale.set(1.1 + 0.04 * sit, 1 - 0.1 * sit, 0.92 - 0.42 * sit);
      skirt.position.set(0, 0.01 * sit, 0);
      skirt.rotation.x = -1.05 * sit;
      lining.visible = sit > 0.3;
    };
    sleeve = { ...sleeve, color: C.sub, outline: O.sub, cuff: C.sub };
  } else if (style.top === "hoodie") { // c07：上から下へ色が変わるかぶりのパーカー
    const grad = (y, y0, y1) => new THREE.Color(C.sub).lerp(new THREE.Color(C.top), THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1));
    const rib = new THREE.Color(C.top).lerp(new THREE.Color(C.sub), 0.6).getHex();
    vcPart(chest, capsule(0.1, 0.1), (x, y) => grad(y, -0.1, 0.12), O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.9]);
    vcPart(chest, new THREE.TorusGeometry(0.09, 0.014, 10, 48), (x, y) => new THREE.Color(rib).multiplyScalar(0.92 + 0.08 * Math.cos(Math.atan2(y, x) * 40)),
      O.top, [0, 0.008, 0], [P / 2, 0, 0], [1.12, 0.9, 1]);
    part(chest, new THREE.TorusGeometry(0.072, 0.026, 12, 32, P * 1.62), C.top, O.top, [0, 0.205, -0.004], [P / 2 + 0.38, 0, P * 0.5 + P * 0.19], [1.08, 1, 0.85]);
    part(chest, new THREE.SphereGeometry(0.06, 24, 16), C.top, O.top, [0, 0.18, -0.085], [0.1, 0, 0], [1.3, 1.05, 0.55]);
    part(chest, new THREE.SphereGeometry(0.03, 14, 10), C.skin, null, [0, 0.214, 0.02], [0, 0, 0], [1.2, 0.8, 0.6]);
    sleeve = { ...sleeve, x: 0.118, r1: 0.039, r2: 0.036, hand: -0.102, grad, rib };
  } else if (style.top === "knit") { // c05：上から下へ少し暗くなるケーブルニット（これ1枚が体のベース）
    const knitBot = darken(C.top, 0.18), rib = darken(C.top, 0.3), cable = lighten(C.top, 0.25);
    const grad = (y, y0, y1) => new THREE.Color(knitBot).lerp(new THREE.Color(C.top), THREE.MathUtils.clamp((y - y0) / (y1 - y0), 0, 1));
    vcPart(chest, capsule(0.1, 0.1), (x, y) => grad(y, -0.15, 0.15), O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.9]);
    part(chest, new THREE.CylinderGeometry(0.108, 0.104, 0.034, 28), rib, O.top, [0, -0.012, 0], [0, 0, 0], [1.12, 1, 0.9]);
    part(chest, new THREE.TorusGeometry(0.05, 0.012, 10, 24), rib, O.top, [0, 0.212, 0.004], [P / 2, 0, 0], [1, 0.95, 1]);
    // 縄編み：斜めの粒を交差させた3本と、そのあいだの細い畝
    for (const x of [-0.042, 0, 0.042]) {
      for (let i = 0; i < 6; i++) {
        const zf = 0.09 * Math.sqrt(Math.max(0, 1 - (x / 0.112) ** 2)) + 0.001;
        for (const t of [-1, 1]) part(chest, new THREE.SphereGeometry(0.0075, 10, 8), cable, null, [x + t * 0.006, 0.03 + i * 0.028, zf], [0, x * 4, t * (i % 2 ? 0.7 : -0.7)], [0.75, 1.9, 0.45]);
      }
    }
    for (const x of [-0.064, -0.021, 0.021, 0.064]) {
      const zf = 0.09 * Math.sqrt(Math.max(0, 1 - (x / 0.112) ** 2)) - 0.001;
      part(chest, new THREE.CylinderGeometry(0.0025, 0.0025, 0.17, 6), cable, null, [x, 0.1, zf], [-0.05, 0, 0]);
    }
    // 編み込みの小さな星
    const sm = new THREE.MeshBasicMaterial({ color: lighten(C.top, 0.6) });
    let sd = 11; const rnd = () => ((sd = (sd * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 16; i++) {
      const ang = (rnd() - 0.5) * 2.2, y = 0.02 + rnd() * 0.16;
      const st = new THREE.Mesh(new THREE.OctahedronGeometry(0.0045, 0), sm);
      st.position.set(Math.sin(ang) * 0.112, y, Math.cos(ang) * 0.09 + 0.001); st.scale.set(1, 1, 0.4);
      st.lookAt(st.position.clone().multiplyScalar(2)); chest.add(st);
    }
    sleeve = { ...sleeve, x: 0.118, r1: 0.039, r2: 0.036, hand: -0.102, grad, rib, cuffRib: false };
  } else if (style.top === "coat" || style.top === "duffle") {
    // c08 のダブルコート（前が V に開いて襟が付く）と c09 のダッフルコート（トグルで閉じる）。
    // 中に着る服を体のベースにして、コートは殻としてかぶせる。すそは腰から下げて、座ったらひざの上にたたむ
    const duffle = style.top === "duffle";
    const hi = lighten(C.top, duffle ? 0.25 : 0.35), dk = darken(C.top, duffle ? 0.65 : 0.75);
    part(chest, capsule(0.095, 0.1), C.sub, O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.88]);
    if (!duffle) part(chest, new THREE.TorusGeometry(0.046, 0.011, 10, 24), C.sub, O.top, [0, 0.214, 0.004], [P / 2, 0, 0]);
    const SXc = 1.12, SZc = 0.88;
    const coatPts = duffle
      ? [[0.108, -0.06], [0.105, -0.02], [0.103, 0.05], [0.103, 0.13], [0.1, 0.165], [0.09, 0.195], [0.075, 0.217], [0.062, 0.23]]
      : [[0.107, -0.06], [0.104, -0.02], [0.102, 0.05], [0.102, 0.13], [0.099, 0.165], [0.089, 0.195], [0.073, 0.217], [0.059, 0.228]];
    const coatR = (y) => { for (let i = 1; i < coatPts.length; i++) { const a = coatPts[i - 1], b = coatPts[i]; if (y >= a[1] && y <= b[1]) return a[0] + (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]); } return y < 0 ? coatPts[0][0] : coatPts[coatPts.length - 1][0]; };
    const zSurf = (x, y) => { const r = coatR(y); return r * SZc * Math.sqrt(Math.max(0, 1 - (x / (r * SXc)) ** 2)); };
    if (duffle) {
      const coat = part(chest, new THREE.LatheGeometry(V2(coatPts), 48), C.top, O.top, [0, 0, 0], [0, 0, 0], [SXc, 1, SZc]);
      coat.material.side = THREE.DoubleSide;
      part(chest, new THREE.BoxGeometry(0.005, 0.2, 0.004), hi, null, [-0.028, 0.08, zSurf(-0.028, 0.08) + 0.001]);
      [0.15, 0.095, 0.04].forEach((y) => { // トグル：右に角のトグル、左へ暗いロープ
        const z = zSurf(0.0, y) + 0.004;
        part(chest, capsule(0.0055, 0.016), 0xb8dcff, O.acc, [0.012, y, z], [0, 0, P / 2]);
        part(chest, new THREE.BoxGeometry(0.036, 0.004, 0.003), dk, null, [-0.012, y, z - 0.002]);
        part(chest, new THREE.SphereGeometry(0.004, 8, 6), dk, null, [-0.032, y, zSurf(-0.032, y) + 0.002]);
      });
    } else {
      const lo = part(chest, new THREE.LatheGeometry(V2(coatPts.slice(0, 4).map(([r, y], i) => [r, i === 3 ? 0.1 : y])), 48), C.top, O.top, [0, 0, 0], [0, 0, 0], [SXc, 1, SZc]);
      lo.material.side = THREE.DoubleSide;
      const OPEN = THREE.MathUtils.degToRad(22);
      const up = part(chest, new THREE.LatheGeometry(V2([[0.102, 0.095], ...coatPts.slice(3)]), 48, OPEN, P * 2 - OPEN * 2), C.top, O.top, [0, 0, 0], [0, 0, 0], [SXc, 1, SZc]);
      up.material.side = THREE.DoubleSide;
      for (const s of [-1, 1]) { // 刻みのある襟：平らな形をコートの表面に沿わせる
        const sh = new THREE.Shape();
        sh.moveTo(0.0, 0.085); sh.lineTo(0.05, 0.218); sh.lineTo(0.068, 0.205); sh.lineTo(0.06, 0.182);
        sh.lineTo(0.082, 0.176); sh.lineTo(0.06, 0.12); sh.lineTo(0.0, 0.085);
        const geo = new THREE.ExtrudeGeometry(sh, { depth: 0.004, bevelEnabled: false, curveSegments: 4 });
        const p = geo.attributes.position;
        for (let i = 0; i < p.count; i++) { const x = p.getX(i), y = p.getY(i), z = p.getZ(i); p.setXYZ(i, s * x, y, zSurf(x, y) + 0.002 + z); }
        geo.computeVertexNormals();
        part(chest, geo, hi, O.top).material.side = THREE.DoubleSide;
      }
      [0.065, 0.025, -0.015].forEach((y) => [-1, 1].forEach((s) => {
        const x = s * 0.032;
        part(chest, new THREE.SphereGeometry(0.0075, 10, 8), dk, null, [x, y, zSurf(x, y) + 0.003], [0, 0, 0], [1, 1, 0.5]);
      }));
    }
    const skirtPts = V2(duffle
      ? [[0.109, 0.02], [0.113, -0.02], [0.12, -0.06], [0.128, -0.1], [0.132, -0.125], [0.12, -0.127]]
      : [[0.108, 0.02], [0.112, -0.02], [0.122, -0.07], [0.134, -0.12], [0.142, -0.158], [0.144, -0.166], [0.13, -0.168]]);
    const skirt = part(hips, new THREE.LatheGeometry(skirtPts, 48), C.top, O.top, [0, 0, 0], [0, 0, 0], [SXc, 1, 0.92]);
    skirt.material.side = THREE.DoubleSide;
    if (duffle) {
      part(skirt, new THREE.BoxGeometry(0.005, 0.14, 0.004), hi, null, [-0.028, -0.055, 0.112], [-0.09, 0, 0]);
      part(skirt, capsule(0.0055, 0.016), 0xb8dcff, O.acc, [0.012, -0.015, 0.108], [0, 0, P / 2]);
      part(skirt, new THREE.BoxGeometry(0.036, 0.004, 0.003), dk, null, [-0.012, -0.015, 0.106]);
      for (const s of [-1, 1]) { // ふた付きのポケット
        const pk = part(skirt, new THREE.BoxGeometry(0.052, 0.046, 0.006), C.top, O.top, [s * 0.072, -0.07, 0.098], [-0.08, s * 0.6, 0]);
        part(pk, new THREE.BoxGeometry(0.056, 0.014, 0.008), hi, null, [0, 0.022, 0.002]);
      }
    } else {
      for (const s of [-1, 1]) part(skirt, new THREE.BoxGeometry(0.05, 0.014, 0.006), hi, null, [s * 0.075, -0.045, 0.098], [0.12, s * 0.62, 0]).material.side = THREE.DoubleSide;
      part(skirt, new THREE.BoxGeometry(0.004, 0.15, 0.003), hi, null, [0.0, -0.09, 0.108], [-0.12, 0, 0]);
    }
    const lining = hemLining(skirt, skirtPts, C.top);
    skirt.onBeforeRender = () => { // エプロンと同じく、つぶしてひざにかぶせ、口は裏地でふさぐ
      const sit = THREE.MathUtils.clamp(-J.thighL.rotation.x / 1.5, 0, 1);
      skirt.scale.set(SXc + 0.05 * sit, 1 - (duffle ? 0.15 : 0.18) * sit, 0.92 - 0.42 * sit);
      skirt.position.set(0, 0.012 * sit, 0);
      skirt.rotation.x = -1.1 * sit;
      lining.visible = sit > 0.3;
    };
    sleeve = { ...sleeve, r1: duffle ? 0.038 : 0.037, r2: duffle ? 0.035 : 0.034, cuff: hi, cuffR: duffle ? [0.038, 0.038] : [0.037, 0.037], cuffH: 0.016, cuffY: -0.076 };
  } else { // zip（c15）：Tシャツの上にフード付きのジップジャケット
    part(chest, capsule(0.1, 0.1), C.top, O.top, [0, 0.1, 0], [0, 0, 0], [1.12, 1, 0.9]);
    part(chest, new THREE.TorusGeometry(0.047, 0.01, 10, 24), C.sub, O.top, [0, 0.214, 0.004], [P / 2, 0, 0]);
    part(chest, new THREE.TorusGeometry(0.078, 0.03, 12, 28, P * 1.25), C.top, O.top, [0, 0.215, -0.012], [P / 2, 0, P * 0.5 - P * 0.625 + P], [1.05, 1, 0.8]);
    part(chest, new THREE.SphereGeometry(0.06, 24, 16), C.top, O.top, [0, 0.182, -0.087], [0.1, 0, 0], [1.35, 1.1, 0.55]);
    sleeve = { ...sleeve, x: 0.118, r1: 0.039, r2: 0.036, hand: -0.102, cuff: lighten(C.top, 0.35), cuffR: [0.033, 0.035] };
  }

  // ---- 腕 ----
  for (const s of [-1, 1]) {
    const k = s < 0 ? "L" : "R";
    const sh = joint(chest, s * sleeve.x, 0.19, 0);
    const el = joint(sh, 0, -0.11, 0);
    if (sleeve.grad) {
      vcPart(sh, capsule(sleeve.r1, 0.05), () => new THREE.Color(C.top), sleeve.outline, [0, -0.055, 0]);
      vcPart(el, capsule(sleeve.r2, 0.045), (x, y) => sleeve.grad(y, -0.06, 0.06), sleeve.outline, [0, -0.045, 0]);
      if (sleeve.cuffRib === false) part(el, new THREE.CylinderGeometry(0.033, 0.035, 0.022, 16), sleeve.rib, sleeve.outline, [0, -0.08, 0]);
      else vcPart(el, new THREE.CylinderGeometry(0.033, 0.035, 0.022, 24), (x, y, z) => new THREE.Color(sleeve.rib).multiplyScalar(0.9 + 0.1 * Math.cos(Math.atan2(z, x) * 12)),
        sleeve.outline, [0, -0.08, 0]);
    } else {
      part(sh, capsule(sleeve.r1, 0.05), sleeve.color, sleeve.outline, [0, -0.055, 0]);
      part(el, capsule(sleeve.r2, 0.045), sleeve.color, sleeve.outline, [0, -0.045, 0]);
      if (sleeve.cuff != null) {
        const [a, b] = sleeve.cuffR || [0.036, 0.036];
        part(el, new THREE.CylinderGeometry(a, b, sleeve.cuffH || 0.022, 16), sleeve.cuff, sleeve.outline, [0, sleeve.cuffY || (sleeve.cuffR ? -0.08 : -0.078), 0]);
      }
    }
    part(el, new THREE.SphereGeometry(0.03, 14, 10), C.skin, O.skin, [0, sleeve.hand, 0]);
    J["sh" + k] = sh; J["el" + k] = el;
  }

  // ---- 小物 ----
  if (style.acc === "backpack") { // c05：背中のリュックと、肩から前へ下りる2本のひも
    const strap = darken(C.acc, 0.15), trim = lighten(C.acc, 0.12);
    const pack = joint(chest, 0, 0.125, -0.122);
    part(pack, capsule(0.072, 0.06), C.acc, O.acc, [0, 0, 0], [0, 0, 0], [1.15, 1, 0.55]);
    part(pack, new THREE.SphereGeometry(0.075, 24, 12, 0, P * 2, 0, P * 0.42), trim, O.acc, [0, 0.03, 0], [0, 0, 0], [1.16, 1.05, 0.6]);
    part(pack, capsule(0.04, 0.03), trim, O.acc, [0, -0.04, -0.035], [0, 0, 0], [1.3, 0.9, 0.45]);
    part(pack, new THREE.TorusGeometry(0.014, 0.004, 6, 14, P), strap, null, [0, 0.105, -0.005]);
    const coatLift = style.top === "coat" || style.top === "duffle" ? 0.012 : 0.006; // コートの上はひもを少し浮かせる
    for (const s of [-1, 1]) {
      const x = s * 0.086;
      const path = new THREE.CatmullRomCurve3([[x * 0.97, 0.05, 0.062], [x, 0.13, 0.068], [x, 0.19, 0.055], [x, 0.222, 0.012], [x, 0.212, -0.045], [x, 0.17, -0.078], [x, 0.12, -0.09]]
        .map(([a, b, c]) => new THREE.Vector3(a, b, c + Math.sign(c) * coatLift)));
      part(chest, new THREE.TubeGeometry(path, 32, 0.008, 8, false), strap, O.acc);
    }
  } else if (style.acc === "scarf") { // c09：首に2回巻いて、ふさの付いた端を前に垂らす
    const dk = darken(C.acc, 0.2);
    part(chest, new THREE.TorusGeometry(0.066, 0.03, 14, 32), C.acc, O.acc, [0, 0.212, 0.006], [P / 2 - 0.08, 0, 0], [1.12, 1, 1]);
    part(chest, new THREE.TorusGeometry(0.06, 0.026, 14, 32), dk, O.acc, [0, 0.238, 0.0], [P / 2 + 0.06, 0, 0.05], [1.1, 1, 1]);
    const tail = joint(chest, 0.05, 0.2, 0.091);
    tail.rotation.set(-0.12, 0, 0.04);
    part(tail, new THREE.BoxGeometry(0.05, 0.12, 0.014), C.acc, O.acc, [0, -0.055, 0]);
    [-0.018, -0.006, 0.006, 0.018].forEach((x) => part(tail, new THREE.CylinderGeometry(0.0035, 0.0028, 0.022, 6), dk, null, [x, -0.125, 0]));
    part(tail, new THREE.BoxGeometry(0.05, 0.004, 0.016), dk, null, [0, -0.095, 0]);
  }

  // ---- 頭と顔 ----
  const neck = joint(chest, 0, 0.235, 0);
  J.neck = neck;
  const head = joint(neck, 0, 0.15, 0);
  J.head = head;
  const R = 0.165, SX = 1.08, SY = 0.95;
  const face = part(head, new THREE.SphereGeometry(R, 40, 30), C.skin, O.skin, [0, 0, 0], [0, 0, 0], [SX, SY, 1]);
  face.material.gradientMap = rampSoft;
  face.material.emissive = new THREE.Color(C.skin).multiplyScalar(0.1);

  const faceParts = new THREE.Group(); head.add(faceParts);
  const zOn = (x, y) => R * Math.sqrt(Math.max(0, 1 - (x / (SX * R)) ** 2 - (y / (SY * R)) ** 2));
  function decal(mesh, x, y, lift = 0.001) {
    const z = zOn(x, y);
    const nrm = new THREE.Vector3(x / (SX * SX), y / (SY * SY), z).normalize();
    mesh.position.set(x, y, z).addScaledVector(nrm, lift);
    mesh.lookAt(mesh.position.clone().add(nrm));
    faceParts.add(mesh);
    return mesh;
  }
  const flat = (c, opts = {}) => new THREE.MeshBasicMaterial({ color: c, ...opts });
  const eyes = [];
  for (const s of [-1, 1]) {
    const e = decal(new THREE.Mesh(new THREE.SphereGeometry(1, 18, 12), flat(C.eye)), s * 0.068, -0.03, 0);
    e.scale.set(0.0145, 0.0185, 0.005);
    eyes.push(e);
    const ck = decal(new THREE.Mesh(new THREE.CircleGeometry(0.03, 24), flat(C.cheek, { transparent: true, opacity: 0.42, depthWrite: false })), s * 0.098, -0.066, 0.002);
    ck.scale.set(1.35, 0.85, 1);
    // 耳：おさげは髪の下から少し、ショート・ツンツンははっきり見せる。ボブ系は髪に隠れる
    if (style.hair === "braids") part(head, new THREE.SphereGeometry(0.03, 14, 10), C.skin, O.skin, [s * 0.176, -0.035, -0.004], [0, 0, 0], [0.45, 0.75, 0.6]);
    if (style.hair === "short") part(head, new THREE.SphereGeometry(0.03, 14, 10), C.skin, O.skin, [s * 0.18, -0.04, -0.004], [0, 0, 0], [0.5, 0.75, 0.6]);
    if (style.hair === "spiky" || style.hair === "flick") {
      const ear = part(head, new THREE.SphereGeometry(0.03, 16, 12), C.skin, O.skin, [s * 0.18, -0.04, -0.01], [0, 0, 0], [0.6, 1, 0.85]);
      ear.material.gradientMap = rampSoft;
    }
  }
  // まゆげ（c15）：髪の色を暗くした短い線。ぱっつん前髪のときは前髪のすぐ下に出す
  if (style.brows !== "none") {
    const by = style.bangs === "none" ? 0.014 : -0.001;
    const [w, h, tilt] = { normal: [0.021, 0.0058, 0.08], thick: [0.023, 0.0078, 0.06], down: [0.021, 0.0058, -0.22], up: [0.021, 0.0062, 0.3] }[style.brows];
    for (const s of [-1, 1]) {
      const br = decal(new THREE.Mesh(new THREE.SphereGeometry(1, 16, 8), flat(darken(C.hair, 0.25))), s * 0.07, by, 0.002);
      br.scale.set(w, h, 0.003);
      br.rotateZ(-s * tilt);
    }
  }
  decal(new THREE.Mesh(new THREE.CircleGeometry(0.0035, 10), flat(C.nose)), 0, -0.054, 0.001);
  const mouth = decal(new THREE.Mesh(new THREE.CircleGeometry(0.0062, 16), flat(C.mouth)), 0, -0.08, 0.001);
  mouth.scale.set(0.95, 1.2, 1);
  J.eyes = eyes;

  // ---- 髪 ----
  const HR = R + 0.014;
  const sphereSeg = (ps, pl, ts, tl) => new THREE.SphereGeometry(HR, 40, 24, ps, pl, ts, tl);
  const hairMat = toon(C.hair); hairMat.side = THREE.DoubleSide;
  const hiMat = toon(C.hairHi); hiMat.side = THREE.DoubleSide;
  const addHair = (geo, scl = [1.06, 0.98, 1.02], pos = [0, 0.004, 0], outline = true) => {
    const m = new THREE.Mesh(geo, hairMat);
    m.scale.set(...scl); m.position.set(...pos);
    if (outline) m.add(new THREE.Mesh(geo, outlineMat(O.hair)));
    head.add(m); return m;
  };
  // ボブ：後ろ〜横を包む Lathe の殻（顔の前 ±62° はあける）
  const bob = (pts) => addHair(new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), 40, THREE.MathUtils.degToRad(62), THREE.MathUtils.degToRad(236)),
    [1.06, 1.0, 1.03], [0, 0, -0.004]);

  if (style.hair !== "spiky" && style.hair !== "flick") addHair(sphereSeg(0, P * 2, 0, P * 0.36)); // 頭頂
  if (style.hair === "braids") { // c01
    addHair(sphereSeg(P * 0.86, P * 1.28, P * 0.34, P * 0.46), [1.08, 1.0, 1.05], [0, -0.004, -0.006]);
    for (const s of [-1, 1]) {
      const braid = joint(head, s * 0.16, -0.12, -0.02);
      part(braid, new THREE.SphereGeometry(0.012, 10, 8), C.tie, O.hair, [0, 0.03, 0]);
      [[0, 0, 0, 0.038], [s * 0.014, -0.05, 0.01, 0.034], [s * 0.022, -0.095, 0.02, 0.03], [s * 0.026, -0.135, 0.026, 0.024]]
        .forEach(([x, y, z, r]) => part(braid, new THREE.SphereGeometry(r, 14, 10), C.hair, O.hair, [x, y, z], [0, 0, 0], [1, 1.2, 1]));
      J["braid" + (s < 0 ? "L" : "R")] = braid;
    }
  } else if (style.hair === "bob") { // c02
    bob([[0.158, 0.082], [0.176, 0.05], [0.188, 0.01], [0.193, -0.035], [0.19, -0.07], [0.183, -0.1], [0.172, -0.115], [0.16, -0.12]]);
  } else if (style.hair === "longbob") { // c03：すそが外にはねる
    bob([[0.158, 0.082], [0.176, 0.05], [0.188, 0.01], [0.194, -0.035], [0.197, -0.075], [0.205, -0.11], [0.214, -0.135], [0.205, -0.142], [0.19, -0.138]]);
  } else if (style.hair === "buns") { // c06：短いボブ＋頭の上におだんご2つ
    bob([[0.158, 0.082], [0.176, 0.05], [0.188, 0.01], [0.193, -0.03], [0.196, -0.062], [0.2, -0.085], [0.19, -0.094], [0.175, -0.09]]);
    for (const s of [-1, 1]) {
      const bun = new THREE.Group();
      bun.position.set(s * 0.118, 0.158, 0.0);
      bun.rotation.set(0, 0, -s * 0.55);
      head.add(bun);
      part(bun, new THREE.SphereGeometry(0.062, 24, 18), C.hair, O.hair, [0, 0.018, 0], [0, 0, 0], [1, 0.92, 1]);
      const sw = new THREE.Mesh(new THREE.TorusGeometry(0.03, 0.0045, 6, 24, P * 1.3), hiMat);
      sw.position.set(0, 0.04, 0.036); sw.rotation.set(-0.7, 0, s * 0.5);
      bun.add(sw);
    }
  } else if (style.hair === "short") { // c07：耳の上で終わる短い後ろと横
    addHair(sphereSeg(P * 0.82, P * 1.36, P * 0.3, P * 0.33), [1.09, 1.0, 1.06], [0, -0.002, -0.006]);
  } else if (style.hair === "wavy") { // c08：胸まで届くウェーブのロング。すそは波打つ
    const longGeo = new THREE.LatheGeometry(V2([[0.156, 0.09], [0.178, 0.05], [0.19, 0.0], [0.194, -0.06], [0.19, -0.12], [0.188, -0.18], [0.194, -0.24], [0.202, -0.29], [0.19, -0.315]]),
      64, THREE.MathUtils.degToRad(58), THREE.MathUtils.degToRad(244));
    const p = longGeo.attributes.position;
    const sm = (a, b, v) => { const t = THREE.MathUtils.clamp((v - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
    for (let i = 0; i < p.count; i++) {
      let x = p.getX(i), y = p.getY(i), z = p.getZ(i);
      const r = Math.hypot(x, z), phi = Math.atan2(x, z);
      const r2 = r + sm(-0.02, -0.12, y) * (0.011 * Math.sin(phi * 9 + y * 28) + 0.007 * Math.sin(y * 42));
      y += sm(-0.22, -0.315, y) * 0.03 * Math.sin(phi * 9 + 1.2);
      p.setXYZ(i, Math.sin(phi) * r2, y, Math.cos(phi) * r2);
    }
    longGeo.computeVertexNormals();
    addHair(longGeo, [1.06, 1.0, 0.98], [0, 0, -0.006]);
    // 顔まわりの細い毛束：前髪の下から出て、ほおの横を通って下がる
    function wisp(pts, r0) {
      const path = new THREE.CatmullRomCurve3(pts.map((v) => new THREE.Vector3(...v)));
      const TS = 40, RS = 10;
      const geo = new THREE.TubeGeometry(path, TS, 1, RS, false);
      const q = geo.attributes.position;
      for (let i = 0; i <= TS; i++) {
        const u = i / TS, c = path.getPointAt(u);
        const rr = r0 * Math.pow(Math.min(1, u / 0.3), 0.7) * Math.pow(Math.max(0, 1 - u), 0.55) + 0.0006;
        for (let j = 0; j <= RS; j++) { const k = i * (RS + 1) + j; q.setXYZ(k, c.x + (q.getX(k) - c.x) * rr, c.y + (q.getY(k) - c.y) * rr, c.z + (q.getZ(k) - c.z) * rr); }
      }
      geo.computeVertexNormals();
      return part(head, geo, C.hair, O.hair);
    }
    for (const s of [-1, 1]) {
      wisp([[s * 0.125, 0.1, 0.085], [s * 0.148, 0.03, 0.1], [s * 0.16, -0.02, 0.098], [s * 0.148, -0.07, 0.104], [s * 0.16, -0.12, 0.092], [s * 0.15, -0.165, 0.085]], 0.011);
      wisp([[s * 0.11, 0.1, 0.1], [s * 0.13, 0.04, 0.114], [s * 0.142, 0.005, 0.112], [s * 0.132, -0.035, 0.116], [s * 0.14, -0.07, 0.11]], 0.008);
    }
    // 肩の前に下りる波打つ毛束（おさげの joint に付けて揺らす）
    for (const s of [-1, 1]) {
      const lock = joint(head, s * 0.172, -0.06, 0.035);
      const beads = [];
      for (let i = 0; i < 14; i++) beads.push(new THREE.Vector3(s * (0.006 + 0.014 * Math.sin(i * 0.8)), -i * 0.019, 0.008 * Math.sin(i * 0.8 + 1.4) - i * 0.0013));
      const path = new THREE.CatmullRomCurve3(beads);
      const TS = 64, RS = 14;
      const geo = new THREE.TubeGeometry(path, TS, 1, RS, false);
      const q = geo.attributes.position;
      for (let i = 0; i <= TS; i++) {
        const u = i / TS, c = path.getPointAt(u);
        const rr = 0.031 * (1 - 0.3 * u) * Math.pow(Math.max(0, 1 - u), 0.32) + 0.0008;
        for (let j = 0; j <= RS; j++) {
          const k = i * (RS + 1) + j;
          const d = new THREE.Vector3(q.getX(k), q.getY(k), q.getZ(k)).sub(c);
          d.z *= 0.85;
          q.setXYZ(k, c.x + d.x * rr, c.y + d.y * rr, c.z + d.z * rr);
        }
      }
      geo.computeVertexNormals();
      part(lock, geo, C.hair, O.hair);
      part(lock, new THREE.SphereGeometry(0.031, 14, 10), C.hair, null, [beads[0].x, beads[0].y, beads[0].z], [0, 0, 0], [1, 1, 0.85]);
      const curve = new THREE.CatmullRomCurve3(beads.slice(2, 12).map((v) => v.clone().add(new THREE.Vector3(s * 0.022, 0, 0.014))));
      part(lock, new THREE.TubeGeometry(curve, 40, 0.0035, 6), C.hairHi, null);
      J["braid" + (s < 0 ? "L" : "R")] = lock;
    }
    for (const s of [-1, 1]) { // 後ろ髪のつやの線
      const pts = [];
      for (let i = 0; i <= 8; i++) {
        const y = 0.02 - i * 0.036, phi = s * (2.3 + 0.08 * Math.sin(i * 1.3));
        const r = 0.205 + 0.008 * Math.sin(y * 42);
        pts.push(new THREE.Vector3(Math.sin(phi) * r * 1.06, y, Math.cos(phi) * r * 0.98 - 0.006));
      }
      part(head, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.0035, 6), C.hairHi, null);
    }
  } else if (style.hair === "flick") { // c05：頭全体を1枚の厚い殻で包み、すそを型紙どおりにとがらせたはね毛
    const D = THREE.MathUtils.degToRad;
    const wrap = (a) => ((a + 540) % 360) - 180;
    const sstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
    const tab = (T, x) => { if (x <= T[0][0]) return T[0][1]; for (let i = 1; i < T.length; i++) if (x <= T[i][0]) { const [x0, y0] = T[i - 1], [x1, y1] = T[i]; return y0 + (y1 - y0) * (x - x0) / (x1 - x0); } return T[T.length - 1][1]; };
    const spikes = (L, psi) => L.reduce((m, [c, d, sl, sr]) => { const q = wrap(psi - c); return Math.max(m, d - (q < 0 ? sl : sr) * Math.abs(q)); }, -1e9);
    const ridge = (L, psi, w = 9) => L.reduce((m, [c]) => Math.max(m, Math.exp(-((wrap(psi - c) / w) ** 2))), 0);
    function onHead(psi, th, t) {
      const p = D(psi), h = D(th);
      const x = Math.sin(h) * Math.sin(p), y = Math.cos(h), z = Math.sin(h) * Math.cos(p);
      const rho = 1 / Math.sqrt((x / (SX * R)) ** 2 + (y / (SY * R)) ** 2 + (z / R) ** 2);
      return new THREE.Vector3(x, y, z).multiplyScalar(rho * (1 + t));
    }
    function slab(fn, nA, nU, ring) {
      const pos = [], idx = [], nJ = ring ? nA : nA + 1;
      const add = (v) => (pos.push(v.x, v.y, v.z), pos.length / 3 - 1);
      const G = (o) => Array.from({ length: nU + 1 }, (_, i) => Array.from({ length: nJ }, (_, j) => add(fn(j / nA, i / nU, o))));
      const A = G(true), B = G(false);
      const quad = (a, b, c, d) => idx.push(a, b, c, a, c, d);
      for (let i = 0; i < nU; i++) for (let j = 0; j < nA; j++) {
        const j1 = ring ? (j + 1) % nA : j + 1;
        quad(A[i][j], A[i + 1][j], A[i + 1][j1], A[i][j1]);
        quad(B[i][j], B[i][j1], B[i + 1][j1], B[i + 1][j]);
      }
      const wall = (pts) => { const ra = pts.map(([a, u]) => add(fn(a, u, true))), rb = pts.map(([a, u]) => add(fn(a, u, false)));
        for (let k = 0; k + 1 < pts.length; k++) quad(ra[k], rb[k], rb[k + 1], ra[k + 1]); };
      const span = (n, f) => Array.from({ length: n + 1 }, (_, k) => f(k / n));
      wall(span(nA, (a) => [a, 1]));
      wall(span(nA, (a) => [1 - a, 0]));
      if (!ring) { wall(span(nU, (u) => [1, 1 - u])); wall(span(nU, (u) => [0, u])); }
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      return g;
    }
    const addShell = (geo, mat = hairMat, outline = O.hair) => { const m = new THREE.Mesh(geo, mat); if (outline != null) m.add(new THREE.Mesh(geo, outlineMat(outline))); head.add(m); return m; };
    function shine(fn, a0, w, u0, u1, lift = 1.012) {
      const pos = [], idx = [], n = 16;
      for (let k = 0; k <= n; k++) { const u = u0 + (u1 - u0) * k / n, ww = w * Math.sin(P * k / n);
        for (const s of [-1, 1]) { const v = fn(a0 + s * ww, u, true).multiplyScalar(lift); pos.push(v.x, v.y, v.z); } }
      for (let k = 0; k < n; k++) idx.push(2 * k, 2 * k + 1, 2 * k + 3, 2 * k, 2 * k + 3, 2 * k + 2);
      const g = new THREE.BufferGeometry(); g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
      return addShell(g, hiMat, null);
    }
    function cowlick(psi, th, t, len, w, bend) {
      const pts = []; for (let i = 0; i <= 10; i++) { const u = i / 10; pts.push(new THREE.Vector2(w / 2 * Math.pow(1 - u, 0.9) + 0.0003, u * len)); }
      const g = new THREE.LatheGeometry(pts, 10); g.scale(1, 1, 0.6);
      const pa = g.attributes.position;
      for (let i = 0; i < pa.count; i++) { const y = pa.getY(i), u = y / len;
        pa.setXYZ(i, pa.getX(i) + bend[0] * len * u * u, y + bend[1] * len * u * u, pa.getZ(i) + bend[2] * len * u * u); }
      g.computeVertexNormals();
      const m = addShell(g), base = onHead(psi, th, t);
      m.position.copy(base); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), base.clone().normalize());
      return m;
    }
    const FRONT = [[-66, 97, 3.2, 1.3], [-42, 100, 3.2, 1.3], [-18, 96, 3.2, 1.3], [4, 90, 3.2, 1.4], [23, 82, 3, 1.6], [57, 82, 1.6, 3], [-80, 104, 3.2, 3.2], [76, 102, 3.2, 3.2]];
    const EARS = [[-106, 110, 2.4, 2.4], [106, 110, 2.4, 2.4]];
    const NAPE = [[-130, 140, 2, 2], [-155, 152, 2, 2], [180, 156, 2, 2], [155, 152, 2, 2], [130, 140, 2, 2]];
    const ALL = [...FRONT, ...EARS, ...NAPE];
    const BASE = [[-180, 142], [-140, 130], [-112, 108], [-88, 96], [-66, 78], [-60, 73], [0, 73], [30, 68], [42, 62], [54, 70], [66, 78], [88, 96], [112, 108], [140, 130], [180, 142]];
    const hemA = (psi) => Math.max(tab(BASE, psi), spikes(ALL, psi));
    const HANG = 100; // 頭の後ろより下は、頭の下へ回り込まずにまっすぐ下がる
    const place = (ph, th, t) => {
      const p = onHead(ph, th, t);
      if (th <= HANG) return p;
      const q = onHead(ph, HANG, t), s = (th - HANG) / 60;
      return new THREE.Vector3(q.x * (1 - 0.12 * s), p.y, q.z * (1 - 0.12 * s));
    };
    const shellA = (a, u, outer) => {
      const psi = wrap(-180 + 360 * a);
      const wf = 1 - sstep(50, 95, Math.abs(psi)), wb = sstep(110, 150, Math.abs(psi));
      const ph = psi - 16 * wf * Math.pow(u, 1.6);
      const th = hemA(psi) * u;
      const ear = Math.exp(-(((Math.abs(psi) - 92) / 16) ** 2)) * sstep(78, 96, th);
      if (!outer) return place(ph, th, 0.006 + 0.1 * ear);
      let t = 0.035 + 0.1 * Math.pow(1 - u, 1.4) + 0.05 * wb * Math.sin(P * Math.min(1, u * 1.1)) + 0.11 * ear;
      t += (0.028 + 0.03 * wb) * Math.pow(u, 0.8) * ridge(ALL, psi, 9 + 4 * wb);
      t += 0.12 * sstep(0.75, 1, u) * ridge(EARS, psi, 8);
      return place(ph, th, t);
    };
    addShell(slab(shellA, 360, 30, true));
    [[-42, 3], [-18, 2.6], [4, 2.2]].forEach(([q, w]) => shine(shellA, (q + 180) / 360, w / 360, 0.45, 0.93));
    shine(shellA, (-106 + 180) / 360, 2.5 / 360, 0.5, 0.9); shine(shellA, (106 + 180) / 360, 2.5 / 360, 0.5, 0.9);
    cowlick(-25, 10, 0.1, 0.07, 0.03, [0.25, 0, -0.5]);
    cowlick(8, 6, 0.1, 0.06, 0.026, [-0.2, 0, -0.55]);
    cowlick(170, 16, 0.08, 0.05, 0.026, [0.1, 0, -0.5]);
  } else { // spiky（c15）：つむじの1点から頭の表面に沿って伸ばした、先のとがった毛束
    const cap = new THREE.Mesh(new THREE.SphereGeometry(HR * 0.995, 40, 16, 0, P * 2, 0, P * 0.22), hairMat);
    cap.scale.set(1.05, 0.97, 1.02); cap.position.set(0, 0.002, -0.004); head.add(cap);
    const HS = new THREE.Vector3(1.06, 0.98, 1.03);
    const dirOn = (aDeg, thDeg) => { const a = THREE.MathUtils.degToRad(aDeg), t = THREE.MathUtils.degToRad(thDeg);
      return new THREE.Vector3(Math.sin(t) * Math.sin(a), Math.cos(t), Math.sin(t) * Math.cos(a)); };
    const ORIGIN = dirOn(-28, 12), MIRROR = dirOn(28, 12);
    function lock(endA, endTh, w, { bulge = 0.45, hook = 0.05, sway = 0, rr = HR * 1.02, thick = 0.65, mat = hairMat, from = ORIGIN } = {}) {
      const o = from.clone(), e = dirOn(endA, endTh);
      const k = new THREE.Vector3().crossVectors(o, e).normalize(), ang = o.angleTo(e), len = ang * rr;
      const pts = [];
      for (let i = 0; i <= 20; i++) {
        const u = i / 20;
        const prof = u < 0.5 ? 0.4 + 0.6 * Math.sin(P * u) : Math.pow((1 - u) / 0.5, 0.9);
        pts.push(new THREE.Vector2((w / 2) * prof + 0.0004, u * len));
      }
      const geo = new THREE.LatheGeometry(pts, 16);
      geo.scale(1, 1, thick);
      const pa = geo.attributes.position, q = new THREE.Quaternion(), v = new THREE.Vector3();
      for (let i = 0; i < pa.count; i++) {
        const x = pa.getX(i), y = pa.getY(i), z = pa.getZ(i), u = y / len;
        q.setFromAxisAngle(k, u * ang);
        const d = o.clone().applyQuaternion(q);
        const out = bulge * len * Math.sin(P * Math.min(1, u * 1.15)) * 0.25 + hook * len * u * u * u;
        v.copy(d).multiplyScalar(rr + z + out).addScaledVector(k, -x + sway * len * u * u);
        v.multiply(HS);
        pa.setXYZ(i, v.x, v.y + 0.004, v.z);
      }
      geo.computeVertexNormals();
      const m = new THREE.Mesh(geo, mat);
      m.add(new THREE.Mesh(geo, outlineMat(O.hair)));
      head.add(m);
      return m;
    }
    const side = (a, th, w, o = {}) => { lock(a, th, w, { ...o, from: ORIGIN }); lock(-a, th, w, { ...o, from: MIRROR, sway: -(o.sway || 0) }); };
    lock(4, 82, 0.11, { sway: 0.08 });
    side(64, 78, 0.1, { sway: -0.04 });
    lock(-32, 84, 0.09, { sway: 0.1, rr: HR * 1.024 });
    lock(-15, 78, 0.06, { sway: 0.12, rr: HR * 1.032 });
    lock(26, 83, 0.095, { sway: 0.06, rr: HR * 1.024 });
    lock(46, 76, 0.065, { sway: 0.03, rr: HR * 1.032 });
    side(84, 82, 0.1, { bulge: 0.15, hook: 0.03, rr: HR * 1.012 });
    side(112, 106, 0.14, { bulge: 0.35, hook: 0.04, sway: -0.08, rr: HR * 1.018 });
    side(136, 116, 0.15, { bulge: 0.35, hook: 0.08, sway: 0.08, rr: HR * 1.026 });
    side(158, 122, 0.15, { bulge: 0.35, hook: 0.04, sway: -0.08, rr: HR * 1.018 });
    lock(180, 124, 0.16, { bulge: 0.35, hook: 0.08, sway: 0.08, rr: HR * 1.026 });
    side(124, 106, 0.12, { bulge: 0.4, hook: 0.06, rr: HR * 1.03 });
    side(170, 114, 0.12, { bulge: 0.4, hook: 0.06, rr: HR * 1.03 });
    [[-126, 124, 0.12], [-148, 134, 0.13], [-169, 138, 0.13], [169, 138, 0.13], [148, 134, 0.13], [126, 124, 0.12]]
      .forEach(([a, th, w], i) => lock(a, th, w, { from: dirOn(a, 78), bulge: 0, hook: 0, sway: (i % 2 ? 0.06 : -0.06), rr: HR * 1.0, thick: 0.35 }));
    for (const s of [-1, 1]) {
      lock(s * 78, 108, 0.085, { from: dirOn(s * 80, 46), bulge: 0.15, hook: 0.02, sway: s * -0.04, rr: HR * 1.022 });
      lock(s * 70, 96, 0.06, { from: dirOn(s * 70, 48), bulge: 0.15, hook: 0.02, sway: s * 0.03, rr: HR * 1.028 });
    }
    side(98, 80, 0.11, { bulge: 0.35, hook: 0.05, rr: HR * 1.02 });
    side(80, 48, 0.11, { bulge: 0.6, hook: 0.15, rr: HR * 1.04 });
    side(150, 56, 0.12, { bulge: 0.6, hook: 0.15, rr: HR * 1.04 });
    lock(-48, 46, 0.022, { bulge: 0.3, rr: HR * 1.05, thick: 0.6, mat: hiMat, from: dirOn(-34, 22) });
    lock(-66, 48, 0.016, { bulge: 0.3, rr: HR * 1.05, thick: 0.6, mat: hiMat, from: dirOn(-50, 26) });
  }
  if (style.bangs === "blunt") { // ぱっつん前髪を3つのかたまりで（phi 0.5π が正面）
    [[0.15, 0.225], [0.39, 0.22], [0.625, 0.225]].forEach(([ps, pl]) => {
      const m = new THREE.Mesh(sphereSeg(P * ps, P * pl, P * 0.2, P * 0.27), hairMat);
      m.scale.set(1.075, 0.985, 1.04); m.position.set(0, 0.004, 0.002);
      head.add(m);
    });
  } else if (style.bangs === "curtain") { // c08：少し左で分けて横へ流した前髪（分け目の近くは短く、こめかみへ長く）
    [[0.12, 0.13, 0.295], [0.26, 0.11, 0.275], [0.38, 0.09, 0.255], [0.485, 0.11, 0.25], [0.605, 0.125, 0.27], [0.74, 0.14, 0.295]].forEach(([ps, pl, tl]) => {
      const m = new THREE.Mesh(sphereSeg(P * ps, P * pl, P * 0.18, P * tl), hairMat);
      m.scale.set(1.075, 0.985, 1.04); m.position.set(0, 0.004, 0.002);
      head.add(m);
    });
  }

  // ---- 帽子（c07 のニット帽：ピンク→ライラック→水色、折り返しのリブ） ----
  if (style.hat === "knit") {
    const hatTop = 0xf7a2d2, hatMid = 0xe9a9e2, hatBot = 0xa9cdf6;
    const fade3 = (a, b, c, t) => (t < 0.5 ? new THREE.Color(a).lerp(new THREE.Color(b), t * 2) : new THREE.Color(b).lerp(new THREE.Color(c), (t - 0.5) * 2));
    const hat = joint(head, 0, -0.012, -0.006);
    hat.rotation.set(-0.34, 0, 0);
    hat.scale.set(SX, 1, 1);
    const domePts = [];
    for (let i = 0; i <= 14; i++) {
      const a = (i / 14) * P / 2;
      domePts.push(new THREE.Vector2(0.19 * Math.pow(Math.cos(a), 0.6) + 0.0005, 0.1 + 0.125 * Math.sin(a)));
    }
    const OH = glow(hatTop);
    vcPart(hat, new THREE.LatheGeometry(domePts, 48), (x, y) => fade3(hatBot, hatMid, hatTop, THREE.MathUtils.clamp((y - 0.1) / 0.06, 0, 1)), OH);
    vcPart(hat, new THREE.SphereGeometry(0.07, 20, 14), () => new THREE.Color(hatTop), OH, [0, 0.2, -0.06], [0.25, 0, 0], [1.25, 0.8, 1.15]);
    const cuffPts = [[0.182, 0.04], [0.196, 0.043], [0.202, 0.062], [0.202, 0.084], [0.196, 0.103], [0.184, 0.107]].map(([r, y]) => new THREE.Vector2(r, y));
    vcPart(hat, new THREE.LatheGeometry(cuffPts, 96), (x, y, z) => new THREE.Color(0xf0b0e0).lerp(new THREE.Color(0x9fd4f6), THREE.MathUtils.clamp((x + 0.17) / 0.34, 0, 1))
      .multiplyScalar(0.9 + 0.1 * Math.cos(Math.atan2(x, z) * 36)), OH);
  }

  if (style.hat === "beret") { // c08：やわらかい平たい円盤を後ろへ少し傾けて、バンドと小さな軸
    const beret = joint(head, 0.0, 0.098, -0.014);
    beret.rotation.set(-0.2, 0, -0.13);
    const bm = part(beret, new THREE.LatheGeometry(V2([[0.001, 0.098], [0.06, 0.095], [0.115, 0.083], [0.16, 0.06], [0.195, 0.032], [0.214, 0.008], [0.208, -0.008], [0.19, -0.02], [0.165, -0.02]]), 48),
      C.hat, O.hat, [0, 0, 0], [0, 0, 0], [1.03, 1, 1]);
    bm.material.side = THREE.DoubleSide;
    part(beret, new THREE.TorusGeometry(0.163, 0.011, 10, 40), darken(C.hat, 0.15), O.hat, [0, -0.018, 0], [P / 2, 0, 0], [1.03, 1, 1]);
    part(beret, new THREE.CylinderGeometry(0.006, 0.009, 0.026, 10), C.hat, O.hat, [0.004, 0.108, 0], [0, 0, 0.25]);
  }

  if (!J.braidL) J.braidL = joint(head, -0.16, -0.12, -0.02);
  if (!J.braidR) J.braidR = joint(head, 0.16, -0.12, -0.02);
  return J;
}
