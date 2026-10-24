# 電脳オフィス（Claude Code 向けの説明）

オフィスの島をミニキャラ（three.js）で見せる在席ボード。サーバは `server/server.js`（依存なし、`node server/server.js` で http://localhost:8080/）。人向けの説明は README.md、キャラの決まりは CONTRIBUTING.md。

ここを開く人の多くは、コードを書かずに言葉でミニキャラを作りたい人（docs/claude-code.md）。返事はやさしい日本語で、専門用語は言い換えて、作業の結果（どこに何を作ったか、どう見るか）を短く伝える。

## キャラを作るとき

### 最初に確かめること
- **作成者のフォルダ名**（英小文字・数字・`-`・`_`、32 文字まで）と、**公開するか**（公開 → `characters/<作成者>/`、自分用 → `characters/local/`、git に入らない）。分からなければ聞く。
- その作成者の `characters/<作成者>/STYLE.md` があれば読み、書いてある作風に合わせる。リポジトリ直下に `PROGRESS.md` があれば（git に入らない作成者の個人メモ）、その作風ルールと進め方にも従う。
- **ほかの作成者のフォルダは変えない**（読んで参考にするのはよい）。

### 作り方
1. 新しいキャラは雛形をコピーする：`cp characters/_template.html characters/<作成者>/<id>.html`（id も英小文字・数字・`-`・`_`）。似たキャラがあればそれを元にしてもよい。
2. `characters/<作成者>/characters.json`（`{ "author": "表示名", "characters": [{ "id", "feature", "wip": true }] }`）に足す。`feature` は「髪、服、…」の形で、最初の「、」までが名前になる。**作成者が「完成」と言うまで `"wip": true` のまま**にする。
3. `makeChara()` の中を書き換えて作る。`<title>` と `<h1>`、`<p class="sub">` の説明もそのキャラに合わせる。
4. 変えるたびに `node tools/check_chara.mjs characters/<作成者>` を通す（初回は `cd tools && npm install`）。エラーは直してから見せる。
5. 見た目は自分で確かめてから見せる。リポジトリ直下で `python3 -m http.server 8800` を動かし、`http://localhost:8800/characters/<作成者>/<id>.html` を開く（ポーズは「座って作業 / 座って待機 / 立ち」のボタン）。立ちと座りの両方を見る。オフィスに座らせて見るなら `node server/server.js` → マイページでそのキャラを選ぶ（`wip` のあいだは選べない）。

### オフィスで動くための決まり（check_chara.mjs が確かめる）
- 目印 `const C = {` と `// ---- set:` は1つずつ、この順。サーバはこの間だけを切り出す。**コメントにもこの2つの文字列を書かない。**
- キャラ本体（目印の間）では `THREE` と、渡される `toon()` / `outlineMat()` / `ramp` / `rampSoft` / `outlineUniforms` だけを使う。`fetch`・`document`・`window`・`localStorage`・URL・`import`・`eval`・`constructor`・three.js の Loader などは書かない（オフィスを開いた全員のブラウザで動くため）。
- 返す `J` に `root, hips, thighL/R, kneeL/R, chest, shL/R, elL/R, neck, head, eyes, braidL/R` を全部入れる。おさげが無くても `braidL/R` は空の joint。
- 寸法は雛形のまま：`hips` の高さ 0.295、太もも→ひざ→足首 0.13 ずつ、首→頭 0.15。+z が前、立ったとき足の裏が y=0。
- `J.eyes` は目のメッシュの配列。まばたきで `scale.y` を 0.0185 ⇔ 0.003 に切り替えるので、目は半径 1 の球を `scale.y = 0.0185` にしたもの（まばたきしない子は `[]`）。
- 大きさは立ちで高さ 0.6〜1.1、横幅 0.6 以下、奥行き 0.55 以下。三角形は 20 万個まで。
- three.js は 0.160.0。キャラの html の中で読み込んでよいのは three.js 0.160.0（cdn.jsdelivr.net）と Google Fonts だけ。
- html の先頭に `<meta charset="utf-8">`（無いと日本語が文字化けする）。

### 作風は自由。作るときに役立つこと（今いるキャラから）
- 服の重ね着は実際の順番で：下に着るもの（シャツ・Tシャツ）を体のベースにし、上着（カーディガン・ジャケット・パーカー・エプロン）は `LatheGeometry` の殻として外からかぶせる（前を開けるなら phiStart / phiLength で隙間を作る）。下の服を板で上から貼らない（例 `maple/c01`、`maple/c02`）。
- ボブは Lathe の殻で後ろ〜横を包む（`maple/c02`・`maple/c03`）。ぱっつん前髪は頭より少し大きい球を切り取ったもの（`SphereGeometry` の phi 0.5π が正面）。毛束は平たい円すいを頭の表面に沿わせる（`maple/c15`）。
- 帽子は頭にかぶせる殻（`maple/c07` のニット帽）。おさげは `braidL/R` の joint に付けると揺れる（`maple/c01`）。
- 輪郭の色（`O`）が明るすぎたり、`multiplyScalar` で 1 より明るくした色を広い面に使うと、StopWatch の小さな画面で光がにじむ。
- 顔は頭の楕円体に貼る（雛形の `decal()`）。

### 仕上げ（作成者が「完成」と言ったら）
- `"wip": true` を外す。
- マイページ用の写真：`tools/.venv` があれば `cd tools && .venv/bin/python render_chara.py ../characters/<作成者>/<id>.html out/<id>` を撮り、`out/<id>_front.png` を `characters/<作成者>/` に置く。道具が無ければ無理に入れず、PR の GitHub Actions が撮ると伝える。
- 作風メモを頼まれたら `characters/<作成者>/STYLE.md` に書く（そのキャラに共通の作り方だけ、短く）。

## してはいけないこと
- 頼まれていないコミット・push・Pull Request。PR を送るのは作成者の確認を取ってから。
- ほかの作成者のフォルダ、`server/`・`firmware/`・`tools/` の書き換え（キャラ作りでは要らない。頼まれたときだけ）。
- `characters/local/`、`server/members.json`、`firmware/denno_config.h` のコミット（git に入らない）。
- 他の人のイラストやキャラをそっくりまねたキャラ（公開できない）。
