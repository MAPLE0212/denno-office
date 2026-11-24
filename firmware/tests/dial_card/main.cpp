// M5Dial でカードが読めるかを確かめるだけのプログラム（電脳オフィス本体とは別）
//
// 書き込み: pio run -e dial-card-test -t upload
// 元の Dial 版に戻す: pio run -e m5stack-dial -t upload
//
// カードを Dial の画面の上にかざすと、カードの番号（UID）と種類を画面とシリアル(115200)に出す。
// 同じカードをもう一度かざすと「前と同じ番号」かどうかも出す（毎回番号が変わるカードは登録に使えない）。
// M5Dial の読み取り部品（WS1850S）は ISO14443A（MIFARE など）だけ読める。Suica などの FeliCa は反応しない。
#include <M5Dial.h>

static String lastUid;
static int count = 0;

static void screen(const String& l1, const String& l2, const String& l3, uint16_t color) {
  auto& d = M5Dial.Display;
  d.fillScreen(TFT_BLACK);
  d.setTextDatum(middle_center);
  d.setFont(&fonts::lgfxJapanGothic_16);
  d.setTextColor(TFT_LIGHTGREY);
  d.drawString(l1, 120, 70);
  d.setFont(&fonts::lgfxJapanGothic_20);
  d.setTextColor(color);
  d.drawString(l2, 120, 115);
  d.setFont(&fonts::lgfxJapanGothic_16);
  d.setTextColor(TFT_LIGHTGREY);
  d.drawString(l3, 120, 160);
}

void setup() {
  auto cfg = M5.config();
  M5Dial.begin(cfg, false, true);  // つまみは使わない、カード読み取りを使う
  Serial.begin(115200);
  M5Dial.Display.setBrightness(120);
  screen("カードの読み取りテスト", "かざしてください", "", TFT_WHITE);
  Serial.println("[card] かざしてください");
}

void loop() {
  M5Dial.update();
  auto& r = M5Dial.Rfid;
  if (!r.PICC_IsNewCardPresent() || !r.PICC_ReadCardSerial()) { delay(50); return; }

  String uid;
  for (byte i = 0; i < r.uid.size; i++) {
    if (i) uid += ":";
    char b[3];
    snprintf(b, sizeof b, "%02X", r.uid.uidByte[i]);
    uid += b;
  }
  String type = r.PICC_GetTypeName(r.PICC_GetType(r.uid.sak));
  // 4 バイトで先頭が 08 の番号は、かざすたびに変わる「使い捨ての番号」（スマホや一部の社員証）
  bool random = r.uid.size == 4 && r.uid.uidByte[0] == 0x08;

  count++;
  String note;
  uint16_t color = TFT_GREENYELLOW;
  if (random) { note = "毎回変わる番号かも"; color = TFT_ORANGE; }
  else if (lastUid.isEmpty()) note = "もう一度かざしてみて";
  else if (uid == lastUid) note = "前と同じ番号 OK";
  else note = "前と違うカード";

  screen(type, uid, note, color);
  Serial.printf("[card] #%d uid=%s (%d bytes) sak=%02X type=%s %s\n", count, uid.c_str(), r.uid.size, r.uid.sak,
                type.c_str(), note.c_str());
  M5Dial.Speaker.tone(2000, 60);
  lastUid = uid;

  r.PICC_HaltA();
  delay(1200);  // かざしっぱなしで何度も読まないように
}
