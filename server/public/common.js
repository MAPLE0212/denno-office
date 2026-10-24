// オフィス・マイページ共通：状態の購読、更新、トースト
const Denno = (() => {
  let toastTimer = null;

  function toast(msg, isErr = false) {
    let el = document.querySelector(".toast");
    if (!el) { el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status"); document.body.append(el); }
    el.textContent = msg;
    el.classList.toggle("err", isErr);
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 1800);
  }

  // サーバから状態が届くたびに onState(state) を呼ぶ。切れたら自動で再接続する
  function subscribe(onState, connEl) {
    const es = new EventSource("/api/events");
    es.addEventListener("state", (e) => onState(JSON.parse(e.data)));
    es.onopen = () => { if (connEl) { connEl.classList.add("live"); connEl.textContent = "接続中"; } };
    es.onerror = () => { if (connEl) { connEl.classList.remove("live"); connEl.textContent = "再接続中…"; } };
    return es;
  }

  async function patch(id, body) {
    const res = await fetch(`/api/members/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json.error || `エラー (${res.status})`);
    return json;
  }

  // 「あと 1時間23分」
  function remaining(until) {
    const min = Math.max(0, Math.ceil((until - Date.now()) / 60000));
    if (min >= 60) return `あと ${Math.floor(min / 60)}時間${min % 60 ? `${min % 60}分` : ""}`;
    return `あと ${min}分`;
  }

  function avatar(character, size) {
    const box = document.createElement("div");
    box.className = "avatar";
    if (size) box.style.width = size;
    if (character && character.image) {
      const img = document.createElement("img");
      img.src = character.image;
      img.alt = character.label;
      img.loading = "lazy";
      box.append(img);
    } else {
      const ph = document.createElement("span");
      ph.className = "ph";
      ph.textContent = character ? character.id.split("/").pop() : "?";
      box.append(ph);
    }
    return box;
  }

  return { toast, subscribe, patch, remaining, avatar };
})();
