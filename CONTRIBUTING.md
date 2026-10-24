# キャラの作り方・追加のしかた

キャラは 1 体 = 1 つの HTML ファイルです。ブラウザで直接開くと、そのキャラだけをぐるぐる回して見られます。サーバはこのファイルからキャラを組み立てる部分だけを切り出して、3D オフィスに座らせます。

キャラは **作成者ごとのフォルダ** に入っていて、マイページのキャラ選びでは作成者ごとのタブになります。

```
characters/
  _template.html          新しいキャラの元（素体）
  maple/                  作成者のフォルダ（= マイページのタブ）
    characters.json       この作成者のキャラ一覧
    c01.html              キャラ本体
    c01_front.png         マイページ用の写真（任意）
    STYLE.md              この作成者の作風メモ（任意。Claude Code はキャラを作る前に読む）
  local/                  自分のオフィスだけで使うキャラ（git に入らない）
```

**作風は自由です。** 髪型・服・小物・色、どう作ってもかまいません。守ってほしいのは、下の「オフィスで動くための決まり」だけです。

コードを書かずに、[Claude Code](https://claude.com/claude-code) に話しかけて作ることもできます。手順は [docs/claude-code.md](docs/claude-code.md) を見てください。

## 1. 自分のフォルダを作って、雛形をコピーする

作成者のフォルダ名は、英小文字・数字・`-`・`_` で 32 文字までです（GitHub のユーザー名などがおすすめ）。

```bash
mkdir characters/alice
cp characters/_template.html characters/alice/cat-ears.html
```

- キャラの ID（ファイル名）も、英小文字・数字・`-`・`_` で 32 文字まで。フォルダの中で重ならなければ、ほかの人と同じ名前でもかまいません（オフィスの中では `alice/cat-ears` のように作成者付きで区別されます）。
- 既存のキャラを元にしてもかまいません（ボブなら `maple/c02`、短髪の男の子なら `maple/c15`、お団子なら `maple/c06`、帽子なら `maple/c07`）。

## 2. 一覧に足す

自分のフォルダに `characters.json` を作ります。

```json
{
  "author": "Alice",
  "characters": [
    { "id": "cat-ears", "feature": "ねこみみフード、黄色のパーカー、デニム" }
  ]
}
```

- `author` はマイページのタブに出る名前です。
- `feature` はキャラ選びに出る説明です。最初の「、」までが名前として使われます（`"label": "うちの猫"` で名前を直接決めることもできます）。
- 作りかけのときは `"wip": true` を付けると、マイページに「準備中」と出て選べなくなります。

サーバは毎回このファイルを読み直すので、再起動しなくても反映されます。

## 3. 見た目を作る

`cat-ears.html` をブラウザで開き、見ながら書き換えます（ファイルを直接開いてうまく表示されないときは、リポジトリ直下で `python3 -m http.server 8800` を動かして `http://localhost:8800/characters/alice/cat-ears.html` を開きます）。サーバが切り出すのは **`const C = {` から `// ---- set:` の手前まで** なので、この範囲の中で作ります。

| 場所 | 中身 |
|---|---|
| `const C = { ... }` | 体の色（肌・髪・服など） |
| `const O = { ... }` | 輪郭の発光色 |
| `part()` / `joint()` / `capsule()` | 部品を置く道具（そのまま使う） |
| `function makeChara()` | キャラを組み立てる本体 |

### オフィスで動くための決まり

- **2 つの目印（`const C = {` と `// ---- set:`）を1つずつ残す。** これが無いとサーバが切り出せません。コメントの中にも同じ文字を書かないでください。
- **関節をそろえる。** `makeChara()` は関節の一覧 `J` を返します。オフィスのポーズが使うので、次の名前をすべて入れてください。
  `root, hips, thighL/R, kneeL/R, chest, shL/R, elL/R, neck, head, eyes, braidL/R`
  おさげが無いキャラは、空の `joint` を `braidL` / `braidR` に入れておきます（雛形がそうなっています）。
- **体の寸法を変えない。** `hips` の高さ 0.295、太もも・すねの長さ 0.13 ずつ、首から頭まで 0.15 は雛形のままにします。座りポーズがこの寸法で机と椅子に合わせてあります。
- **目はまばたきできる形にする。** `J.eyes` は目のメッシュの配列です。オフィスでは `scale.y` を 0.0185（開）と 0.003（閉）に切り替えてまばたきさせるので、目は雛形と同じ「半径 1 の球を `scale.y = 0.0185` で縦長にしたもの」にします。まばたきしないキャラは `[]` にします。
- **大きさの目安。** 立ったときの高さ 0.6〜1.1、横幅 0.6 以下、奥行き 0.55 以下（はみ出すと隣の席や机にめり込みます）。
- **キャラ本体では THREE と、渡される材質（`toon()` / `outlineMat()` / `ramp` / `rampSoft` / `outlineUniforms`）だけを使う。** ネットからの読み込みや、ページ・ブラウザの操作（`fetch`、`document`、`localStorage` など）は書かないでください。キャラのコードはオフィスを開いた全員のブラウザで動くためです。
- three.js は 0.160.0 です（HTML の importmap）。

StopWatch 版では小さな画面に縮めて表示するので、白に近い輪郭や、明るさを 1 より上げた色（`multiplyScalar(1.3)` など）を広い面に使うと、光がにじみやすくなります（決まりではなく注意です）。

## 4. チェックする

決まりを守れているかは、スクリプトで確かめられます（Node.js 18 以上）。

```bash
cd tools
npm install
node check_chara.mjs ../characters/alice
```

- `✔` なら OK、`△` は注意（動きます）、`✖` はエラー（直さないとオフィスで動かないか、取り込めません）。
- 引数なしで全員分、`--stats` を付けると高さや部品の数も出ます。

## 5. マイページ用の写真を作る（任意）

写真が無くても動きますが、あるとキャラ選びで顔が見えます。Pull Request を送ると GitHub Actions が撮ってくれるので（下）、自分で撮らなくてもかまいません。自分で撮るときは、`tools/` の環境（README の「tools の環境」）を用意してから:

```bash
cd tools
.venv/bin/python render_chara.py ../characters/alice/cat-ears.html out/cat-ears
cp out/cat-ears_front.png ../characters/alice/
```

## 6. 共有する（Pull Request）

できたキャラは Pull Request で送ってください。

- 変えるのは **自分のフォルダ `characters/<作成者>/` の中だけ** にしてください。ほかの人のフォルダと重ならないので、取り込みでぶつかりません。
- PR を送ると GitHub Actions がチェックを走らせ、変わったキャラの写真を撮ります（実行結果の Artifacts「character-shots」からダウンロードできます）。
- 取り込む前に、管理者がキャラのコードを読んで確かめます。チェックは機械的なものなので、それだけで安全とは言えないためです。
- キャラは自分で考えたものにしてください。他の人のイラストやキャラを、許可なくなぞったりまねたりしないでください。
- 取り込んだキャラは、このリポジトリと同じ [MIT License](LICENSE) で公開されます（誰でも改変・再配布・商用利用できます）。

## 公開しないで、自分のオフィスだけで使う

`characters/local/` に置いたキャラは git に入りません。Pull Request を送らずに、自分のオフィスだけで使えます。

```bash
mkdir characters/local
cp characters/_template.html characters/local/my-chara.html
```

`characters/local/characters.json` の書き方は上と同じです（`author` を省くとタブは「自分用」になります）。`local` のタブはマイページの先頭に出ます。

## 使う作成者をしぼる

自分のオフィスでは決まった作成者のキャラだけを使いたいときは、サーバを起動するときに書きます。

```bash
CHARACTER_AUTHORS=maple,local node server/server.js
```
