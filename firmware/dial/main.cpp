// 電脳オフィス 6席：ミニキャラ版を M5Dial で表示する（StopWatch 版 ../main.cpp の Dial 向け）
//
// M5Dial の中身は StampS3（ESP32-S3FN8、フラッシュ 8MB、PSRAM なし）。画面は 1.28" の丸 240x240。
// PSRAM が無いので、StopWatch 版とはメモリの使い方を変えている。
//   - 合成用のキャンバスは 1 枚（約 113KB）だけ、内蔵 RAM に置く
//   - 背景はフラッシュにある RGB565 の配列（office_art_dial.h の BG_RAW）を毎コマそのまま写す（RAM に展開しない）
//   - サーバから取り寄せたキャラの「はんこ」は、フラッシュの sprites 領域（partitions_dial.csv）に書き、そこを直接読んで描く
//
// 毎フレーム
//   背景コピー → 奥の列(B) → 手前の列(A) のキャラ → 不在タグ・吹き出し → 画面へ転送
//
// サーバ連携（../denno_config.h に Wi-Fi を書いたとき。StopWatch と同じ設定ファイルを使う）
//   ネット用のタスク（コア0）が POLL_MS ごとにサーバの /api/device?board=dial を取りに行き、在席・名前・ひとりごとを反映する。
//   端末での操作はサーバへ PATCH で送る。画面の描画（コア1）は通信で止まらない。
//   画面下の点：緑=同期中 / 橙=Wi-Fi はつながったがサーバに届かない / 灰=Wi-Fi 接続中
//   キャラ：マイページで選んだキャラの Dial 用のはんこ（server/sprites/<cid>/dial/<席>.bin）を、変わった席だけ取り寄せる。
//   届くまで・取れないときは、ファームに入っている絵（office_art_dial.h）で描く。
//
// 操作
//   つまみを回す  : 操作する席を選ぶ（島のまわりを時計回り）
//   つまみを押す  : 選択中の席のコメント（定型文）を順送り
//   つまみを長押し: 選択中の席の 在席 / 不在 を切り替え
//   画面タップ    : タップした席の 在席 / 不在 を切り替え
//   シリアル(115200): "p 3" 席3の在席切替 / "c 3 寒い…" 席3にコメント / "c 3" 席3のコメントを消す
#include <M5Unified.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
#include <esp_partition.h>
// ../denno_config.h（Wi-Fi のパスワードを書く。git には入らない）が無ければ、端末だけで動くサンプル設定を使う
#if __has_include("../denno_config.h")
#include "../denno_config.h"
#else
#include "../denno_config.example.h"
#endif
#include "office_art_dial.h"

static const int W = 240, H = 240;
static M5Canvas canvas(&M5.Display);
static uint16_t* fb = nullptr;

// サーバから取り寄せた、その席用のキャラのはんこ（フラッシュの置き場を窓で見ているもの）
struct DynArt {
  spi_flash_mmap_handle_t mh;
  int16_t x, y, w, h;
  const uint16_t* open[FRAMES];
  const uint16_t* blink[FRAMES];
};

struct SeatState {
  const char* code;
  String name;
  bool present;
  String comment;
  int presetIdx;
  uint32_t nextBlink;
  int blinkLeft;
  String id;            // サーバ上のメンバー id（最初の同期で入る）
  uint32_t localUntil;  // 端末で変えた直後はサーバの古い状態で上書きしない
  DynArt* art;          // 取り寄せたはんこ（nullptr ならファームに入っている絵）
};

// 名前とコメントはサンプル（サーバにつながると置き換わる）
static SeatState S[6] = {
  {"A1", "佐藤", true, "午後から会議", 4, 0, 0},
  {"A2", "鈴木", true, "", 0, 0, 0},
  {"A3", "高橋", false, "", 0, 0, 0},
  {"B1", "田中", true, "寒い…", 2, 0, 0},
  {"B2", "伊藤", false, "", 0, 0, 0},
  {"B3", "渡辺", true, "集中モード", 1, 0, 0},
};
static const char* PRESETS[] = {"", "集中モード", "寒い…", "暑い…", "午後から会議", "話しかけOK"};
static const int PRESET_N = sizeof(PRESETS) / sizeof(PRESETS[0]);

// 吹き出しの置き場所（席ごとに決め打ち）。cx, top : 箱の中心xと上端 / tx, ty : しっぽの先
// コメントだけを1行で出す（名前は画面下と不在タグに出す）。箱の幅は文字に合わせ、円からはみ出すぶんは内側へ寄せる
struct BubblePos { int16_t cx, top, tx, ty; };
static const int BH = 18, BW_MAX = 84;
static const BubblePos BUB[6] = {
  { 72, 186,  58, 176},   // A1（手前の列は椅子の下に出す）
  {152, 168, 146, 160},   // A2
  {190, 147, 204, 140},   // A3
  { 66,  44,  34,  68},   // B1（奥の列は頭の上）
  {110,  22,  98,  62},   // B2
  {166,  40, 154,  59},   // B3
};
static const int DRAW_ORDER[6] = {3, 4, 5, 0, 1, 2};  // 奥 → 手前
static const int DIAL_ORDER[6] = {3, 4, 5, 2, 1, 0};  // つまみで選ぶ順（B1 → B2 → B3 → A3 → A2 → A1、島のまわりを時計回り）

static int selected = 0;
static int frameIdx = 0;
static uint32_t nextTick = 0;
static uint32_t nameUntil = 0;  // つまみで選んだ直後だけ、その席に名札を出す
static const uint32_t TICK_MS = 80;
static const uint32_t LOCAL_HOLD_MS = 4000;

static uint16_t C565(uint8_t r, uint8_t g, uint8_t b) { return canvas.color565(r, g, b); }

// ---------- サーバ連携 ----------

enum NetState { NET_OFF, NET_CONNECTING, NET_NO_SERVER, NET_OK };
static volatile NetState netState = NET_OFF;
static SemaphoreHandle_t netLock;
static String inbox;          // ネット側 → 画面側：最新の /api/device の中身
static bool inboxNew = false;
static const int OUT_MAX = 8;
static String outbox[OUT_MAX];  // 画面側 → ネット側："id<TAB>JSON" の PATCH 待ち
static int outN = 0;

static bool netEnabled() { return strlen(WIFI_SSID) > 0; }

static String jsonStr(const String& s) {
  String o = "\"";
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '"' || c == '\\') o += '\\';
    o += c;
  }
  return o + "\"";
}

// 端末での変更をサーバへ送る予約。id がまだ分からない（未同期）ときは送らない
static void enqueue(int i, const String& json) {
  if (!netEnabled() || S[i].id.length() == 0) return;
  S[i].localUntil = millis() + LOCAL_HOLD_MS;
  xSemaphoreTake(netLock, portMAX_DELAY);
  if (outN < OUT_MAX) outbox[outN++] = S[i].id + "\t" + json;
  xSemaphoreGive(netLock);
}

static void sendPresent(int i) { enqueue(i, String("{\"present\":") + (S[i].present ? "true" : "false") + "}"); }
static void sendComment(int i) {
  if (S[i].comment.length() == 0) enqueue(i, "{\"comment\":null}");
  else enqueue(i, "{\"comment\":{\"text\":" + jsonStr(S[i].comment) + ",\"duration\":\"2h\"}}");
}

// ---------- キャラのはんこ ----------
// ネット側が「席ごとに今どのキャラ・版を持っているか」を覚えておき、/api/device の キャラ・版 と違ったら取り寄せる。
// 取り寄せ終わったものだけを画面側へ渡す（pendingArt）。画面側は描画の合間に差し替える。
//
// はんこはフラッシュの sprites 領域に書く。席ごとに 2 つの置き場（slot）を交互に使い、
// 画面が片方を描いているあいだに、もう片方へ書く。置き場の先頭に SlotHdr を置き、
// 電源を切っても次の起動でそのまま使う（取り直さない）。
static String netHaveChar[6];
static uint32_t netHaveVer[6];
static DynArt* pendingArt[6];
static bool pendingSet[6];   // true なら pendingArt[i] に差し替える（nullptr ならファームの絵に戻す）

static const uint32_t SLOT_SIZE = 0x30000;      // 192KB（64KB の倍数）。12 個で partitions_dial.csv の sprites と同じ大きさ
static const uint32_t SLOT_DATA = 64;           // はんこ本体の位置（SlotHdr の後ろ）
static const uint32_t SLOT_MAGIC = 0x31534444;  // "DDS1"
struct SlotHdr {
  uint32_t magic, gen, len, ver;
  char cid[48];
};
static const esp_partition_t* spritePart = nullptr;
static int netSlot[6] = {-1, -1, -1, -1, -1, -1};  // ネット側が最後に画面へ渡した置き場
static uint32_t slotGen = 1;                       // 書くたびに増やす（どちらの置き場が新しいかを見分ける）
static uint8_t chunk[4096];

static uint16_t rd16(const uint8_t* p) { return p[0] | (p[1] << 8); }
static uint32_t rd32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

static void freeArt(DynArt* a) {
  if (!a) return;
  spi_flash_munmap(a->mh);
  delete a;
}

// はんこの中身を確かめ、コマごとの位置を割り出す。形式がおかしければ false
// 形式: "DSP1" / x y w h frames hasBlink (uint16) / offsets (uint32) / データ（tools/bake_chara.py）
static bool parseArt(DynArt* a, const uint8_t* buf, int len) {
  if (len < 16 || memcmp(buf, "DSP1", 4) != 0) return false;
  int x = rd16(buf + 4), y = rd16(buf + 6), w = rd16(buf + 8), hh = rd16(buf + 10);
  int frames = rd16(buf + 12), hasBlink = rd16(buf + 14);
  int nOff = frames * (hasBlink ? 2 : 1);
  int dataAt = 16 + 4 * nOff;
  bool ok = frames > 0 && frames <= 64 && dataAt < len && x + w <= W && y + hh <= H;
  for (int k = 0; ok && k < nOff; k++) ok = dataAt + (int)rd32(buf + 16 + 4 * k) < len;
  if (!ok) return false;
  a->x = x; a->y = y; a->w = w; a->h = hh;
  for (int k = 0; k < FRAMES; k++) {
    a->open[k] = (const uint16_t*)(buf + dataAt + rd32(buf + 16 + 4 * (k % frames)));
    a->blink[k] = hasBlink ? (const uint16_t*)(buf + dataAt + rd32(buf + 16 + 4 * (frames + k % frames))) : a->open[k];
  }
  return true;
}

static bool readHdr(int slot, SlotHdr& hd) {
  if (esp_partition_read(spritePart, slot * SLOT_SIZE, &hd, sizeof(hd)) != ESP_OK) return false;
  hd.cid[sizeof(hd.cid) - 1] = 0;
  return hd.magic == SLOT_MAGIC && hd.len >= 16 && hd.len <= SLOT_SIZE - SLOT_DATA;
}

// 置き場のはんこを読めるようにする（フラッシュを窓で見るだけで、RAM には読まない）
static DynArt* mapSlot(int slot, const SlotHdr& hd) {
  const void* p;
  DynArt* a = new DynArt;
  if (esp_partition_mmap(spritePart, slot * SLOT_SIZE, SLOT_DATA + hd.len, SPI_FLASH_MMAP_DATA, &p, &a->mh) != ESP_OK) {
    delete a;
    return nullptr;
  }
  if (!parseArt(a, (const uint8_t*)p + SLOT_DATA, hd.len)) {
    spi_flash_munmap(a->mh);
    delete a;
    return nullptr;
  }
  return a;
}

// 起動時：前に取り寄せて書いてあるはんこを、席ごとに新しいほうから使う
static void loadSlots() {
  spritePart = esp_partition_find_first((esp_partition_type_t)0x40, ESP_PARTITION_SUBTYPE_ANY, "sprites");
  if (!spritePart || spritePart->size < 12 * SLOT_SIZE) {
    Serial.println("[art] sprites 領域が無いので、ファームの絵だけで描きます（partitions_dial.csv で書き込み直す）");
    spritePart = nullptr;
    return;
  }
  for (int i = 0; i < 6; i++) {
    int best = -1;
    SlotHdr hb;
    for (int k = 0; k < 2; k++) {
      SlotHdr hd;
      if (!readHdr(2 * i + k, hd)) continue;
      slotGen = max(slotGen, hd.gen + 1);
      if (best < 0 || hd.gen > hb.gen) { best = 2 * i + k; hb = hd; }
    }
    if (best < 0) continue;
    DynArt* a = mapSlot(best, hb);
    if (!a) continue;
    S[i].art = a;
    netSlot[i] = best;
    netHaveChar[i] = hb.cid;
    netHaveVer[i] = hb.ver;
    Serial.printf("[art] %s: 前回の %s を使います\n", S[i].code, hb.cid);
  }
}

// /sprites/<cid>/dial/<席>.bin を、画面が使っていない置き場へ書いてから読めるようにする。失敗したら nullptr
static DynArt* fetchArt(const String& base, const String& cid, int i, uint32_t ver) {
  const char* seat = S[i].code;
  if (!spritePart || cid.length() >= sizeof(SlotHdr::cid)) return nullptr;
  HTTPClient h;
  h.setConnectTimeout(2000);
  h.setTimeout(5000);
  h.begin(base + "/sprites/" + cid + "/dial/" + seat + ".bin");
  int code = h.GET();
  int len = h.getSize();
  if (code != 200 || len < 16 || len > (int)(SLOT_SIZE - SLOT_DATA)) {
    Serial.printf("[art] %s %s: GET %d size %d\n", cid.c_str(), seat, code, len);
    h.end();
    return nullptr;
  }

  // 前に渡したはんこへ画面が差し替え終わるまで待つ（その前の置き場がまだ使われているかもしれない）
  for (;;) {
    xSemaphoreTake(netLock, portMAX_DELAY);
    bool busy = pendingSet[i];
    xSemaphoreGive(netLock);
    if (!busy) break;
    delay(5);
  }
  int slot = netSlot[i] == 2 * i ? 2 * i + 1 : 2 * i;
  uint32_t off = slot * SLOT_SIZE;
  if (esp_partition_erase_range(spritePart, off, SLOT_SIZE) != ESP_OK) { h.end(); return nullptr; }

  WiFiClient* st = h.getStreamPtr();
  int got = 0;
  uint32_t t0 = millis();
  bool ok = true;
  while (ok && got < len && millis() - t0 < 15000) {
    int n = st->available();
    if (n <= 0) { delay(2); continue; }
    n = st->readBytes(chunk, min(n, min(len - got, (int)sizeof(chunk))));
    ok = esp_partition_write(spritePart, off + SLOT_DATA + got, chunk, n) == ESP_OK;
    got += n;
  }
  h.end();
  if (!ok || got != len) {
    Serial.printf("[art] %s %s: 途中で切れた (%d/%d bytes)\n", cid.c_str(), seat, got, len);
    return nullptr;
  }

  // 最後に見出しを書く（ここまで書けたものだけが、次の起動で使われる）
  SlotHdr hd = {SLOT_MAGIC, slotGen++, (uint32_t)len, ver, {0}};
  strncpy(hd.cid, cid.c_str(), sizeof(hd.cid) - 1);
  if (esp_partition_write(spritePart, off, &hd, sizeof(hd)) != ESP_OK) return nullptr;
  DynArt* a = mapSlot(slot, hd);
  if (!a) { Serial.printf("[art] %s %s: 壊れたデータ (%d bytes)\n", cid.c_str(), seat, len); return nullptr; }
  netSlot[i] = slot;
  Serial.printf("[art] %s %s: %d KB  置き場 %d  RAM 残り %u KB\n", cid.c_str(), seat, len / 1024, slot, ESP.getFreeHeap() / 1024);
  return a;
}

// /api/device の各行（席 \t id \t 在席 \t 名前 \t ひとりごと \t キャラ \t 版）を見て、変わった席のはんこを取り寄せる
static void syncArt(const String& base, const String& body) {
  int pos = 0;
  while (pos < (int)body.length()) {
    int nl = body.indexOf('\n', pos);
    if (nl < 0) nl = body.length();
    String line = body.substring(pos, nl);
    pos = nl + 1;
    String f[7];
    int start = 0;
    for (int k = 0; k < 7; k++) {
      int t = k < 6 ? line.indexOf('\t', start) : -1;
      if (t < 0) t = line.length();
      f[k] = start <= (int)line.length() ? line.substring(start, t) : String("");
      start = t + 1;
    }
    for (int i = 0; i < 6; i++) {
      if (f[0] != S[i].code) continue;
      String cid = f[5];
      uint32_t ver = strtoul(f[6].c_str(), nullptr, 10);
      if (cid == netHaveChar[i] && ver == netHaveVer[i]) break;
      DynArt* a = nullptr;
      if (cid.length() && ver > 0) {
        a = fetchArt(base, cid, i, ver);
        if (!a) break;  // 次の同期でもう一度
      } else {
        netSlot[i] = -1;  // ファームの絵に戻す（置き場はどちらも空いたことになる）
      }
      xSemaphoreTake(netLock, portMAX_DELAY);
      if (pendingSet[i]) freeArt(pendingArt[i]);
      pendingArt[i] = a;
      pendingSet[i] = true;
      xSemaphoreGive(netLock);
      netHaveChar[i] = cid;
      netHaveVer[i] = ver;
      break;
    }
  }
}

// 画面側：取り寄せ終わったはんこに差し替える
static void applyArt() {
  for (int i = 0; i < 6; i++) {
    DynArt* old = nullptr;
    bool swapped = false;
    xSemaphoreTake(netLock, portMAX_DELAY);
    if (pendingSet[i]) {
      old = S[i].art;
      S[i].art = pendingArt[i];
      pendingArt[i] = nullptr;
      pendingSet[i] = false;
      swapped = true;
    }
    xSemaphoreGive(netLock);
    if (swapped) freeArt(old);
  }
}

// SERVER_HOST が ".local" なら mDNS で IP を引く
static String resolveBase() {
  String host = SERVER_HOST;
  if (host.endsWith(".local")) {
    IPAddress ip = MDNS.queryHost(host.substring(0, host.length() - 6), 2000);
    if (ip == IPAddress(0, 0, 0, 0)) { Serial.printf("[net] %s が見つからない\n", SERVER_HOST); return ""; }
    host = ip.toString();
    Serial.printf("[net] %s = %s\n", SERVER_HOST, host.c_str());
  }
  return "http://" + host + ":" + String(SERVER_PORT);
}

static void netTask(void*) {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  MDNS.begin("denno-dial");
  String base;
  uint32_t lastPoll = 0;
  int fails = 0;

  for (;;) {
    if (WiFi.status() != WL_CONNECTED) {
      if (netState != NET_CONNECTING) Serial.println("[net] Wi-Fi 接続中…");
      netState = NET_CONNECTING;
      base = "";
      delay(500);
      continue;
    }
    if (base.length() == 0) {
      Serial.printf("[net] Wi-Fi OK  IP %s\n", WiFi.localIP().toString().c_str());
      base = resolveBase();
      if (base.length() == 0) { netState = NET_NO_SERVER; delay(3000); continue; }
    }

    // 送る予約があれば先に送る
    String job;
    xSemaphoreTake(netLock, portMAX_DELAY);
    if (outN > 0) {
      job = outbox[0];
      for (int k = 1; k < outN; k++) outbox[k - 1] = outbox[k];
      outN--;
    }
    xSemaphoreGive(netLock);
    if (job.length()) {
      int tab = job.indexOf('\t');
      HTTPClient h;
      h.setConnectTimeout(2000);
      h.setTimeout(3000);
      h.begin(base + "/api/members/" + job.substring(0, tab));
      h.addHeader("Content-Type", "application/json");
      int code = h.sendRequest("PATCH", job.substring(tab + 1));
      h.end();
      Serial.printf("[net] PATCH %s -> %d\n", job.c_str(), code);
      lastPoll = 0;  // 送ったらすぐ取り直す
      continue;
    }

    if (lastPoll && millis() - lastPoll < POLL_MS) { delay(50); continue; }
    lastPoll = millis();

    HTTPClient h;
    h.setConnectTimeout(2000);
    h.setTimeout(3000);
    h.begin(base + "/api/device?board=dial");  // 版の列は Dial 用のはんこの版（Dial 用が無ければ 0）
    int code = h.GET();
    if (code == 200) {
      String body = h.getString();
      xSemaphoreTake(netLock, portMAX_DELAY);
      inbox = body;
      inboxNew = true;
      xSemaphoreGive(netLock);
      if (netState != NET_OK) Serial.println("[net] サーバと同期しました");
      netState = NET_OK;
      fails = 0;
      h.end();
      syncArt(base, body);
      continue;
    } else {
      Serial.printf("[net] GET /api/device -> %d\n", code);
      netState = NET_NO_SERVER;
      if (++fails >= 3) { base = ""; fails = 0; }  // Mac の IP が変わったかもしれないので引き直す
    }
    h.end();
  }
}

// 届いた状態を席に反映（画面側で呼ぶ）。1行 = 席 \t id \t 在席 \t 名前 \t ひとりごと
static void applyInbox() {
  String body;
  xSemaphoreTake(netLock, portMAX_DELAY);
  if (inboxNew) { body = inbox; inboxNew = false; }
  xSemaphoreGive(netLock);
  if (body.length() == 0) return;

  uint32_t now = millis();
  int pos = 0;
  while (pos < (int)body.length()) {
    int nl = body.indexOf('\n', pos);
    if (nl < 0) nl = body.length();
    String line = body.substring(pos, nl);
    pos = nl + 1;
    String f[5];  // 6・7列目（キャラ・版）は syncArt が見る
    int start = 0;
    for (int k = 0; k < 5; k++) {
      int t = line.indexOf('\t', start);
      if (t < 0) t = line.length();
      f[k] = line.substring(start, t);
      start = t + 1;
    }
    for (int i = 0; i < 6; i++) {
      if (f[0] != S[i].code) continue;
      S[i].id = f[1];
      S[i].name = f[3];
      if ((int32_t)(now - S[i].localUntil) < 0) continue;  // 端末で変えた直後
      S[i].present = f[2] == "1";
      S[i].comment = f[4];
    }
  }
}

// ---------- 描画 ----------

// マスク付きランレングスのスプライトをフレームバッファへ書き込む（左上 x0,y0 から h 行）
static void blit(int x0, int y0, int h, const uint16_t* d) {
  for (int y = 0; y < h; y++) {
    int runs = *d++;
    uint16_t* row = fb + (y0 + y) * W + x0;
    int x = 0;
    for (int r = 0; r < runs; r++) {
      x += *d++;
      int len = *d++;
      memcpy(row + x, d, len * 2);
      d += len;
      x += len;
    }
  }
}

static uint16_t accent() { return C565(140, 170, 255); }

// 幅 w・高さ h の箱を、円形の画面に収まるよう左右に寄せた x を返す
static int inCircle(int x, int w, int y, int h) {
  const int r = W / 2, pad = 3;
  int yy = max(abs(y - r), abs(y + h - r));
  if (yy >= r) return r - w / 2;
  int half = (int)sqrtf((float)(r * r - yy * yy)) - pad;
  int lo = r - half, hi = r + half - w;
  return hi < lo ? r - w / 2 : constrain(x, lo, hi);
}

// 吹き出しは「しっぽを全部 → 箱を全部」の順に描く（長いコメントの箱が、となりのしっぽに切られないように）
static void drawBubbles() {
  uint16_t paper = C565(246, 248, 252), ink = C565(24, 30, 50);
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  int bx[6], bw[6];
  for (int pass = 0; pass < 2; pass++) {
    for (int n = 0; n < 6; n++) {
      int i = DRAW_ORDER[n];
      const SeatState& s = S[i];
      if (!s.present || s.comment.length() == 0) continue;
      const BubblePos& b = BUB[i];
      if (pass == 0) {
        bw[i] = min((int)canvas.textWidth(s.comment) + 12, BW_MAX);
        bx[i] = inCircle(b.cx - bw[i] / 2, bw[i], b.top, BH);
        int baseX = constrain((int)b.tx, bx[i] + 8, bx[i] + bw[i] - 8);
        int baseY = (b.ty > b.top) ? b.top + BH - 1 : b.top;
        canvas.fillTriangle(baseX - 5, baseY, baseX + 5, baseY, b.tx, b.ty, paper);
        continue;
      }
      canvas.fillRoundRect(bx[i], b.top, bw[i], BH, 6, paper);
      if (i == selected) {
        canvas.drawRoundRect(bx[i], b.top, bw[i], BH, 6, accent());
        canvas.drawRoundRect(bx[i] + 1, b.top + 1, bw[i] - 2, BH - 2, 5, accent());
      }
      canvas.setClipRect(bx[i] + 3, b.top, bw[i] - 6, BH);
      canvas.setTextDatum(middle_left);
      canvas.setTextColor(ink);
      canvas.drawString(s.comment, bx[i] + 6, b.top + BH / 2);
      canvas.clearClipRect();
    }
  }
}

// 名前の札（不在タグ・名札）。円からはみ出さないよう寄せる
static void drawTag(const String& t, int cx, int y, uint16_t bg, uint16_t fg, bool ring) {
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  int tw = canvas.textWidth(t) + 10;
  int x = inCircle(cx - tw / 2, tw, y, 16);
  canvas.fillRoundRect(x, y, tw, 16, 4, bg);
  if (ring) canvas.drawRoundRect(x, y, tw, 16, 4, accent());
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(fg);
  canvas.drawString(t, x + tw / 2, y + 8);
}

static void drawAwayTag(int i) {
  drawTag(S[i].name + " 不在", SEATS[i].chairX, SEATS[i].chairY - 8, C565(20, 26, 44), C565(150, 160, 190), i == selected);
}

static void drawSelection() {
  // つまみで選んだ直後は、在席の人の頭の上に名札を出す
  if ((int32_t)(millis() - nameUntil) < 0 && S[selected].present)
    drawTag(S[selected].name, SEATS[selected].headX, SEATS[selected].headY - 20, accent(), C565(16, 20, 40), false);

  // 画面下：選んでいる席と、通信の状態
  String t = String(S[selected].code) + " " + S[selected].name;
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(accent());
  canvas.drawString(t, W / 2 + 5, 224);
  if (netState == NET_OFF) return;
  uint16_t c = netState == NET_OK ? C565(126, 224, 184) : netState == NET_NO_SERVER ? C565(255, 170, 80) : C565(110, 118, 140);
  canvas.fillCircle(W / 2 + 5 - canvas.textWidth(t) / 2 - 8, 224, 3, c);
}

static void render() {
  memcpy(fb, BG_RAW, W * H * 2);
  uint32_t now = millis();
  for (int n = 0; n < 6; n++) {
    int i = DRAW_ORDER[n];
    SeatState& s = S[i];
    if (!s.present) continue;
    if ((int32_t)(now - s.nextBlink) >= 0) { s.blinkLeft = 2; s.nextBlink = now + 2000 + random(4000); }
    int f = (frameIdx + i * 3) % FRAMES;
    bool closed = s.blinkLeft > 0;
    if (s.art) blit(s.art->x, s.art->y, s.art->h, closed ? s.art->blink[f] : s.art->open[f]);
    else blit(SEATS[i].x, SEATS[i].y, SEATS[i].h, closed ? SEATS[i].blink[f] : SEATS[i].open[f]);
    if (s.blinkLeft > 0) s.blinkLeft--;
  }
  for (int i = 0; i < 6; i++) if (!S[i].present) drawAwayTag(i);
  drawBubbles();
  drawSelection();
  canvas.pushSprite(0, 0);
}

// タップ位置に一番近い席
static int seatAt(int tx, int ty) {
  int best = -1, bestD = 1 << 30;
  for (int i = 0; i < 6; i++) {
    const SeatArt& a = SEATS[i];
    int cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    bool inside = tx >= a.x - 5 && tx < a.x + a.w + 5 && ty >= a.y - 5 && ty < a.y + a.h + 5;
    int d = (tx - cx) * (tx - cx) + (ty - cy) * (ty - cy);
    if (inside && d < bestD) { bestD = d; best = i; }
  }
  return best;
}

static void handleSerial() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() < 3) return;
  char cmd = line[0];
  int i = line.substring(2, 3).toInt();
  if (i < 0 || i > 5) return;
  if (cmd == 'p') { S[i].present = !S[i].present; sendPresent(i); }
  if (cmd == 'c') { String t = line.length() > 4 ? line.substring(4) : String(""); t.trim(); S[i].comment = t; sendComment(i); }
  Serial.printf("seat %d present=%d comment=\"%s\"\n", i, S[i].present, S[i].comment.c_str());
}

// ---------- つまみ（ロータリーエンコーダ） ----------
// A/B 2 本の信号の変化を割り込みで数える。1 カチッで 4 つ進む（ENC_STEP）
// 実機で「1 カチッで 2 席動く / 2 カチッで 1 席」なら ENC_STEP を、向きが逆なら ENC_A と ENC_B を入れ替える
static const int ENC_A = 41, ENC_B = 40;
static const int ENC_STEP = 4;
static volatile int32_t encCount = 0;
static volatile uint8_t encPrev = 0;
static int32_t encBase = 0;

static void IRAM_ATTR encIsr() {
  static const int8_t T[16] = {0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0};
  uint8_t s = (digitalRead(ENC_A) << 1) | digitalRead(ENC_B);
  encCount += T[(encPrev << 2) | s];
  encPrev = s;
}

static void encBegin() {
  pinMode(ENC_A, INPUT_PULLUP);
  pinMode(ENC_B, INPUT_PULLUP);
  encPrev = (digitalRead(ENC_A) << 1) | digitalRead(ENC_B);
  attachInterrupt(ENC_A, encIsr, CHANGE);
  attachInterrupt(ENC_B, encIsr, CHANGE);
}

// 回したカチッの数（右回りが +）
static int encSteps() {
  int32_t c = encCount;
  int d = (c - encBase) / ENC_STEP;
  encBase += d * ENC_STEP;
  return d;
}

static void handleDial() {
  int d = encSteps();
  if (d) {
    int k = 0;
    while (DIAL_ORDER[k] != selected) k++;
    k = ((k + d) % 6 + 6) % 6;
    selected = DIAL_ORDER[k];
    nameUntil = millis() + 1500;
  }
  if (M5.BtnA.wasHold()) {
    S[selected].present = !S[selected].present;
    sendPresent(selected);
  } else if (M5.BtnA.wasClicked()) {
    SeatState& s = S[selected];
    s.presetIdx = (s.presetIdx + 1) % PRESET_N;
    s.comment = PRESETS[s.presetIdx];
    sendComment(selected);
  }
}

void setup() {
  auto cfg = M5.config();
  cfg.fallback_board = m5::board_t::board_M5Dial;  // 見分けられなかったときも Dial として動かす
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setBrightness(170);
  M5.Display.fillScreen(TFT_BLACK);
  Serial.printf("display %dx%d  RAM %u KB\n", M5.Display.width(), M5.Display.height(), ESP.getFreeHeap() / 1024);

  // 合成用のキャンバス 1 枚（約 113KB）を内蔵 RAM に置く。Wi-Fi より先に確保する
  canvas.setPsram(false);
  canvas.setColorDepth(16);
  if (!canvas.createSprite(W, H)) {
    M5.Display.setTextColor(TFT_WHITE);
    M5.Display.drawString("sprite alloc failed", 40, 110);
    while (true) delay(1000);
  }
  fb = (uint16_t*)canvas.getBuffer();
  loadSlots();
  encBegin();

  uint32_t now = millis();
  for (int i = 0; i < 6; i++) S[i].nextBlink = now + 1000 + random(4000);

  netLock = xSemaphoreCreateMutex();
  if (netEnabled()) {
    netState = NET_CONNECTING;
    xTaskCreatePinnedToCore(netTask, "net", 8192, nullptr, 1, nullptr, 0);
  } else {
    Serial.println("[net] denno_config.h の WIFI_SSID が空なので、端末だけで動きます");
  }
}

void loop() {
  M5.update();
  handleSerial();
  applyInbox();
  applyArt();
  handleDial();
  if (M5.Touch.getCount() > 0) {
    auto t = M5.Touch.getDetail();
    if (t.wasClicked()) {
      int i = seatAt(t.x, t.y);
      if (i >= 0) { S[i].present = !S[i].present; selected = i; sendPresent(i); }
    }
  }

  uint32_t now = millis();
  if ((int32_t)(now - nextTick) >= 0) {
    nextTick = now + TICK_MS;
    render();
    frameIdx = (frameIdx + 1) % FRAMES;
  }
  delay(1);
}
