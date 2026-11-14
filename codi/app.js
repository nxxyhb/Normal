import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm";

const MODEL = "claude-opus-5-5";
const SEOUL = { lat: 37.5665, lon: 126.978, name: "서울" };
const CATEGORIES = ["상의", "하의", "아우터", "원피스", "신발", "가방", "액세서리", "기타"];

/* ---------------- storage (IndexedDB) ---------------- */
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open("codi", 1);
  req.onupgradeneeded = () => {
    const db = req.result;
    db.createObjectStore("items", { keyPath: "id" });
    db.createObjectStore("history", { keyPath: "id" });
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function store(name, mode = "readonly") {
  const db = await dbPromise;
  return db.transaction(name, mode).objectStore(name);
}
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
const db = {
  all: async (name) => wrap((await store(name)).getAll()),
  put: async (name, value) => wrap((await store(name, "readwrite")).put(value)),
  del: async (name, id) => wrap((await store(name, "readwrite")).delete(id)),
};

const settings = {
  get key() { try { return localStorage.getItem("codi.key") || ""; } catch { return ""; } },
  set key(v) { try { localStorage.setItem("codi.key", v); } catch {} },
  get profile() { try { return localStorage.getItem("codi.profile") || ""; } catch { return ""; } },
  set profile(v) { try { localStorage.setItem("codi.profile", v); } catch {} },
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function setStatus(el, msg, isError = false) { el.textContent = msg; el.classList.toggle("error", isError); }

/* ---------------- Claude ---------------- */
function client() {
  if (!settings.key) throw new Error("설정 탭에서 Anthropic API 키를 먼저 입력해 주세요.");
  return new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true });
}

// Calls Claude with structured JSON output; handles pause_turn (web search) and refusals.
async function askJSON({ system, content, schema, effort = "medium", tools }) {
  const c = client();
  const messages = [{ role: "user", content }];
  for (let i = 0; i < 5; i++) {
    const res = await c.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system,
      messages,
      tools,
      output_config: { effort, format: { type: "json_schema", schema } },
    });
    if (res.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: res.content });
      continue;
    }
    if (res.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 못했어요. 다른 사진/요청으로 다시 시도해 주세요.");
    if (res.stop_reason === "max_tokens") throw new Error("응답이 너무 길어 잘렸어요. 다시 시도해 주세요.");
    const text = res.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    return JSON.parse(text);
  }
  throw new Error("응답을 완료하지 못했어요. 다시 시도해 주세요.");
}

function friendlyError(e) {
  if (e instanceof Anthropic.AuthenticationError) return "API 키가 올바르지 않아요. 설정 탭에서 확인해 주세요.";
  if (e instanceof Anthropic.RateLimitError) return "요청이 너무 많아요. 잠시 후 다시 시도해 주세요.";
  if (e instanceof Anthropic.APIConnectionError) return "네트워크 연결을 확인해 주세요.";
  if (e instanceof Anthropic.APIError) return `API 오류 (${e.status ?? "?"}): ${e.message}`;
  return e?.message || String(e);
}

/* ---------------- image helpers ---------------- */
async function resizeImage(file, max = 900) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.82);
}

/* ---------------- wardrobe analysis ---------------- */
const ITEM_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "category", "subcategory", "colors", "pattern", "material", "seasons", "warmth", "formality", "style_tags", "notes"],
        properties: {
          name: { type: "string", description: "짧은 한국어 이름, 예: '네이비 울 가디건'" },
          category: { type: "string", enum: CATEGORIES },
          subcategory: { type: "string", description: "예: 셔츠, 니트, 슬랙스, 청바지, 코트, 스니커즈" },
          colors: { type: "array", items: { type: "string" } },
          pattern: { type: "string", description: "무지, 스트라이프, 체크 등" },
          material: { type: "string", description: "추정 소재" },
          seasons: { type: "array", items: { type: "string", enum: ["봄", "여름", "가을", "겨울"] } },
          warmth: { type: "integer", description: "1(아주 얇음)~5(아주 따뜻함)" },
          formality: { type: "integer", description: "1(아주 캐주얼)~5(아주 포멀)" },
          style_tags: { type: "array", items: { type: "string" } },
          notes: { type: "string", description: "핏, 디테일 등 코디에 도움 될 특징" },
        },
      },
    },
  },
};

async function analyzePhoto(dataUrl) {
  const data = dataUrl.split(",")[1];
  const out = await askJSON({
    effort: "low",
    system: "당신은 패션 스타일리스트입니다. 사진 속 의류/신발/가방/액세서리를 옷장 데이터베이스용으로 정확히 분류합니다. 한국어로 답하세요. 사진에 사람이 입고 있으면 착용한 아이템 각각을 따로 항목으로 만듭니다. 의류가 없으면 빈 배열을 반환하세요.",
    content: [
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data } },
      { type: "text", text: "이 사진 속 아이템들을 분석해 주세요." },
    ],
    schema: ITEM_SCHEMA,
  });
  return out.items;
}

/* ---------------- weather (Open-Meteo, no key) ---------------- */
const WMO = {
  0: ["맑음", "☀️"], 1: ["대체로 맑음", "🌤️"], 2: ["구름 조금", "⛅"], 3: ["흐림", "☁️"],
  45: ["안개", "🌫️"], 48: ["안개", "🌫️"], 51: ["이슬비", "🌦️"], 53: ["이슬비", "🌦️"], 55: ["이슬비", "🌦️"],
  61: ["비", "🌧️"], 63: ["비", "🌧️"], 65: ["강한 비", "🌧️"], 66: ["어는 비", "🌧️"], 67: ["어는 비", "🌧️"],
  71: ["눈", "🌨️"], 73: ["눈", "🌨️"], 75: ["많은 눈", "❄️"], 77: ["싸락눈", "🌨️"],
  80: ["소나기", "🌦️"], 81: ["소나기", "🌧️"], 82: ["강한 소나기", "⛈️"], 85: ["눈 소나기", "🌨️"], 86: ["눈 소나기", "🌨️"],
  95: ["뇌우", "⛈️"], 96: ["뇌우", "⛈️"], 99: ["뇌우", "⛈️"],
};
let weatherDays = [];

async function loadWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: SEOUL.lat, longitude: SEOUL.lon, timezone: "Asia/Seoul", forecast_days: "2",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max",
    hourly: "temperature_2m",
  }).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error("날씨 정보를 불러오지 못했어요.");
  const j = await r.json();
  const d = j.daily;
  weatherDays = d.time.map((date, i) => {
    const hours = j.hourly.time.map((t, k) => [t, j.hourly.temperature_2m[k]]).filter(([t]) => t.startsWith(date));
    const at = (h) => hours.find(([t]) => t.endsWith(`T${h}:00`))?.[1];
    const [desc, icon] = WMO[d.weather_code[i]] || ["알 수 없음", "🌡️"];
    return {
      date, desc, icon,
      max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
      feelsMax: d.apparent_temperature_max[i], feelsMin: d.apparent_temperature_min[i],
      rain: d.precipitation_probability_max[i], wind: d.wind_speed_10m_max[i], uv: d.uv_index_max[i],
      morning: at("08"), afternoon: at("14"), evening: at("20"),
    };
  });
  renderWeather();
}

function weatherText(w) {
  return `${SEOUL.name} ${w.date}: ${w.desc}, 최저 ${w.min}°C / 최고 ${w.max}°C (체감 ${w.feelsMin}~${w.feelsMax}°C), ` +
    `아침8시 ${w.morning}°C, 오후2시 ${w.afternoon}°C, 저녁8시 ${w.evening}°C, 강수확률 ${w.rain}%, 최대풍속 ${w.wind}km/h, 자외선지수 ${w.uv}`;
}

function renderWeather() {
  const w = weatherDays[+$("#day-select").value];
  if (!w) return;
  $("#weather-chip").textContent = `${w.icon} ${Math.round(w.min)}° / ${Math.round(w.max)}°`;
  $("#weather-card").innerHTML = `
    <div class="weather">
      <div class="icon">${w.icon}</div>
      <div>
        <div class="temp">${Math.round(w.min)}° / ${Math.round(w.max)}°</div>
        <div class="meta">${SEOUL.name} · ${esc(w.desc)} · 체감 ${Math.round(w.feelsMin)}~${Math.round(w.feelsMax)}°</div>
        <div class="meta">아침 ${Math.round(w.morning)}° · 낮 ${Math.round(w.afternoon)}° · 저녁 ${Math.round(w.evening)}° · 강수 ${w.rain}%</div>
      </div>
    </div>`;
}

/* ---------------- closet UI ---------------- */
let items = [];
let filter = "전체";
const pending = []; // placeholders while analyzing

async function refreshItems() {
  items = (await db.all("items")).sort((a, b) => b.createdAt - a.createdAt);
  renderCloset();
}

function renderCloset() {
  const cats = ["전체", ...CATEGORIES.filter((c) => items.some((i) => i.category === c))];
  $("#closet-filters").innerHTML = cats
    .map((c) => `<button class="${c === filter ? "on" : ""}" data-cat="${c}">${c} ${c === "전체" ? items.length : items.filter((i) => i.category === c).length}</button>`)
    .join("");
  const shown = filter === "전체" ? items : items.filter((i) => i.category === filter);
  $("#closet-grid").innerHTML =
    pending.map((p) => `<div class="item pending"><img src="${p.image}" alt="" /><div class="label">분석 중…</div></div>`).join("") +
    shown.map((i) => `<button class="item" data-id="${i.id}"><img src="${i.image}" alt="${esc(i.name)}" loading="lazy" /><div class="label">${esc(i.name)}</div></button>`).join("");
  $("#closet-empty").style.display = items.length || pending.length ? "none" : "block";
}

$("#closet-filters").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-cat]");
  if (!b) return;
  filter = b.dataset.cat;
  renderCloset();
});

$("#photo-input").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  if (!files.length) return;
  const status = $("#upload-status");
  try { client(); } catch (err) { setStatus(status, err.message, true); return; }

  let done = 0, added = 0, failed = 0;
  setStatus(status, `${files.length}장 분석 중…`);
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const p = { image: await resizeImage(file) };
      pending.push(p);
      renderCloset();
      try {
        const found = await analyzePhoto(p.image);
        for (const it of found) {
          await db.put("items", { ...it, id: uid(), image: p.image, createdAt: Date.now() });
          added++;
        }
      } catch (err) {
        failed++;
        console.error(err);
        setStatus(status, friendlyError(err), true);
      } finally {
        pending.splice(pending.indexOf(p), 1);
        done++;
        await refreshItems();
        if (!failed) setStatus(status, `${done}/${files.length}장 완료 · ${added}개 아이템 등록`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  setStatus(status, `완료: ${added}개 아이템 등록${failed ? ` · ${failed}장 실패` : ""}`, failed > 0);
});

// edit dialog
const dialog = $("#item-dialog");
const form = $("#item-form");
form.category.innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join("");
let editing = null;

$("#closet-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button.item");
  if (!b) return;
  editing = items.find((i) => i.id === b.dataset.id);
  if (!editing) return;
  $("#item-img").src = editing.image;
  form.name.value = editing.name;
  form.category.value = editing.category;
  form.warmth.value = editing.warmth;
  form.colors.value = (editing.colors || []).join(", ");
  form.seasons.value = (editing.seasons || []).join(", ");
  form.style_tags.value = (editing.style_tags || []).join(", ");
  dialog.showModal();
});

dialog.addEventListener("close", async () => {
  if (!editing) return;
  const split = (s) => s.split(",").map((x) => x.trim()).filter(Boolean);
  if (dialog.returnValue === "save") {
    await db.put("items", {
      ...editing,
      name: form.name.value.trim() || editing.name,
      category: form.category.value,
      warmth: Math.min(5, Math.max(1, +form.warmth.value || editing.warmth)),
      colors: split(form.colors.value),
      seasons: split(form.seasons.value),
      style_tags: split(form.style_tags.value),
    });
  } else if (dialog.returnValue === "delete" && confirm(`'${editing.name}' 삭제할까요?`)) {
    await db.del("items", editing.id);
  }
  editing = null;
  refreshItems();
});

/* ---------------- recommendation ---------------- */
const OUTFIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["weather_advice", "outfits", "missing_items", "trend_notes"],
  properties: {
    weather_advice: { type: "string", description: "오늘 날씨에 맞는 옷차림 요령 한두 문장" },
    outfits: {
      type: "array",
      description: "추천 코디 2~3개, 가장 추천하는 것부터",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "item_ids", "reason", "styling_tip"],
        properties: {
          title: { type: "string" },
          item_ids: { type: "array", items: { type: "string" }, description: "옷장 아이템 id만 사용" },
          reason: { type: "string" },
          styling_tip: { type: "string" },
        },
      },
    },
    missing_items: {
      type: "array",
      description: "옷장에 있으면 좋을 아이템 (최대 3개, 없으면 빈 배열)",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "why"],
        properties: { item: { type: "string" }, why: { type: "string" } },
      },
    },
    trend_notes: { type: "string", description: "검색한 트렌드 요약. 검색 안 했으면 빈 문자열" },
  },
};

let lastResult = null;

async function recentlyWorn() {
  const hist = (await db.all("history")).sort((a, b) => b.createdAt - a.createdAt);
  const weekAgo = Date.now() - 7 * 864e5;
  return hist.filter((h) => h.createdAt > weekAgo).map((h) => ({ date: h.date, item_ids: h.item_ids }));
}

$("#recommend-btn").addEventListener("click", async () => {
  const btn = $("#recommend-btn");
  const status = $("#recommend-status");
  const w = weatherDays[+$("#day-select").value];
  if (!items.length) { setStatus(status, "옷장 탭에서 옷 사진부터 추가해 주세요.", true); return; }
  if (!w) { setStatus(status, "날씨 정보가 아직 없어요. 잠시 후 다시 시도해 주세요.", true); return; }

  const useSearch = $("#use-search").checked;
  btn.disabled = true;
  setStatus(status, useSearch ? "트렌드 검색하고 코디 짜는 중… (1분 정도 걸릴 수 있어요)" : "코디 짜는 중…");
  $("#recommend-result").innerHTML = "";

  const wardrobe = items.map(({ image, createdAt, ...rest }) => rest);
  const worn = await recentlyWorn();
  const occasion = $("#occasion").value;
  const note = $("#request-note").value.trim();

  const prompt = [
    `## 날씨\n${weatherText(w)}`,
    `## 상황\n${occasion}`,
    note && `## 추가 요청\n${note}`,
    settings.profile && `## 사용자 정보\n${settings.profile}`,
    `## 최근 7일 착용 기록 (가능하면 같은 조합 반복 피하기)\n${worn.length ? JSON.stringify(worn) : "없음"}`,
    `## 옷장\n${JSON.stringify(wardrobe)}`,
    useSearch ? "먼저 웹 검색으로 이번 시즌 한국 데일리룩 트렌드를 간단히 찾아보고 코디에 반영하세요." : "",
  ].filter(Boolean).join("\n\n");

  try {
    const result = await askJSON({
      effort: "medium",
      system:
        "당신은 한국 사용자의 개인 스타일리스트입니다. 사용자의 실제 옷장에 있는 아이템만으로 코디를 짭니다. " +
        "아침·저녁 기온 차이, 체감온도, 비 소식을 고려해 겉옷과 신발을 정하고, 색 조합과 상황에 맞는 격식을 맞춥니다. " +
        "각 코디는 최소 상의+하의(또는 원피스)+신발을 포함하고, 필요하면 아우터/가방/액세서리를 더합니다. " +
        "옷장에 해당 카테고리가 없으면 있는 것만으로 구성하고 missing_items에 적습니다. 한국어로 친근하게 답하세요.",
      content: prompt,
      schema: OUTFIT_SCHEMA,
      tools: useSearch ? [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] : undefined,
    });
    lastResult = { ...result, date: w.date, occasion };
    renderResult(lastResult);
    setStatus(status, "");
  } catch (err) {
    console.error(err);
    setStatus(status, friendlyError(err), true);
  } finally {
    btn.disabled = false;
  }
});

function itemFigures(ids) {
  return ids
    .map((id) => items.find((i) => i.id === id))
    .filter(Boolean)
    .map((i) => `<figure><img src="${i.image}" alt="" /><figcaption>${esc(i.name)}</figcaption></figure>`)
    .join("");
}

function renderResult(r) {
  const outfits = r.outfits
    .map((o, idx) => `
      <div class="card outfit">
        <h3><span>${idx === 0 ? "⭐ " : ""}${esc(o.title)}</span></h3>
        <div class="outfit-items">${itemFigures(o.item_ids)}</div>
        <p>${esc(o.reason)}</p>
        <p class="tip">💡 ${esc(o.styling_tip)}</p>
        <button class="primary" data-wear="${idx}">이걸로 입을게</button>
      </div>`)
    .join("");
  const missing = r.missing_items.length
    ? `<div class="card"><h3>있으면 좋은 아이템</h3><ul class="missing">${r.missing_items.map((m) => `<li><b>${esc(m.item)}</b> — ${esc(m.why)}</li>`).join("")}</ul></div>`
    : "";
  const trend = r.trend_notes ? `<div class="card"><h3>요즘 트렌드</h3><p>${esc(r.trend_notes)}</p></div>` : "";
  $("#recommend-result").innerHTML = `<div class="card"><p>🌡️ ${esc(r.weather_advice)}</p></div>${outfits}${trend}${missing}`;
}

$("#recommend-result").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-wear]");
  if (!b || !lastResult) return;
  const o = lastResult.outfits[+b.dataset.wear];
  await db.put("history", { id: uid(), createdAt: Date.now(), date: lastResult.date, occasion: lastResult.occasion, title: o.title, item_ids: o.item_ids });
  b.textContent = "기록했어요 ✓";
  b.disabled = true;
  renderHistory();
});

/* ---------------- history ---------------- */
async function renderHistory() {
  const hist = (await db.all("history")).sort((a, b) => b.createdAt - a.createdAt);
  $("#history-list").innerHTML = hist
    .map((h) => `
      <div class="card history-entry">
        <div class="row"><span class="date grow">${esc(h.date)} · ${esc(h.occasion)}</span><button class="danger" data-del="${h.id}">삭제</button></div>
        <h3>${esc(h.title)}</h3>
        <div class="outfit-items">${itemFigures(h.item_ids)}</div>
      </div>`)
    .join("");
  $("#history-empty").style.display = hist.length ? "none" : "block";
}
$("#history-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-del]");
  if (!b) return;
  await db.del("history", b.dataset.del);
  renderHistory();
});

/* ---------------- settings & backup ---------------- */
$("#api-key").value = settings.key;
$("#profile-note").value = settings.profile;
$("#save-settings").addEventListener("click", () => {
  settings.key = $("#api-key").value.trim();
  settings.profile = $("#profile-note").value.trim();
  setStatus($("#settings-status"), "저장했어요.");
});

$("#export-btn").addEventListener("click", async () => {
  const data = { version: 1, items: await db.all("items"), history: await db.all("history") };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `codi-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    for (const it of data.items || []) await db.put("items", it);
    for (const h of data.history || []) await db.put("history", h);
    await refreshItems();
    renderHistory();
    setStatus($("#settings-status"), `불러오기 완료: 아이템 ${data.items?.length || 0}개`);
  } catch {
    setStatus($("#settings-status"), "백업 파일을 읽지 못했어요.", true);
  }
});

/* ---------------- tabs & init ---------------- */
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (!b) return;
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${b.dataset.tab}`));
  window.scrollTo(0, 0);
});
$("#day-select").addEventListener("change", renderWeather);

refreshItems();
renderHistory();
loadWeather().catch((err) => {
  $("#weather-chip").textContent = "날씨 오류";
  $("#weather-card").innerHTML = `<p class="status error">${esc(err.message)}</p>`;
});
if (!settings.key) document.querySelector('.tabs button[data-tab="settings"]').click();
