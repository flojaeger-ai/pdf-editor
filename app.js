import * as pdfjsLib from "./vendor/pdf.min.mjs";
pdfjsLib.GlobalWorkerOptions.workerSrc = "./vendor/pdf.worker.min.mjs";
const { PDFDocument, rgb, StandardFonts, degrees, LineCapStyle, BlendMode,
  PDFTextField, PDFCheckBox, PDFDropdown, PDFRadioGroup, PDFOptionList } = window.PDFLib;

const APP_VERSION = 1; /* Version 1 */
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
let tool = "select";
let zoom = 1, baseScale = 1;
let selectedId = null;
let hist = [], hIndex = -1;
const PEN_COLORS = ["#1d1d1f", "#1f4fbf", "#d32f2f", "#1f9d55", "#f57c00"];
const MK_COLORS = ["#ffd400", "#7ee35a", "#ff8ad1", "#6ec6ff"];
const settings = {
  pen: { color: "#1d1d1f", width: 2 },
  marker: { color: "#ffd400", width: 14 },
  text: { color: "#1d1d1f", size: 12 },
};
try { const s = JSON.parse(localStorage.getItem("pdfeditor.settings") || "{}"); for (const k of ["pen", "marker", "text"]) if (s[k]) Object.assign(settings[k], s[k]); } catch (e) {}
const saveSettings = () => { try { localStorage.setItem("pdfeditor.settings", JSON.stringify(settings)); } catch (e) {} };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const scale = () => baseScale * zoom;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function toast(msg, ms = 2400) {
  const t = $("#toast"); t.textContent = msg; t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), ms);
}
const busy = (on, text) => { $("#busytext").textContent = text || "Bitte warten …"; $("#busy").classList.toggle("open", !!on); };

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
  saveT = setTimeout(() => { if (pdfBytes) idb("put", "state", { objects, formValues }); }, 400);
}
const isDirty = () => hist.length > 1 || Object.keys(formValues).some((k) => formValues[k] !== formInitial[k]);

/* ---------- open / load ---------- */
const fileInput = $("#fileinput");
function pickFile() {
  if (pdfBytes && isDirty() && !confirm("Aktuelle Bearbeitung verwerfen und eine andere PDF öffnen?\n(Vorher exportieren, wenn du sie behalten willst.)")) return;
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
    await idb("put", "state", { objects, formValues });
  } catch (e) {
    console.error(e);
    if (e && e.name === "PasswordException") alert("Diese PDF ist passwortgeschützt und kann nicht bearbeitet werden.");
    else alert("Die Datei konnte nicht geöffnet werden.\n" + (e && e.message ? e.message : e));
  } finally { busy(false); refreshOpts(); }
};
$("#btnClose").onclick = async () => {
  if (isDirty() && !confirm("Datei schließen? Nicht exportierte Änderungen gehen verloren.")) return;
  await idb("del", "pdf"); await idb("del", "state");
  resetDoc(); document.body.classList.remove("has-doc"); $("#title").textContent = "PDF bearbeiten";
  $("#btnExport").disabled = true; $("#btnClose").disabled = true; refreshOpts();
};

function resetDoc() {
  if (io) io.disconnect();
  if (pdfDoc) { try { pdfDoc.destroy(); } catch (e) {} }
  pdfDoc = null; pdfBytes = null; pages = []; objects = []; formValues = {}; formInitial = {};
  selectedId = null; hist = []; hIndex = -1; pagesEl.innerHTML = ""; visible.clear(); updateUndo();
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
    const p = { num: i, pdfPage: pg, vp1, w: vp1.width, h: vp1.height, widgets: annots.filter((a) => a.subtype === "Widget" && !a.hidden && a.fieldName), renderedScale: 0 };
    for (const a of p.widgets) initField(a);
    pages.push(p);
  }
  if (saved) {
    objects = Array.isArray(saved.objects) ? saved.objects : [];
    if (saved.formValues) for (const k in saved.formValues) if (k in formValues) formValues[k] = saved.formValues[k];
  }
  hist = [JSON.stringify(objects)]; hIndex = 0; updateUndo();
  document.body.classList.add("has-doc");
  buildPages();
  $("#btnExport").disabled = false; $("#btnClose").disabled = false;
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
      if (en.isIntersecting) { visible.add(p); renderPage(p); }
      else { visible.delete(p); if (pages.length > 6) releasePage(p); }
    }
  }, { root: viewer, rootMargin: "700px 0px" });
  for (const p of pages) {
    const el = document.createElement("div");
    el.className = "page"; el.dataset.num = p.num;
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "ink"); svg.setAttribute("viewBox", `0 0 ${p.w} ${p.h}`); svg.setAttribute("preserveAspectRatio", "none");
    const forms = document.createElement("div"); forms.className = "layer forms";
    const draw = document.createElement("div"); draw.className = "layer draw";
    const objs = document.createElement("div"); objs.className = "layer objs";
    const canvas = document.createElement("canvas"); canvas.className = "pdfc"; canvas.width = 0; canvas.height = 0;
    el.append(canvas, svg, forms, draw, objs);
    Object.assign(p, { el, svg, forms, draw, objs, canvas });
    pagesEl.appendChild(el);
  }
  for (const p of pages) { buildForms(p); renderInk(p); renderObjs(p); attachDraw(p); io.observe(p.el); }
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
  autosizeTexts();
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
    } else if (tool === "text") {
      cur = { p, id: e.pointerId, start: [e.clientX, e.clientY], pt };
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
    else if (tool === "text") {
      if (Math.hypot(e.clientX - c.start[0], e.clientY - c.start[1]) < 12) createText(p, c.pt);
    }
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

/* ---------- objects: text + signature ---------- */
function findObj(id) { return objects.find((o) => o.id === id); }
function renderObjs(p) {
  p.objs.innerHTML = "";
  for (const o of objects) if (o.page === p.num && (o.type === "text" || o.type === "sig")) p.objs.appendChild(makeObjEl(o, p));
  autosizeTexts();
}
function renderAll() { for (const p of pages) { renderInk(p); renderObjs(p); } refreshOpts(); }
function posObj(el, o, p) { placePct(el, p, o.x, o.y, o.w, o.type === "sig" ? o.h : null); }
function makeObjEl(o, p) {
  const el = document.createElement("div");
  el.className = "obj " + o.type + (o.id === selectedId ? " sel" : "");
  el.dataset.id = o.id;
  posObj(el, o, p);
  if (o.type === "text") {
    const ta = document.createElement("textarea");
    ta.value = o.text; ta.rows = 1; ta.spellcheck = true; ta.setAttribute("autocapitalize", "sentences");
    ta.style.fontSize = `calc(var(--s) * ${o.size}px)`; ta.style.color = o.color;
    let before = o.text;
    ta.addEventListener("focus", () => { before = o.text; if (selectedId !== o.id) select(o.id); });
    ta.addEventListener("input", () => { o.text = ta.value; autosize(ta); });
    ta.addEventListener("blur", () => {
      if (!findObj(o.id)) return;
      if (!o.text.trim()) { objects = objects.filter((x) => x !== o); el.remove(); if (selectedId === o.id) selectedId = null; refreshOpts(); commit(); }
      else if (o.text !== before) commit();
    });
    el.appendChild(ta);
    const mv = handle("mv", "✥"); el.appendChild(mv);
    mv.addEventListener("pointerdown", (e) => startDrag(e, o, p, el, "move"));
  } else {
    const img = document.createElement("img"); img.src = o.data; img.alt = "Unterschrift"; img.draggable = false;
    el.appendChild(img);
    el.addEventListener("pointerdown", (e) => { if (e.target === el || e.target === img) startDrag(e, o, p, el, "move"); });
  }
  const del = handle("del", "✕"); el.appendChild(del);
  del.addEventListener("pointerdown", (e) => { e.stopPropagation(); e.preventDefault(); });
  del.addEventListener("click", (e) => { e.stopPropagation(); deleteObj(o.id); });
  const rs = handle("rs", "⤡"); el.appendChild(rs);
  rs.addEventListener("pointerdown", (e) => startDrag(e, o, p, el, "resize"));
  return el;
}
function handle(cls, txt) { const b = document.createElement("button"); b.className = "h " + cls; b.textContent = txt; b.tabIndex = -1; return b; }
function autosize(ta) { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + "px"; }
function autosizeTexts() { for (const ta of pagesEl.querySelectorAll(".obj.text textarea")) autosize(ta); }
function startDrag(e, o, p, el, mode) {
  e.preventDefault(); e.stopPropagation();
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
      const hh = o.type === "sig" ? o.h : 10;
      o.x = clamp(s0.x + dx, -o.w * 0.8, p.w - o.w * 0.2);
      o.y = clamp(s0.y + dy, -hh * 0.8, p.h - 10);
    } else if (o.type === "sig") {
      const ar = s0.w / s0.h;
      o.w = clamp(s0.w + dx, 20, p.w * 1.2); o.h = o.w / ar;
    } else {
      o.w = clamp(s0.w + dx, 20, p.w * 1.5);
    }
    posObj(el, o, p);
    if (o.type === "text") autosize(el.querySelector("textarea"));
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
  refreshOpts();
}
function deleteObj(id) {
  const o = findObj(id); if (!o) return;
  objects = objects.filter((x) => x !== o);
  if (selectedId === id) selectedId = null;
  const p = pages[o.page - 1];
  const el = p.objs.querySelector(`[data-id="${id}"]`); if (el) el.remove();
  refreshOpts(); commit();
}
viewer.addEventListener("pointerdown", (e) => {
  if (!selectedId) return;
  if (e.target.closest(".obj")) return;
  if (document.activeElement && document.activeElement.closest && document.activeElement.closest(".obj")) document.activeElement.blur();
  select(null);
});
function createText(p, pt) {
  const st = settings.text;
  const w = Math.min(200, Math.max(60, p.w - pt[0] - 8));
  const o = { id: uid(), type: "text", page: p.num, x: pt[0], y: pt[1] - st.size * 0.6, w, size: st.size, color: st.color, text: "" };
  objects.push(o);
  selectedId = o.id;
  const el = makeObjEl(o, p); p.objs.appendChild(el);
  setTool("select");
  const ta = el.querySelector("textarea"); autosize(ta);
  ta.focus();
  select(o.id);
}

/* ---------- history ---------- */
function commit() {
  const snap = JSON.stringify(objects);
  if (snap === hist[hIndex]) { scheduleSave(); return; }
  hist = hist.slice(0, hIndex + 1); hist.push(snap);
  if (hist.length > 150) hist.shift();
  hIndex = hist.length - 1; updateUndo(); scheduleSave();
}
function undo() { if (hIndex > 0) { hIndex--; objects = JSON.parse(hist[hIndex]); selectedId = null; renderAll(); updateUndo(); scheduleSave(); } }
function redo() { if (hIndex < hist.length - 1) { hIndex++; objects = JSON.parse(hist[hIndex]); selectedId = null; renderAll(); updateUndo(); scheduleSave(); } }
function updateUndo() { $("#btnUndo").disabled = !(hIndex > 0); $("#btnRedo").disabled = !(hIndex >= 0 && hIndex < hist.length - 1); }
$("#btnUndo").onclick = undo; $("#btnRedo").onclick = redo;
document.addEventListener("keydown", (e) => {
  const inField = e.target.closest && e.target.closest("input, textarea, select");
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !inField) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
  else if ((e.key === "Delete" || e.key === "Backspace") && selectedId && !inField) { e.preventDefault(); deleteObj(selectedId); }
  else if (e.key === "Escape") { if (document.activeElement) document.activeElement.blur(); select(null); }
});

/* ---------- tools + options ---------- */
function setTool(t) {
  tool = t; cancelStroke();
  document.body.className = document.body.className.replace(/\bt-\w+/g, "").replace(/\s+/g, " ").trim() + " t-" + t;
  for (const b of document.querySelectorAll(".tool[data-tool]")) b.classList.toggle("on", b.dataset.tool === t);
  if (t !== "select" && t !== "text") select(null); else refreshOpts();
}
for (const b of document.querySelectorAll(".tool[data-tool]")) b.onclick = () => setTool(b.dataset.tool);
function refreshOpts() {
  const box = $("#opts"); box.innerHTML = "";
  const sel = selectedId ? findObj(selectedId) : null;
  const add = (el) => box.appendChild(el);
  const nofocus = (b) => { b.addEventListener("pointerdown", (e) => e.preventDefault()); b.addEventListener("mousedown", (e) => e.preventDefault()); return b; };
  const hint = (t) => { const s = document.createElement("span"); s.className = "hint"; s.textContent = t; add(s); };
  const swatches = (colors, curC, onPick) => {
    for (const c of colors) {
      const b = nofocus(document.createElement("button")); b.className = "sw" + (c === curC ? " on" : ""); b.style.background = c;
      b.onclick = () => onPick(c); add(b);
    }
  };
  const widths = (list, curW, onPick, mk) => {
    for (const w of list) {
      const b = document.createElement("button"); b.className = "wd" + (w === curW ? " on" : "");
      const i = document.createElement("i"); i.style.height = Math.max(2, Math.min(16, mk ? w * 0.7 : w * 1.6)) + "px";
      if (mk) { i.style.background = settings.marker.color; i.style.opacity = .8; }
      b.appendChild(i); b.onclick = () => onPick(w); add(b);
    }
  };
  const sizeCtl = (size, onSet) => {
    const m = nofocus(document.createElement("button")); m.className = "pill"; m.textContent = "A−";
    const l = document.createElement("span"); l.className = "fs"; l.textContent = size + " pt";
    const pl = nofocus(document.createElement("button")); pl.className = "pill"; pl.textContent = "A+";
    m.onclick = () => onSet(Math.max(6, size - 1)); pl.onclick = () => onSet(Math.min(48, size + 1));
    add(m); add(l); add(pl);
  };
  if (!pdfBytes) { hint("Öffne eine PDF, um loszulegen."); return; }
  if (sel && sel.type === "text") {
    swatches(PEN_COLORS, sel.color, (c) => { sel.color = c; settings.text.color = c; saveSettings(); updateObjEl(sel); refreshOpts(); commit(); });
    sizeCtl(sel.size, (s) => { sel.size = s; settings.text.size = s; saveSettings(); updateObjEl(sel); refreshOpts(); commit(); });
    delBtn(add, sel, nofocus);
    return;
  }
  if (sel && sel.type === "sig") { hint("Ziehen zum Verschieben · ⤡ Größe"); delBtn(add, sel, nofocus); return; }
  if (tool === "pen") {
    swatches(PEN_COLORS, settings.pen.color, (c) => { settings.pen.color = c; saveSettings(); refreshOpts(); });
    widths([1, 2, 4, 7], settings.pen.width, (w) => { settings.pen.width = w; saveSettings(); refreshOpts(); });
  } else if (tool === "marker") {
    swatches(MK_COLORS, settings.marker.color, (c) => { settings.marker.color = c; saveSettings(); refreshOpts(); });
    widths([8, 14, 22], settings.marker.width, (w) => { settings.marker.width = w; saveSettings(); refreshOpts(); }, true);
  } else if (tool === "eraser") {
    hint("Über einen Strich wischen, um ihn zu löschen");
  } else if (tool === "text") {
    hint("Auf die Seite tippen");
    swatches(PEN_COLORS, settings.text.color, (c) => { settings.text.color = c; saveSettings(); refreshOpts(); });
    sizeCtl(settings.text.size, (s) => { settings.text.size = s; saveSettings(); refreshOpts(); });
  } else {
    hint(pages.some((p) => p.widgets.length) ? "Formularfelder antippen zum Ausfüllen" : "Werkzeug wählen · Objekte antippen zum Verschieben");
  }
}
function delBtn(add, o, nofocus) {
  const b = nofocus(document.createElement("button")); b.className = "pill danger"; b.textContent = "🗑 Löschen";
  b.onclick = () => deleteObj(o.id); add(b);
}
function updateObjEl(o) {
  const el = pagesEl.querySelector(`.obj[data-id="${o.id}"]`); if (!el) return;
  const ta = el.querySelector("textarea");
  if (ta) { ta.style.fontSize = `calc(var(--s) * ${o.size}px)`; ta.style.color = o.color; autosize(ta); }
}

/* ---------- signatures ---------- */
const SIG_KEY = "pdfeditor.signatures";
const loadSigs = () => { try { return JSON.parse(localStorage.getItem(SIG_KEY) || "[]"); } catch (e) { return []; } };
const storeSigs = (a) => { try { localStorage.setItem(SIG_KEY, JSON.stringify(a)); return true; } catch (e) { toast("Unterschrift konnte nicht gespeichert werden"); return false; } };
let sigTarget = null;
function openDlg(id) { $(id).classList.add("open"); }
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => b.closest(".dlg").classList.remove("open");
$("#btnSig").onclick = () => { if (!pdfBytes) { toast("Bitte zuerst eine PDF öffnen"); return; } openSigChooser(null); };
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
      o = { x: b.l + (b.w - w) / 2, y: b.t + (b.h - h) / 2, w, h };
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
    setTool("select");
    selectedId = o.id;
    p.objs.appendChild(makeObjEl(o, p));
    select(o.id); commit();
  };
  img.src = data;
}

/* ---------- export ---------- */
function hexRgb(h) { const n = parseInt(h.slice(1), 16); return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255); }
function makeSanitizer(font) {
  const ok = new Map();
  return (s) => Array.from(String(s).replace(/\r/g, "").replace(/\t/g, "    ")).map((ch) => {
    if (ch === "\n") return ch;
    if (!ok.has(ch)) { try { font.encodeText(ch); font.widthOfTextAtSize(ch, 10); ok.set(ch, true); } catch (e) { ok.set(ch, false); } }
    return ok.get(ch) ? ch : "?";
  }).join("");
}
function breakWord(word, W, maxW, out, start = "") {
  let chunk = start;
  for (const ch of word) { if (chunk && W(chunk + ch) > maxW) { out.push(chunk); chunk = ch; } else chunk += ch; }
  return chunk;
}
function wrapText(text, font, size, maxW) {
  const W = (t) => font.widthOfTextAtSize(t, size);
  const out = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (const tok of para.split(/(\s+)/)) {
      if (!tok) continue;
      if (!line.trim()) {
        line = W((line + tok).trimEnd()) <= maxW ? line + tok : breakWord(tok, W, maxW, out, line);
      } else if (W((line + tok).trimEnd()) <= maxW) {
        line += tok;
      } else {
        out.push(line.trimEnd());
        const t = /^\s+$/.test(tok) ? "" : tok;
        line = W(t) <= maxW ? t : breakWord(t, W, maxW, out);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}
async function buildExport() {
  const out = await PDFDocument.load(pdfBytes, { ignoreEncryption: true, updateMetadata: false });
  const font = await out.embedFont(StandardFonts.Helvetica);
  const clean = makeSanitizer(font);
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
      const lines = wrapText(clean(o.text), font, o.size, o.w);
      const lh = o.size * 1.2, color = hexRgb(o.color);
      lines.forEach((ln, i) => {
        if (!ln) return;
        const by = o.y + i * lh + o.size * 0.93;
        const [x, y] = conv(o.x, by);
        pg.drawText(ln, { x, y, size: o.size, font, color, rotate: degrees(ang(o.x, by)) });
      });
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
$("#btnExport").onclick = async () => {
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

/* ---------- start ---------- */
refreshOpts();
(async () => {
  const saved = await idb("get", "pdf");
  if (saved && saved.bytes) {
    try {
      busy(true, "Letzte Datei wird geladen …");
      await loadPdf(new Uint8Array(saved.bytes), saved.name, await idb("get", "state"));
      toast("Letzte Bearbeitung wiederhergestellt");
    } catch (e) { console.warn(e); await idb("del", "pdf"); await idb("del", "state"); resetDoc(); document.body.classList.remove("has-doc"); }
    finally { busy(false); refreshOpts(); }
  }
})();
window.__pdfEditor = { get objects() { return objects; }, get formValues() { return formValues; }, buildExport, setTool, placeSignature, setZoom, loadPdf };

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
    if (pdfBytes) idb("put", "state", { objects, formValues }).then(refreshOnce); else refreshOnce();
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
