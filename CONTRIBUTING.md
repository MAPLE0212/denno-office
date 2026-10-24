# キャラの作り方・追加のしかた

キャラは 1 体 = 1 つの HTML ファイル（`characters/cXX.html`）です。
ブラウザで直接開くと、そのキャラだけをぐるぐる回して見られます。サーバはこのファイルからキャラを組み立てる部分だけを切り出して、3D オフィスに座らせます。

## 1. 既存のキャラをコピーする

```bash
cp characters/c01.html characters/c20.html
```

- ID は `c` + 数字 2 桁（`c20` など）。既存の ID と重ならないものにします。
- 作風の近いキャラを元にすると早いです（ボブなら `c02` / `c03`、短髪の男の子なら `c15`、お団子なら `c06`、帽子なら `c07`）。

## 2. 見た目を変える

`c20.html` をブラウザで開き、見ながら書き換えます。サーバが切り出すのは **`const C = {` から `// ---- set:` の手前まで** なので、この範囲の中で作ります。

| 場所 | 中身 |
|---|---|
| `const C = { ... }` | 体の色（肌・髪・服など） |
| `const O = { ... }` | 輪郭の発光色 |
| `part()` / `joint()` / `capsule()` | 部品を置く道具（そのまま使う） |
| `function makeChara()` | キャラを組み立てる本体 |

守ってほしいこと:

- **2 つの目印（`const C = {` と `// ---- set:`）を消さない。** これが無いとサーバが切り出せません。
- `makeChara()` は関節の一覧 `J` を返します。オフィスのポーズが使うので、次の名前をすべて入れてください。
  `root, hips, thighL/R, kneeL/R, chest, shL/R, elL/R, neck, head, eyes, braidL/R`
  おさげが無いキャラは、空の `joint` を `braidL` / `braidR` に入れておきます（`c02` の末尾が例です）。
- 材質は `toon()` / `outlineMat()` / `ramp` / `rampSoft` を使います。オフィス側から同じものが渡されます。
- three.js は 0.160.0 です（HTML の importmap）。

## 3. 一覧に足す

`characters/characters.json` に 1 行足します。

```json
{ "id": "c20", "feature": "赤いショートヘア、黄色のパーカー、デニム" }
```

- `feature` はマイページのキャラ選びに出る説明です。最初の「、」までが名前として使われます（`"label": "うちの猫"` で名前を直接決めることもできます）。
- 作りかけのときは `"wip": true` を付けると、マイページに「準備中」と出て選べなくなります。

サーバは毎回このファイルを読み直すので、再起動しなくても反映されます。

## 4. マイページ用の画像を作る（任意）

画像が無くても動きますが、あるとキャラ選びで顔が見えます。`tools/` の環境（README の「tools の環境」）を用意してから:

```bash
cd tools
.venv/bin/python render_chara.py ../characters/c20.html out/c20
cp out/c20_front.png ../characters/
```

## 5. 共有する

できたキャラは Pull Request で送ってください。`cXX.html`、`cXX_front.png`、`characters.json` の 1 行があれば十分です。
