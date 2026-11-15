import * as pdfjsLib from "./vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
const { PDFDocument, rgb, StandardFonts, degrees, LineCapStyle, BlendMode,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = window.PDFLib;

const APP_VERSION = 4; /* Version 4 */
const $ = (s) => document.querySelector(s);
const viewer = $("#viewer"), pagesEl = $("#pages");
$("#ver").textContent = "v" + APP_VERSION;
$("#ver2").textContent = "Version " + APP_VERSION;

/* ---------- state ---------- */
let pdfDoc = null, pdfBytes = null, fileName = "";
let pages = [];
let objects = [];
let formValues = {}, formInitial = {};
const fieldFs = {};
let tool = "write";          // write | pen | marker | eraser
let penKind = "pen";         // last used drawing tool
let zoom = 1, baseScale = 1;
let selectedId = null;
let hist = [], hIndex = -1;
const PEN_COLORS = ["#111111", "#1f4fbf", "#d32f2f", "#1f9d55"];
const INK = "#111111";
const MK_COLORS = ["#ffd400", "#7ee35a", "#ff8ad1", "#6ec6ff"];
const settings = {
  pen: { color: "#111111", width: 2 },
  marker: { color: "#ffd400", width: 14 },
  text: { color: "#111111", size: 11 },
  check: "x",
  hints: true,
};
try {
  const s = JSON.parse(localStorage.getItem("pdfeditor.settings") || "{}");
  for (const k of ["pen", "marker", "text"]) if (s[k]) Object.assign(settings[k], s[k]);
  if (s.check) settings.check = s.check;
  if (typeof s.hints === "boolean") settings.hints = s.hints;
} catch (e) {}
function solidColor(c) {
  if (typeof c !== "string" || !/^#[0-9a-f]{6}$/i.test(c)) return INK;
  const n = parseInt(c.slice(1), 16), l = (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  return (l > 0.55 || c.toLowerCase() === "#1d1d1f") ? INK : c;
}
settings.text.color = solidColor(settings.text.color);
settings.pen.color = solidColor(settings.pen.color);
const saveSettings = () => { try { localStorage.setItem("pdfeditor.settings", JSON.stringify(settings)); } catch (e) {} };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const scale = () => baseScale * zoom;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const overlap = (a1, a2, b1, b2) => Math.max(0, Math.min(a2, b2) - Math.max(a1, b1));

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
const busy = (on, text) => { $("#busytext").textContent = text || "Bitte warten …"; $("#busy").classList.toggle("open", !!on); };

/* Helvetica-Metriken (identisch zum Export) für Layout auf dem Bildschirm */
const measDoc = await PDFDocument.create();
const helv = await measDoc.embedFont(StandardFonts.Helvetica);
const okChars = new Map();
function clean(s) {
  return Array.from(String(s == null ? "" : s).replace(/\r/g, "").replace(/\t/g, "    ")).map((ch) => {
    if (ch === "\n") return ch;
    if (!okChars.has(ch)) { try { helv.encodeText(ch); helv.widthOfTextAtSize(ch, 10); okChars.set(ch, true); } catch (e) { okChars.set(ch, false); } }
    return okChars.get(ch) ? ch : "?";
  }).join("");
}
const TW = (t, size) => helv.widthOfTextAtSize(t, size);

/* ---------- IndexedDB autosave ---------- */
let dbP = null;
function db() {
  if (!dbP) dbP = new Promise((res, rej) => {
    const r = indexedDB.open("pdf-editor", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("kv");
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  return dbP;
}
async function idb(mode, key, val) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const tx = d.transaction("kv", mode === "get" ? "readonly" : "readwrite");
      const st = tx.objectStore("kv");
      const rq = mode === "get" ? st.get(key) : mode === "del" ? st.delete(key) : st.put(val, key);
      rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error);
    });
  } catch (e) { console.warn("IDB", e); return undefined; }
}
let saveT = null;
function scheduleSave() {
  clearTimeout(saveT);
  saveT = setTimeout(() => { if (pdfBytes) idb("put", "state", { v: 3, objects, formValues }); }, 400);
}


/* ---------- open / load ---------- */
const fileInput = $("#fileinput");
const isDirty = () => hist.length > 1 || Object.keys(formValues).some((k) => formValues[k] !== formInitial[k]);
function pickFile() {
  if (pdfBytes && isDirty() && !confirm("Aktuelle Bearbeitung verwerfen und eine andere PDF öffnen?\n(Vorher mit „Fertig“ sichern, wenn du sie behalten willst.)")) return;
  fileInput.value = ""; fileInput.click();
}
$("#btnOpen").onclick = pickFile; $("#btnOpen2").onclick = pickFile;
fileInput.onchange = async () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  try {
    busy(true, "PDF wird geöffnet …");
    const buf = new Uint8Array(await f.arrayBuffer());
    await loadPdf(buf, f.name || "Dokument.pdf", null);
    await idb("put", "pdf", { name: fileName, bytes: buf });
    await idb("put", "state", { v: 3, objects, formValues });
    if (!localStorage.getItem("pdfeditor.hinted")) {
      setTimeout(() => toast("Tipp einfach auf eine Linie oder ein Feld und schreib los.", 4500), 600);
      try { localStorage.setItem("pdfeditor.hinted", "1"); } catch (e) {}
    }
  } catch (e) {
    console.error(e);
    if (e && e.name === "PasswordException") alert("Diese PDF ist passwortgeschützt und kann nicht bearbeitet werden.");
    else alert("Die Datei konnte nicht geöffnet werden.\n" + (e && e.message ? e.message : e));
  } finally { busy(false); }
};
$("#btnClose").onclick = async () => {
  finishEdit();
  if (isDirty() && !confirm("Datei schließen? Nicht gesicherte Änderungen gehen verloren.")) return;
  await idb("del", "pdf"); await idb("del", "state");
  resetDoc(); document.body.classList.remove("has-doc"); $("#title").textContent = "PDF bearbeiten";
  $("#btnClose").disabled = true;
};

function resetDoc() {
  finishEdit(true);
  if (io) io.disconnect();
  if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) {} }
  pdfDoc = null; pdfBytes = null; pages = []; objects = []; formValues = {}; formInitial = {};
  selectedId = null; hist = []; hIndex = -1; pagesEl.innerHTML = ""; visible.clear(); detectQueue.length = 0; updateUndo();
}

function migrate(objs) {
  for (const o of objs) {
    if (o.type === "text" && !o.mode) { o.mode = "free"; o.base = o.y + o.size * 0.93; o.maxW = o.w; }
  }
  return objs;
}

async function loadPdf(bytes, name, saved) {
  resetDoc();
  const task = pdfjsLib.getDocument({
    data: bytes.slice(), isEvalSupported: false,
    standardFontDataUrl: "./vendor/standard_fonts/", cMapUrl: "./vendor/cmaps/", cMapPacked: true,
  });
  pdfDoc = await task.promise;
  pdfBytes = bytes; fileName = name;
  $("#title").textContent = name;
  for (let i = 1; i <= pdfDoc.numPages; i++) {
    const pg = await pdfDoc.getPage(i);
    const vp1 = pg.getViewport({ scale: 1 });
    let annots = [];
    try { annots = await pg.getAnnotations(); } catch (e) {}
    const p = { num: i, pdfPage: pg, vp1, w: vp1.width, h: vp1.height, targets: [], detected: false,
      widgets: annots.filter((a) => a.subtype === "Widget" && !a.hidden && a.fieldName), renderedScale: 0 };
    for (const a of p.widgets) initField(a);
    pages.push(p);
  }
  if (saved) {
    objects = migrate(Array.isArray(saved.objects) ? saved.objects : []);
    if (!saved.v || saved.v < 3) for (const o of objects) if (o.type === "text" && o.size > 11) o.size = 11; // v2 hat teils größer gesetzt
    if (saved.formValues) for (const k in saved.formValues) if (k in formValues) formValues[k] = saved.formValues[k];
  }
  hist = [JSON.stringify(objects)]; hIndex = 0; updateUndo();
  document.body.classList.add("has-doc");
  buildPages();
  $("#btnClose").disabled = false;
  zoom = 1; layout(); viewer.scrollTop = 0; viewer.scrollLeft = 0;
  renderVisibleSoon(0);
  updatePageInd();
}

function fieldKind(a) {
  if (a.fieldType === "Tx") return "text";
  if (a.fieldType === "Ch") return "choice";
  if (a.fieldType === "Sig") return "sig";
  if (a.fieldType === "Btn") return a.checkBox ? "check" : a.radioButton ? "radio" : "push";
  return "other";
}
function initField(a) {
  const k = fieldKind(a), n = a.fieldName;
  if (n in formInitial) return;
  let v;
  if (k === "text") v = a.fieldValue == null ? "" : String(a.fieldValue);
  else if (k === "check" || k === "radio") v = a.fieldValue && a.fieldValue !== "Off" ? String(a.fieldValue) : "Off";
  else if (k === "choice") v = Array.isArray(a.fieldValue) ? (a.fieldValue[0] || "") : (a.fieldValue == null ? "" : String(a.fieldValue));
  else return;
  formInitial[n] = v; formValues[n] = v;
}

/* ---------- page DOM ---------- */
let io = null;
const visible = new Set();
function buildPages() {
  pagesEl.innerHTML = "";
  io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const p = pages[+en.target.dataset.num - 1];
      if (!p) continue;
      if (en.isIntersecting) { visible.add(p); renderPage(p); queueDetect(p); }
      else { visible.delete(p); if (pages.length > 6) releasePage(p); }
    }
  }, { root: viewer, rootMargin: "700px 0px" });
  for (const p of pages) {
    const el = document.createElement("div");
    el.className = "page"; el.dataset.num = p.num;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink"); svg.setAttribute("viewBox", `0 0 ${p.w} ${p.h}`); svg.setAttribute("preserveAspectRatio", "none");
    const hints = document.createElement("div"); hints.className = "layer hints";
    const tap = document.createElement("div"); tap.className = "layer tap";
    const forms = document.createElement("div"); forms.className = "layer forms";
    const objs = document.createElement("div"); objs.className = "layer objs";
    const draw = document.createElement("div"); draw.className = "layer draw";
    const canvas = document.createElement("canvas"); canvas.className = "pdfc"; canvas.width = 0; canvas.height = 0;
    el.append(canvas, hints, svg, tap, forms, objs, draw);
    Object.assign(p, { el, svg, hints, tap, forms, objs, draw, canvas });
    pagesEl.appendChild(el);
  }
  for (const p of pages) { buildForms(p); renderInk(p); renderObjs(p); attachDraw(p); attachTap(p); io.observe(p.el); }
}
function computeBase() {
  const maxW = Math.max(...pages.map((p) => p.w), 1);
  const avail = Math.max(200, viewer.clientWidth - 24);
  baseScale = Math.min(avail / maxW, 1.3);
}
function layout() {
  if (!pages.length) return;
  computeBase();
  const s = scale();
  for (const p of pages) {
    p.el.style.width = Math.round(p.w * s) + "px";
    p.el.style.height = Math.round(p.h * s) + "px";
    p.el.style.setProperty("--s", s);
  }
  $("#zl").textContent = Math.round(zoom * 100) + " %";
}
async function renderPage(p) {
  const s = scale();
  if (p.renderedScale === s && p.canvas.width) return;
  if (p.task) { if (p.taskScale === s) return; try { p.task.cancel(); } catch (e) {} }
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  let px = s * dpr;
  const maxPx = 12e6, area = p.w * p.h * px * px;
  if (area > maxPx) px *= Math.sqrt(maxPx / area);
  const vp = p.pdfPage.getViewport({ scale: px });
  const c = document.createElement("canvas");
  c.className = "pdfc"; c.width = Math.floor(vp.width); c.height = Math.floor(vp.height);
  const task = p.pdfPage.render({ canvasContext: c.getContext("2d"), viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS });
  p.task = task; p.taskScale = s;
  try { await task.promise; } catch (e) { if (e && e.name !== "RenderingCancelledException") console.warn(e); return; }
  if (p.task !== task) return;
  p.task = null;
  p.canvas.replaceWith(c); p.canvas.width = 0; p.canvas = c; p.renderedScale = s;
}
function releasePage(p) {
  if (p.task) { try { p.task.cancel(); } catch (e) {} p.task = null; }
  p.canvas.width = 0; p.canvas.height = 0; p.renderedScale = 0;
}
let rvT = null;
function renderVisibleSoon(ms = 160) {
  clearTimeout(rvT);
  rvT = setTimeout(() => { for (const p of visible) renderPage(p); }, ms);
}
window.addEventListener("resize", () => {
  if (!pages.length) return;
  const old = scale(); layout();
  if (old !== scale()) renderVisibleSoon();
});

/* ---------- page indicator ---------- */
function currentPage() {
  if (!pages.length) return null;
  const vr = viewer.getBoundingClientRect(), mid = vr.top + vr.height * 0.4;
  let best = pages[0], bd = Infinity;
  for (const p of pages) {
    const r = p.el.getBoundingClientRect();
    if (mid >= r.top && mid <= r.bottom) return p;
    const d = Math.min(Math.abs(mid - r.top), Math.abs(mid - r.bottom));
    if (d < bd) { bd = d; best = p; }
  }
  return best;
}
function updatePageInd() {
  const p = currentPage();
  $("#pageind").textContent = p ? `Seite ${p.num} / ${pages.length}` : "–";
}
viewer.addEventListener("scroll", () => { requestAnimationFrame(updatePageInd); }, { passive: true });

/* ---------- zoom ---------- */
function setZoom(z, fx, fy) {
  const vr = viewer.getBoundingClientRect();
  if (fx == null) { fx = vr.left + vr.width / 2; fy = vr.top + vr.height / 2; }
  const old = scale();
  zoom = clamp(z, 0.4, 5);
  const cx = viewer.scrollLeft + fx - vr.left, cy = viewer.scrollTop + fy - vr.top;
  layout();
  const r = scale() / old;
  viewer.scrollLeft = cx * r - (fx - vr.left);
  viewer.scrollTop = cy * r - (fy - vr.top);
  renderVisibleSoon();
}
$("#zin").onclick = () => setZoom(zoom * 1.25);
$("#zout").onclick = () => setZoom(zoom / 1.25);
$("#zl").onclick = () => setZoom(1);
viewer.addEventListener("wheel", (e) => {
  if (!pages.length || !(e.ctrlKey || e.metaKey)) return;
  e.preventDefault();
  setZoom(zoom * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
}, { passive: false });
// two-finger pinch / pan (touch)
let gesture = null;
const tdist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
const tmid = (t) => [(t[0].clientX + t[1].clientX) / 2, (t[0].clientY + t[1].clientY) / 2];
viewer.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2 && pages.length) {
    cancelStroke();
    const vr = viewer.getBoundingClientRect(), [mx, my] = tmid(e.touches);
    gesture = { d0: tdist(e.touches) || 1, z0: zoom, s: 1, mid: [mx, my],
      cx: viewer.scrollLeft + mx - vr.left, cy: viewer.scrollTop + my - vr.top, sl: viewer.scrollLeft, st: viewer.scrollTop, vr };
  }
}, { passive: true });
viewer.addEventListener("touchmove", (e) => {
  if (!gesture || e.touches.length !== 2) return;
  if (e.cancelable) e.preventDefault();
  const g = gesture, [mx, my] = tmid(e.touches);
  g.s = clamp(tdist(e.touches) / g.d0, 0.4 / g.z0, 5 / g.z0); g.mid = [mx, my];
  const tx = mx - g.vr.left - g.cx * g.s + viewer.scrollLeft, ty = my - g.vr.top - g.cy * g.s + viewer.scrollTop;
  pagesEl.style.transform = `translate(${tx}px, ${ty}px) scale(${g.s})`;
}, { passive: false });
const endGesture = () => {
  if (!gesture) return;
  const g = gesture; gesture = null;
  pagesEl.style.transform = "";
  const old = scale();
  zoom = clamp(g.z0 * g.s, 0.4, 5);
  layout();
  const r = scale() / old;
  viewer.scrollLeft = g.cx * r - (g.mid[0] - g.vr.left);
  viewer.scrollTop = g.cy * r - (g.mid[1] - g.vr.top);
  renderVisibleSoon(60);
};
viewer.addEventListener("touchend", (e) => { if (e.touches.length < 2) endGesture(); });
viewer.addEventListener("touchcancel", endGesture);
document.addEventListener("gesturestart", (e) => e.preventDefault());

/* ---------- forms ---------- */
function rectOf(p, a) {
  const [x1, y1, x2, y2] = p.vp1.convertToViewportRectangle(a.rect);
  return { l: Math.min(x1, x2), t: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
}
function placePct(el, p, l, t, w, h) {
  el.style.left = (l / p.w * 100) + "%"; el.style.top = (t / p.h * 100) + "%";
  el.style.width = (w / p.w * 100) + "%"; if (h != null) el.style.height = (h / p.h * 100) + "%";
}
function buildForms(p) {
  p.forms.innerHTML = "";
  for (const a of p.widgets) {
    const k = fieldKind(a), n = a.fieldName, r = rectOf(p, a);
    let el = null;
    if (k === "text") {
      el = document.createElement(a.multiLine ? "textarea" : "input");
      if (!a.multiLine) el.type = a.password ? "password" : "text";
      el.value = formValues[n] || "";
      if (a.maxLen) el.maxLength = a.maxLen;
      let fs = (a.defaultAppearanceData && a.defaultAppearanceData.fontSize) || 0;
      const fsOrig = fs;
      if (!fs) fs = a.multiLine ? 10 : Math.min(r.h * 0.65, 13);
      fs = a.multiLine ? Math.min(fs, 12) : Math.min(fs, r.h * 0.7, 16);
      // Export soll aussehen wie in der App: wenn wir die Größe begrenzt haben, merken
      if (!fsOrig || fs < fsOrig - 0.5) fieldFs[n] = fs;
      el.style.fontSize = `calc(var(--s) * ${fs}px)`;
      el.style.textAlign = ["left", "center", "right"][a.textAlignment || 0] || "left";
      el.autocomplete = "off"; el.spellcheck = false;
      el.addEventListener("input", () => setFormValue(n, el.value, el));
    } else if (k === "check" || k === "radio") {
      el = document.createElement("button");
      el.className = "fchk" + (k === "radio" ? " radio" : "");
      el.dataset.on = k === "check" ? (a.exportValue || "Yes") : (a.buttonValue || "Yes");
      el.style.fontSize = `calc(var(--s) * ${Math.max(6, Math.min(r.w, r.h) * 0.85)}px)`;
      el.addEventListener("click", () => {
        const on = el.dataset.on, cur = formValues[n];
        setFormValue(n, cur === on ? (k === "radio" && a.noToggleToOff ? on : "Off") : on, null);
      });
    } else if (k === "choice") {
      el = document.createElement("select");
      const opts = a.options || [];
      const cur = formValues[n] || "";
      if (!opts.some((o) => o.exportValue === cur)) el.add(new Option(cur || "", cur || ""));
      for (const o of opts) el.add(new Option(o.displayValue || o.exportValue, o.exportValue));
      el.value = cur;
      el.style.fontSize = `calc(var(--s) * ${Math.min(r.h * 0.65, 13)}px)`;
      el.addEventListener("change", () => setFormValue(n, el.value, el));
    } else if (k === "sig") {
      el = document.createElement("button");
      el.className = "fsig"; el.textContent = "✍️ Unterschreiben";
      el.style.fontSize = `calc(var(--s) * ${Math.min(r.h * 0.4, 12)}px)`;
      el.addEventListener("click", () => openSigChooser({ page: p.num, box: r }));
    } else continue;
    el.classList.add("ff"); el.dataset.name = n; el.dataset.kind = k;
    if (a.readOnly) el.disabled = true;
    placePct(el, p, r.l, r.t, r.w, r.h);
    p.forms.appendChild(el);
  }
  syncChecks();
}
function syncChecks(name) {
  for (const p of pages) if (p.forms) for (const el of p.forms.querySelectorAll(".fchk")) {
    if (name && el.dataset.name !== name) continue;
    el.textContent = formValues[el.dataset.name] === el.dataset.on ? (el.dataset.kind === "radio" ? "●" : "✓") : "";
  }
}
function setFormValue(n, v, src) {
  formValues[n] = v;
  for (const p of pages) for (const el of p.forms.querySelectorAll(".ff")) {
    if (el.dataset.name !== n || el === src) continue;
    if (el.dataset.kind === "text" || el.dataset.kind === "choice") el.value = v;
  }
  syncChecks(n);
  scheduleSave();
}


/* ---------- automatische Erkennung von Schreibstellen ---------- */
const detectQueue = [];
let detecting = false;
function queueDetect(p) {
  if (p.detected || p.detectQueued) return;
  p.detectQueued = true; detectQueue.push(p);
  runDetectQueue();
}
async function runDetectQueue() {
  if (detecting) return;
  detecting = true;
  while (detectQueue.length) {
    const p = detectQueue.shift();
    if (!pages.includes(p)) continue;
    try { p.targets = await detectPage(p); }
    catch (e) { console.warn("Erkennung Seite " + p.num, e); p.targets = []; }
    p.detected = true;
    if (pages.includes(p)) renderHints(p);
    await new Promise((r) => setTimeout(r, 30));
  }
  detecting = false;
}

const FILL_RE = /_{3,}|(?:\.[ \u00a0]?){4,}|…{2,}/g;
const BOX_RE = /[\u2610\u25A1\u274F\u25FB\u2B1C\u25A2]/g;
const SIG_RE = /unterschrift|unterzeichn|signatur|signature/i;
const DATE_RE = /datum|\bdate\b/i;
const measCtx = document.createElement("canvas").getContext("2d");
measCtx.font = "100px Helvetica, Arial, sans-serif";

function textItems(p, tc) {
  const out = [];
  for (const it of tc.items) {
    if (!it.str || !it.str.trim()) continue;
    const tx = pdfjsLib.Util.transform(p.vp1.transform, it.transform);
    if (!(tx[0] > 0) || Math.abs(tx[1]) > 0.15 * Math.abs(tx[0])) continue; // nur waagerechter Text
    const size = Math.abs(tx[3]) || Math.hypot(tx[2], tx[3]) || 10;
    const x0 = tx[4], base = tx[5];
    out.push({ str: it.str, x0, x1: x0 + Math.max(it.width, 0.1), base, size });
  }
  return out;
}
function itemPieces(it) {
  const str = it.str, total = measCtx.measureText(str).width || 1, span = it.x1 - it.x0;
  const X = (i) => it.x0 + measCtx.measureText(str.slice(0, i)).width / total * span;
  const out = []; let last = 0, m;
  const pushText = (a, b) => {
    const s = str.slice(a, b); if (!s.trim()) return;
    const lead = s.length - s.trimStart().length, trail = s.length - s.trimEnd().length;
    out.push({ fill: false, x0: X(a + lead), x1: X(b - trail), str: s.trim(), base: it.base, size: it.size });
  };
  FILL_RE.lastIndex = 0;
  while ((m = FILL_RE.exec(str))) {
    if (m.index > last) pushText(last, m.index);
    out.push({ fill: true, kind: m[0][0] === "_" ? "u" : "d", x0: X(m.index), x1: X(m.index + m[0].length), str: m[0], base: it.base, size: it.size });
    last = m.index + m[0].length;
  }
  if (last < str.length) pushText(last, str.length);
  BOX_RE.lastIndex = 0;
  while ((m = BOX_RE.exec(str))) out.push({ box: true, x0: X(m.index), x1: X(m.index + 1), base: it.base, size: it.size });
  return out;
}

/* Läufe dunkler Pixel entlang Zeilen (horizontal) oder Spalten (vertikal) finden und zu Segmenten zusammenfassen */
function scanSegments(L, W, H, horiz, gap, minLen, dmin, dmax, maxT) {
  const n = horiz ? W : H, m = horiz ? H : W;
  const segs = []; let active = [];
  for (let r = 0; r < m; r++) {
    const runs = [];
    let k = 0;
    while (k < n) {
      const i0 = horiz ? r * W + k : k * W + r;
      if (!L[i0]) { k++; continue; }
      let start = k, last = k, cnt = 0;
      while (k < n && k - last <= gap) {
        if (L[horiz ? r * W + k : k * W + r]) { last = k; cnt++; }
        k++;
      }
      const len = last - start + 1, d = cnt / len;
      if (len >= minLen && d >= dmin && d <= dmax) runs.push([start, last]);
      k = last + 1;
    }
    const next = [];
    for (const rn of runs) {
      let seg = null;
      for (const a of active) {
        if (a.used) continue;
        if (overlap(a.a1, a.a2 + 1, rn[0], rn[1] + 1) >= 0.7 * Math.min(a.a2 - a.a1 + 1, rn[1] - rn[0] + 1)) { seg = a; break; }
      }
      if (seg) { seg.used = true; seg.b2 = r; seg.a1 = Math.min(seg.a1, rn[0]); seg.a2 = Math.max(seg.a2, rn[1]); next.push(seg); }
      else next.push({ a1: rn[0], a2: rn[1], b1: r, b2: r, used: true });
    }
    for (const a of active) if (!a.used) segs.push(a);
    for (const a of next) a.used = false;
    active = next;
  }
  segs.push(...active);
  return segs.filter((s) => s.b2 - s.b1 + 1 <= maxT);
}
function frac(L, W, H, horiz, b, a1, a2) {
  if (horiz ? (b < 0 || b >= H) : (b < 0 || b >= W)) return 0;
  let c = 0;
  for (let a = a1; a <= a2; a++) c += L[horiz ? b * W + a : a * W + b];
  return c / (a2 - a1 + 1);
}

async function detectPage(p) {
  let s = 2; const maxPx = 4.5e6;
  if (p.w * p.h * s * s > maxPx) s = Math.sqrt(maxPx / (p.w * p.h));
  const vp = p.pdfPage.getViewport({ scale: s });
  const W = Math.ceil(vp.width), H = Math.ceil(vp.height);
  const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
  await p.pdfPage.render({ canvasContext: ctx, viewport: vp, annotationMode: pdfjsLib.AnnotationMode.ENABLE_FORMS }).promise;
  const data = ctx.getImageData(0, 0, W, H).data;
  cv.width = 0;
  const N = W * H, D = new Uint8Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) D[i] = (data[j] * 0.299 + data[j + 1] * 0.587 + data[j + 2] * 0.114) < 200 ? 1 : 0;

  let tc = { items: [] };
  try { tc = await p.pdfPage.getTextContent(); } catch (e) {}
  const items = textItems(p, tc);
  const pieces = items.flatMap(itemPieces);
  const words = pieces.filter((pc) => !pc.fill && !pc.box);
  p.words = words;

  // Textkörper ausblenden, damit Buchstaben nicht als Linien gelten
  const L = D.slice();
  for (const w of words) {
    const x0 = clamp(Math.floor(w.x0 * s) - 1, 0, W - 1), x1 = clamp(Math.ceil(w.x1 * s) + 1, 0, W - 1);
    const y0 = clamp(Math.floor((w.base - w.size * 0.95) * s), 0, H - 1), y1 = clamp(Math.ceil((w.base + w.size * 0.04) * s), 0, H - 1);
    for (let y = y0; y <= y1; y++) L.fill(0, y * W + x0, y * W + x1 + 1);
  }
  const maxT = Math.max(3, Math.round(2.2 * s));
  const gS = Math.max(1, Math.round(s * 0.5));
  const hS = scanSegments(L, W, H, true, gS, 5 * s, 0, 1, maxT).filter((g) =>
    frac(L, W, H, true, g.b1 - 2, g.a1, g.a2) < 0.4 && frac(L, W, H, true, g.b2 + 2, g.a1, g.a2) < 0.4);
  const hD = scanSegments(L, W, H, true, Math.round(4 * s), 30 * s, 0.2, 0.8, maxT).filter((g) =>
    frac(L, W, H, true, g.b1 - 2, g.a1, g.a2) < 0.12 && frac(L, W, H, true, g.b2 + 2, g.a1, g.a2) < 0.12);
  const vS = scanSegments(L, W, H, false, gS, 5 * s, 0, 1, maxT).filter((g) =>
    frac(L, W, H, false, g.b1 - 2, g.a1, g.a2) < 0.4 && frac(L, W, H, false, g.b2 + 2, g.a1, g.a2) < 0.4);

  // Linienmaske -> geschlossene Flächen (Zellen, Kästchen)
  const M = new Uint8Array(N);
  for (const g of hS) for (let y = Math.max(0, g.b1 - 1); y <= Math.min(H - 1, g.b2 + 1); y++) M.fill(1, y * W + Math.max(0, g.a1 - 3), y * W + Math.min(W - 1, g.a2 + 3) + 1);
  for (const g of vS) for (let y = Math.max(0, g.a1 - 3); y <= Math.min(H - 1, g.a2 + 3); y++) M.fill(1, y * W + Math.max(0, g.b1 - 1), y * W + Math.min(W - 1, g.b2 + 1) + 1);
  const lab = new Int32Array(N), Q = new Int32Array(N);
  const comps = [];
  let id = 0;
  for (let i0 = 0; i0 < N; i0++) {
    if (M[i0] || lab[i0]) continue;
    id++;
    let qh = 0, qt = 0; Q[qt++] = i0; lab[i0] = id;
    let minx = W, maxx = 0, miny = H, maxy = 0, cnt = 0, border = false;
    while (qh < qt) {
      const i = Q[qh++], x = i % W, y = (i - x) / W;
      cnt++;
      if (x < minx) minx = x; if (x > maxx) maxx = x; if (y < miny) miny = y; if (y > maxy) maxy = y;
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) border = true;
      if (x > 0 && !M[i - 1] && !lab[i - 1]) { lab[i - 1] = id; Q[qt++] = i - 1; }
      if (x < W - 1 && !M[i + 1] && !lab[i + 1]) { lab[i + 1] = id; Q[qt++] = i + 1; }
      if (y > 0 && !M[i - W] && !lab[i - W]) { lab[i - W] = id; Q[qt++] = i - W; }
      if (y < H - 1 && !M[i + W] && !lab[i + W]) { lab[i + W] = id; Q[qt++] = i + W; }
    }
    if (border) continue;
    const bw = maxx - minx + 1, bh = maxy - miny + 1;
    if (bw < 4 * s || bh < 4 * s || cnt / (bw * bh) < 0.82) continue;
    comps.push({ l: (minx - 1) / s, t: (miny - 1) / s, w: (bw + 2) / s, h: (bh + 2) / s, px: [minx, miny, maxx, maxy] });
  }
  const density = (x0, y0, x1, y1) => { // Punkte (pt) -> Anteil dunkler Pixel
    const a0 = clamp(Math.floor(x0 * s), 0, W - 1), a1 = clamp(Math.ceil(x1 * s), 0, W - 1);
    const b0 = clamp(Math.floor(y0 * s), 0, H - 1), b1 = clamp(Math.ceil(y1 * s), 0, H - 1);
    if (a1 <= a0 || b1 <= b0) return 0;
    let c = 0; for (let y = b0; y <= b1; y++) for (let x = a0; x <= a1; x++) c += D[y * W + x];
    return c / ((a1 - a0 + 1) * (b1 - b0 + 1));
  };
  const labelLeft = (yBase, x, tol) => {
    let best = null;
    for (const w of words) if (Math.abs(w.base - yBase) < tol && w.x1 <= x + 3 && w.x1 >= x - 170 && (!best || w.x1 > best.x1)) best = w;
    return best;
  };
  const targets = [];
  const push = (t) => { targets.push(t); };
  const flags = (txt) => ({ sig: SIG_RE.test(txt) && !DATE_RE.test(txt), date: DATE_RE.test(txt), sigAlso: SIG_RE.test(txt) && DATE_RE.test(txt) });

  // 1) Kästchen und Zellen
  for (const c of comps) {
    const { l, t, w, h } = c;
    if (w >= 5 && w <= 22 && h >= 5 && h <= 22 && Math.abs(w - h) <= 0.3 * Math.max(w, h)) {
      if (density(l + 1.5, t + 1.5, l + w - 1.5, t + h - 1.5) < 0.08) push({ kind: "check", box: { l, t, w, h } });
      continue;
    }
    if (h < 8 || w < 14 || (w > p.w * 0.85 && h > p.h * 0.5)) continue;
    const inside = words.filter((wd) => { const cx = (wd.x0 + wd.x1) / 2, cy = wd.base - wd.size * 0.35; return cx > l && cx < l + w && cy > t && cy < t + h; });
    if (inside.length > 8) continue;
    const r = l + w, b = t + h;
    let box = null, label = "", lsize = 0;
    if (!inside.length) {
      if (density(l + 2, t + 2, r - 2, b - 2) > 0.02) continue;
      box = { l, t, w, h };
      const head = words.filter((wd) => { const cx = (wd.x0 + wd.x1) / 2; return cx > l && cx < r && wd.base < t + 1 && wd.base > t - 40; }).sort((a, b2) => b2.base - a.base)[0];
      const left = labelLeft(t + h / 2 + 3, l, h / 2 + 2);
      label = (left ? left.str + " " : "") + (head ? head.str : "");
      lsize = (left || head || {}).size || 0;
    } else {
      const tr = Math.max(...inside.map((x) => x.x1)), tb = Math.max(...inside.map((x) => x.base + x.size * 0.25));
      const rows = new Set(inside.map((x) => Math.round(x.base / 3))).size;
      label = inside.map((x) => x.str).join(" "); lsize = inside[0].size;
      if (r - tr >= Math.max(30, 0.35 * w) && rows === 1 && /[:：]\s*$/.test(label) && density(tr + 3, t + 2, r - 2, b - 2) < 0.02) box = { l: tr + 3, t, w: r - tr - 3, h };
      else if (b - tb >= Math.max(10, lsize * 1.3) && density(l + 2, tb + 1, r - 2, b - 2) < 0.02) box = { l, t: tb, w, h: b - tb };
      else continue;
    }
    const f = flags(label);
    const size = clamp(box.h * 0.6, 6, 11); // einheitlich 11 pt, nur bei engen Zellen kleiner
    push({ kind: "cell", box, size, label: label.trim(), ...f });
  }

  // 2) Schreiblinien (durchgezogen oder gepunktet)
  const isEdge = (y, x1, x2) => comps.some((c) => (Math.abs(y - c.t) < 2.5 || Math.abs(y - (c.t + c.h)) < 2.5) && overlap(x1, x2, c.l, c.l + c.w) > 0.3 * Math.min(x2 - x1, c.w));
  const segPts = [...hS, ...hD].map((g) => ({ x1: g.a1 / s, x2: (g.a2 + 1) / s, y: (g.b1 + g.b2 + 1) / 2 / s, dotted: hD.includes(g) }));
  const lineCands = segPts.filter((g) => g.x2 - g.x1 >= 25 && !isEdge(g.y, g.x1, g.x2));
  const fillPieces = pieces.filter((pc) => pc.fill && pc.x1 - pc.x0 >= 12);
  for (const fp of fillPieces) lineCands.push({ x1: fp.x0, x2: fp.x1, y: fp.base + (fp.kind === "u" ? fp.size * 0.12 : fp.size * 0.02), fromText: true, size: fp.size });
  const lines = [];
  for (const g of lineCands) {
    if (g.fromText && lines.some((o) => Math.abs(o.y - g.y) < 4 && overlap(o.x1, o.x2, g.x1, g.x2) > 0.4 * Math.min(o.x2 - o.x1, g.x2 - g.x1))) continue;
    if (!g.fromText && lines.some((o) => Math.abs(o.y - g.y) < 2 && overlap(o.x1, o.x2, g.x1, g.x2) > 0.5 * (g.x2 - g.x1))) continue;
    // Text, der auf der Linie steht, aussparen
    const cover = words.filter((w) => w.size < 30 && w.base > g.y - 16 && w.base < g.y + 1.5 && overlap(w.x0, w.x1, g.x1, g.x2) > 0)
      .map((w) => [w.x0 - 2, w.x1 + 3]).sort((a, b) => a[0] - b[0]);
    let parts = [[g.x1, g.x2]];
    for (const [c0, c1] of cover) parts = parts.flatMap(([a, b]) => (c1 <= a || c0 >= b) ? [[a, b]] : [[a, Math.max(a, c0)], [Math.min(b, c1), b]]);
    for (const [a, b] of parts) if (b - a >= 20) lines.push({ x1: a, x2: b, y: g.y, fromText: g.fromText, size: g.size });
  }
  for (const ln of lines) {
    const len = ln.x2 - ln.x1;
    const left = labelLeft(ln.y - 1.5, ln.x1, 9);
    const below = words.filter((w) => w.base > ln.y + 2 && w.base < ln.y + 18 && overlap(w.x0, w.x1, ln.x1, ln.x2) > 0.2 * (w.x1 - w.x0))
      .sort((a, b) => a.base - b.base)[0];
    const parallel = lines.some((o) => o !== ln && Math.abs(o.y - ln.y) > 10 && Math.abs(o.y - ln.y) < 40 && overlap(o.x1, o.x2, ln.x1, ln.x2) > 0.6 * len);
    if (len > p.w * 0.6 && !left && !below && !parallel && !ln.fromText) continue; // Trennlinie
    // Platz nach oben
    let gapUp = 24;
    for (const o of segPts) if (o.y < ln.y - 2 && o.y > ln.y - 40 && overlap(o.x1, o.x2, ln.x1, ln.x2) > 0.3 * len) gapUp = Math.min(gapUp, ln.y - o.y - 1);
    for (const w of words) if (w.base < ln.y - 3 && w.base > ln.y - 44 && overlap(w.x0, w.x1, ln.x1, ln.x2) > 0) gapUp = Math.min(gapUp, ln.y - (w.base + w.size * 0.25) - 1);
    const h = clamp(gapUp, 9, 24);
    const label = [left && left.str, below && below.str].filter(Boolean).join(" ");
    const lsize = left ? left.size : (ln.size || 0);
    const size = Math.min(11, Math.max(7, h * 0.8)); // einheitlich 11 pt, auch auf breiten Linien
    push({ kind: "line", box: { l: ln.x1 + 1.5, t: ln.y - h, w: len - 3, h }, lineY: ln.y, size, label, ...flags(label) });
  }

  // 3) Kästchen-Zeichen im Text (☐)
  for (const pc of pieces) if (pc.box) {
    const sz = pc.size * 0.72;
    push({ kind: "check", box: { l: pc.x0 + (pc.x1 - pc.x0 - sz) / 2, t: pc.base - sz * 0.95, w: sz, h: sz } });
  }

  // Bereiche echter Formularfelder überspringen; doppelte Kästchen entfernen
  const wr = p.widgets.map((a) => rectOf(p, a));
  const out = [];
  for (const t of targets) {
    const b = t.box;
    if (wr.some((r) => overlap(b.l, b.l + b.w, r.l, r.l + r.w) * overlap(b.t, b.t + b.h, r.t, r.t + r.h) > 0.3 * b.w * b.h)) continue;
    if (t.kind === "check" && out.some((o) => o.kind === "check" && overlap(b.l, b.l + b.w, o.box.l, o.box.l + o.box.w) > b.w * 0.5 && overlap(b.t, b.t + b.h, o.box.t, o.box.t + o.box.h) > b.h * 0.5)) continue;
    out.push(t);
  }
  out.sort((a, b) => (Math.abs(a.box.t + a.box.h - b.box.t - b.box.h) < 4 ? a.box.l - b.box.l : (a.box.t + a.box.h) - (b.box.t + b.box.h)));
  out.forEach((t, i) => { t.id = "p" + p.num + "t" + i; });
  return out;
}

/* ---------- ink (strokes) ---------- */
function pathD(pts, map) {
  const P = map ? pts.map(map) : pts;
  const f = (n) => Math.round(n * 100) / 100;
  if (!P.length) return "";
  if (P.length === 1) return `M${f(P[0][0])} ${f(P[0][1])} L${f(P[0][0] + 0.01)} ${f(P[0][1])}`;
  let d = `M${f(P[0][0])} ${f(P[0][1])}`;
  for (let i = 1; i < P.length - 1; i++) {
    const mx = (P[i][0] + P[i + 1][0]) / 2, my = (P[i][1] + P[i + 1][1]) / 2;
    d += ` Q${f(P[i][0])} ${f(P[i][1])} ${f(mx)} ${f(my)}`;
  }
  const L = P[P.length - 1];
  d += ` L${f(L[0])} ${f(L[1])}`;
  return d;
}
function strokeEl(o) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", "path");
  el.setAttribute("d", pathD(o.points));
  el.setAttribute("stroke", o.color); el.setAttribute("stroke-width", o.width);
  if (o.kind === "marker") { el.setAttribute("stroke-opacity", o.opacity); el.setAttribute("class", "mk"); }
  el.dataset.id = o.id;
  return el;
}
function renderInk(p) {
  p.svg.innerHTML = "";
  for (const o of objects) if (o.type === "stroke" && o.page === p.num) p.svg.appendChild(strokeEl(o));
}
let cur = null; // active drawing
const touchIds = new Set();
function cancelStroke() {
  if (cur && cur.o) {
    objects = objects.filter((x) => x !== cur.o);
    if (cur.el) cur.el.remove();
  }
  cur = null;
}
function ptOf(p, e) {
  const r = p.el.getBoundingClientRect();
  return [(e.clientX - r.left) / r.width * p.w, (e.clientY - r.top) / r.height * p.h];
}
function attachDraw(p) {
  const d = p.draw;
  d.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") {
      touchIds.add(e.pointerId);
      if (touchIds.size > 1 || gesture) { cancelStroke(); return; }
    }
    if (e.button && e.button !== 0) return;
    e.preventDefault();
    try { d.setPointerCapture(e.pointerId); } catch (er) {}
    const pt = ptOf(p, e);
    if (tool === "pen" || tool === "marker") {
      const st = settings[tool];
      const o = { id: uid(), type: "stroke", page: p.num, kind: tool, color: st.color, width: st.width, opacity: tool === "marker" ? 0.4 : 1, points: [pt] };
      objects.push(o);
      const el = strokeEl(o); p.svg.appendChild(el);
      cur = { p, o, el, id: e.pointerId };
    } else if (tool === "eraser") {
      cur = { p, id: e.pointerId, erased: false };
      eraseAt(p, pt);
    }
  });
  d.addEventListener("pointermove", (e) => {
    if (!cur || cur.id !== e.pointerId || cur.p !== p) return;
    let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    if (!evs.length) evs = [e];
    if (cur.o) {
      const minD = 0.6 / scale();
      for (const ev of evs) {
        const pt = ptOf(p, ev), last = cur.o.points[cur.o.points.length - 1];
        if (Math.hypot(pt[0] - last[0], pt[1] - last[1]) >= minD) cur.o.points.push(pt);
      }
      cur.el.setAttribute("d", pathD(cur.o.points));
    } else if (tool === "eraser") {
      for (const ev of evs) eraseAt(p, ptOf(p, ev));
    }
  });
  const up = (e) => {
    if (e.pointerType === "touch") touchIds.delete(e.pointerId);
    if (!cur || cur.id !== e.pointerId || cur.p !== p) return;
    const c = cur; cur = null;
    if (c.o) commit();
    else if (tool === "eraser") { if (c.erased) commit(); }

  };
  d.addEventListener("pointerup", up);
  d.addEventListener("pointercancel", (e) => { if (e.pointerType === "touch") touchIds.delete(e.pointerId); if (cur && cur.id === e.pointerId) { if (cur.o) cancelStroke(); else cur = null; } });
}
function distSeg(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy;
  let t = l2 ? ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
function eraseAt(p, pt) {
  const tol = 10 / scale();
  const hit = objects.filter((o) => {
    if (o.type !== "stroke" || o.page !== p.num) return false;
    const lim = o.width / 2 + tol, P = o.points;
    if (P.length === 1) return Math.hypot(pt[0] - P[0][0], pt[1] - P[0][1]) < lim;
    for (let i = 0; i < P.length - 1; i++) if (distSeg(pt, P[i], P[i + 1]) < lim) return true;
    return false;
  });
  if (!hit.length) return;
  objects = objects.filter((o) => !hit.includes(o));
  for (const o of hit) { const el = p.svg.querySelector(`[data-id="${o.id}"]`); if (el) el.remove(); }
  if (cur) cur.erased = true;
}


/* ---------- Text-Layout (gleich für Bildschirm und Export) ---------- */
function wrapText(text, size, maxW) {
  const W = (t) => TW(t, size);
  const out = [];
  const brk = (word, start = "") => { let ch0 = start; for (const ch of word) { if (ch0 && W(ch0 + ch) > maxW) { out.push(ch0); ch0 = ch; } else ch0 += ch; } return ch0; };
  for (const para of text.split("\n")) {
    let line = "";
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      if (!line.trim()) line = W((line + tok).trimEnd()) <= maxW ? line + tok : brk(tok, line);
      else if (W((line + tok).trimEnd()) <= maxW) line += tok;
      else { out.push(line.trimEnd()); const t = /^\s+$/.test(tok) ? "" : tok; line = W(t) <= maxW ? t : brk(t); }
    }
    out.push(line.trimEnd());
  }
  return out;
}
function layoutText(o) {
  const txt = clean(o.text || "");
  if (o.mode === "line") {
    const one = txt.replace(/\n/g, " ");
    let size = o.size;
    const w = TW(one, size);
    if (w > o.box.w && w > 0) size = Math.max(4, size * o.box.w / w);
    const base = o.lineY - Math.max(1.3, size * 0.2);
    return { size, lh: size * 1.2, lines: [{ t: one, x: o.box.l, base }] };
  }
  if (o.mode === "cell") {
    const b = o.box, inset = Math.min(2.5, b.w * 0.06), aw = b.w - 2 * inset, ah = b.h - 2;
    let size = o.size, lines = [txt];
    for (; size >= 4; size -= 0.5) {
      lines = wrapText(txt, size, aw);
      if (lines.length * size * 1.15 <= ah && lines.every((l) => TW(l, size) <= aw + 0.5)) break;
    }
    size = Math.max(4, size);
    const lh = size * 1.15;
    let res;
    if (lines.length === 1 && b.h <= 3 * lh) res = [{ t: lines[0], x: b.l + inset, base: b.t + b.h / 2 + size * 0.35 }];
    else res = lines.map((t, i) => ({ t, x: b.l + inset, base: b.t + 1 + size * 0.92 + i * lh }));
    return { size, lh, lines: res };
  }
  const p = pages[o.page - 1];
  const size = o.size, lh = size * 1.2;
  const maxW = o.maxW || Math.max(40, (p ? p.w : 595) - o.x - 8);
  return { size, lh, lines: wrapText(txt, size, maxW).map((t, i) => ({ t, x: o.x, base: o.base + i * lh })) };
}
const ASC = 0.82; // Oberkante der Zeile relativ zur Grundlinie (CSS line-height:1)

/* ---------- Objekte darstellen ---------- */
function findObj(id) { return objects.find((o) => o.id === id); }
function renderObjs(p) {
  p.objs.querySelectorAll(".txt, .chk, .obj").forEach((e) => e.remove());
  for (const o of objects) if (o.page === p.num) {
    if (o.type === "text") p.objs.appendChild(makeTextEl(o, p));
    else if (o.type === "check") p.objs.appendChild(makeCheckEl(o));
    else if (o.type === "sig") p.objs.appendChild(makeSigEl(o, p));
  }
  if (p.detected) renderHints(p);
}
function renderAll() { for (const p of pages) { renderInk(p); renderObjs(p); } }
const pt = (v) => `calc(var(--s) * ${v.toFixed(2)}px)`;
function makeTextEl(o, p) {
  const el = document.createElement("div");
  el.className = "txt"; el.dataset.id = o.id;
  fillTextEl(el, o);
  let down = null, moved = false, lp = null;
  el.addEventListener("pointerdown", (e) => {
    if (tool !== "write") return;
    if (!e.target.classList.contains("ln")) return;
    e.stopPropagation();
    down = { x: e.clientX, y: e.clientY, id: e.pointerId }; moved = false;
    try { el.setPointerCapture(e.pointerId); } catch (er) {}
    lp = setTimeout(() => el.classList.add("lift"), 450);
  });
  el.addEventListener("pointermove", (e) => {
    if (!down || e.pointerId !== down.id) return;
    const dx = e.clientX - down.x, dy = e.clientY - down.y;
    if (!moved && Math.hypot(dx, dy) < (e.pointerType === "touch" ? 8 : 4)) return;
    if (!moved) {
      moved = true; clearTimeout(lp); el.classList.add("lift");
      const L = layoutText(o), f = L.lines[0];
      down.o0 = { x: f.x, base: f.base, size: L.size };
      down.k = p.w / p.el.getBoundingClientRect().width;
    }
    o.mode = "free"; delete o.targetId; delete o.box; delete o.lineY; delete o.maxW;
    o.size = down.o0.size; o.x = down.o0.x + dx * down.k; o.base = down.o0.base + dy * down.k;
    fillTextEl(el, o);
  });
  const end = (e) => {
    if (!down || e.pointerId !== down.id) return;
    clearTimeout(lp); el.classList.remove("lift");
    const wasMoved = moved; down = null;
    if (wasMoved) { commit(); renderHints(p); el._suppress = true; setTimeout(() => { el._suppress = false; }, 350); }
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    if (tool !== "write" || el._suppress) return;
    startEdit(o, p);
  });
  return el;
}
function fillTextEl(el, o) {
  const L = layoutText(o);
  el.innerHTML = "";
  for (const ln of L.lines) {
    const s = document.createElement("span"); s.className = "ln";
    s.textContent = ln.t || "\u200b";
    s.style.left = pt(ln.x); s.style.top = pt(ln.base - ASC * L.size);
    s.style.fontSize = pt(L.size); s.style.color = solidColor(o.color); s.style.webkitTextFillColor = solidColor(o.color);
    el.appendChild(s);
  }
}
function makeCheckEl(o) {
  const el = document.createElement("div");
  el.className = "chk"; el.dataset.id = o.id;
  el.style.left = pt(o.box.l); el.style.top = pt(o.box.t); el.style.width = pt(o.box.w); el.style.height = pt(o.box.h);
  el.innerHTML = o.mark === "v"
    ? `<svg viewBox="0 0 100 100"><polyline points="18,52 42,76 84,22" fill="none" stroke="${solidColor(o.color)}" stroke-width="12" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    : `<svg viewBox="0 0 100 100"><path d="M20 20 L80 80 M80 20 L20 80" fill="none" stroke="${solidColor(o.color)}" stroke-width="12" stroke-linecap="round"/></svg>`;
  return el;
}

/* ---------- Hinweise auf erkannte Stellen ---------- */
function renderHints(p) {
  p.hints.innerHTML = "";
  if (!settings.hints) return;
  const used = new Set(objects.filter((o) => o.page === p.num && o.targetId).map((o) => o.targetId));
  const pts = [];
  for (const o of objects) if (o.page === p.num) {
    if (o.type === "text" && o.text && o.text.trim()) for (const ln of layoutText(o).lines) pts.push([ln.x + 2, ln.base - 2]);
    else if (o.type === "sig") pts.push([o.x + o.w / 2, o.y + o.h * 0.8]);
  }
  for (const t of p.targets) {
    if (used.has(t.id)) continue;
    const tb = t.box, bottom = t.kind === "line" ? t.lineY + 3 : tb.t + tb.h;
    if (pts.some(([x, y]) => x >= tb.l - 3 && x <= tb.l + tb.w && y >= tb.t - 3 && y <= bottom)) continue;
    const d = document.createElement("div");
    d.className = "hint " + t.kind + (t.sig ? " sig" : "") + (t.date ? " date" : "");
    const b = t.box;
    if (t.kind === "line") {
      const hh = Math.min(b.h, 13);
      d.style.left = pt(b.l); d.style.top = pt(t.lineY - hh); d.style.width = pt(b.w); d.style.height = pt(hh);
    } else {
      d.style.left = pt(b.l + 0.8); d.style.top = pt(b.t + 0.8); d.style.width = pt(Math.max(1, b.w - 1.6)); d.style.height = pt(Math.max(1, b.h - 1.6));
    }
    if (t.sig) d.dataset.ic = "✍️"; else if (t.date) d.dataset.ic = "📅";
    p.hints.appendChild(d);
  }
}

/* ---------- Antippen im Schreib-Modus ---------- */
let lastFinish = 0;
function hitTarget(p, x, y) {
  let best = null, bestA = Infinity;
  for (const t of p.targets) {
    const b = t.box, pad = t.kind === "check" ? 5 : 3;
    const bottom = t.kind === "line" ? t.lineY + 6 : b.t + b.h + pad;
    if (x >= b.l - pad && x <= b.l + b.w + pad && y >= b.t - pad && y <= bottom) {
      const a = b.w * b.h; if (a < bestA) { bestA = a; best = t; }
    }
  }
  return best;
}
function attachTap(p) {
  p.tap.addEventListener("click", (e) => {
    if (tool !== "write") return;
    const r = p.el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width * p.w, y = (e.clientY - r.top) / r.height * p.h;
    finishEdit();
    if (selectedId) { select(null); return; }
    closePop();
    const t = p.detected ? hitTarget(p, x, y) : null;
    if (t) { activateTarget(p, t); return; }
    const fs = settings.text.size || 11;
    const o = { id: uid(), type: "text", page: p.num, mode: "free", x, base: y + fs * 0.35, size: fs, color: settings.text.color, text: "" };
    objects.push(o);
    const el = makeTextEl(o, p); p.objs.appendChild(el);
    startEdit(o, p);
  });
}
function nearestTextSize(p, x, y) {
  let best = null, bd = 80;
  for (const w of (p.words || [])) { const d = Math.abs(w.base - y) + Math.max(0, w.x0 - x, x - w.x1) * 0.3; if (d < bd) { bd = d; best = w; } }
  return best ? clamp(Math.round(best.size * 2) / 2, 8, 14) : 0;
}
function activateTarget(p, t) {
  if (t.kind === "check") {
    const ex = objects.find((o) => o.type === "check" && o.targetId === t.id);
    if (ex) { objects = objects.filter((o) => o !== ex); }
    else objects.push({ id: uid(), type: "check", page: p.num, targetId: t.id, box: { ...t.box }, mark: settings.check, color: settings.text.color });
    renderObjs(p); commit();
    return;
  }
  if (t.sig) { openSigChooser({ page: p.num, box: sigBoxFor(t), align: "left", targetId: t.id }); return; }
  let o = objects.find((x) => x.type === "text" && x.targetId === t.id);
  if (!o) {
    o = { id: uid(), type: "text", page: p.num, mode: t.kind, targetId: t.id, box: { ...t.box }, lineY: t.lineY, size: t.size || settings.text.size, color: settings.text.color, text: "" };
    objects.push(o);
    p.objs.appendChild(makeTextEl(o, p));
  }
  startEdit(o, p, t);
}
function sigBoxFor(t) {
  if (t.kind === "line") {
    const h = clamp(t.box.h * 1.6, 22, 46);
    return { l: t.box.l, t: t.lineY - h * 0.85, w: t.box.w, h };
  }
  return t.box;
}

/* ---------- Text-Editor (ein Cursor, keine Kästen) ---------- */
let editing = null;
function startEdit(o, p, target) {
  finishEdit();
  closePop();
  const el = p.objs.querySelector(`.txt[data-id="${o.id}"]`);
  if (el) el.style.visibility = "hidden";
  const ta = document.createElement("textarea");
  ta.className = "editor"; ta.value = o.text; ta.spellcheck = true;
  ta.setAttribute("autocapitalize", "sentences"); ta.setAttribute("autocomplete", "off");
  if (o.mode === "line") { ta.setAttribute("wrap", "off"); ta.enterKeyHint = "next"; }
  else ta.enterKeyHint = o.mode === "free" ? "enter" : "done";
  ta.style.color = solidColor(o.color); ta.style.webkitTextFillColor = solidColor(o.color);
  p.objs.appendChild(ta);
  const t = target || (o.targetId ? p.targets.find((x) => x.id === o.targetId) : null);
  let chips = null;
  if (t && (t.date || t.sigAlso)) {
    chips = document.createElement("div"); chips.className = "chips";
    if (t.date) {
      const today = new Date().toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
      const c = document.createElement("button"); c.textContent = "📅 Heute: " + today;
      c.addEventListener("pointerdown", (e) => e.preventDefault());
      c.addEventListener("click", (e) => { e.stopPropagation(); ta.value = (ta.value.trim() ? ta.value.trim() + ", " : "") + today; onInput(); finishEdit(); });
      chips.appendChild(c);
    }
    if (t.sigAlso) {
      const c = document.createElement("button"); c.textContent = "✍️ Unterschrift";
      c.addEventListener("pointerdown", (e) => e.preventDefault());
      c.addEventListener("click", (e) => { e.stopPropagation(); finishEdit(); openSigChooser({ page: p.num, box: sigBoxFor(t), align: "left" }); });
      chips.appendChild(c);
    }
    p.objs.appendChild(chips);
  }
  editing = { o, p, ta, el, chips, before: o.text };
  const place = () => {
    const L = layoutText({ ...o, text: o.text || "M" });
    const sz = o.text ? L.size : L.size;
    ta.style.fontSize = pt(sz);
    if (o.mode === "line") {
      ta.style.left = pt(o.box.l - 1); ta.style.width = pt(o.box.w + 2);
      ta.style.top = pt(L.lines[0].base - ASC * sz - sz * 0.1); ta.style.height = pt(sz * 1.25);
      ta.style.lineHeight = pt(sz * 1.05);
    } else if (o.mode === "cell") {
      const inset = Math.min(2.5, o.box.w * 0.06);
      const top = L.lines[0].base - ASC * sz - sz * 0.05;
      ta.style.left = pt(o.box.l + inset - 1); ta.style.width = pt(o.box.w - 2 * inset + 2);
      ta.style.top = pt(top); ta.style.height = pt(Math.max(sz * 1.2, o.box.t + o.box.h - top));
      ta.style.lineHeight = pt(L.lh);
    } else {
      const lines = Math.max(1, L.lines.length);
      const wMax = (o.maxW || Math.max(40, p.w - o.x - 8));
      const wNow = Math.max(...L.lines.map((l) => TW(l.t, sz)), 0);
      ta.style.left = pt(o.x - 1); ta.style.width = pt(Math.min(wMax, wNow + sz * 3) + 2);
      ta.style.top = pt(o.base - ASC * sz - sz * 0.1); ta.style.height = pt(lines * L.lh + sz * 0.3);
      ta.style.lineHeight = pt(L.lh);
    }
    if (chips) { chips.style.left = pt(o.mode === "free" ? o.x : o.box.l); chips.style.top = `calc(${ta.style.top} - 40px)`; }
  };
  const onInput = () => { o.text = ta.value; place(); };
  editing.place = place;
  ta.addEventListener("input", onInput);
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { e.preventDefault(); finishEdit(); }
    else if ((e.key === "Enter" && o.mode === "line") || e.key === "Tab") {
      e.preventDefault();
      const nxt = nextTarget(p, o);
      finishEdit();
      if (nxt) activateTarget(nxt.p, nxt.t);
    }
  });
  ta.addEventListener("blur", () => { if (editing && editing.ta === ta) setTimeout(() => { if (editing && editing.ta === ta && document.activeElement !== ta) finishEdit(); }, 0); });
  place();
  ensureVisible(p, o.mode === "free" ? o.x : o.box.l, o.mode === "line" ? o.lineY : o.mode === "cell" ? o.box.t : o.base);
  ta.focus({ preventScroll: true });
  try { const n = ta.value.length; ta.setSelectionRange(n, n); } catch (e) {}
  refreshPop();
}
function ensureVisible(p, x, y) {
  const phone = viewer.clientWidth < 768;
  if (phone && scale() < 1.1) setZoom(1.15 / baseScale);
  const r = p.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect(), k = r.width / p.w;
  const sx = r.left + x * k, sy = r.top + y * k;
  if (phone ? (sy < vr.top + vr.height * 0.12 || sy > vr.top + vr.height * 0.42) : (sy < vr.top + 40 || sy > vr.bottom - 60))
    viewer.scrollTop += sy - (vr.top + vr.height * (phone ? 0.28 : 0.4));
  if (sx < vr.left + 60 || sx > vr.right - 100) viewer.scrollLeft += sx - (vr.left + Math.min(80, vr.width * 0.2));
}
function finishEdit(silent) {
  if (!editing) return;
  const { o, p, ta, el, chips, before } = editing;
  editing = null; lastFinish = Date.now();
  o.text = ta.value;
  ta.remove(); if (chips) chips.remove();
  if (silent) return;
  if (!o.text.trim()) {
    objects = objects.filter((x) => x !== o);
    if (el) el.remove();
  } else if (el) { el.style.visibility = ""; fillTextEl(el, o); }
  renderHints(p);
  if (o.text !== before || !o.text.trim()) commit();
  refreshPop();
}
function nextTarget(p, o) {
  const used = new Set(objects.filter((x) => x.targetId && x !== o && (x.text || x.type !== "text")).map((x) => x.targetId));
  for (let k = p.num - 1; k < pages.length; k++) {
    const pg = pages[k];
    const list = pg.targets.filter((t) => t.kind !== "check" && !t.sig);
    let start = 0;
    if (k === p.num - 1 && o.targetId) start = list.findIndex((t) => t.id === o.targetId) + 1;
    for (let i = start; i < list.length; i++) if (!used.has(list[i].id)) return { p: pg, t: list[i] };
    if (!pg.detected) return null;
  }
  return null;
}

/* ---------- Unterschrift-Objekte ---------- */
function makeSigEl(o, p) {
  const el = document.createElement("div");
  el.className = "obj sig" + (o.id === selectedId ? " sel" : "");
  el.dataset.id = o.id;
  posSig(el, o);
  const img = document.createElement("img"); img.src = o.data; img.alt = "Unterschrift"; img.draggable = false;
  el.appendChild(img);
  el.addEventListener("pointerdown", (e) => { if (tool === "write" && (e.target === el || e.target === img)) startDrag(e, o, p, el, "move"); });
  const del = handle("del", "✕"); el.appendChild(del);
  del.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteObj(o.id); });
  const rs = handle("rs", "⤡"); el.appendChild(rs);
  rs.addEventListener("pointerdown", (e) => startDrag(e, o, p, el, "resize"));
  return el;
}
function posSig(el, o) { el.style.left = pt(o.x); el.style.top = pt(o.y); el.style.width = pt(o.w); el.style.height = pt(o.h); }
function handle(cls, txt) { const b = document.createElement("button"); b.className = "h " + cls; b.textContent = txt; b.tabIndex = -1; return b; }
function startDrag(e, o, p, el, mode) {
  e.preventDefault(); e.stopPropagation();
  finishEdit();
  select(o.id);
  const t = e.currentTarget;
  try { t.setPointerCapture(e.pointerId); } catch (er) {}
  const s0 = { x: o.x, y: o.y, w: o.w, h: o.h, cx: e.clientX, cy: e.clientY };
  const r = p.el.getBoundingClientRect(), k = p.w / r.width;
  let moved = false;
  const mv = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    const dx = (ev.clientX - s0.cx) * k, dy = (ev.clientY - s0.cy) * k;
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = true;
    if (mode === "move") {
      o.x = clamp(s0.x + dx, -o.w * 0.8, p.w - o.w * 0.2);
      o.y = clamp(s0.y + dy, -o.h * 0.8, p.h - 10);
    } else {
      const ar = s0.w / s0.h;
      o.w = clamp(s0.w + dx, 20, p.w * 1.2); o.h = o.w / ar;
    }
    posSig(el, o);
  };
  const end = (ev) => {
    if (ev.pointerId !== e.pointerId) return;
    t.removeEventListener("pointermove", mv); t.removeEventListener("pointerup", end); t.removeEventListener("pointercancel", end);
    if (moved) commit();
  };
  t.addEventListener("pointermove", mv); t.addEventListener("pointerup", end); t.addEventListener("pointercancel", end);
}
function select(id) {
  selectedId = id;
  for (const el of pagesEl.querySelectorAll(".obj")) el.classList.toggle("sel", el.dataset.id === id);
}
function deleteObj(id) {
  const o = findObj(id); if (!o) return;
  objects = objects.filter((x) => x !== o);
  if (selectedId === id) selectedId = null;
  renderObjs(pages[o.page - 1]); commit();
}

/* ---------- Verlauf ---------- */
function commit() {
  const snap = JSON.stringify(objects);
  if (snap === hist[hIndex]) { scheduleSave(); return; }
  hist = hist.slice(0, hIndex + 1); hist.push(snap);
  if (hist.length > 150) hist.shift();
  hIndex = hist.length - 1; updateUndo(); scheduleSave();
}
function undo() { finishEdit(); if (hIndex > 0) { hIndex--; objects = JSON.parse(hist[hIndex]); selectedId = null; renderAll(); updateUndo(); scheduleSave(); } }
function redo() { finishEdit(); if (hIndex < hist.length - 1) { hIndex++; objects = JSON.parse(hist[hIndex]); selectedId = null; renderAll(); updateUndo(); scheduleSave(); } }
function updateUndo() { $("#btnUndo").disabled = !(hIndex > 0); }
$("#btnUndo").onclick = undo;
document.addEventListener("keydown", (e) => {
  const inField = e.target.closest && e.target.closest("input, textarea, select");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !inField) { e.preventDefault(); deleteObj(selectedId); }
  else if (e.key === "Escape") { closePop(); select(null); }
});
viewer.addEventListener("pointerdown", (e) => {
  if (selectedId && !e.target.closest(".obj")) select(null);
});

/* ---------- Werkzeugleiste + Popover ---------- */
function setTool(t) {
  if (t !== "write") finishEdit();
  tool = t; cancelStroke();
  if (t === "pen" || t === "marker" || t === "eraser") penKind = t;
  document.body.classList.toggle("m-write", t === "write");
  document.body.classList.toggle("m-pen", t !== "write");
  $("#bWrite").classList.toggle("on", t === "write");
  $("#bPen").classList.toggle("on", t !== "write");
  $("#bPen .ic").textContent = t === "marker" ? "🖍️" : t === "eraser" ? "🧽" : "✏️";
  $("#bPen .lb").textContent = t === "marker" ? "Marker" : t === "eraser" ? "Radierer" : "Stift";
  if (t !== "write") select(null);
  refreshPop();
}
const pop = $("#pop");
let popKind = null;
function closePop() { popKind = null; pop.classList.remove("open"); }
function openPop(kind, anchor) {
  popKind = kind; refreshPop();
  pop.classList.add("open");
  const r = anchor.getBoundingClientRect(), pr = pop.getBoundingClientRect();
  const left = clamp(r.left + r.width / 2 - pr.width / 2, 8, window.innerWidth - pr.width - 8);
  pop.style.left = left + "px";
  if (r.top > window.innerHeight / 2) { pop.style.top = ""; pop.style.bottom = (window.innerHeight - r.top + 8) + "px"; }
  else { pop.style.bottom = ""; pop.style.top = (r.bottom + 8) + "px"; }
}
$("#bWrite").onclick = (e) => {
  if (tool === "write") { popKind === "write" ? closePop() : openPop("write", e.currentTarget); }
  else { setTool("write"); closePop(); }
};
$("#bPen").onclick = (e) => {
  if (tool !== "write") { popKind === "pen" ? closePop() : openPop("pen", e.currentTarget); }
  else { setTool(penKind); closePop(); }
};
document.addEventListener("pointerdown", (e) => {
  if (popKind && !e.target.closest("#pop") && !e.target.closest("#bWrite") && !e.target.closest("#bPen")) closePop();
});
function refreshPop() {
  if (!popKind) return;
  pop.innerHTML = "";
  const row = (title) => { const r = document.createElement("div"); r.className = "prow"; if (title) { const h = document.createElement("div"); h.className = "pt"; h.textContent = title; pop.appendChild(h); } pop.appendChild(r); return r; };
  const btn = (parent, cls, html, on, fn) => {
    const b = document.createElement("button"); b.className = cls + (on ? " on" : ""); b.innerHTML = html;
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", (e) => { e.stopPropagation(); fn(); refreshPop(); });
    parent.appendChild(b); return b;
  };
  if (popKind === "pen") {
    const r0 = row();
    btn(r0, "seg", "✏️ Stift", tool === "pen", () => setTool("pen"));
    btn(r0, "seg", "🖍️ Marker", tool === "marker", () => setTool("marker"));
    btn(r0, "seg", "🧽 Radierer", tool === "eraser", () => setTool("eraser"));
    if (tool === "eraser") { const r = row(); r.innerHTML = '<span class="pnote">Über einen Strich wischen, um ihn zu löschen.</span>'; return; }
    const st = settings[tool];
    const r1 = row("Farbe");
    for (const c of (tool === "marker" ? MK_COLORS : PEN_COLORS)) btn(r1, "sw", "", st.color === c, () => { st.color = c; saveSettings(); }).style.background = c;
    const r2 = row("Stärke");
    for (const w of (tool === "marker" ? [8, 14, 22] : [1, 2, 4, 7])) {
      const b = btn(r2, "wd", "<i></i>", st.width === w, () => { st.width = w; saveSettings(); });
      const i = b.querySelector("i"); i.style.height = Math.max(2, Math.min(16, tool === "marker" ? w * 0.7 : w * 1.6)) + "px";
      if (tool === "marker") { i.style.background = st.color; i.style.opacity = 0.8; }
    }
  } else {
    const o = editing ? editing.o : null;
    const r1 = row(o ? "Farbe dieses Texts" : "Textfarbe");
    for (const c of PEN_COLORS) btn(r1, "sw", "", (o ? o.color : settings.text.color) === c, () => {
      settings.text.color = c; saveSettings();
      if (o) { o.color = c; editing.ta.style.color = c; editing.ta.style.webkitTextFillColor = c; }
    }).style.background = c;
    const r2 = row(o ? "Größe dieses Texts" : "Schriftgröße (frei platzierter Text)");
    const cur = o ? o.size : settings.text.size;
    btn(r2, "pill", "A−", false, () => { const v = Math.max(5, cur - 1); if (o) { o.size = v; editing.place(); } else settings.text.size = v; saveSettings(); });
    const l = document.createElement("span"); l.className = "pnote"; l.textContent = (Math.round(cur * 10) / 10) + " pt"; r2.appendChild(l);
    btn(r2, "pill", "A+", false, () => { const v = Math.min(48, cur + 1); if (o) { o.size = v; editing.place(); } else settings.text.size = v; saveSettings(); });
    const r3 = row("Kästchen ankreuzen mit");
    btn(r3, "pill", "✗", settings.check === "x", () => { settings.check = "x"; saveSettings(); });
    btn(r3, "pill", "✓", settings.check === "v", () => { settings.check = "v"; saveSettings(); });
    const r4 = row();
    btn(r4, "pill wide", (settings.hints ? "☑" : "☐") + " Erkannte Stellen anzeigen", settings.hints, () => { settings.hints = !settings.hints; saveSettings(); for (const p of pages) renderHints(p); });
  }
}

/* ---------- signatures ---------- */
const SIG_KEY = "pdfeditor.signatures";
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || "[]"); } catch (e) { return []; } };
const storeSigs = (a) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(a)); return true; } catch (e) { toast("Unterschrift konnte nicht gespeichert werden"); return false; } };
let sigTarget = null;
function openDlg(id) { $(id).classList.add("open"); }
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => b.closest(".dlg").classList.remove("open");
$("#bSig").onclick = () => {
  if (!pdfBytes) { toast("Bitte zuerst eine PDF öffnen"); return; }
  finishEdit(); closePop();
  // Erkannte Unterschriftszeile auf der aktuellen Seite bevorzugen
  const p = currentPage();
  const used = new Set(objects.filter((o) => o.targetId).map((o) => o.targetId));
  const t = p && p.targets.find((x) => x.sig && !used.has(x.id));
  openSigChooser(t ? { page: p.num, box: sigBoxFor(t), align: "left", targetId: t.id } : null);
};
function openSigChooser(target) {
  sigTarget = target;
  const sigs = loadSigs();
  if (!sigs.length) { openPad(); return; }
  const list = $("#siglist"); list.innerHTML = "";
  for (const s of sigs) {
    const it = document.createElement("div"); it.className = "sigitem";
    const img = document.createElement("img"); img.src = s.data; it.appendChild(img);
    const rm = document.createElement("button"); rm.className = "rm"; rm.textContent = "🗑"; rm.title = "Löschen";
    rm.onclick = (e) => { e.stopPropagation(); if (confirm("Diese gespeicherte Unterschrift löschen?")) { storeSigs(loadSigs().filter((x) => x.id !== s.id)); $("#dlgChoose").classList.remove("open"); if (loadSigs().length) openSigChooser(sigTarget); } };
    it.appendChild(rm);
    it.onclick = () => { $("#dlgChoose").classList.remove("open"); placeSignature(s.data, sigTarget); };
    list.appendChild(it);
  }
  const nw = document.createElement("div"); nw.className = "sigitem new"; nw.textContent = "+ Neue Unterschrift";
  nw.onclick = () => { $("#dlgChoose").classList.remove("open"); openPad(); };
  list.appendChild(nw);
  openDlg("#dlgChoose");
}
const pad = $("#pad"); let padStrokes = [], padCur = null, padColor = "#111827";
function openPad() { padStrokes = []; openDlg("#dlgPad"); requestAnimationFrame(sizePad); }
function sizePad() {
  const r = pad.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
  pad.width = Math.round(r.width * dpr); pad.height = Math.round(r.height * dpr);
  drawPad();
}
function drawPad() {
  const ctx = pad.getContext("2d"), dpr = window.devicePixelRatio || 1;
  ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, pad.width, pad.height);
  ctx.fillStyle = "#ffffff"; ctx.fillRect(0, 0, pad.width, pad.height); // weißer Grund im Bild selbst (auch bei Dunkelmodus)
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  strokeAll(ctx, padStrokes, 2.6, padColor);
  $("#padph").style.display = padStrokes.length ? "none" : "flex";
}
function strokeAll(ctx, strokes, lw, color) {
  ctx.lineCap = "round"; ctx.lineJoin = "round"; ctx.strokeStyle = color; ctx.fillStyle = color;
  for (const s of strokes) {
    ctx.lineWidth = lw;
    if (s.length === 1) { ctx.beginPath(); ctx.arc(s[0][0], s[0][1], lw / 2, 0, Math.PI * 2); ctx.fill(); continue; }
    ctx.beginPath(); ctx.moveTo(s[0][0], s[0][1]);
    for (let i = 1; i < s.length - 1; i++) ctx.quadraticCurveTo(s[i][0], s[i][1], (s[i][0] + s[i + 1][0]) / 2, (s[i][1] + s[i + 1][1]) / 2);
    const L = s[s.length - 1]; ctx.lineTo(L[0], L[1]); ctx.stroke();
  }
}
const padPt = (e) => { const r = pad.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
pad.addEventListener("pointerdown", (e) => { e.preventDefault(); try { pad.setPointerCapture(e.pointerId); } catch (er) {} padCur = { id: e.pointerId, s: [padPt(e)] }; padStrokes.push(padCur.s); drawPad(); });
pad.addEventListener("pointermove", (e) => {
  if (!padCur || padCur.id !== e.pointerId) return;
  let evs = e.getCoalescedEvents ? e.getCoalescedEvents() : []; if (!evs.length) evs = [e];
  for (const ev of evs) padCur.s.push(padPt(ev));
  drawPad();
});
pad.addEventListener("pointerup", () => { padCur = null; });
pad.addEventListener("pointercancel", () => { padCur = null; });
$("#padClear").onclick = () => { padStrokes = []; drawPad(); };
for (const b of document.querySelectorAll("[data-pc]")) b.onclick = () => {
  padColor = b.dataset.pc; for (const x of document.querySelectorAll("[data-pc]")) x.classList.toggle("on", x === b); drawPad();
};
window.addEventListener("resize", () => { if ($("#dlgPad").classList.contains("open")) sizePad(); });
$("#padSave").onclick = () => {
  if (!padStrokes.length) { toast("Bitte zuerst unterschreiben"); return; }
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const s of padStrokes) for (const [x, y] of s) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const k = 3, m = 4;
  const c = document.createElement("canvas");
  c.width = Math.ceil((x1 - x0 + 2 * m) * k); c.height = Math.ceil((y1 - y0 + 2 * m) * k);
  const ctx = c.getContext("2d"); ctx.setTransform(k, 0, 0, k, (m - x0) * k, (m - y0) * k);
  strokeAll(ctx, padStrokes, 2.6, padColor);
  const data = c.toDataURL("image/png");
  const sigs = loadSigs(); sigs.unshift({ id: uid(), data });
  storeSigs(sigs.slice(0, 6));
  $("#dlgPad").classList.remove("open");
  placeSignature(data, sigTarget);
};
function placeSignature(data, target) {
  const img = new Image();
  img.onload = () => {
    const ar = img.naturalWidth / img.naturalHeight || 3;
    let p, o;
    if (target) {
      p = pages[target.page - 1];
      const b = target.box; let w = b.w * 0.95, h = w / ar;
      if (h > b.h * 0.95) { h = b.h * 0.95; w = h * ar; }
      o = target.align === "left" ? { x: b.l + Math.min(6, b.w * 0.05), y: b.t + (b.h - h), w, h } : { x: b.l + (b.w - w) / 2, y: b.t + (b.h - h) / 2, w, h };
      if (target.targetId) o.targetId = target.targetId;
    } else {
      p = currentPage();
      const r = p.el.getBoundingClientRect(), vr = viewer.getBoundingClientRect();
      const cx = ((Math.max(r.left, vr.left) + Math.min(r.right, vr.right)) / 2 - r.left) / r.width * p.w;
      const cy = ((Math.max(r.top, vr.top) + Math.min(r.bottom, vr.bottom)) / 2 - r.top) / r.height * p.h;
      const w = Math.min(160, p.w * 0.4), h = w / ar;
      o = { x: clamp(cx - w / 2, 0, p.w - w), y: clamp(cy - h / 2, 0, p.h - h), w, h };
    }
    Object.assign(o, { id: uid(), type: "sig", page: p.num, data });
    objects.push(o);
    setTool("write");
    p.objs.appendChild(makeSigEl(o, p));
    renderHints(p);
    select(o.id); commit();
    toast("Unterschrift eingefügt – ziehen zum Verschieben", 2200);
  };
  img.src = data;
}

/* ---------- export ---------- */
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
async function buildExport() {
  const out = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const font = await out.embedFont(StandardFonts.Helvetica);
  let form = null;
  try { form = out.getForm(); } catch (e) { console.warn(e); }
  if (form) for (const n of Object.keys(formValues)) {
    const v = formValues[n];
    if (v === formInitial[n]) continue;
    let f; try { f = form.getField(n); } catch (e) { continue; }
    try {
      if (f instanceof PDFTextField) {
        // Auto-Schriftgröße (0 Tf) bei mehrzeiligen Feldern wird in pdf-lib riesig – Größe wie in der App setzen
        try {
          if (fieldFs[n] && (f.isMultiline() || fieldFs[n] < 30)) {
            const size = Math.max(4, Math.round(fieldFs[n]));
            f.setFontSize(size);
            for (const w of f.acroField.getWidgets()) { const da = w.getDefaultAppearance(); if (da) w.setDefaultAppearance(da.replace(/([\d.]+)\s+Tf/, size + " Tf")); }
          }
        } catch (e) { console.warn("Schriftgröße", n, e); }
        f.setText(clean(v) || undefined);
      }
      else if (f instanceof PDFCheckBox) { v && v !== "Off" ? f.check() : f.uncheck(); }
      else if (f instanceof PDFRadioGroup) {
        if (v === "Off") f.clear();
        else {
          const optsR = f.getOptions();
          let opt = optsR.includes(v) ? v : null;
          if (!opt) {
            const ws = f.acroField.getWidgets();
            const i = ws.findIndex((w) => { try { const on = w.getOnValue(); return on && on.decodeText() === v; } catch (e) { return false; } });
            if (i >= 0 && optsR[i] != null) opt = optsR[i];
          }
          f.select(opt != null ? opt : v);
        }
      }
      else if (f instanceof PDFDropdown || f instanceof PDFOptionList) {
        if (!v) f.clear();
        else {
          try { f.select(v); }
          catch (e) {
            const a = pages.flatMap((p) => p.widgets).find((w) => w.fieldName === n);
            const o = a && (a.options || []).find((x) => x.exportValue === v);
            if (o && o.displayValue) f.select(o.displayValue); else throw e;
          }
        }
      }
    } catch (e) { console.warn("Feld", n, e); }
  }
  const pdfPages = out.getPages();
  const imgs = new Map();
  for (const o of objects) {
    const p = pages[o.page - 1], pg = pdfPages[o.page - 1];
    if (!p || !pg) continue;
    const conv = (x, y) => p.vp1.convertToPdfPoint(x, y);
    const ang = (x, y) => { const [a, b] = conv(x, y), [c, d] = conv(x + 10, y); return Math.atan2(d - b, c - a) * 180 / Math.PI; };
    if (o.type === "stroke") {
      const d = pathD(o.points, ([x, y]) => { const [a, b] = conv(x, y); return [a, -b]; });
      const opt = { x: 0, y: 0, borderColor: hexRgb(o.color), borderWidth: o.width, borderLineCap: LineCapStyle.Round };
      if (o.kind === "marker") { opt.borderOpacity = o.opacity; opt.blendMode = BlendMode.Multiply; }
      pg.drawSvgPath(d, opt);
    } else if (o.type === "text") {
      if (!o.text || !o.text.trim()) continue;
      const L = layoutText(o), color = hexRgb(solidColor(o.color));
      for (const ln of L.lines) {
        if (!ln.t) continue;
        const [x, y] = conv(ln.x, ln.base);
        pg.drawText(ln.t, { x, y, size: L.size, font, color, rotate: degrees(ang(ln.x, ln.base)) });
      }
    } else if (o.type === "check") {
      const b = o.box, ins = Math.min(b.w, b.h) * 0.2, lw = Math.max(0.8, Math.min(b.w, b.h) * 0.12), color = hexRgb(solidColor(o.color));
      const P = (fx, fy) => { const [x, y] = conv(b.l + b.w * fx, b.t + b.h * fy); return { x, y }; };
      const segs = o.mark === "v" ? [[P(0.18, 0.52), P(0.42, 0.76)], [P(0.42, 0.76), P(0.84, 0.22)]] : [[P(0.2, 0.2), P(0.8, 0.8)], [P(0.8, 0.2), P(0.2, 0.8)]];
      for (const [a, c] of segs) pg.drawLine({ start: a, end: c, thickness: lw, color, lineCap: LineCapStyle.Round });
    } else if (o.type === "sig") {
      let img = imgs.get(o.data);
      if (!img) { img = await out.embedPng(o.data); imgs.set(o.data, img); }
      const [x, y] = conv(o.x, o.y + o.h);
      pg.drawImage(img, { x, y, width: o.w, height: o.h, rotate: degrees(ang(o.x, o.y + o.h)) });
    }
  }
  try { return await out.save(); }
  catch (e) { console.warn("save mit Feld-Darstellung fehlgeschlagen", e); return await out.save({ updateFieldAppearances: false }); }
}
function outName() { return (fileName || "Dokument.pdf").replace(/\.pdf$/i, "") + "_bearbeitet.pdf"; }
const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
let readyFile = null;
function download(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement("a"); a.href = url; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  toast("PDF gespeichert: " + file.name + (isMobile ? "" : " (Downloads)"), 3500);
}
async function share(file) {
  // Nur die Datei teilen – kein title/text, sonst zeigt iOS „2 Objekte“ und „Sichern“ ist gesperrt
  try { await navigator.share({ files: [file] }); return true; }
  catch (e) { if (e && e.name === "AbortError") return true; if (e && e.name === "NotAllowedError") return false; console.warn(e); download(file); return true; }
}
$("#bDone").onclick = async () => {
  finishEdit(); closePop();
  if (!pdfBytes) return;
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  busy(true, "PDF wird erstellt …");
  let file;
  try {
    const bytes = await buildExport();
    file = new File([bytes], outName(), { type: "application/pdf" });
    window.__lastExport = bytes;
  } catch (e) {
    console.error(e); busy(false); alert("Export fehlgeschlagen: " + (e && e.message ? e.message : e)); return;
  }
  busy(false);
  if (isMobile && navigator.canShare && navigator.canShare({ files: [file] })) {
    const ok = await share(file);
    if (!ok) { readyFile = file; $("#readyName").textContent = file.name; openDlg("#dlgReady"); }
  } else download(file);
};
$("#readyShare").onclick = async () => {
  $("#dlgReady").classList.remove("open");
  if (readyFile) { const ok = await share(readyFile); if (!ok) download(readyFile); }
};


/* ---------- Start ---------- */
setTool("write");
(async () => {
  const saved = await idb("get", "pdf");
  if (saved && saved.bytes) {
    try {
      busy(true, "Letzte Datei wird geladen …");
      await loadPdf(new Uint8Array(saved.bytes), saved.name, await idb("get", "state"));
      toast("Letzte Bearbeitung wiederhergestellt");
    } catch (e) { console.warn(e); await idb("del", "pdf"); await idb("del", "state"); resetDoc(); document.body.classList.remove("has-doc"); }
    finally { busy(false); }
  }
})();
window.__pdfEditor = { get objects() { return objects; }, get formValues() { return formValues; }, get pages() { return pages; }, buildExport, setTool, loadPdf, layoutText };

/* ---------- service worker (network-first, auto update) ---------- */
function setupServiceWorker() {
  if (!("serviceWorker" in navigator) || location.protocol === "file:") return;
  try {
    if (sessionStorage.getItem("pdfeditor.updated") === "1") {
      sessionStorage.removeItem("pdfeditor.updated");
      setTimeout(() => toast("Neue Version geladen"), 300);
    }
  } catch (e) {}
  const refreshOnce = () => {
    try {
      if (sessionStorage.getItem("pdfeditor.swReloading") === "1") return;
      sessionStorage.setItem("pdfeditor.swReloading", "1");
      sessionStorage.setItem("pdfeditor.updated", "1");
    } catch (e) {}
    location.reload();
  };
  let hadController = !!navigator.serviceWorker.controller;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try {
      if (sessionStorage.getItem("pdfeditor.swReloading") === "1") { sessionStorage.removeItem("pdfeditor.swReloading"); return; }
    } catch (e) {}
    if (!hadController) { hadController = true; return; } // erste Installation: kein Reload nötig
    // Bearbeitung vor dem Neuladen in IndexedDB sichern
    clearTimeout(saveT);
    if (pdfBytes) idb("put", "state", { v: 3, objects, formValues }).then(refreshOnce); else refreshOnce();
  });
  const checkUpdate = (reg) => { if (reg && reg.update) reg.update().catch(() => {}); };
  navigator.serviceWorker.register("./sw.js", { scope: "./" }).then((reg) => {
    checkUpdate(reg);
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") checkUpdate(reg); });
    window.addEventListener("focus", () => checkUpdate(reg));
    if (reg.waiting) { try { reg.waiting.postMessage({ type: "SKIP_WAITING" }); } catch (e) {} }
    reg.addEventListener("updatefound", () => {
      const nw = reg.installing; if (!nw) return;
      nw.addEventListener("statechange", () => {
        if (nw.state === "installed" && navigator.serviceWorker.controller) { try { nw.postMessage({ type: "SKIP_WAITING" }); } catch (e) {} }
      });
    });
  }).catch((err) => console.warn("Service Worker nicht registriert", err));
}
setupServiceWorker();
