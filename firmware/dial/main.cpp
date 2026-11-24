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
// Dial の役割（サーバの /admin で決める。/api/device の #dial 行で届く。サーバの SEAT_MODE で使える役割が変わる）
//   固定席（SEAT_MODE=fixed）
//     全体用 : 登録したカードなら誰でも、その人の 在席 / 不在。つまみ・タップは席を選んで名前を見るだけ
//     個人用 : 持ち主のカードだけ受け付ける。つまみの長押し・押す・タップは持ち主の席の操作。持ち主が不在のあいだ背景がゆっくり光る
//     未設定 : 全体用と同じ。登録済みのカードをかざした直後に長押しすると、その人の専用（個人用）になる
//   フリーアドレス（SEAT_MODE=free）
//     机     : Dial を置いた机。カードをかざす → 今日はこの席に座る / 離席から戻る / もう一度で帰る（席が空く）
//              押す・タップ・長押しは、この机に座っている人の操作
//     未設定 : 机が決まっていない（画面下に Dial の番号＝MAC の下 4 桁。/admin でこの番号の Dial に机を決める）
//   どの役割でも、未登録のカードをかざすと 4 桁の番号が出る → /join かマイページの「カード」に入れると、そのカードがその人のものになる
//   カードは Dial に入っている読み取り部品（WS1850S、MFRC522 と同じ使い方）で読む。MIFARE などの ISO14443A だけ
//
// サーバ連携（../denno_config.h に Wi-Fi を書いたとき。StopWatch と同じ設定ファイルを使う）
//   ネット用のタスク（コア0）が POLL_MS ごとにサーバの /api/device?board=dial を取りに行き、在席・名前・ひとりごとを反映する。
//   端末での操作はサーバへ PATCH で送る。画面の描画（コア1）は通信で止まらない。
//   画面下の点：緑=同期中 / 橙=Wi-Fi はつながったがサーバに届かない / 灰=Wi-Fi 接続中
//   キャラ：マイページで選んだキャラの Dial 用のはんこ（server/sprites/<cid>/dial/<席>.bin）を、変わった席だけ取り寄せる。
//   届くまで・取れないときは、ファームに入っている絵（office_art_dial.h）で描く。
//
// 操作（「この Dial の席」= 個人用なら持ち主の席、机ならその机。Wi-Fi なしのお試しでは、つまみで選んだ席）
//   カードをかざす: 上の「Dial の役割」
//   つまみを回す  : 席を選んで名札を見る（固定席の全体用・未設定と、お試しのとき）
//   つまみを押す・画面タップ: この Dial の席の人の「ひとこと選び」を開く（下の「ひとこと選び」）。全体用・未設定はタップで席を選ぶ
//   つまみを長押し: この Dial の席の 在席 / 不在（フリーアドレスは 離席。席は取ったまま）
//   お試し（Wi-Fi なし）: つまみで席を選び、押す=ひとこと選び・長押し=在席 / 不在、タップ=その席の在席 / 不在、画面の長押し=その席のひとこと
//   シリアル(115200): "p 3" 席3の在席切替 / "c 3 寒い…" 席3にコメント / "c 3" 席3のコメントを消す / "l en" 言語（ja / en / zh。試す用）
//
// 言語：個人用の Dial は持ち主、机の Dial は座っている人がマイページで選んだ言語（/api/device の #dial 行の 5 列目）。
// 全体用・未設定の Dial は日本語。Dial に言語を選ぶ操作は無い。
// 日本語のフォントに無い字（中国語の简体字など）を含む文字列は、中国語のフォント（efontCN）で描く。
//                     "k 04A1B2C3" その番号のカードをかざしたことにする（カードなしで試す）
#include <M5Unified.h>
#include <M5Dial.h>  // カードの読み取り（M5Dial.Rfid）だけ使う。つまみは下の自前の割り込みで読む
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
  uint32_t nextBlink;
  int blinkLeft;
  String id;            // サーバ上のメンバー id（最初の同期で入る）
  uint32_t localUntil;  // 端末で変えた直後はサーバの古い状態で上書きしない
  DynArt* art;          // 取り寄せたはんこ（nullptr ならファームに入っている絵）
  String back;          // 戻る時刻（"16:00"。不在タグに出す）
  int8_t tGen;          // 時間のひとことのジャンル（GEN の番号 + 1。0 なら無し）
  uint32_t tEnd;        // その終わり（millis）
  uint32_t tTotal;      // 全体の長さ（秒。タイマー画面の輪の長さ）
};

// 名前とコメントはサンプル（サーバにつながると置き換わる）
static SeatState S[6] = {
  {"A1", "佐藤", true, "午後から会議"},
  {"A2", "鈴木", true, ""},
  {"A3", "高橋", false, ""},
  {"B1", "田中", true, "寒い"},
  {"B2", "伊藤", false, ""},
  {"B3", "渡辺", true, "集中 〜17:00"},
};
static const int ORIG_MAX = 10;
static String orig[6][ORIG_MAX];  // 席ごとのオリジナル（マイページで登録した文。/api/device の #o 行）
static int origN[6];

// ---------- 言語 ----------
// ひとこと選び・不在タグ・タイマー・自分の在席の知らせに出る文字（Dial の設定・登録の案内は日本語のまま）。
// %s には時刻やジャンル名が入る。島の画面の吹き出しは最大 84px なので、コメントになる文は短めに
struct LangText {
  const char* code;
  const char* genre[10];  // ジャンル名（GEN と同じ順）
  const char* temp[4];    // 気温
  const char* plan[3];    // 予定
  const char* talk[4];    // 声かけ
  const char* unitUntil;  // 集中・休憩・会議の「60 分」
  const char* unitAfter;  // 外出の「10 分後」
  const char* labelUntil; // 「〜15:45 まで」
  const char* labelAfter; // 「14:55 に外出」
  const char* labelBack;  // 戻りの時刻の下
  const char* cmtUntil;   // 送るコメント「集中 〜15:45」（ジャンル名, 時刻）
  const char* cmtAfter;   // 送るコメント「14:55 外出」
  const char* away;       // 不在タグ（固定席）
  const char* awayFree;   // 不在タグ（フリーアドレスの離席）
  const char* awayBack;   // 不在タグ「16:00戻り」
  const char* noOrig[2];  // オリジナルが無いとき
  const char* tLeft;      // タイマー「休憩 のこり」
  const char* tOut;       // 「外出まで」
  const char* tBack;      // 「戻りまで」
  const char* tDone;      // 0 になった
  const char* tDoneOut;   // 外出の 0
  const char* tNone[2];   // タイマーが無いとき
  const char* san;        // 名前のあと（" さん"）
  const char* present;    // 在席
  const char* hello;      // おはよう
  const char* bye;        // おつかれさま
  const char* welcome;    // おかえり
  const char* seeYou;     // いってらっしゃい
  const char* keepSeat;   // 席はそのままです
  const char* setIn;      // 在席にしました
  const char* setOut;     // 不在にしました
  const char* freed;      // 席を空けました
  const char* sat;        // 「A1 に座りました」
};
static const LangText LANGS[] = {
  {"ja",
   {"集中", "休憩", "会議", "外出", "戻り", "気温", "予定", "声かけ", "オリジナル", "消す"},
   {"寒い", "ちょっと寒い", "ちょっと暑い", "暑い"},
   {"午後から会議", "定時で帰ります", "明日はお休み"},
   {"話しかけOK", "手が空いてます", "雑談したい", "あとで返事します"},
   "分", "分後", "〜%s まで", "%s に外出", "に戻ります",
   "%s 〜%s", "%s 外出", "不在", "離席", "%s戻り",
   {"マイページの", "「オリジナル」で足せます"},
   "%s のこり", "外出まで", "戻りまで", "時間です", "出かける時間", {"タイマーなし", "集中・休憩などを選ぶと出ます"},
   " さん", "在席", "おはよう", "おつかれさま", "おかえり", "いってらっしゃい", "席はそのままです",
   "在席にしました", "不在にしました", "席を空けました", "%s に座りました"},
  {"en",
   {"Focus", "Break", "Meeting", "Out", "Back", "Temp", "Plans", "Chat", "Custom", "Clear"},
   {"Cold", "A bit cold", "A bit hot", "Hot"},
   {"PM meetings", "Leaving on time", "Off tomorrow"},
   {"Free to talk", "I'm free now", "Up for a chat", "Will reply later"},
   "min", "min", "until %s", "out at %s", "I'll be back",
   "%s ~%s", "Out %s", "Away", "Stepped out", "back %s",
   {"Add your own in", "My Page > Custom"},
   "%s left", "Until out", "Until back", "Time's up", "Time to go", {"No timer", "Pick Focus, Break, etc."},
   "", "In", "Good morning", "Good work", "Welcome back", "See you", "Seat kept",
   "Marked in", "Marked away", "Seat freed", "Sat at %s"},
  {"zh",
   {"专注", "休息", "开会", "外出", "回来", "温度", "安排", "交流", "自定义", "清除"},
   {"好冷", "有点冷", "有点热", "好热"},
   {"下午开会", "准时下班", "明天休息"},
   {"随时找我", "现在有空", "想聊聊天", "稍后回复"},
   "分钟", "分钟后", "到 %s", "%s 外出", "回来",
   "%s至%s", "%s 外出", "不在", "暂离", "%s回来",
   {"可在我的页面的", "「自定义」中添加"},
   "%s 剩余", "距离外出", "距离回来", "时间到了", "该出发了", {"没有计时", "选择专注、休息等即可显示"},
   "", "在座", "早上好", "辛苦了", "欢迎回来", "慢走", "座位已保留",
   "已设为在座", "已设为不在", "已空出座位", "已坐在 %s"},
};
static const int LANG_N = sizeof(LANGS) / sizeof(LANGS[0]);
static int lang = 0;  // サーバの #dial 行で変わる（全体用・未設定は 0 = 日本語）
static int langForced = -1;  // シリアルの "l en"（試す用。電源を切ると戻る）
static const LangText& L() { return LANGS[langForced >= 0 ? langForced : lang]; }

static int langIndex(const String& code) {
  for (int k = 0; k < LANG_N; k++) if (code.equalsIgnoreCase(LANGS[k].code)) return k;
  return -1;
}

// "%s" を a, b で埋める
static String fmt(const char* f, const String& a, const String& b = String()) {
  char buf[96];
  snprintf(buf, sizeof(buf), f, a.c_str(), b.c_str());
  return buf;
}
// サーバの時計（/api/device の #now 行）。まだ届いていなければ 12:00 から数える
static int32_t srvSec = -1;
static uint32_t srvAt = 0;

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

// この Dial の役割（サーバの #dial 行）。届くまでは ROLE_UNKNOWN
enum DialRole { ROLE_UNKNOWN, ROLE_NONE, ROLE_SHARED, ROLE_PERSONAL, ROLE_DESK };
static DialRole role = ROLE_UNKNOWN;
static int roleSeat = -1;       // 個人用：持ち主の席 / 机：置いた机（S の番号）。-1 = なし
static String ownerName;        // 個人用の持ち主
static bool freeMode = false;   // サーバがフリーアドレス（#mode 行）
static int selected = 0;        // つまみで選んでいる席（全体用・未設定・お試し）
static String macTail;          // MAC の下 4 桁（/admin の一覧と見比べる）
static int frameIdx = 0;
static uint32_t nextTick = 0;
static uint32_t nameUntil = 0;  // 選んだ・座った直後だけ、その席に名札を出す
static const uint32_t TICK_MS = 80;
static const uint32_t LOCAL_HOLD_MS = 4000;

static uint16_t C565(uint8_t r, uint8_t g, uint8_t b) { return canvas.color565(r, g, b); }

static bool netEnabled();
// この Dial の席：個人用なら持ち主の席、机ならその机。全体用・未設定・お試しはつまみで選んだ席。フリーアドレスの未設定は -1
static bool ownSeatRole() { return role == ROLE_PERSONAL || role == ROLE_DESK; }
static int focusSeat() {
  if (!netEnabled()) return selected;
  if (ownSeatRole()) return roleSeat;
  if (freeMode) return -1;
  return selected;
}
// つまみ・タップで席を選べるか（固定席の全体用・未設定、お試し）
static bool canSelect() { return !netEnabled() || (role != ROLE_UNKNOWN && !freeMode && !ownSeatRole()); }

// ---------- サーバ連携 ----------

enum NetState { NET_OFF, NET_CONNECTING, NET_NO_SERVER, NET_OK };
static volatile NetState netState = NET_OFF;
static SemaphoreHandle_t netLock;
static String inbox;          // ネット側 → 画面側：最新の /api/device の中身
static bool inboxNew = false;
static const int OUT_MAX = 8;
static String outbox[OUT_MAX];  // 画面側 → ネット側："id<TAB>JSON" の PATCH 待ち
static int outN = 0;
static String cardJob;        // 画面側 → ネット側："card<TAB>番号"（POST /api/card 待ち）か "claim<TAB>番号"（/api/card/claim）
static String cardReply;      // ネット側 → 画面側：その答え（"sit\t佐藤\tA2" など。届かなければ "net"）
static bool cardReplyNew = false;
static String macHex;         // この Dial の MAC（12 桁、サーバに送る）

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
  macHex = WiFi.macAddress();
  macHex.replace(":", "");
  macHex.toLowerCase();
  macTail = macHex.substring(8);
  macTail.toUpperCase();
  Serial.printf("[net] この Dial の MAC %s（/admin では Dial %s）\n", macHex.c_str(), macTail.c_str());
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
      if (base.length() == 0) {
        netState = NET_NO_SERVER;
        xSemaphoreTake(netLock, portMAX_DELAY);
        if (cardJob.length()) { cardJob = ""; cardReply = "net"; cardReplyNew = true; }
        xSemaphoreGive(netLock);
        delay(3000);
        continue;
      }
    }

    // かざされたカードがあれば、いちばん先に送る（答えを画面に出すので待たせない）。cardJob = "card|claim <TAB> 番号"
    String job0;
    xSemaphoreTake(netLock, portMAX_DELAY);
    job0 = cardJob;
    cardJob = "";
    xSemaphoreGive(netLock);
    if (job0.length()) {
      int tab = job0.indexOf('\t');
      String path = job0.substring(0, tab) == "claim" ? "/api/card/claim" : "/api/card";
      String uid = job0.substring(tab + 1);
      HTTPClient h;
      h.setConnectTimeout(2000);
      h.setTimeout(3000);
      h.begin(base + path);
      h.addHeader("Content-Type", "application/json");
      int code = h.POST("{\"mac\":\"" + macHex + "\",\"uid\":\"" + uid + "\"}");
      String reply = code == 200 ? h.getString() : String("net");
      h.end();
      reply.trim();
      Serial.printf("[net] POST %s %s -> %d %s\n", path.c_str(), uid.c_str(), code, reply.c_str());
      xSemaphoreTake(netLock, portMAX_DELAY);
      cardReply = reply;
      cardReplyNew = true;
      xSemaphoreGive(netLock);
      lastPoll = 0;  // 座った・帰ったをすぐ画面に出す
      continue;
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
    h.begin(base + "/api/device?board=dial&mac=" + macHex);  // 版の列は Dial 用のはんこの版。#dial 行でこの Dial の役割が分かる
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

// タブ区切りの1行を n 個に分ける（最後の1個は行の残り全部）
static void splitTabs(const String& line, String* f, int n) {
  int start = 0;
  for (int k = 0; k < n; k++) {
    int t = k < n - 1 ? line.indexOf('\t', start) : -1;
    if (t < 0) t = line.length();
    f[k] = start <= (int)line.length() ? line.substring(start, t) : String("");
    start = t + 1;
  }
}

// 届いた状態を席に反映（画面側で呼ぶ）
//   席の行 = 席 \t id \t 在席 \t 名前 \t ひとりごと \t キャラ \t 版 \t 戻る時刻（キャラ・版は syncArt が見る）
//   #now \t サーバの時計（0 時からの秒） / #o \t 席 \t オリジナルの文 / #mode \t fixed|free
//   #dial \t 役割（none / shared / personal / desk）\t 席（持ち主の席・置いた机）\t 持ち主の名前
static int8_t timerGen(const String& kind);  // 下（ひとこと選びのところ）

static void applyInbox() {
  String body;
  xSemaphoreTake(netLock, portMAX_DELAY);
  if (inboxNew) { body = inbox; inboxNew = false; }
  xSemaphoreGive(netLock);
  if (body.length() == 0) return;

  uint32_t now = millis();
  int newN[6] = {0};
  int8_t tGen[6] = {0};
  uint32_t tLeft[6] = {0}, tTotal[6] = {0};
  int pos = 0;
  while (pos < (int)body.length()) {
    int nl = body.indexOf('\n', pos);
    if (nl < 0) nl = body.length();
    String line = body.substring(pos, nl);
    pos = nl + 1;
    if (line.startsWith("#now\t")) { srvSec = line.substring(5).toInt(); srvAt = now; continue; }
    if (line.startsWith("#mode\t")) { freeMode = line.substring(6) == "free"; continue; }
    if (line.startsWith("#dial\t")) {
      String f[5];
      splitTabs(line, f, 5);
      lang = max(0, langIndex(f[4]));  // 個人用は持ち主、机は座っている人の言語。ほかは ja
      DialRole r = f[1] == "personal" ? ROLE_PERSONAL : f[1] == "desk" ? ROLE_DESK : f[1] == "shared" ? ROLE_SHARED : ROLE_NONE;
      int rs = -1;
      for (int i = 0; i < 6; i++) if (f[2] == S[i].code) rs = i;
      if (r != role || rs != roleSeat) Serial.printf("[dial] 役割 %s %s %s\n", f[1].c_str(), f[2].c_str(), f[3].c_str());
      if (r == ROLE_PERSONAL || r == ROLE_DESK) { if (rs < 0) r = ROLE_NONE; }
      role = r;
      roleSeat = rs;
      ownerName = f[3];
      continue;
    }
    if (line.startsWith("#t\t")) {  // #t 席 種類 残り秒 全体の秒（時間のひとこと）
      String f[5];
      splitTabs(line, f, 5);
      for (int i = 0; i < 6; i++) {
        if (f[1] != S[i].code) continue;
        tGen[i] = timerGen(f[2]);
        tLeft[i] = f[3].toInt();
        tTotal[i] = f[4].toInt();
      }
      continue;
    }
    if (line.startsWith("#o\t")) {
      String f[3];
      splitTabs(line, f, 3);
      for (int i = 0; i < 6; i++)
        if (f[1] == S[i].code && newN[i] < ORIG_MAX) orig[i][newN[i]++] = f[2];
      continue;
    }
    String f[8];
    splitTabs(line, f, 8);
    for (int i = 0; i < 6; i++) {
      if (f[0] != S[i].code) continue;
      S[i].id = f[1];  // だれも座っていない席は id も名前も空
      S[i].name = f[3];
      if ((int32_t)(now - S[i].localUntil) < 0) continue;  // 端末で変えた直後
      S[i].present = f[2] == "1";
      S[i].comment = f[4];
      S[i].back = f[7];
    }
  }
  for (int i = 0; i < 6; i++) {
    origN[i] = newN[i];
    if ((int32_t)(now - S[i].localUntil) < 0) continue;
    S[i].tGen = tGen[i];
    S[i].tEnd = now + tLeft[i] * 1000;
    S[i].tTotal = tTotal[i];
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

// 文字に合うフォントにする（px は 12 / 16 / 20 / 24）。
// 日本語のフォントに無い字（中国語の简体字など）があれば、中国語のフォント（efontCN）で描く。
// 中国語のフォントには日本だけの漢字が無いので、文字列ごとに使い分ける。efontCN に 20 は無いので 24 を使う
static void setFontFor(const String& s, int px = 12) {
  const lgfx::IFont* ja = px >= 24 ? (const lgfx::IFont*)&fonts::lgfxJapanGothic_24
                        : px >= 20 ? (const lgfx::IFont*)&fonts::lgfxJapanGothic_20
                        : px >= 16 ? (const lgfx::IFont*)&fonts::lgfxJapanGothic_16
                                   : (const lgfx::IFont*)&fonts::lgfxJapanGothic_12;
  lgfx::FontMetrics m;
  for (size_t i = 0; i < s.length();) {
    uint8_t c = s[i];
    int n = c < 0x80 ? 1 : (c & 0xE0) == 0xC0 ? 2 : (c & 0xF0) == 0xE0 ? 3 : 4;
    uint32_t u = n == 1 ? c : n == 2 ? (c & 0x1F) : n == 3 ? (c & 0x0F) : (c & 0x07);
    for (int k = 1; k < n && i + k < s.length(); k++) u = (u << 6) | (s[i + k] & 0x3F);
    i += n;
    if (u > 0xFFFF) continue;  // 絵文字などはどちらのフォントにも無い
    if (!ja->updateFontMetric(&m, u)) {
      canvas.setFont(px >= 20 ? &fonts::efontCN_24 : px >= 16 ? &fonts::efontCN_16 : &fonts::efontCN_12);
      return;
    }
  }
  canvas.setFont(ja);
}

// 吹き出しは「しっぽを全部 → 箱を全部」の順に描く（長いコメントの箱が、となりのしっぽに切られないように）
static void drawBubbles() {
  uint16_t paper = C565(246, 248, 252), ink = C565(24, 30, 50);
  int bx[6], bw[6];
  for (int pass = 0; pass < 2; pass++) {
    for (int n = 0; n < 6; n++) {
      int i = DRAW_ORDER[n];
      const SeatState& s = S[i];
      if (!s.present || s.comment.length() == 0) continue;
      const BubblePos& b = BUB[i];
      setFontFor(s.comment);
      if (pass == 0) {
        bw[i] = min((int)canvas.textWidth(s.comment) + 12, BW_MAX);
        bx[i] = inCircle(b.cx - bw[i] / 2, bw[i], b.top, BH);
        int baseX = constrain((int)b.tx, bx[i] + 8, bx[i] + bw[i] - 8);
        int baseY = (b.ty > b.top) ? b.top + BH - 1 : b.top;
        canvas.fillTriangle(baseX - 5, baseY, baseX + 5, baseY, b.tx, b.ty, paper);
        continue;
      }
      canvas.fillRoundRect(bx[i], b.top, bw[i], BH, 6, paper);
      if (i == focusSeat()) {
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
  setFontFor(t);
  int tw = canvas.textWidth(t) + 10;
  int x = inCircle(cx - tw / 2, tw, y, 16);
  canvas.fillRoundRect(x, y, tw, 16, 4, bg);
  if (ring) canvas.drawRoundRect(x, y, tw, 16, 4, accent());
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(fg);
  canvas.drawString(t, x + tw / 2, y + 8);
}

// 不在（フリーアドレスは離席）の人：戻る時刻があれば「田中 16:00戻り」（緑の字）、なければ「田中 不在」
static void drawAwayTag(int i) {
  bool back = S[i].back.length() > 0;
  drawTag(S[i].name + " " + (back ? fmt(L().awayBack, S[i].back) : String(freeMode ? L().awayFree : L().away)), SEATS[i].chairX, SEATS[i].chairY - 8,
          C565(20, 26, 44), back ? C565(126, 224, 184) : C565(150, 160, 190), i == focusSeat());
}

// だれもいない席（名前が空）。この Dial の席なら、椅子の上に「空き」の札（青い枠）
static bool seatEmpty(int i) { return S[i].name.length() == 0; }

static void drawSelection() {
  int fs = focusSeat();
  bool naming = (int32_t)(millis() - nameUntil) < 0;
  // 選んだ・座った直後は、その人の頭の上に名札を出す
  if (fs >= 0 && naming && S[fs].present)
    drawTag(S[fs].name, SEATS[fs].headX, SEATS[fs].headY - 20, accent(), C565(16, 20, 40), false);
  if (fs >= 0 && seatEmpty(fs))
    drawTag("空き", SEATS[fs].chairX, SEATS[fs].chairY - 8, C565(20, 26, 44), accent(), true);

  // 画面下：この Dial の席と人、通信の状態
  String t;
  String seatName = fs >= 0 ? String(S[fs].code) + " " + (seatEmpty(fs) ? String("空き") : S[fs].name) : String("");
  if (!netEnabled()) t = seatName;
  else if (role == ROLE_UNKNOWN) t = "つないでいます…";
  else if (role == ROLE_DESK) t = String(S[fs].code) + " " + (seatEmpty(fs) ? String("カードをかざしてね") : S[fs].name);
  else if (role == ROLE_PERSONAL) t = String(S[fs].code) + " " + ownerName + " の Dial";
  else if (freeMode) t = "机が未設定 Dial " + macTail;
  else if (naming) t = seatName;
  else t = (role == ROLE_SHARED ? String("全体用") : String("未設定 Dial ") + macTail) + "・カードをかざしてね";
  setFontFor(t);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(accent());
  canvas.drawString(t, W / 2 + 5, 224);
  if (netState == NET_OFF) return;
  uint16_t c = netState == NET_OK ? C565(126, 224, 184) : netState == NET_NO_SERVER ? C565(255, 170, 80) : C565(110, 118, 140);
  canvas.fillCircle(W / 2 + 5 - canvas.textWidth(t) / 2 - 8, 224, 3, c);
}

// ---------- カード ----------
// かざした結果を画面の真ん中に出す（座った・帰った・4 桁の番号など）
static String noteTitle, noteBig, noteSub;
static uint16_t noteColor = 0;
static uint32_t noteUntil = 0;
static String lastUid;
static uint32_t lastUidAt = 0;
static bool cardWaiting = false;
static uint32_t cardSentAt = 0;

static void notice(const String& title, const String& big, const String& sub, uint16_t color, uint32_t ms) {
  noteTitle = title;
  noteBig = big;
  noteSub = sub;
  noteColor = color;
  noteUntil = millis() + ms;
}

static bool noticeShown() { return (int32_t)(millis() - noteUntil) < 0; }

static void drawNotice() {
  if (!noticeShown()) return;
  canvas.fillRoundRect(22, 66, 196, 108, 16, C565(14, 18, 34));
  canvas.drawRoundRect(22, 66, 196, 108, 16, noteColor);
  canvas.drawRoundRect(23, 67, 194, 106, 15, noteColor);
  canvas.setTextDatum(middle_center);
  setFontFor(noteTitle);
  canvas.setTextColor(C565(170, 180, 205));
  canvas.drawString(noteTitle, 120, 86);
  bool digits = noteBig.length() > 0;
  for (size_t k = 0; k < noteBig.length(); k++) digits = digits && isdigit((unsigned char)noteBig[k]);
  if (digits) canvas.setFont(&fonts::Font7);  // 4 桁の番号は 7 セグの大きな数字
  else setFontFor(noteBig, 24);
  canvas.setTextColor(noteColor);
  canvas.drawString(noteBig, 120, 122);
  setFontFor(noteSub);
  canvas.setTextColor(C565(170, 180, 205));
  canvas.drawString(noteSub, 120, 157);
}

static String claimUid;        // 「長押しでこの Dial を自分専用に」を出しているカード（固定席の未設定の Dial）
static uint32_t claimUntil = 0;

// カードの番号（"04A1B2C3"）をサーバへ送る予約。kind は "card"（かざした）か "claim"（専用にする）
static void sendCard(const char* kind, const String& uid) {
  xSemaphoreTake(netLock, portMAX_DELAY);
  cardJob = String(kind) + "\t" + uid;
  xSemaphoreGive(netLock);
  cardWaiting = true;
  cardSentAt = millis();
}

static void tapCard(const String& uid) {
  if (!netEnabled()) { notice("カード " + uid, "お試し中", "Wi-Fi の設定がありません", C565(255, 170, 80), 3000); return; }
  claimUntil = 0;
  claimUid = uid;
  sendCard("card", uid);
  notice("カードを読みました", "…", "サーバに聞いています", accent(), 8000);
  M5.Speaker.tone(2000, 40);
}

// サーバの答えを画面に出す
static void applyCardReply() {
  String r;
  xSemaphoreTake(netLock, portMAX_DELAY);
  if (cardReplyNew) { r = cardReply; cardReplyNew = false; }
  xSemaphoreGive(netLock);
  if (r.length() == 0) {
    if (cardWaiting && millis() - cardSentAt > 8000) {
      cardWaiting = false;
      notice("カード", "とどきません", "サーバにつながっていません", C565(255, 170, 80), 4000);
    }
    return;
  }
  cardWaiting = false;
  String f[3];
  splitTabs(r, f, 3);
  uint16_t ok = C565(126, 224, 184), warn = C565(255, 170, 80);
  if (f[0] == "in" || f[0] == "out") {  // 固定席：在席 / 不在。claim なら「長押しで自分専用に」も出す
    bool claim = f[2] == "claim";
    bool in = f[0] == "in";
    notice(f[1] + L().san, in ? L().hello : L().bye, claim ? "長押しでこの Dial を自分専用に" : in ? L().setIn : L().setOut,
           in ? ok : accent(), claim ? 6000 : 3000);
    claimUntil = claim ? millis() + 6000 : 0;
    M5.Speaker.tone(in ? 2600 : 1600, in ? 60 : 80);
  } else if (f[0] == "deny") {
    notice("この Dial は", f[1] + " さん専用", "全体用の Dial を使ってね", warn, 3000);
  } else if (f[0] == "ok") {
    notice("この Dial を", f[1] + " さん専用", "にしました", ok, 3000);
    M5.Speaker.tone(2600, 60);
  } else if (f[0] == "ng") {
    notice("できませんでした", f[1], "", warn, 3000);
  } else if (f[0] == "sit") {
    notice(f[1] + L().san, L().hello, fmt(L().sat, f[2]), ok, 3000);
    nameUntil = millis() + 4000;
    M5.Speaker.tone(2600, 60);
  } else if (f[0] == "back") {
    notice(f[1] + L().san, L().welcome, L().setIn, ok, 3000);
    M5.Speaker.tone(2600, 60);
  } else if (f[0] == "leave") {
    notice(f[1] + L().san, L().bye, L().freed, accent(), 3000);
    M5.Speaker.tone(1600, 80);
  } else if (f[0] == "code") {
    notice("はじめてのカード", f[1], "/join かマイページの「カード」に入力", C565(255, 214, 120), 60000);
    M5.Speaker.tone(2200, 40);
  } else if (f[0] == "nodesk") {
    notice(f[1] + " さん", "机が未設定", "/admin で Dial " + macTail + " の机を決めて", warn, 5000);
  } else {
    notice("カード", "とどきません", "サーバにつながっていません", warn, 4000);
  }
}

// カードを読む（画面側で少しずつ）。同じカードをかざしっぱなしなら 3 秒は読み直さない
static uint32_t nextCardPoll = 0;
static bool rfidOk = false;
static void pollCard() {
  if (!rfidOk || (int32_t)(millis() - nextCardPoll) < 0) return;
  nextCardPoll = millis() + 150;
  auto& r = M5Dial.Rfid;
  if (!r.PICC_IsNewCardPresent() || !r.PICC_ReadCardSerial()) return;
  String uid;
  for (byte i = 0; i < r.uid.size; i++) {
    char b[3];
    snprintf(b, sizeof b, "%02X", r.uid.uidByte[i]);
    uid += b;
  }
  r.PICC_HaltA();
  // 4 バイトで先頭が 08 の番号は、かざすたびに変わる（スマホや一部の社員証）。登録に使えない
  if (r.uid.size == 4 && r.uid.uidByte[0] == 0x08) {
    notice("このカードは使えません", "×", "かざすたびに番号が変わるカード", C565(255, 157, 176), 4000);
    return;
  }
  if (uid == lastUid && millis() - lastUidAt < 3000) { lastUidAt = millis(); return; }
  lastUid = uid;
  lastUidAt = millis();
  Serial.printf("[card] %s\n", uid.c_str());
  tapCard(uid);
}

// 個人用の Dial で持ち主が不在のあいだ、背景がゆっくり明るくなったり戻ったりする（「いるのに不在のまま」に気づける程度に）
static const uint32_t AWAY_PULSE_MS = 2400;             // 明るくなって戻るまでの時間
static const int AWAY_R = 20, AWAY_G = 44, AWAY_B = 31;  // 寄せる色（RGB565 の各成分。R・B は 0〜31、G は 0〜63。淡い水色）
static const int AWAY_MIX = 64;                         // いちばん明るいときにどれだけ寄せるか（0〜256）

// 今どれだけ寄せるか（0〜AWAY_MIX）。個人用で持ち主が不在のときだけ
static int awayMix() {
  if (role != ROLE_PERSONAL || roleSeat < 0 || S[roleSeat].present || seatEmpty(roleSeat)) return 0;
  uint32_t t = millis() % AWAY_PULSE_MS, half = AWAY_PULSE_MS / 2;
  uint32_t u = t < half ? t : AWAY_PULSE_MS - t;  // 0 → half → 0
  return AWAY_MIX * u / half;
}

// フレームバッファ（上位・下位バイトが入れ替わった RGB565）の背景を、AWAY_* の色へ mix だけ寄せる
static void tintBackground(int mix) {
  for (int k = 0; k < W * H; k++) {
    uint16_t v = __builtin_bswap16(fb[k]);
    int r = v >> 11, g = (v >> 5) & 63, b = v & 31;
    r += (AWAY_R - r) * mix >> 8;
    g += (AWAY_G - g) * mix >> 8;
    b += (AWAY_B - b) * mix >> 8;
    fb[k] = __builtin_bswap16((uint16_t)((r << 11) | (g << 5) | b));
  }
}

static void render() {
  memcpy(fb, BG_RAW, W * H * 2);
  int mix = awayMix();
  if (mix > 0) tintBackground(mix);
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
  for (int i = 0; i < 6; i++) if (!S[i].present && !seatEmpty(i)) drawAwayTag(i);
  drawBubbles();
  drawSelection();
  drawNotice();
  canvas.pushSprite(0, 0);
}

static void handleSerial() {
  if (!Serial.available()) return;
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() < 3) return;
  char cmd = line[0];
  if (cmd == 'l') {
    langForced = langIndex(line.substring(2));
    Serial.printf("lang=%s\n", L().code);
    return;
  }
  if (cmd == 'k') { String uid = line.substring(2); uid.trim(); uid.toUpperCase(); tapCard(uid); return; }
  int i = line.substring(2, 3).toInt();
  if (i < 0 || i > 5) return;
  if (cmd == 'p') { S[i].present = !S[i].present; sendPresent(i); }
  if (cmd == 'c') { String t = line.length() > 4 ? line.substring(4) : String(""); t.trim(); S[i].comment = t; sendComment(i); }
  Serial.printf("seat %d present=%d comment=\"%s\"\n", i, S[i].present, S[i].comment.c_str());
}

// ---------- つまみ（ロータリーエンコーダ） ----------
// A/B 2 本の信号の変化を割り込みで数える。1 カチッで 4 つ進む（ENC_STEP）
// 実機で「1 カチッで 2 席動く / 2 カチッで 1 席」なら ENC_STEP を、向きが逆なら ENC_A と ENC_B を入れ替える
static const int ENC_A = 40, ENC_B = 41;  // 実機で右回りが逆だったので入れ替えた
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

// ---------- ひとこと選び ----------
// 出荷時デモ（M5Dial-UserDemo）の見た目に合わせた 3 つの画面
//   ジャンル : 黒い画面のふちに 10 個の丸いアイコン。回すと内側の白い点が動き、真ん中に名前（ランチャー風）
//   時間     : ジャンルの色の画面に白い箱、大きな数字（明るさ設定風）
//   文       : 黒い画面に縦の一覧。選んでいる文はオレンジのバー（MORE メニュー風）
// 決める : つまみを押す / 画面の真ん中をタップ
// もどる : つまみを長押し / 画面のどこでも長押し / 下の「<」をタップ
enum Mode { M_OFFICE, M_GENRE, M_VALUE, M_LIST, M_TIMER };
enum Kind { K_UNTIL, K_AFTER, K_BACK, K_LIST, K_CLEAR };
struct Genre {
  uint32_t color;
  uint8_t kind;
  int16_t step, lo, hi, def;  // 時間のジャンル：つまみ1カチッの分、いちばん短い・長い、はじめの値（分）
  int8_t list;                // 文のジャンル：0 気温 / 1 予定 / 2 声かけ / 3 オリジナル（文は LangText にある）
  uint8_t nItems;
  const char* duration;       // 文のジャンル：消えるまで（サーバの "2h" / "today"）
  const char* timer;          // 時間のジャンル：サーバに送る種類（タイマー画面で残り時間を出す）
};
// ジャンルの名前は LangText の genre（この順）
static const int GN = 10;
static const Genre GEN[GN] = {
  {0xFD5C4C, K_UNTIL, 15, 15, 240, 60, -1, 0, nullptr, "focus"},
  {0xEB8429, K_UNTIL, 5, 5, 60, 10, -1, 0, nullptr, "rest"},
  {0x577EFF, K_UNTIL, 15, 15, 180, 60, -1, 0, nullptr, "meeting"},
  {0x03A964, K_AFTER, 5, 5, 120, 10, -1, 0, nullptr, "out"},
  {0x0B8F6A, K_BACK, 15, 15, 720, 60, -1},
  {0x008CD6, K_LIST, 0, 0, 0, 0, 0, 4, "2h"},
  {0x5D7BA2, K_LIST, 0, 0, 0, 0, 1, 3, "today"},
  {0x1AA198, K_LIST, 0, 0, 0, 0, 2, 4, "2h"},
  {0xD9A21B, K_LIST, 0, 0, 0, 0, 3, 0, "2h"},
  {0x6B6F7A, K_CLEAR, 0, 0, 0, 0, -1},
};

static Mode mode = M_OFFICE;
static int hSeat = 0;               // ひとことを出す席
static int gSel = 0;                // 選んでいるジャンル
static float gAng = -90, gVel = 0;  // 白い点の角度（ばねで追いかけ、少し行き過ぎて戻る）
static int vVal = 0;                // 時間の値（分。戻りはその日の 0 時からの分）
static int lSel = 0;
static float lPos = 0;              // 一覧のスクロール位置（なめらかに追いかける）
static uint32_t menuIdle = 0;
static const uint32_t MENU_IDLE_MS = 20000;  // さわらなければ島の画面に戻る
static const uint32_t MENU_TICK_MS = 30;

static String gName(int i) { return L().genre[i]; }
static const char* const* gItems(int i) {
  switch (GEN[i].list) {
    case 0: return L().temp;
    case 1: return L().plan;
    case 2: return L().talk;
  }
  return nullptr;  // オリジナル
}

static uint16_t hex565(uint32_t c) { return C565(c >> 16, (c >> 8) & 255, c & 255); }
static uint16_t white() { return C565(255, 255, 255); }
static uint16_t cream() { return C565(243, 233, 210); }

// 時計はサーバの時計（srvSec。まだ届いていなければ 12:00 から数える）
static int nowMin() {
  if (srvSec < 0) return (12 * 60 + millis() / 60000) % 1440;
  return (int)((srvSec + (millis() - srvAt) / 1000) / 60) % 1440;
}
// サーバの時計で、その日の 0 時からの秒
static int32_t nowSec() {
  if (srvSec < 0) return (12 * 3600 + millis() / 1000) % 86400;
  return (int32_t)((srvSec + (millis() - srvAt) / 1000) % 86400);
}

static int8_t timerGen(const String& kind) {
  for (int g = 0; g < GN; g++)
    if (GEN[g].timer && kind == GEN[g].timer) return g + 1;
  return 0;
}

static String hhmm(int m) {
  m = ((m % 1440) + 1440) % 1440;
  char b[8];
  snprintf(b, sizeof(b), "%d:%02d", m / 60, m % 60);
  return b;
}

static void sendText(int i, const String& text, const String& extra) {
  enqueue(i, "{\"comment\":{\"text\":" + jsonStr(text) + "," + extra + "}}");
}

// ---- アイコン（42px くらいの丸の中に白で描く。s = 1 で約 22px） ----
static void drawIcon(int id, int cx, int cy, float s, uint16_t fg, uint16_t bg) {
  auto X = [&](float u) { return (int)lroundf(cx + u * s); };
  auto Y = [&](float u) { return (int)lroundf(cy + u * s); };
  auto R = [&](float u) { return max(1, (int)lroundf(u * s)); };
  switch (id) {
    case 0:  // 集中：ヘッドホン
      canvas.fillArc(X(0), Y(1), R(10), R(8), 180, 360, fg);
      canvas.fillRoundRect(X(-11), Y(0), R(5), R(10), R(2), fg);
      canvas.fillRoundRect(X(6), Y(0), R(5), R(10), R(2), fg);
      break;
    case 1:  // 休憩：カップ
      canvas.fillCircle(X(5), Y(2), R(5), fg);
      canvas.fillCircle(X(5), Y(2), R(2.5f), bg);
      canvas.fillRoundRect(X(-9), Y(-3), R(14), R(12), R(3), fg);
      canvas.drawWideLine(X(-5), Y(-10), X(-5), Y(-6), s * 0.9f, fg);
      canvas.drawWideLine(X(0), Y(-10), X(0), Y(-6), s * 0.9f, fg);
      break;
    case 2:  // 会議：人たち
      canvas.fillCircle(X(5), Y(-5), R(3.5f), fg);
      canvas.fillArc(X(5), Y(8), R(8), 0, 180, 360, fg);
      canvas.fillCircle(X(-3), Y(-3), R(5.5f), bg);
      canvas.fillCircle(X(-3), Y(-3), R(4), fg);
      canvas.fillArc(X(-3), Y(10), R(10.5f), 0, 180, 360, bg);
      canvas.fillArc(X(-3), Y(10), R(9), 0, 180, 360, fg);
      break;
    case 3:  // 外出：歩く人
      canvas.fillCircle(X(2), Y(-9), R(2.8f), fg);
      canvas.drawWideLine(X(1), Y(-5), X(-1), Y(3), s * 1.5f, fg);
      canvas.drawWideLine(X(-1), Y(3), X(-5), Y(10), s * 1.3f, fg);
      canvas.drawWideLine(X(-1), Y(3), X(3), Y(6), s * 1.3f, fg);
      canvas.drawWideLine(X(3), Y(6), X(4), Y(10), s * 1.3f, fg);
      canvas.drawWideLine(X(1), Y(-4), X(-4), Y(0), s * 1.1f, fg);
      canvas.drawWideLine(X(1), Y(-4), X(6), Y(-1), s * 1.1f, fg);
      break;
    case 4:  // 戻り：戻る矢印
      canvas.drawWideLine(X(-5), Y(-5), X(3), Y(-5), s * 1.4f, fg);
      canvas.fillArc(X(3), Y(1), R(7.4f), R(4.6f), 270, 360, fg);
      canvas.fillArc(X(3), Y(1), R(7.4f), R(4.6f), 0, 90, fg);
      canvas.drawWideLine(X(3), Y(7), X(-4), Y(7), s * 1.4f, fg);
      canvas.fillTriangle(X(-11), Y(-5), X(-5), Y(-11), X(-5), Y(1), fg);
      break;
    case 5:  // 気温：温度計
      canvas.fillRoundRect(X(-3), Y(-11), R(6), R(16), R(3), fg);
      canvas.fillCircle(X(0), Y(6), R(5), fg);
      canvas.fillRoundRect(X(-1), Y(-9), R(2), R(7), R(1), bg);
      break;
    case 6:  // 予定：カレンダー
      canvas.fillRoundRect(X(-9), Y(-7), R(18), R(17), R(3), fg);
      canvas.fillRect(X(-7), Y(-1), R(14), R(9), bg);
      for (int r = 0; r < 2; r++)
        for (int c = 0; c < 3; c++) canvas.fillRect(X(-6 + c * 4.5f), Y(0.5f + r * 4), R(3), R(2.5f), fg);
      canvas.fillRoundRect(X(-6), Y(-11), R(3), R(6), R(1), fg);
      canvas.fillRoundRect(X(3), Y(-11), R(3), R(6), R(1), fg);
      break;
    case 7:  // 声かけ：吹き出し
      canvas.fillCircle(X(0), Y(-1), R(10), fg);
      canvas.fillTriangle(X(-7), Y(4), X(-10), Y(11), X(-1), Y(8), fg);
      for (int k = -1; k <= 1; k++) canvas.fillCircle(X(k * 4.5f), Y(-1), R(1.6f), bg);
      break;
    case 8: {  // オリジナル：星
      float ox[5], oy[5], ix[5], iy[5];
      for (int k = 0; k < 5; k++) {
        float a = (-90 + 72 * k) * DEG_TO_RAD, b = (-54 + 72 * k) * DEG_TO_RAD;
        ox[k] = X(11 * cosf(a)); oy[k] = Y(1 + 11 * sinf(a));
        ix[k] = X(4.6f * cosf(b)); iy[k] = Y(1 + 4.6f * sinf(b));
      }
      for (int k = 0; k < 5; k++) {
        canvas.fillTriangle(X(0), Y(1), ox[k], oy[k], ix[k], iy[k], fg);
        canvas.fillTriangle(X(0), Y(1), ox[k], oy[k], ix[(k + 4) % 5], iy[(k + 4) % 5], fg);
      }
      break;
    }
    case 9: {  // 消す：消しゴム（ななめの箱）
      float c = 0.7071f;
      auto P = [&](float u, float v, int& px, int& py) {  // 箱の座標 (u: 長さ, v: 幅) → 画面
        px = X(u * c - v * c);
        py = Y(-1 + u * -c - v * c);
      };
      int x0, y0, x1, y1, x2, y2, x3, y3;
      P(-9, -4.5f, x0, y0); P(9, -4.5f, x1, y1); P(9, 4.5f, x2, y2); P(-9, 4.5f, x3, y3);
      canvas.fillTriangle(x0, y0, x1, y1, x2, y2, fg);
      canvas.fillTriangle(x0, y0, x2, y2, x3, y3, fg);
      int a0, b0, a1, b1;
      P(-3, -4.5f, a0, b0); P(-3, 4.5f, a1, b1);
      canvas.drawWideLine(a0, b0, a1, b1, s * 0.9f, bg);
      canvas.drawWideLine(X(-1), Y(11), X(10), Y(11), s * 0.9f, fg);
      break;
    }
  }
}

// ---- 画面 ----
static void iconPos(int i, int& x, int& y) {
  float a = (-90 + i * 36) * DEG_TO_RAD;
  x = 120 + (int)lroundf(95 * cosf(a));
  y = 120 + (int)lroundf(95 * sinf(a));
}

static void renderGenre() {
  canvas.fillScreen(TFT_BLACK);
  float diff = (-90 + gSel * 36) - gAng;
  while (diff > 180) diff -= 360;
  while (diff < -180) diff += 360;
  gVel = gVel * 0.55f + diff * 0.25f;
  gAng += gVel;

  for (int i = 0; i < GN; i++) {
    int x, y;
    iconPos(i, x, y);
    bool on = i == gSel;
    uint16_t c = hex565(GEN[i].color);
    canvas.fillSmoothCircle(x, y, on ? 25 : 21, c);
    drawIcon(i, x, y, on ? 1.15f : 1.0f, white(), c);
  }
  float a = gAng * DEG_TO_RAD;
  canvas.fillSmoothCircle(120 + 58 * cosf(a), 120 + 58 * sinf(a), 5, cream());

  // 名前は白い点のほうへ少し寄せる（デモと同じ）。長い名前は点に重ならないよう真ん中に置き、字も少し小さく
  String name = gName(gSel);
  bool longName = name.length() > 9;
  int tx = longName ? 120 : 120 + 8 * cosf(a), ty = longName ? 120 : 120 + 8 * sinf(a);
  canvas.setTextDatum(middle_center);
  setFontFor(name, longName ? 20 : 24);
  canvas.setTextColor(cream());
  canvas.drawString(name, tx, ty - 6);
  String seat = String(S[hSeat].code) + " " + S[hSeat].name;
  setFontFor(seat);
  canvas.setTextColor(C565(130, 136, 150));
  canvas.drawString(seat, tx, ty + 18);
}

static void drawBack(uint16_t c) {
  canvas.setFont(&fonts::lgfxJapanGothic_20);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(c);
  canvas.drawString("<", 120, 218);
}

// 時間の画面に出す「大きな数字・単位・下の説明」
static void valueText(String& num, String& unit, String& label) {
  const Genre& g = GEN[gSel];
  int now = nowMin();
  if (g.kind == K_UNTIL) { num = String(vVal); unit = L().unitUntil; label = fmt(L().labelUntil, hhmm(now + vVal)); }
  if (g.kind == K_AFTER) { num = String(vVal); unit = L().unitAfter; label = fmt(L().labelAfter, hhmm(now + vVal)); }
  if (g.kind == K_BACK) { num = hhmm(vVal); unit = ""; label = L().labelBack; }
}

static void renderValue() {
  const Genre& g = GEN[gSel];
  uint16_t c = hex565(g.color);
  canvas.fillScreen(c);
  drawIcon(gSel, 120, 26, 1.15f, white(), c);
  canvas.fillSmoothRoundRect(0, 50, 240, 140, 36, white());

  String num, unit, label;
  valueText(num, unit, label);
  canvas.setFont(&fonts::FreeSansBold24pt7b);
  int w1 = canvas.textWidth(num);
  setFontFor(unit, 20);
  int w2 = unit.length() ? canvas.textWidth(unit) + 3 : 0;
  int x0 = 120 - (w1 + w2) / 2;
  canvas.setTextColor(c);
  canvas.setTextDatum(baseline_left);
  canvas.setFont(&fonts::FreeSansBold24pt7b);
  canvas.drawString(num, x0, 118);
  if (w2) {
    setFontFor(unit, 20);
    canvas.drawString(unit, x0 + w1 + 3, 116);
  }
  canvas.setTextDatum(middle_center);
  setFontFor(label, 16);
  canvas.drawString(label, 120, 158);
  // 指でも増やせるように、箱の左右に − と ＋
  canvas.setFont(&fonts::lgfxJapanGothic_24);
  canvas.setTextColor(C565(200, 204, 214));
  canvas.drawString("-", 26, 108);
  canvas.drawString("+", 214, 108);
  drawBack(white());
}

static int listCount() { return gItems(gSel) ? GEN[gSel].nItems : origN[hSeat]; }
static String listItem(int i) { return gItems(gSel) ? String(gItems(gSel)[i]) : orig[hSeat][i]; }

static void renderList() {
  const Genre& g = GEN[gSel];
  canvas.fillScreen(TFT_BLACK);
  canvas.setTextDatum(middle_center);
  String title = gName(gSel);
  setFontFor(title, 20);
  canvas.setTextColor(hex565(g.color));
  canvas.drawString(title, 120, 30);

  int n = listCount();
  if (n == 0) {
    setFontFor(String(L().noOrig[0]) + L().noOrig[1], 16);
    canvas.setTextColor(C565(150, 156, 170));
    canvas.drawString(L().noOrig[0], 120, 108);
    canvas.drawString(L().noOrig[1], 120, 132);
    drawBack(C565(140, 140, 140));
    return;
  }
  if (lSel >= n) lSel = n - 1;
  lPos += (lSel * 32 - lPos) * 0.35f;

  // 選んでいる文のバー（真ん中に固定。文がそこへ流れてくる）
  String cur = listItem(lSel);
  setFontFor(cur, cur.length() > 27 ? 16 : 20);
  int bw = min(196, (int)canvas.textWidth(cur) + 16);
  canvas.fillSmoothRoundRect(26, 106, bw, 28, 5, C565(250, 112, 0));

  canvas.setTextDatum(middle_left);
  canvas.setClipRect(20, 46, 200, 164);
  for (int i = 0; i < n; i++) {
    float dy = i * 32 - lPos;
    if (dy < -80 || dy > 90) continue;
    String t = listItem(i);
    float off = 120 - 120 * cosf(dy / 120);  // 丸い画面のふちに沿って右へずらす
    int v = max(50, 255 - (int)fabsf(dy) * 2);
    setFontFor(t, t.length() > 27 ? 16 : 20);
    canvas.setTextColor(fabsf(dy) < 14 ? C565(5, 143, 255) : C565(v, v, v));  // バーの上は反転した色
    canvas.drawString(t, 34 + (int)off, 120 + (int)dy);
  }
  canvas.clearClipRect();
  drawBack(C565(140, 140, 140));
}

// ---- タイマー画面（オフィスの画面を左右にスワイプ）----
// 時間のひとこと（集中・休憩・会議・外出）の残り時間と、不在のときの「戻り」までの時間を大きく出す
static void roleHint();  // 下（操作のところ）
static int tSeat = 0;
static int8_t tShowGen = 0;      // 出している種類（GEN の番号 + 1。戻りは K_BACK のジャンル）
static uint32_t tShowEnd = 0, tShowTotal = 1;
static uint32_t tDoneAt = 0;      // 0 になった時刻（鳴らすのは 1 回だけ。少し見せたら島に戻る）
static int beepLeft = 0;
static uint32_t nextBeep = 0;

static int genOf(uint8_t kind) {
  for (int g = 0; g < GN; g++) if (GEN[g].kind == kind) return g;
  return 0;
}

// その席で見せられるタイマーを選ぶ。無ければ false
static bool pickTimer(int i) {
  SeatState& s = S[i];
  uint32_t now = millis();
  if (s.tGen > 0 && (int32_t)(s.tEnd - now) > 0) {
    tShowGen = s.tGen;
    tShowEnd = s.tEnd;
    tShowTotal = max<uint32_t>(s.tTotal, 1);
    return true;
  }
  if (!s.present && s.back.length() >= 4) {  // 戻り 16:00
    int h = s.back.toInt(), m = s.back.substring(s.back.indexOf(':') + 1).toInt();
    int32_t left = (h * 60 + m) * 60 - nowSec();
    if (left <= 0 || left > 12 * 3600) return false;
    tShowGen = genOf(K_BACK) + 1;
    tShowEnd = now + (uint32_t)left * 1000;
    tShowTotal = left;
    return true;
  }
  return false;
}

static void openTimer(int i) {
  if (i < 0) { roleHint(); return; }
  if (seatEmpty(i) || !pickTimer(i)) {
    String who = seatEmpty(i) ? String("机 ") + S[i].code : S[i].name + L().san;
    notice(who, L().tNone[0], L().tNone[1], accent(), 2500);
    return;
  }
  tSeat = i;
  tDoneAt = 0;
  beepLeft = 0;
  mode = M_TIMER;
}

static void renderTimer() {
  const Genre& g = GEN[tShowGen - 1];
  uint16_t c = hex565(g.color);
  uint32_t now = millis();
  int32_t leftMs = (int32_t)(tShowEnd - now);
  int32_t left = leftMs > 0 ? (leftMs + 999) / 1000 : 0;
  if (left == 0 && !tDoneAt) { tDoneAt = now ? now : 1; beepLeft = 3; nextBeep = now; }
  if (beepLeft > 0 && (int32_t)(now - nextBeep) >= 0) { M5.Speaker.tone(2600, 120); beepLeft--; nextBeep = now + 250; }

  canvas.fillScreen(c);
  // 外の輪：残りの割合（12 時から時計回りに減る）
  uint16_t track = C565(((c >> 11) & 31) * 8 * 3 / 5, ((c >> 5) & 63) * 4 * 3 / 5, (c & 31) * 8 * 3 / 5);
  canvas.fillArc(120, 120, 119, 109, 0, 360, track);
  float frac = min(1.0f, (float)leftMs / (tShowTotal * 1000.0f));
  if (frac > 0) canvas.fillArc(120, 120, 119, 109, -90, -90 + 360 * frac, white());

  drawIcon(tShowGen - 1, 120, 44, 1.0f, white(), c);
  canvas.setTextDatum(middle_center);
  canvas.setTextColor(white());
  String title = g.kind == K_AFTER ? String(L().tOut) : g.kind == K_BACK ? String(L().tBack) : fmt(L().tLeft, gName(tShowGen - 1));
  setFontFor(title, 16);
  canvas.drawString(title, 120, 76);

  if (left == 0) {
    String done = g.kind == K_AFTER ? L().tDoneOut : L().tDone;
    setFontFor(done, 24);
    canvas.setTextSize(done.length() > 15 ? 1.2f : 1.6f);
    canvas.drawString(done, 120, 120);
    canvas.setTextSize(1);
  } else {
    char b[12];
    if (left >= 3600) snprintf(b, sizeof(b), "%ld:%02ld:%02ld", (long)(left / 3600), (long)(left / 60 % 60), (long)(left % 60));
    else snprintf(b, sizeof(b), "%ld:%02ld", (long)(left / 60), (long)(left % 60));
    canvas.setFont(&fonts::FreeSansBold24pt7b);
    canvas.setTextSize(left >= 3600 ? 1.1f : 1.5f);
    canvas.drawString(b, 120, 122);
    canvas.setTextSize(1);
  }

  // 終わる時刻と、だれのタイマーか（自分の Dial でなければ）
  int endMin = (int)((nowSec() + max<int32_t>(leftMs, 0) / 1000 + 30) / 60);
  canvas.setFont(&fonts::lgfxJapanGothic_20);
  canvas.drawString(String("〜") + hhmm(endMin), 120, 164);
  if (!ownSeatRole()) {
    String who = S[tSeat].name + L().san;
    setFontFor(who, 16);
    canvas.drawString(who, 120, 190);
  }
}

static void renderMenu() {
  if (mode == M_TIMER) renderTimer();
  else if (mode == M_GENRE) renderGenre();
  else if (mode == M_VALUE) renderValue();
  else renderList();
  canvas.pushSprite(0, 0);
}

// ---- 操作 ----
static void openMenu(int seat) {
  hSeat = seat;
  if (canSelect()) selected = seat;
  mode = M_GENRE;
  gAng = -90 + gSel * 36;
  gVel = 0;
  menuIdle = millis();
}

static void closeMenu() {
  mode = M_OFFICE;
  if (canSelect()) nameUntil = millis() + 1500;
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

// この Dial の席でできないことをしたときの案内
static void roleHint() {
  uint16_t warn = C565(255, 170, 80);
  if (freeMode && role != ROLE_DESK) notice("この Dial", "机が未設定", "/admin で Dial " + macTail + " の机を決めて", warn, 4000);
  else if (role == ROLE_UNKNOWN) notice("この Dial", "つないでいます", "サーバと同期するまで待ってね", accent(), 2500);
  else notice("在席の切り替えは", "カードで", "カードをかざしてね", accent(), 2500);
}

// この Dial の席の人のひとこと選びを開く（個人用・机）
static void openOwnMenu() {
  int i = focusSeat();
  if (!ownSeatRole() || i < 0) { roleHint(); return; }
  if (seatEmpty(i)) { notice(String("机 ") + S[i].code, "空き", "カードをかざすと座れます", accent(), 3000); return; }
  openMenu(i);
}

// この Dial の席の 在席 / 不在（離席）。個人用・机だけ
static void toggleOwnPresent() {
  int i = focusSeat();
  if (!ownSeatRole() || i < 0 || seatEmpty(i)) { if (i >= 0 && seatEmpty(i)) openOwnMenu(); else roleHint(); return; }
  S[i].present = !S[i].present;
  sendPresent(i);
  const char* off = freeMode ? L().awayFree : L().away;
  notice(S[i].name + L().san, S[i].present ? L().present : off, S[i].present ? L().welcome : freeMode ? L().keepSeat : L().seeYou, accent(), 2000);
}

// 押したアイコンの色の丸を、画面いっぱいまで広げる（デモのアプリを開くときと同じ）
static void playOpen() {
  int x, y;
  iconPos(gSel, x, y);
  uint16_t c = hex565(GEN[gSel].color);
  for (int r = 30; r < 340; r += 40) {
    canvas.fillSmoothCircle(x, y, r, c);
    canvas.pushSprite(0, 0);
  }
}

static void enterGenre() {
  const Genre& g = GEN[gSel];
  if (g.kind == K_CLEAR) {
    S[hSeat].comment = "";
    S[hSeat].tGen = 0;
    sendComment(hSeat);
    closeMenu();
    return;
  }
  playOpen();
  if (g.kind == K_LIST) {
    lSel = 0;
    for (int i = 0; i < listCount(); i++) if (listItem(i) == S[hSeat].comment) lSel = i;
    lPos = lSel * 32;
    mode = M_LIST;
  } else {
    int now = nowMin();
    vVal = g.kind == K_BACK ? ((now + g.def + 14) / 15) * 15 : g.def;
    mode = M_VALUE;
  }
}

static void turnValue(int d) {
  const Genre& g = GEN[gSel];
  if (g.kind == K_BACK) {
    int now = nowMin();
    int lo = ((now + g.lo + 14) / 15) * 15, hi = now + g.hi;
    vVal = constrain(vVal + d * g.step, lo, hi);
  } else {
    vVal = constrain(vVal + d * g.step, (int)g.lo, (int)g.hi);
  }
}

static void decide() {
  const Genre& g = GEN[gSel];
  SeatState& s = S[hSeat];
  if (mode == M_GENRE) { enterGenre(); return; }
  if (mode == M_VALUE) {
    String t = hhmm(g.kind == K_BACK ? vVal : nowMin() + vVal);
    String extra = "\"until\":\"" + t + "\",\"timer\":\"" + (g.timer ? g.timer : "") + "\"";
    if (g.kind == K_UNTIL) s.comment = fmt(L().cmtUntil, gName(gSel), t);
    if (g.kind == K_AFTER) s.comment = fmt(L().cmtAfter, t);
    if (g.kind == K_UNTIL || g.kind == K_AFTER) {
      sendText(hSeat, s.comment, extra);
      // サーバと同じく、その時刻（分の頭）までの秒
      int32_t left = ((nowMin() + vVal) % 1440) * 60 - nowSec();
      if (left <= 0) left += 86400;
      s.tGen = gSel + 1;
      s.tEnd = millis() + (uint32_t)left * 1000;
      s.tTotal = left;
    }
    if (g.kind == K_BACK) {
      s.present = false;
      s.back = t;
      enqueue(hSeat, "{\"present\":false,\"back\":\"" + t + "\"}");
    }
    closeMenu();
    return;
  }
  if (listCount() == 0) return;
  s.comment = listItem(lSel);
  s.tGen = 0;
  sendText(hSeat, s.comment, String("\"duration\":\"") + g.duration + "\"");
  closeMenu();
}

static void goBack() {
  if (mode == M_GENRE) closeMenu();
  else { mode = M_GENRE; gVel = 0; }
}

static void tapMenu(int tx, int ty) {
  int dx = tx - 120, dy = ty - 120;
  if (mode == M_GENRE) {
    if (dx * dx + dy * dy < 50 * 50) { decide(); return; }
    for (int i = 0; i < GN; i++) {  // アイコンをタップ → そのジャンルを開く
      int x, y;
      iconPos(i, x, y);
      if ((tx - x) * (tx - x) + (ty - y) * (ty - y) < 28 * 28) { gSel = i; gAng = -90 + i * 36; decide(); return; }
    }
    return;
  }
  if (ty > 198) { goBack(); return; }
  if (mode == M_VALUE) {
    if (ty < 50 || ty > 190) return;
    if (tx < 64) turnValue(-1);
    else if (tx > 176) turnValue(1);
    else decide();
    return;
  }
  int n = listCount();
  if (n == 0) return;
  int k = lSel + (int)lroundf(dy / 32.0f);
  if (k == lSel) decide();
  else if (k >= 0 && k < n) lSel = k;
}

static void handleInput() {
  int d = encSteps();
  bool click = M5.BtnA.wasClicked(), hold = M5.BtnA.wasHold();
  bool tap = false, press = false, swipe = false;
  int tx = 0, ty = 0;
  if (M5.Touch.getCount() > 0) {
    auto t = M5.Touch.getDetail();
    tx = t.x;
    ty = t.y;
    tap = t.wasClicked();
    press = t.wasHold();
    int dx = t.distanceX(), dy = t.distanceY();
    swipe = t.wasFlicked() && abs(dx) > 40 && abs(dx) > abs(dy);  // 左右にさっと払う
  }

  if (mode == M_TIMER) {  // どの操作でも島に戻る。0 になったら少し見せて戻る
    if (click || hold || tap || press || swipe) mode = M_OFFICE;
    else if (tDoneAt && millis() - tDoneAt > 10000) mode = M_OFFICE;
    else if (noticeShown()) mode = M_OFFICE;  // カードをかざしたときの知らせを見せる
    return;
  }
  if (mode != M_OFFICE && (d || click || hold || tap || press)) menuIdle = millis();

  if (mode == M_OFFICE) {
    // つまみを回す：席を選んで名札を見る（固定席の全体用・未設定、お試し）
    if (d && canSelect()) {
      int k = 0;
      while (DIAL_ORDER[k] != selected) k++;
      k = ((k + d) % 6 + 6) % 6;
      selected = DIAL_ORDER[k];
      nameUntil = millis() + 1500;
    }
    // カードの直後の「長押しでこの Dial を自分専用に」
    if (hold && (int32_t)(millis() - claimUntil) < 0) {
      claimUntil = 0;
      sendCard("claim", claimUid);
      notice("この Dial を", "専用にしています…", "", accent(), 8000);
      return;
    }
    if ((click || tap) && noticeShown()) { noteUntil = 0; claimUntil = 0; return; }  // 出ている知らせを閉じる
    if (swipe) { noteUntil = 0; openTimer(focusSeat()); return; }  // 時間のひとことの残り時間

    if (!netEnabled()) {  // お試し：今までどおり全部の席を動かせる
      if (hold) { S[selected].present = !S[selected].present; sendPresent(selected); }
      else if (click) openMenu(selected);
      int i = (tap || press) ? seatAt(tx, ty) : -1;
      if (tap && i >= 0) { S[i].present = !S[i].present; selected = i; sendPresent(i); }
      if (press && i >= 0) openMenu(i);
      return;
    }
    if (ownSeatRole()) {  // 個人用・机：いつもこの Dial の席の人
      if (hold) toggleOwnPresent();
      else if (click || tap || press) openOwnMenu();
      return;
    }
    if (canSelect() && (tap || press)) {  // 全体用・未設定：タップで席を選んで名前を見る
      int i = seatAt(tx, ty);
      if (i >= 0) { selected = i; nameUntil = millis() + 1500; }
      return;
    }
    if (hold || click || tap || press) roleHint();
    return;
  }

  if (hold || press) { goBack(); return; }
  if (d) {
    if (mode == M_GENRE) gSel = ((gSel + d) % GN + GN) % GN;
    else if (mode == M_VALUE) turnValue(d);
    else if (listCount()) lSel = constrain(lSel + d, 0, listCount() - 1);
  }
  if (click) decide();
  else if (tap) tapMenu(tx, ty);
  if (mode != M_OFFICE && millis() - menuIdle > MENU_IDLE_MS) closeMenu();
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
  // カードの読み取り部品（内部の I2C、アドレス 0x28）。見つからなくても島の表示は続ける
  rfidOk = M5.In_I2C.scanID(0x28);
  if (rfidOk) M5Dial.Rfid.begin();
  Serial.printf("[card] 読み取り部品 %s\n", rfidOk ? "OK" : "見つからない");

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
  applyCardReply();
  if (mode == M_OFFICE || mode == M_TIMER) pollCard();
  handleInput();

  uint32_t now = millis();
  if ((int32_t)(now - nextTick) >= 0) {
    if (mode == M_OFFICE) {
      nextTick = now + TICK_MS;
      render();
      frameIdx = (frameIdx + 1) % FRAMES;
    } else {
      nextTick = now + MENU_TICK_MS;
      renderMenu();
    }
  }
  delay(1);
}
