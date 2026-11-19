import Anthropic from "https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@1.2.0/+esm";

const MODEL = "claude-sonnet-5-5";
const BUSAN = { name: "부산", admin: "부산광역시", lat: 35.1796, lon: 129.0756 };
const CATEGORIES = ["상의", "하의", "아우터", "원피스", "신발", "가방", "액세서리", "기타"];
const DAY_COUNT = 10;

/* ================= storage ================= */
const dbPromise = new Promise((resolve, reject) => {
  const req = indexedDB.open("codi", 2);
  req.onupgradeneeded = () => {
    const d = req.result;
    for (const name of ["items", "history", "trips"]) {
      if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: "id" });
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
async function store(name, mode = "readonly") { return (await dbPromise).transaction(name, mode).objectStore(name); }
const db = {
  all: async (n) => wrap((await store(n)).getAll()),
  put: async (n, v) => wrap((await store(n, "readwrite")).put(v)),
  del: async (n, id) => wrap((await store(n, "readwrite")).delete(id)),
};

function lsGet(k, fallback) { try { const v = localStorage.getItem(k); return v === null ? fallback : JSON.parse(v); } catch { return fallback; } }
function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
const settings = {
  get key() { return lsGet("codi.apikey", ""); }, set key(v) { lsSet("codi.apikey", v); },
  get profile() { return lsGet("codi.profile2", ""); }, set profile(v) { lsSet("codi.profile2", v); },
  get autoCut() { return lsGet("codi.autoCut", true); }, set autoCut(v) { lsSet("codi.autoCut", v); },
  get useGps() { return lsGet("codi.useGps", true); }, set useGps(v) { lsSet("codi.useGps", v); },
  get homeCity() { return lsGet("codi.homeCity", BUSAN); }, set homeCity(v) { lsSet("codi.homeCity", v); },
};
// migrate keys from the first version
try {
  const oldKey = localStorage.getItem("codi.key");
  if (oldKey && !settings.key) settings.key = oldKey;
  const oldProfile = localStorage.getItem("codi.profile");
  if (oldProfile && !settings.profile) settings.profile = oldProfile;
} catch {}

/* ================= utils ================= */
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
function setStatus(el, msg, isError = false) { el.textContent = msg; el.classList.toggle("error", isError); }
const ymd = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(d);
const todayStr = () => ymd(new Date());
function addDays(dateStr, n) { const d = new Date(dateStr + "T12:00:00+09:00"); d.setDate(d.getDate() + n); return ymd(d); }
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const dow = (dateStr) => WEEK[new Date(dateStr + "T12:00:00+09:00").getDay()];
const md = (dateStr) => `${+dateStr.slice(5, 7)}/${+dateStr.slice(8, 10)}`;

/* ================= theme ================= */
const root = document.documentElement;
const mq = matchMedia("(prefers-color-scheme: dark)");
const getThemeMode = () => { try { return localStorage.getItem("codi.theme") || "system"; } catch { return "system"; } };
const isDark = () => root.dataset.theme ? root.dataset.theme === "dark" : mq.matches;
function syncThemeUI() {
  root.classList.toggle("is-dark", isDark());
  document.querySelector('meta[name="theme-color"]').content = isDark() ? "#000000" : "#f7f7f7";
  document.querySelectorAll("#theme-seg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === getThemeMode()));
}
function applyTheme(mode, origin) {
  const doApply = () => {
    try { localStorage.setItem("codi.theme", mode); } catch {}
    if (mode === "system") delete root.dataset.theme; else root.dataset.theme = mode;
    syncThemeUI();
  };
  const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce) return doApply();
  if (document.startViewTransition) {
    const x = origin?.x ?? innerWidth / 2, y = origin?.y ?? 0;
    const r = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const t = document.startViewTransition(doApply);
    t.ready.then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${r}px at ${x}px ${y}px)`] },
        { duration: 550, easing: "cubic-bezier(.4,0,.2,1)", pseudoElement: "::view-transition-new(root)" },
      );
    }).catch(() => {});
  } else {
    root.classList.add("theme-fade");
    doApply();
    setTimeout(() => root.classList.remove("theme-fade"), 400);
  }
}
$("#theme-btn").addEventListener("click", (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  applyTheme(isDark() ? "light" : "dark", { x: r.left + r.width / 2, y: r.top + r.height / 2 });
});
$("#theme-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  const r = b.getBoundingClientRect();
  applyTheme(b.dataset.mode, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
});
mq.addEventListener("change", () => {
  if (getThemeMode() !== "system") return;
  root.classList.add("theme-fade");
  syncThemeUI();
  setTimeout(() => root.classList.remove("theme-fade"), 400);
});
syncThemeUI();

/* ================= Claude ================= */
function client() {
  if (!settings.key) throw new Error("설정 탭에서 Anthropic API 키를 먼저 입력해 주세요.");
  return new Anthropic({ apiKey: settings.key, dangerouslyAllowBrowser: true });
}

// Structured JSON output; handles pause_turn (web search) and refusals.
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
    if (res.stop_reason === "pause_turn") { messages.push({ role: "assistant", content: res.content }); continue; }
    if (res.stop_reason === "refusal") throw new Error("AI가 이 요청을 처리하지 못했어요. 다른 사진/요청으로 다시 시도해 주세요.");
    if (res.stop_reason === "max_tokens") throw new Error("응답이 너무 길어 잘렸어요. 다시 시도해 주세요.");
    return JSON.parse(res.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
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

/* ================= location ================= */
async function geocode(query) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: query, count: "6", language: "ko", format: "json" }).toString();
  const r = await fetch(url);
  if (!r.ok) throw new Error("지역 검색에 실패했어요.");
  const j = await r.json();
  return (j.results || []).map((x) => ({ name: x.name, admin: [x.admin1, x.country].filter(Boolean).join(", "), lat: x.latitude, lon: x.longitude }));
}

let gpsPromise = null;
function gpsLocation() {
  gpsPromise ??= new Promise((resolve) => {
    if (!navigator.geolocation) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const lat = +pos.coords.latitude.toFixed(4), lon = +pos.coords.longitude.toFixed(4);
        let name = "현재 위치", admin = "";
        try {
          const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=ko`);
          const j = await r.json();
          name = j.locality || j.city || name;
          admin = j.city && j.city !== name ? j.city : j.principalSubdivision || "";
        } catch {}
        resolve({ name, admin, lat, lon, gps: true });
      },
      () => resolve(null),
      { timeout: 10000, maximumAge: 30 * 60 * 1000 },
    );
  });
  return gpsPromise;
}

async function baseLocation() {
  if (settings.useGps) {
    const g = await gpsLocation();
    if (g) return g;
  }
  return settings.homeCity;
}

let trips = [];
const tripFor = (date) => trips.find((t) => t.start <= date && date <= t.end);

async function locationFor(date) {
  const t = tripFor(date);
  return t ? { ...t.city, trip: t } : await baseLocation();
}

/* ================= weather ================= */
const WMO = {
  0: ["맑음", "☀️"], 1: ["대체로 맑음", "🌤️"], 2: ["구름 조금", "⛅"], 3: ["흐림", "☁️"],
  45: ["안개", "🌫️"], 48: ["안개", "🌫️"], 51: ["이슬비", "🌦️"], 53: ["이슬비", "🌦️"], 55: ["이슬비", "🌦️"],
  61: ["비", "🌧️"], 63: ["비", "🌧️"], 65: ["강한 비", "🌧️"], 66: ["어는 비", "🌧️"], 67: ["어는 비", "🌧️"],
  71: ["눈", "🌨️"], 73: ["눈", "🌨️"], 75: ["많은 눈", "❄️"], 77: ["싸락눈", "🌨️"],
  80: ["소나기", "🌦️"], 81: ["소나기", "🌧️"], 82: ["강한 소나기", "⛈️"], 85: ["눈 소나기", "🌨️"], 86: ["눈 소나기", "🌨️"],
  95: ["뇌우", "⛈️"], 96: ["뇌우", "⛈️"], 99: ["뇌우", "⛈️"],
};
const forecastCache = new Map();

function forecast(loc) {
  const key = `${loc.lat},${loc.lon}`;
  if (!forecastCache.has(key)) {
    const p = (async () => {
      const url = new URL("https://api.open-meteo.com/v1/forecast");
      url.search = new URLSearchParams({
        latitude: loc.lat, longitude: loc.lon, timezone: "auto", forecast_days: "16",
        daily: "weather_code,temperature_2m_max,temperature_2m_min,apparent_temperature_max,apparent_temperature_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max",
        hourly: "temperature_2m",
      }).toString();
      const r = await fetch(url);
      if (!r.ok) throw new Error("날씨 정보를 불러오지 못했어요.");
      const j = await r.json();
      const d = j.daily;
      const byDate = {};
      d.time.forEach((date, i) => {
        const at = (h) => { const k = j.hourly.time.indexOf(`${date}T${h}:00`); return k >= 0 ? j.hourly.temperature_2m[k] : null; };
        const [desc, icon] = WMO[d.weather_code[i]] || ["알 수 없음", "🌡️"];
        byDate[date] = {
          date, desc, icon,
          max: d.temperature_2m_max[i], min: d.temperature_2m_min[i],
          feelsMax: d.apparent_temperature_max[i], feelsMin: d.apparent_temperature_min[i],
          rain: d.precipitation_probability_max[i], wind: d.wind_speed_10m_max[i], uv: d.uv_index_max[i],
          morning: at("08"), afternoon: at("14"), evening: at("20"),
        };
      });
      return byDate;
    })();
    p.catch(() => forecastCache.delete(key));
    forecastCache.set(key, p);
  }
  return forecastCache.get(key);
}

let selectedDate = todayStr();
let current = null; // { date, loc, w }

function renderDayChips() {
  const t = todayStr();
  $("#day-chips").innerHTML = Array.from({ length: DAY_COUNT }, (_, i) => {
    const d = addDays(t, i);
    const label = i === 0 ? "오늘" : i === 1 ? "내일" : dow(d);
    return `<button data-date="${d}" class="${d === selectedDate ? "on" : ""} ${tripFor(d) ? "trip" : ""}">
      <span class="d">${label}</span><span class="n">${+d.slice(8, 10)}</span><span class="dot"></span></button>`;
  }).join("");
}
$("#day-chips").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-date]");
  if (!b) return;
  selectedDate = b.dataset.date;
  renderDayChips();
  loadWeather();
});

const r0 = (n) => (n == null ? "–" : Math.round(n));
let weatherReq = 0;
async function loadWeather() {
  const req = ++weatherReq;
  const card = $("#weather-card");
  card.innerHTML = `<div class="skeleton">날씨 불러오는 중…</div>`;
  current = null;
  try {
    const date = selectedDate;
    const loc = await locationFor(date);
    const w = (await forecast(loc))[date];
    if (req !== weatherReq) return;
    if (!w) throw new Error("해당 날짜 예보가 아직 없어요.");
    current = { date, loc, w };
    card.innerHTML = `
      <div class="w-top">
        <div>
          <div class="w-loc">
            <svg viewBox="0 0 24 24"><path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>
            ${esc(loc.name)}${loc.admin ? `<span class="muted small">&nbsp;${esc(loc.admin)}</span>` : ""}
          </div>
          <div class="w-desc">${md(date)} (${dow(date)}) · ${esc(w.desc)} · 강수 ${w.rain ?? 0}%</div>
        </div>
        <div class="w-icon">${w.icon}</div>
      </div>
      <div class="w-temp">${r0(w.max)}°<small> / ${r0(w.min)}°</small></div>
      <div class="w-desc">체감 ${r0(w.feelsMin)}° ~ ${r0(w.feelsMax)}°</div>
      ${loc.trip ? `<span class="trip-badge">✈ 일정${loc.trip.memo ? ` · ${esc(loc.trip.memo)}` : ""}</span>` : ""}
      <div class="w-hours">
        <div><span>아침</span><b>${r0(w.morning)}°</b></div>
        <div><span>낮</span><b>${r0(w.afternoon)}°</b></div>
        <div><span>저녁</span><b>${r0(w.evening)}°</b></div>
        <div><span>바람</span><b>${r0(w.wind)}</b></div>
      </div>`;
  } catch (err) {
    if (req !== weatherReq) return;
    card.innerHTML = `<p class="status error">${esc(err.message)}</p>`;
  }
}

function weatherText({ loc, w }) {
  return `${loc.name}${loc.admin ? ` (${loc.admin})` : ""} ${w.date}: ${w.desc}, 최저 ${w.min}°C / 최고 ${w.max}°C (체감 ${w.feelsMin}~${w.feelsMax}°C), ` +
    `아침8시 ${w.morning}°C, 오후2시 ${w.afternoon}°C, 저녁8시 ${w.evening}°C, 강수확률 ${w.rain}%, 최대풍속 ${w.wind}km/h, 자외선지수 ${w.uv}`;
}

/* ================= images ================= */
function drawToDataUrl(src, sx, sy, sw, sh, max) {
  const scale = Math.min(1, max / Math.max(sw, sh));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(sw * scale));
  canvas.height = Math.max(1, Math.round(sh * scale));
  canvas.getContext("2d").drawImage(src, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.85);
}

// 일반 사진은 그대로 한 장, 세로로 긴 캡처는 위아래가 조금 겹치게 여러 조각으로 자름
const SLICE_RATIO = 1.4; // 조각 하나의 세로/가로 비율
const MAX_SLICES = 24;
async function sliceImage(file) {
  const bmp = await createImageBitmap(file);
  const { width: w, height: h } = bmp;
  if (h <= w * 2) return [drawToDataUrl(bmp, 0, 0, w, h, 1200)];
  const sliceH = Math.round(w * SLICE_RATIO);
  const step = Math.round(sliceH * 0.85);
  const slices = [];
  for (let y = 0; y < h && slices.length < MAX_SLICES; y += step) {
    const sh = Math.min(sliceH, h - y);
    if (slices.length && sh < sliceH * 0.25) break; // 끝에 남은 얇은 조각은 앞 조각에 이미 겹쳐 있음
    slices.push(drawToDataUrl(bmp, 0, y, w, sh, 1200));
    if (y + sh >= h) break;
  }
  return slices;
}

const loadImg = (src) => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });

// AI가 알려준 위치(0~1000 비율)로 아이템만 정사각형에 가깝게 잘라 썸네일 생성
async function cropItem(sliceUrl, b) {
  const img = await loadImg(sliceUrl);
  const W = img.naturalWidth, H = img.naturalHeight;
  const x0 = (b.x0 / 1000) * W, x1 = (b.x1 / 1000) * W, y0 = (b.y0 / 1000) * H, y1 = (b.y1 / 1000) * H;
  if (!(x1 - x0 > W * 0.05 && y1 - y0 > H * 0.05)) return drawToDataUrl(img, 0, 0, W, H, 900);
  const side = Math.max(x1 - x0, y1 - y0) * 1.15;
  const cw = Math.min(side, W), ch = Math.min(side, H);
  const sx = Math.min(Math.max((x0 + x1) / 2 - cw / 2, 0), W - cw);
  const sy = Math.min(Math.max((y0 + y1) / 2 - ch / 2, 0), H - ch);
  return drawToDataUrl(img, sx, sy, cw, ch, 640);
}

/* ================= 누끼 (배경 제거, 브라우저 안에서 무료로) ================= */
// 처음 한 번 모델(수십 MB)을 내려받고, 이후엔 기기 안에서만 처리해요. 실패하면 원본 사진을 그대로 써요.
const BG_LIB = "https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.7.0/+esm";
let bgLib = null;
let cutChain = Promise.resolve(); // 무거운 작업이라 한 번에 하나씩
let cutRunning = 0;
const thumb = (i) => i.cutout || i.image;

function cutoutQueued(dataUrl) {
  cutRunning++;
  renderCutStatus();
  const job = cutChain.then(() => makeCutout(dataUrl));
  cutChain = job.catch(() => {});
  return job.finally(() => { cutRunning--; renderCutStatus(); });
}

async function makeCutout(dataUrl) {
  if (!bgLib) bgLib = import(BG_LIB).catch((e) => { bgLib = null; throw e; });
  const { removeBackground } = await bgLib;
  const src = await (await fetch(dataUrl)).blob();
  const out = await removeBackground(src, { model: "isnet_quint8", output: { format: "image/png" } });
  return trimTransparent(out);
}

// 투명한 여백을 잘라내고 살짝 여백을 둔 PNG로
async function trimTransparent(blob) {
  const bmp = await createImageBitmap(blob);
  const w = bmp.width, h = bmp.height;
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d");
  g.drawImage(bmp, 0, 0);
  const a = g.getImageData(0, 0, w, h).data;
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (a[(y * w + x) * 4 + 3] > 24) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  if (x1 < 0 || (x1 - x0) * (y1 - y0) < w * h * 0.04) throw new Error("옷을 찾지 못했어요");
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.05);
  const sx = Math.max(0, x0 - pad), sy = Math.max(0, y0 - pad);
  const sw = Math.min(w, x1 + pad) - sx, sh = Math.min(h, y1 + pad) - sy;
  const scale = Math.min(1, 560 / Math.max(sw, sh));
  const o = document.createElement("canvas");
  o.width = Math.round(sw * scale); o.height = Math.round(sh * scale);
  o.getContext("2d").drawImage(c, sx, sy, sw, sh, 0, 0, o.width, o.height);
  return o.toDataURL("image/png");
}

async function cutItem(item) {
  try {
    const cutout = await cutoutQueued(item.image);
    const fresh = (await db.all("items")).find((x) => x.id === item.id);
    if (fresh) await db.put("items", { ...fresh, cutout, cutFailed: false });
  } catch (err) {
    console.warn("누끼 실패", err);
    const fresh = (await db.all("items")).find((x) => x.id === item.id);
    if (fresh) await db.put("items", { ...fresh, cutFailed: true });
  }
  await refreshItems();
}

function renderCutStatus() {
  const el = $("#cut-status");
  const btn = $("#cut-all");
  if (!el || !btn) return;
  const todo = items.filter((i) => !i.cutout && !i.cutFailed).length;
  btn.hidden = !settings.autoCut || cutRunning > 0 || todo === 0;
  btn.textContent = `등록된 옷 ${todo}개 누끼 따기`;
  el.textContent = cutRunning > 0 ? `누끼 따는 중… ${cutRunning}개 남음 (처음엔 모델을 받느라 1분쯤 걸려요)` : "";
}

/* ================= wardrobe ================= */
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
        required: ["image_index", "bbox", "name", "category", "subcategory", "colors", "pattern", "material", "seasons", "warmth", "formality", "style_tags", "notes", "brand", "product_name", "product_code"],
        properties: {
          image_index: { type: "integer", description: "이 아이템이 가장 온전히 보이는 이미지 번호" },
          bbox: {
            type: "object",
            additionalProperties: false,
            required: ["x0", "y0", "x1", "y1"],
            description: "그 이미지 안에서 아이템을 감싸는 상자. 이미지 왼쪽 위가 (0,0), 오른쪽 아래가 (1000,1000)인 비율 좌표",
            properties: { x0: { type: "integer" }, y0: { type: "integer" }, x1: { type: "integer" }, y1: { type: "integer" } },
          },
          name: { type: "string", description: "짧은 한국어 이름, 예: '네이비 울 가디건'" },
          brand: { type: "string", description: "화면에 글자로 보이는 브랜드명. 안 보이면 빈 문자열 (추측 금지)" },
          product_name: { type: "string", description: "화면에 글자로 보이는 정확한 상품명. 안 보이면 빈 문자열" },
          product_code: { type: "string", description: "화면에 보이는 품번/상품번호. 안 보이면 빈 문자열" },
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

const SLICES_PER_REQUEST = 8;

// slices: 같은 사진(또는 긴 캡처를 자른 조각들)의 dataURL 배열
async function analyzeSlices(slices) {
  const multi = slices.length > 1;
  const content = [];
  slices.forEach((url, i) => {
    if (multi) content.push({ type: "text", text: `이미지 ${i}` });
    content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: url.split(",")[1] } });
  });
  content.push({
    type: "text",
    text: multi
      ? `위 ${slices.length}장은 하나의 긴 캡처를 위에서 아래로 자른 조각이고, 이웃한 조각끼리 위아래가 조금 겹쳐요. 겹친 부분에 보이는 아이템은 한 번만 적고, 가장 온전히 보이는 조각 번호를 image_index로 주세요. 아이템들을 분석해 주세요.`
      : "이 사진 속 아이템들을 분석해 주세요. image_index는 0입니다.",
  });
  const out = await askJSON({
    effort: "low",
    system:
      "당신은 패션 스타일리스트입니다. 사진 속 의류/신발/가방/액세서리를 옷장 데이터베이스용으로 정확히 분류합니다. 한국어로 답하세요. " +
      "사진에 사람이 입고 있으면 착용한 아이템 각각을 따로 항목으로 만듭니다. 쇼핑앱·주문내역 캡처라면 상품 사진과 함께 상품명·색상 옵션 글자도 참고합니다. " +
      "같은 상품이 여러 번 보여도 한 번만 적습니다. 의류가 없으면 빈 배열을 반환하세요.",
    content,
    schema: ITEM_SCHEMA,
  });
  return out.items;
}

let items = [];
let filter = "전체";
const pending = [];

async function refreshItems() {
  items = (await db.all("items")).sort((a, b) => b.createdAt - a.createdAt);
  renderCloset();
}

function renderCloset() {
  const cats = ["전체", ...CATEGORIES.filter((c) => items.some((i) => i.category === c))];
  $("#closet-filters").innerHTML = items.length
    ? cats.map((c) => `<button class="${c === filter ? "on" : ""}" data-cat="${c}">${c} ${c === "전체" ? items.length : items.filter((i) => i.category === c).length}</button>`).join("")
    : "";
  const shown = filter === "전체" ? items : items.filter((i) => i.category === filter);
  $("#closet-grid").innerHTML =
    pending.map((p) => `<div class="item pending"><img src="${p.image}" alt="" /><div class="label">분석 중…</div></div>`).join("") +
    shown.map((i) => `<button class="item ${i.cutout ? "cut" : ""}" data-id="${i.id}"><img src="${thumb(i)}" alt="${esc(i.name)}" loading="lazy" /><div class="label">${esc(i.name)}</div></button>`).join("");
  $("#closet-empty").style.display = items.length || pending.length ? "none" : "block";
  renderCutStatus();
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

  let done = 0, added = 0, failed = 0, lastErr = "";
  setStatus(status, `${files.length}장 분석 중…`);
  const queue = files.slice();
  const worker = async () => {
    while (queue.length) {
      const file = queue.shift();
      const p = { image: "" };
      pending.push(p);
      try {
        const slices = await sliceImage(file);
        p.image = slices[0];
        renderCloset();
        for (let s = 0; s < slices.length; s += SLICES_PER_REQUEST) {
          const batch = slices.slice(s, s + SLICES_PER_REQUEST);
          for (const { image_index, bbox, ...it } of await analyzeSlices(batch)) {
            const src = batch[image_index] ?? batch[0];
            const item = { ...it, id: uid(), image: await cropItem(src, bbox), createdAt: Date.now() };
            await db.put("items", item);
            if (settings.autoCut) cutItem(item);
            added++;
          }
        }
      } catch (err) {
        failed++;
        lastErr = friendlyError(err);
        console.error(err);
      } finally {
        pending.splice(pending.indexOf(p), 1);
        done++;
        await refreshItems();
        setStatus(status, `${done}/${files.length}장 · ${added}개 등록${failed ? ` · ${failed}장 실패` : ""}`);
      }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  setStatus(status, `완료: ${added}개 아이템 등록${failed ? `\n${failed}장 실패 — ${lastErr}` : ""}`, failed > 0);
});

const dialog = $("#item-dialog");
const form = $("#item-form");
form.category.innerHTML = CATEGORIES.map((c) => `<option>${c}</option>`).join("");
let editing = null;

$("#closet-grid").addEventListener("click", (e) => {
  const b = e.target.closest("button.item");
  if (!b) return;
  editing = items.find((i) => i.id === b.dataset.id);
  if (!editing) return;
  $("#item-img").src = thumb(editing);
  $("#uncut-btn").hidden = !editing.cutout;
  form.name.value = editing.name;
  form.category.value = editing.category;
  form.warmth.value = editing.warmth;
  form.colors.value = (editing.colors || []).join(", ");
  form.seasons.value = (editing.seasons || []).join(", ");
  form.style_tags.value = (editing.style_tags || []).join(", ");
  form.brand.value = editing.brand || "";
  form.product_code.value = editing.product_code || "";
  $("#item-product").textContent = editing.product_name || "";
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
      brand: form.brand.value.trim(),
      product_code: form.product_code.value.trim(),
    });
  } else if (dialog.returnValue === "uncut") {
    const { cutout, ...rest } = editing;
    await db.put("items", { ...rest, cutFailed: true });
  } else if (dialog.returnValue === "delete" && confirm(`'${editing.name}' 삭제할까요?`)) {
    await db.del("items", editing.id);
  }
  editing = null;
  refreshItems();
});

/* ================= recommendation ================= */
const OUTFIT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["weather_advice", "outfits", "missing_items", "trend_notes"],
  properties: {
    weather_advice: { type: "string", description: "그날 날씨에 맞는 옷차림 요령 한두 문장" },
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

let occasion = "출근/학교";
$("#occasion-seg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  occasion = b.textContent.trim();
  document.querySelectorAll("#occasion-seg button").forEach((x) => x.classList.toggle("on", x === b));
});

let lastResult = null;

async function recentlyWorn() {
  const weekAgo = Date.now() - 7 * 864e5;
  return (await db.all("history")).filter((h) => h.createdAt > weekAgo).map((h) => ({ date: h.date, item_ids: h.item_ids }));
}

$("#recommend-btn").addEventListener("click", async () => {
  const btn = $("#recommend-btn");
  const status = $("#recommend-status");
  if (!items.length) { setStatus(status, "옷장 탭에서 옷 사진부터 추가해 주세요.", true); return; }
  if (!current) { setStatus(status, "날씨 정보가 아직 없어요. 잠시 후 다시 시도해 주세요.", true); return; }

  const ctx = current;
  const useSearch = $("#use-search").checked;
  btn.disabled = true;
  setStatus(status, useSearch ? "트렌드 검색하고 코디 짜는 중… (1분 정도 걸릴 수 있어요)" : "코디 짜는 중…");
  $("#recommend-result").innerHTML = "";

  const wardrobe = items.map(({ image, createdAt, ...rest }) => rest);
  const worn = await recentlyWorn();
  const note = $("#request-note").value.trim();
  const trip = ctx.loc.trip;

  const prompt = [
    `## 날씨\n${weatherText(ctx)}`,
    `## 상황\n${occasion}`,
    trip && `## 일정\n${trip.city.name} 출장/여행 (${trip.start} ~ ${trip.end})${trip.memo ? ` — ${trip.memo}` : ""}. 이동이 있으면 편하게, 일정 성격에 맞게 코디하세요.`,
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
    lastResult = { ...result, date: ctx.date, occasion, place: ctx.loc.name };
    saveResult();
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
    .map((i) => `<figure class="${i.cutout ? "cut" : ""}"><img src="${thumb(i)}" alt="" draggable="false" /><figcaption>${esc(i.name)}</figcaption></figure>`)
    .join("");
}

/* ---------- 결과 화면: 코디 카드 좌우 스와이프 + 오늘 결과 유지 ---------- */
const RESULT_KEY = "codi.lastResult";
function saveResult() { lsSet(RESULT_KEY, { ...lastResult, savedOn: todayStr() }); }
function restoreResult() {
  const r = lsGet(RESULT_KEY, null);
  if (!r || r.savedOn !== todayStr() || !Array.isArray(r.outfits)) return;
  lastResult = r;
  renderResult(r);
}

function renderResult(r) {
  const n = r.outfits.length;
  const slides = r.outfits.map((o, idx) => {
    const worn = r.wornIdx === idx;
    return `
    <div class="outfit-slide">
      <div class="card outfit">
        <div class="rank">${idx === 0 ? "BEST PICK" : `OPTION ${idx + 1}`}<span>${idx + 1} / ${n}</span></div>
        <h3>${esc(o.title)}</h3>
        <div class="outfit-items">${itemFigures(o.item_ids)}</div>
        <p>${esc(o.reason)}</p>
        <p class="tip">${esc(o.styling_tip)}</p>
        <button class="${idx === 0 || worn ? "primary" : ""} wide" data-wear="${idx}" ${worn ? "disabled" : ""}>${worn ? "기록했어요 ✓" : "이걸로 입을게"}</button>
      </div>
    </div>`;
  }).join("");
  const dots = n > 1 ? `<div class="dots" role="tablist">${r.outfits.map((_, i) => `<button data-dot="${i}" class="${i === 0 ? "on" : ""}" aria-label="${i + 1}번째 코디"></button>`).join("")}</div>` : "";
  const missing = r.missing_items.length
    ? `<div class="card"><h3>있으면 좋은 아이템</h3><ul class="missing">${r.missing_items.map((m) => `<li><b>${esc(m.item)}</b> — ${esc(m.why)}</li>`).join("")}</ul></div>`
    : "";
  const trend = r.trend_notes ? `<div class="card"><h3>요즘 트렌드</h3><p>${esc(r.trend_notes)}</p></div>` : "";
  const meta = r.date ? `<div class="result-meta">${md(r.date)} (${dow(r.date)})${r.place ? ` · ${esc(r.place)}` : ""}${r.occasion ? ` · ${esc(r.occasion)}` : ""}</div>` : "";
  $("#recommend-result").innerHTML =
    `<div class="card">${meta}<p class="advice">${esc(r.weather_advice)}</p></div>` +
    `<div class="carousel" id="outfit-carousel"><div class="outfit-track" id="outfit-track">${slides}</div></div>${dots}${trend}${missing}`;
  bindCarousel();
}

// 손가락을 따라 움직이다가, 놓으면 항상 한 장 단위로 딱 맞게 이동 (중간에 걸쳐 멈추지 않음)
function bindCarousel() {
  const vp = $("#outfit-carousel");
  const track = $("#outfit-track");
  if (!vp || !track) return;
  const slides = [...track.children];
  const n = slides.length;
  const dots = [...document.querySelectorAll("#recommend-result .dots button")];
  let idx = 0, sx = 0, sy = 0, dx = 0, axis = null, pid = null, dragged = false;
  let samples = []; // 최근 손가락 위치 (튕기는 속도 계산용)

  const fitHeight = () => { vp.style.height = slides[idx].offsetHeight + "px"; };
  const go = (i, anim = true) => {
    idx = Math.max(0, Math.min(n - 1, i));
    track.style.transition = anim ? "transform .34s cubic-bezier(.22,.8,.26,1)" : "none";
    track.style.transform = `translate3d(${-idx * 100}%,0,0)`;
    dots.forEach((d, k) => d.classList.toggle("on", k === idx));
    fitHeight();
  };

  vp.addEventListener("pointerdown", (e) => {
    if (n < 2 || (e.pointerType === "mouse" && e.button !== 0)) return;
    pid = e.pointerId; sx = e.clientX; sy = e.clientY; dx = 0; axis = null; dragged = false; samples = [[performance.now(), e.clientX]];
  });
  vp.addEventListener("pointermove", (e) => {
    if (e.pointerId !== pid) return;
    const mx = e.clientX - sx, my = e.clientY - sy;
    if (!axis) {
      if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
      axis = Math.abs(mx) > Math.abs(my) ? "x" : "y";
      if (axis === "x") { try { vp.setPointerCapture(pid); } catch {} track.style.transition = "none"; }
    }
    if (axis !== "x") return;
    dragged = true;
    const now = performance.now();
    samples.push([now, e.clientX]);
    while (samples.length > 2 && now - samples[0][0] > 120) samples.shift();
    dx = (idx === 0 && mx > 0) || (idx === n - 1 && mx < 0) ? mx / 3 : mx; // 양 끝에선 살짝만 끌림
    track.style.transform = `translate3d(calc(${-idx * 100}% + ${dx}px),0,0)`;
  });
  const end = (e) => {
    if (e.pointerId !== pid) return;
    pid = null;
    if (axis !== "x") return;
    const [ta, xa] = samples[0], [tb, xb] = samples[samples.length - 1];
    const v = (xb - xa) / Math.max(16, tb - ta); // 최근 0.12초 속도 (px/ms)
    const th = vp.clientWidth * 0.15;
    if (dx < -th || (v < -0.3 && dx < -12)) go(idx + 1);
    else if (dx > th || (v > 0.3 && dx > 12)) go(idx - 1);
    else go(idx);
  };
  vp.addEventListener("pointerup", end);
  vp.addEventListener("pointercancel", end);
  // 끌어서 넘긴 직후 손을 뗀 자리의 버튼이 눌리지 않게
  vp.addEventListener("click", (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
  dots.forEach((d) => d.addEventListener("click", () => go(+d.dataset.dot)));
  if ("ResizeObserver" in window) { const ro = new ResizeObserver(() => fitHeight()); slides.forEach((sl) => ro.observe(sl)); }
  go(0, false);
}

$("#recommend-result").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-wear]");
  if (!b || !lastResult) return;
  const idx = +b.dataset.wear;
  const o = lastResult.outfits[idx];
  lastResult.wornIdx = idx;
  saveResult();
  await db.put("history", { id: uid(), createdAt: Date.now(), date: lastResult.date, occasion: lastResult.occasion, place: lastResult.place, title: o.title, item_ids: o.item_ids });
  b.textContent = "기록했어요 ✓";
  b.disabled = true;
  b.classList.add("primary");
  renderHistory();
});

/* ================= trips ================= */
function cityResults(container, list, onPick) {
  container.innerHTML = list.length
    ? list.map((c, i) => `<button data-i="${i}">${esc(c.name)}<small>${esc(c.admin)}</small></button>`).join("")
    : `<p class="muted small">검색 결과가 없어요. 영문으로도 검색해 보세요 (예: Busan).</p>`;
  container.onclick = (e) => {
    const b = e.target.closest("button[data-i]");
    if (!b) return;
    container.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    onPick(list[+b.dataset.i]);
  };
}

let tripCity = null;
async function searchTripCity() {
  const q = $("#trip-city").value.trim();
  if (!q) return;
  tripCity = null;
  try {
    const list = await geocode(q);
    cityResults($("#trip-city-results"), list, (c) => { tripCity = c; });
    if (list.length === 1) { tripCity = list[0]; $("#trip-city-results button").classList.add("on"); }
  } catch (err) { setStatus($("#trip-status"), err.message, true); }
}
$("#trip-search").addEventListener("click", searchTripCity);
$("#trip-city").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchTripCity(); } });

$("#trip-start").addEventListener("change", () => {
  if (!$("#trip-end").value || $("#trip-end").value < $("#trip-start").value) $("#trip-end").value = $("#trip-start").value;
});

$("#trip-add").addEventListener("click", async () => {
  const status = $("#trip-status");
  const start = $("#trip-start").value, end = $("#trip-end").value || start;
  if (!tripCity) return setStatus(status, "도시를 검색해서 선택해 주세요.", true);
  if (!start) return setStatus(status, "날짜를 선택해 주세요.", true);
  if (end < start) return setStatus(status, "종료일이 시작일보다 빨라요.", true);
  await db.put("trips", { id: uid(), city: tripCity, start, end, memo: $("#trip-memo").value.trim(), createdAt: Date.now() });
  tripCity = null;
  $("#trip-city").value = $("#trip-memo").value = $("#trip-start").value = $("#trip-end").value = "";
  $("#trip-city-results").innerHTML = "";
  setStatus(status, "일정을 추가했어요.");
  await refreshTrips();
});

async function refreshTrips() {
  trips = (await db.all("trips")).sort((a, b) => a.start.localeCompare(b.start));
  const t = todayStr();
  $("#trip-list").innerHTML = trips.map((x) => `
    <div class="card trip-entry ${x.end < t ? "past" : ""}">
      <div>
        <b>${esc(x.city.name)}</b> <span class="muted small">${esc(x.city.admin)}</span>
        <div class="meta">${md(x.start)}(${dow(x.start)})${x.end !== x.start ? ` – ${md(x.end)}(${dow(x.end)})` : ""}${x.memo ? ` · ${esc(x.memo)}` : ""}</div>
      </div>
      <button class="ghost danger" data-del="${x.id}">삭제</button>
    </div>`).join("");
  $("#trip-empty").style.display = trips.length ? "none" : "block";
  renderDayChips();
  loadWeather();
}
$("#trip-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-del]");
  if (!b) return;
  await db.del("trips", b.dataset.del);
  refreshTrips();
});

/* ================= history ================= */
async function renderHistory() {
  const hist = (await db.all("history")).sort((a, b) => b.createdAt - a.createdAt);
  $("#history-list").innerHTML = hist.map((h) => `
    <div class="card history-entry">
      <div class="row"><span class="date grow">${md(h.date)} (${dow(h.date)}) · ${esc(h.occasion)}${h.place ? ` · ${esc(h.place)}` : ""}</span><button class="ghost danger" data-del="${h.id}">삭제</button></div>
      <h3>${esc(h.title)}</h3>
      <div class="outfit-items">${itemFigures(h.item_ids)}</div>
    </div>`).join("");
  $("#history-empty").style.display = hist.length ? "none" : "block";
}
$("#history-list").addEventListener("click", async (e) => {
  const b = e.target.closest("button[data-del]");
  if (!b) return;
  await db.del("history", b.dataset.del);
  renderHistory();
});

/* ================= settings ================= */
let pendingHome = null;
function fillSettings() {
  $("#api-key").value = settings.key;
  $("#profile-note").value = settings.profile;
  $("#use-gps").checked = settings.useGps;
  $("#home-city").value = settings.homeCity.name;
  $("#auto-cut").checked = settings.autoCut;
}
async function searchHome() {
  const q = $("#home-city").value.trim();
  if (!q) return;
  try {
    const list = await geocode(q);
    cityResults($("#home-city-results"), list, (c) => { pendingHome = c; });
    if (list.length === 1) { pendingHome = list[0]; $("#home-city-results button").classList.add("on"); }
  } catch (err) { setStatus($("#settings-status"), err.message, true); }
}
$("#home-search").addEventListener("click", searchHome);
$("#home-city").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); searchHome(); } });

$("#save-settings").addEventListener("click", () => {
  settings.key = $("#api-key").value.trim();
  settings.profile = $("#profile-note").value.trim();
  settings.autoCut = $("#auto-cut").checked;
  const gpsChanged = settings.useGps !== $("#use-gps").checked;
  settings.useGps = $("#use-gps").checked;
  if (pendingHome) { settings.homeCity = pendingHome; pendingHome = null; }
  $("#home-city-results").innerHTML = "";
  fillSettings();
  if (gpsChanged) gpsPromise = null;
  loadWeather();
  setStatus($("#settings-status"), "저장했어요.");
});

$("#export-btn").addEventListener("click", async () => {
  const data = { version: 2, items: await db.all("items"), history: await db.all("history"), trips: await db.all("trips") };
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = `codi-backup-${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
$("#import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    for (const n of ["items", "history", "trips"]) for (const x of data[n] || []) await db.put(n, x);
    await refreshItems();
    await refreshTrips();
    renderHistory();
    setStatus($("#settings-status"), `불러오기 완료: 아이템 ${data.items?.length || 0}개`);
  } catch {
    setStatus($("#settings-status"), "백업 파일을 읽지 못했어요.", true);
  }
});

$("#cut-all").addEventListener("click", () => {
  const todo = items.filter((i) => !i.cutout && !i.cutFailed);
  todo.forEach((i) => cutItem(i));
});

/* ================= tabs & init ================= */
function showTab(name) {
  document.querySelectorAll(".tabs button").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${name}`));
  $("#page-title").textContent = $(`#tab-${name}`).dataset.title;
  window.scrollTo(0, 0);
}
document.querySelector(".tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-tab]");
  if (b) showTab(b.dataset.tab);
});

fillSettings();
renderDayChips();
refreshItems().then(restoreResult);
renderHistory();
refreshTrips();
if (!settings.key) showTab("settings");
