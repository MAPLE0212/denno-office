// 電脳オフィス 6席：ミニキャラ版を M5Stack StopWatch で表示する
//
// 背景（JPEG）を起動時に PSRAM へ展開し、毎フレーム
//   背景コピー → 奥の列(B) → 手前の列(A) のキャラ → 不在タグ・吹き出し → 画面へ転送
// の順で 466x466 のキャンバスに合成している。キャラは事前レンダリング済みのマスク付きスプライト。
//
// サーバ連携（denno_config.h に Wi-Fi を書いたとき）
//   ネット用のタスク（コア0）が POLL_MS ごとにサーバの /api/device を取りに行き、在席・名前・ひとりごとを反映する。
//   端末での操作はサーバへ PATCH で送る。画面の描画（コア1）は通信で止まらない。
//   画面下の点：緑=同期中 / 橙=Wi-Fi はつながったがサーバに届かない / 灰=Wi-Fi 接続中
//   キャラ：マイページで選んだキャラの「はんこ」（席ごとの差分スプライト）を、変わった席だけ取り寄せて差し替える。
//   届くまで・取れないときは、ファームに入っている絵（office_art.h）で描く。
//
// 操作
//   画面タップ : タップした席の 在席 / 不在 を切り替え
//   BtnA      : 操作する席を次へ（画面下に表示）
//   BtnB      : 選択中の席のコメント（定型文）を順送り
//   シリアル(115200): "p 3" 席3の在席切替 / "c 3 寒い…" 席3にコメント / "c 3" 席3のコメントを消す
#include <M5Unified.h>
#include <WiFi.h>
#include <HTTPClient.h>
#include <ESPmDNS.h>
// denno_config.h（Wi-Fi のパスワードを書く。git には入らない）が無ければ、端末だけで動くサンプル設定を使う
#if __has_include("denno_config.h")
#include "denno_config.h"
#else
#include "denno_config.example.h"
#endif
#include "office_art.h"

static const int W = 466, H = 466;
static M5Canvas canvas(&M5.Display);
static M5Canvas bgc(&M5.Display);
static uint16_t* fb = nullptr;
static uint16_t* bgbuf = nullptr;

// サーバから取り寄せた、その席用のキャラのはんこ（server/sprites/<cid>/<席>.bin を PSRAM に読んだもの）
struct DynArt {
  uint8_t* buf;
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

// 吹き出しの置き場所（円形画面に収まり、互いに重ならないよう席ごとに決め打ち）
// cx, top : 箱の中心xと上端 / tx, ty : しっぽの先
struct BubblePos { int16_t cx, top, tx, ty; };
static const int BW = 100, BH = 40;
static const BubblePos BUB[6] = {
  {135, 372, 112, 346},   // A1（手前の列は椅子の下に出す）
  {262, 352, 276, 305},   // A2
  {378, 312, 404, 272},   // A3
  {112,  78,  60, 140},   // B1（奥の列は頭の上）
  {214,  40, 192, 127},   // B2
  {318,  60, 302, 116},   // B3
};
static const int DRAW_ORDER[6] = {3, 4, 5, 0, 1, 2};  // 奥 → 手前

static int selected = 0;
static int frameIdx = 0;
static uint32_t nextTick = 0;
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
static String netHaveChar[6];
static uint32_t netHaveVer[6];
static DynArt* pendingArt[6];
static bool pendingSet[6];   // true なら pendingArt[i] に差し替える（nullptr ならファームの絵に戻す）

static void freeArt(DynArt* a) {
  if (!a) return;
  free(a->buf);
  delete a;
}

static uint16_t rd16(const uint8_t* p) { return p[0] | (p[1] << 8); }
static uint32_t rd32(const uint8_t* p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }

// /sprites/<cid>/<席>.bin を PSRAM に読み、コマごとの位置を割り出す。失敗したら nullptr
static DynArt* fetchArt(const String& base, const String& cid, const char* seat) {
  HTTPClient h;
  h.setConnectTimeout(2000);
  h.setTimeout(5000);
  h.begin(base + "/sprites/" + cid + "/" + seat + ".bin");
  int code = h.GET();
  int len = h.getSize();
  if (code != 200 || len < 16 || len > 2 * 1024 * 1024) {
    Serial.printf("[art] %s %s: GET %d size %d\n", cid.c_str(), seat, code, len);
    h.end();
    return nullptr;
  }
  uint8_t* buf = (uint8_t*)ps_malloc(len);
  if (!buf) { Serial.printf("[art] PSRAM が足りない (%d bytes)\n", len); h.end(); return nullptr; }
  WiFiClient* st = h.getStreamPtr();
  int got = 0;
  uint32_t t0 = millis();
  while (got < len && millis() - t0 < 15000) {
    int n = st->available();
    if (n > 0) got += st->readBytes(buf + got, min(n, len - got));
    else delay(2);
  }
  h.end();

  // 形式: "DSP1" / x y w h frames hasBlink (uint16) / offsets (uint32) / データ
  int x = rd16(buf + 4), y = rd16(buf + 6), w = rd16(buf + 8), hh = rd16(buf + 10);
  int frames = rd16(buf + 12), hasBlink = rd16(buf + 14);
  int nOff = frames * (hasBlink ? 2 : 1);
  int dataAt = 16 + 4 * nOff;
  bool ok = got == len && memcmp(buf, "DSP1", 4) == 0 && frames > 0 && frames <= 64 && dataAt < len &&
            x + w <= W && y + hh <= H;
  for (int k = 0; ok && k < nOff; k++) ok = dataAt + (int)rd32(buf + 16 + 4 * k) < len;
  if (!ok) { Serial.printf("[art] %s %s: 壊れたデータ (%d/%d bytes)\n", cid.c_str(), seat, got, len); free(buf); return nullptr; }

  DynArt* a = new DynArt;
  a->buf = buf;
  a->x = x; a->y = y; a->w = w; a->h = hh;
  for (int k = 0; k < FRAMES; k++) {
    a->open[k] = (const uint16_t*)(buf + dataAt + rd32(buf + 16 + 4 * (k % frames)));
    a->blink[k] = hasBlink ? (const uint16_t*)(buf + dataAt + rd32(buf + 16 + 4 * (frames + k % frames))) : a->open[k];
  }
  Serial.printf("[art] %s %s: %d KB  PSRAM 残り %u KB\n", cid.c_str(), seat, len / 1024, ESP.getFreePsram() / 1024);
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
        a = fetchArt(base, cid, S[i].code);
        if (!a) break;  // 次の同期でもう一度
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
  MDNS.begin("denno-stopwatch");
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
    h.begin(base + "/api/device");
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

static void drawBubble(int i) {
  const SeatState& s = S[i];
  if (!s.present || s.comment.length() == 0) return;
  const BubblePos& b = BUB[i];
  uint16_t paper = C565(246, 248, 252), ink = C565(24, 30, 50), sub = C565(110, 118, 140);
  int x = b.cx - BW / 2;
  // しっぽ：箱の辺から先端へ
  int baseX = constrain((int)b.tx, x + 12, x + BW - 12);
  int baseY = (b.ty > b.top) ? b.top + BH - 1 : b.top;
  canvas.fillTriangle(baseX - 6, baseY, baseX + 6, baseY, b.tx, b.ty, paper);
  canvas.fillRoundRect(x, b.top, BW, BH, 8, paper);
  canvas.setClipRect(x + 4, b.top, BW - 8, BH);
  canvas.setTextDatum(top_left);
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  canvas.setTextColor(sub);
  canvas.drawString(String(s.code) + " " + s.name, x + 7, b.top + 3);
  canvas.setFont(&fonts::lgfxJapanGothic_16);
  canvas.setTextColor(ink);
  canvas.drawString(s.comment, x + 7, b.top + 19);
  canvas.clearClipRect();
}

static void drawAwayTag(int i) {
  const SeatArt& a = SEATS[i];
  String t = S[i].name + " 不在";
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  int tw = canvas.textWidth(t) + 10;
  int x = a.chairX - tw / 2, y = a.chairY - 8;
  canvas.fillRoundRect(x, y, tw, 18, 4, C565(20, 26, 44));
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(C565(150, 160, 190));
  canvas.drawString(t, a.chairX, y + 9);
}

static void drawSelection() {
  String t = String("操作中 ") + S[selected].code + " " + S[selected].name;
  canvas.setFont(&fonts::lgfxJapanGothic_12);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(C565(140, 170, 255));
  canvas.drawString(t, W / 2, 446);
  // 通信の状態
  if (netState == NET_OFF) return;
  uint16_t c = netState == NET_OK ? C565(126, 224, 184) : netState == NET_NO_SERVER ? C565(255, 170, 80) : C565(110, 118, 140);
  canvas.fillCircle(W / 2 - canvas.textWidth(t) / 2 - 10, 446, 4, c);
}

static void render() {
  memcpy(fb, bgbuf, W * H * 2);
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
  for (int n = 0; n < 6; n++) drawBubble(DRAW_ORDER[n]);
  drawSelection();
  canvas.pushSprite(0, 0);
}

// タップ位置に一番近い席
static int seatAt(int tx, int ty) {
  int best = -1, bestD = 1 << 30;
  for (int i = 0; i < 6; i++) {
    const SeatArt& a = SEATS[i];
    int cx = a.x + a.w / 2, cy = a.y + a.h / 2;
    bool inside = tx >= a.x - 10 && tx < a.x + a.w + 10 && ty >= a.y - 10 && ty < a.y + a.h + 10;
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

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setBrightness(170);
  M5.Display.fillScreen(TFT_BLACK);
  Serial.printf("display %dx%d  PSRAM %u KB\n", M5.Display.width(), M5.Display.height(), ESP.getPsramSize() / 1024);

  canvas.setPsram(true); canvas.setColorDepth(16);
  bgc.setPsram(true); bgc.setColorDepth(16);
  if (!canvas.createSprite(W, H) || !bgc.createSprite(W, H)) {
    M5.Display.setTextColor(TFT_WHITE);
    M5.Display.drawString("PSRAM sprite alloc failed", 60, 220);
    while (true) delay(1000);
  }
  fb = (uint16_t*)canvas.getBuffer();
  bgbuf = (uint16_t*)bgc.getBuffer();
  bgc.drawJpg(BG_JPG, sizeof(BG_JPG), 0, 0);

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

  if (M5.BtnA.wasClicked()) selected = (selected + 1) % 6;
  if (M5.BtnB.wasClicked()) {
    SeatState& s = S[selected];
    s.presetIdx = (s.presetIdx + 1) % PRESET_N;
    s.comment = PRESETS[s.presetIdx];
    sendComment(selected);
  }
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
