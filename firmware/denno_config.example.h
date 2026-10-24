// Wi-Fi とサーバの設定（サンプル）
// サーバにつなぐときは、このファイルを同じフォルダに denno_config.h という名前でコピーして書き換える。
// denno_config.h は .gitignore に入っているので、パスワードを書いても git には入らない。
// WIFI_SSID を空のままにすると、端末だけで動く（サーバにはつながない）。
#pragma once

#define WIFI_SSID ""   // 2.4GHz の Wi-Fi の名前（ESP32-S3 は 5GHz にはつながらない）
#define WIFI_PASS ""   // その Wi-Fi のパスワード

// server/server.js を動かしている PC。".local" の名前なら起動時に mDNS で IP を探すので、
// PC の IP が変わっても書き直さなくてよい（Mac の名前は `scutil --get LocalHostName` で確認）
#define SERVER_HOST "your-computer.local"
#define SERVER_PORT 8080

#define POLL_MS 3000   // サーバに状態を取りに行く間隔
