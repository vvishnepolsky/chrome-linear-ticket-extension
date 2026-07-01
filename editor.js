// editor.js — preview + annotate one or more captures that make up a single
// Linear issue, then file it. Captures are read straight from IndexedDB
// (shared across extension pages); a "draft" records which captures belong
// to this report and in what order. New captures taken while this tab is open
// are appended live (see background.js → addToDraft).

import { getCapture, putCapture, getDraft, putDraft, deleteCapture } from "./db.js";

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const params = new URLSearchParams(location.search);
const draftId = params.get("draft");
const legacyCaptureId = params.get("id"); // backward-compat with old single-capture links

// Each entry is the capture object from IndexedDB, enriched in memory with
// per-screenshot annotation `shapes`, a `caption`, and a cached thumbnail URL.
let captures = [];
let activeIndex = -1;

let baseImage = null; // HTMLImageElement for the active screenshot
let objUrl = null; // object URL backing the active image/video, revoked on switch

// ---- annotation tool state (shapes themselves live on each capture) ----
const tool = {
  tool: "select",
  color: "#E5484D",
  size: 4,
  drawing: false,
  start: null,
  current: null,
  moving: null, // index of the shape being dragged with the select tool
  last: null, // last pointer position while dragging
};

const canvas = $("canvas");
const ctx = canvas.getContext("2d");

init();

async function init() {
  wireAnnotation();
  wireForm();

  // Resolve the capture id list from the draft (or a legacy single id).
  let ids = [];
  if (draftId) {
    let draft = null;
    try {
      draft = await getDraft(draftId);
    } catch (e) {
      return fail("Could not read draft: " + e.message);
    }
    if (draft) ids = draft.captureIds.slice();
  } else if (legacyCaptureId) {
    ids = [legacyCaptureId];
  }
  if (!ids.length) return fail("No captures found — they may have expired.");

  for (const id of ids) {
    const cap = await getCapture(id);
    if (cap) captures.push(prep(cap));
  }
  if (!captures.length) return fail("Captures not found — they may have expired.");

  // Tell the worker this tab owns the draft so later captures append here.
  if (draftId) send({ type: "SET_DRAFT_TAB", draftId }).catch(() => {});

  $("loading").classList.add("hidden");
  renderFilmstrip();
  setActive(0);
  loadLinear();

  // Live-append captures taken after the editor opened.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "CAPTURA_CAPTURE_ADDED" && msg.draftId === draftId) {
      onCaptureAdded(msg.captureId);
    }
  });

  // Reconcile against the draft once, in case a capture landed while we were
  // still loading (before the listener above was attached).
  if (draftId) reconcileDraft();
}

async function reconcileDraft() {
  let draft = null;
  try {
    draft = await getDraft(draftId);
  } catch (_) {
    return;
  }
  if (!draft) return;
  for (const id of draft.captureIds) {
    if (!captures.some((c) => c.id === id)) await onCaptureAdded(id);
  }
}

function prep(cap) {
  cap.shapes = cap.shapes || [];
  cap.caption = cap.caption || "";
  cap._thumbUrl = null;
  return cap;
}

function fail(msg) {
  $("loading").textContent = msg;
  $("loading").classList.remove("hidden");
}

async function onCaptureAdded(captureId) {
  if (captures.some((c) => c.id === captureId)) return; // already have it
  const cap = await getCapture(captureId);
  if (!cap) return;
  captures.push(prep(cap));
  $("loading").classList.add("hidden");
  renderFilmstrip();
  setActive(captures.length - 1); // jump to the newest
}

// ---------------------------------------------------------------------------
// Filmstrip + active selection
// ---------------------------------------------------------------------------
function thumbSrc(cap) {
  if (cap.dataUrl) return cap.dataUrl;
  if (cap.blob) {
    if (!cap._thumbUrl) cap._thumbUrl = URL.createObjectURL(cap.blob);
    return cap._thumbUrl;
  }
  return "";
}

function renderFilmstrip() {
  const strip = $("filmstrip");
  strip.innerHTML = "";
  captures.forEach((cap, i) => {
    const item = document.createElement("div");
    item.className = "thumb" + (i === activeIndex ? " active" : "");
    item.onclick = () => setActive(i);

    if (cap.kind === "video") {
      const v = document.createElement("div");
      v.className = "thumb-video";
      v.textContent = "🎥";
      item.appendChild(v);
    } else {
      const img = document.createElement("img");
      img.src = thumbSrc(cap);
      img.alt = "";
      item.appendChild(img);
    }

    const num = document.createElement("span");
    num.className = "thumb-num";
    num.textContent = String(i + 1);
    item.appendChild(num);

    const del = document.createElement("button");
    del.className = "thumb-del";
    del.textContent = "×";
    del.title = "Remove from report";
    del.onclick = (e) => {
      e.stopPropagation();
      removeCapture(i);
    };
    item.appendChild(del);

    strip.appendChild(item);
  });

  const n = captures.length;
  $("filmstrip-hint").textContent = n
    ? `${n} capture${n > 1 ? "s" : ""} in this report — take more from the toolbar and they'll be added here.`
    : "";
}

function setActive(i) {
  if (i < 0 || i >= captures.length) return;
  // Stash the caption being edited before we switch away.
  if (activeIndex >= 0 && captures[activeIndex]) {
    captures[activeIndex].caption = $("caption").value;
  }
  activeIndex = i;
  const cap = captures[i];
  $("caption").value = cap.caption || "";
  document.querySelectorAll("#filmstrip .thumb").forEach((el, idx) =>
    el.classList.toggle("active", idx === i)
  );
  showPreview(cap);
  renderDiagnostics(cap);
  if (cap.note) setSubmitStatus("⚠ " + cap.note, "err");
}

async function removeCapture(i) {
  const cap = captures[i];
  captures.splice(i, 1);
  if (cap._thumbUrl) URL.revokeObjectURL(cap._thumbUrl);

  try {
    if (draftId) {
      const d = await getDraft(draftId);
      if (d) {
        d.captureIds = d.captureIds.filter((id) => id !== cap.id);
        await putDraft(d);
      }
    }
    await deleteCapture(cap.id);
  } catch (_) {}

  if (!captures.length) {
    activeIndex = -1;
    canvas.classList.add("hidden");
    $("video").classList.add("hidden");
    $("caption-bar").classList.add("hidden");
    fail("No captures left. Capture something to add it here.");
    renderFilmstrip();
    return;
  }
  // activeIndex may now point past the end or at a shifted item; reselect.
  activeIndex = -1;
  renderFilmstrip();
  setActive(Math.min(i, captures.length - 1));
}

// ---------------------------------------------------------------------------
// Preview (image → canvas, video → <video>)
// ---------------------------------------------------------------------------
function showPreview(cap) {
  if (objUrl) {
    URL.revokeObjectURL(objUrl);
    objUrl = null;
  }
  const v = $("video");
  $("caption-bar").classList.remove("hidden");

  if (cap.kind === "video") {
    $("anno-toolbar").classList.add("hidden");
    canvas.classList.add("hidden");
    const blob = cap.blob || new Blob([], { type: cap.mimeType });
    objUrl = URL.createObjectURL(blob);
    v.src = objUrl;
    v.classList.remove("hidden");
    return;
  }

  v.classList.add("hidden");
  v.removeAttribute("src");
  $("anno-toolbar").classList.remove("hidden");

  baseImage = new Image();
  baseImage.onload = () => {
    canvas.width = baseImage.naturalWidth;
    canvas.height = baseImage.naturalHeight;
    canvas.classList.remove("hidden");
    redraw();
  };
  baseImage.onerror = () => fail("Failed to load screenshot image.");
  if (cap.dataUrl) {
    baseImage.src = cap.dataUrl;
  } else if (cap.blob) {
    objUrl = URL.createObjectURL(cap.blob);
    baseImage.src = objUrl;
  } else {
    fail("Capture has no image data.");
  }
}

// ---------------------------------------------------------------------------
// Annotation engine — operates on the active capture's `shapes`
// ---------------------------------------------------------------------------
function activeCap() {
  return activeIndex >= 0 ? captures[activeIndex] : null;
}

function wireAnnotation() {
  document.querySelectorAll("#tools .tool").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#tools .tool").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool.tool = b.dataset.tool;
      canvas.dataset.tool = tool.tool;
      canvas.style.cursor = ""; // let the CSS per-tool cursor take over
    };
  });
  canvas.dataset.tool = tool.tool;

  document.querySelectorAll("#colors .swatch").forEach((b) => {
    b.onclick = () => {
      document.querySelectorAll("#colors .swatch").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      tool.color = b.dataset.color;
    };
  });

  const undo = () => {
    const c = activeCap();
    if (c && c.shapes.length) {
      c.shapes.pop();
      redraw();
    }
  };
  $("undo").onclick = undo;
  $("clear").onclick = () => {
    const c = activeCap();
    if (c) {
      c.shapes = [];
      redraw();
    }
  };

  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);

  // Cmd/Ctrl+Z undoes the last annotation (unless you're typing in a field).
  window.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (!typing && (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
  });
}

function toCanvasCoords(e) {
  const r = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (canvas.width / r.width),
    y: (e.clientY - r.top) * (canvas.height / r.height),
  };
}

function onDown(e) {
  const c = activeCap();
  if (!c) return;
  // If a text box is currently open, let this click just commit it (via blur)
  // instead of starting a new annotation.
  if (!$("text-input").classList.contains("hidden")) return;
  const p = toCanvasCoords(e);

  // Select tool: grab the topmost shape under the cursor to drag it.
  if (tool.tool === "select") {
    const idx = hitTest(c.shapes, p);
    if (idx >= 0) {
      tool.moving = idx;
      tool.last = p;
      canvas.style.cursor = "grabbing";
    }
    return;
  }

  if (tool.tool === "text") {
    // Drag out the box the text will live in; typing starts on release.
    e.preventDefault();
    tool.drawing = true;
    tool.start = p;
    tool.current = { tool: "textbox", color: tool.color, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    return;
  }

  tool.drawing = true;
  tool.start = p;
  if (tool.tool === "pen") {
    tool.current = { tool: "pen", color: tool.color, size: tool.size, points: [p] };
  } else {
    tool.current = { tool: tool.tool, color: tool.color, size: tool.size, x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }
}

function onMove(e) {
  const p = toCanvasCoords(e);
  const c = activeCap();

  if (tool.tool === "select") {
    if (tool.moving == null) {
      // Hover feedback: show a move cursor over a draggable shape.
      canvas.style.cursor = c && hitTest(c.shapes, p) >= 0 ? "move" : "default";
      return;
    }
    if (!c) return;
    translateShape(c.shapes[tool.moving], p.x - tool.last.x, p.y - tool.last.y);
    tool.last = p;
    redraw();
    return;
  }

  if (!tool.drawing) return;
  if (tool.tool === "pen") {
    tool.current.points.push(p);
  } else {
    tool.current.x1 = p.x;
    tool.current.y1 = p.y;
  }
  redraw();
}

function onUp() {
  if (tool.tool === "select") {
    if (tool.moving != null) canvas.style.cursor = "move";
    tool.moving = null;
    tool.last = null;
    return;
  }
  if (!tool.drawing) return;
  tool.drawing = false;
  const c = activeCap();
  const cur = tool.current;
  tool.current = null;
  if (!cur || !c) {
    redraw();
    return;
  }
  if (cur.tool === "textbox") {
    openTextBox(cur, c);
    redraw();
    return;
  }
  const tiny = cur.tool !== "pen" && Math.abs(cur.x1 - cur.x0) < 3 && Math.abs(cur.y1 - cur.y0) < 3;
  if (!tiny) c.shapes.push(cur);
  redraw();
}

// ---- moving / hit-testing -------------------------------------------------
function shapeBBox(s) {
  if (s.tool === "pen") {
    if (!s.points || !s.points.length) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of s.points) {
      minX = Math.min(minX, pt.x);
      minY = Math.min(minY, pt.y);
      maxX = Math.max(maxX, pt.x);
      maxY = Math.max(maxY, pt.y);
    }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }
  if (s.tool === "text") {
    const m = textMetrics(s);
    return { x: s.x, y: s.y, w: m.w, h: m.h };
  }
  return {
    x: Math.min(s.x0, s.x1),
    y: Math.min(s.y0, s.y1),
    w: Math.abs(s.x1 - s.x0),
    h: Math.abs(s.y1 - s.y0),
  };
}

function hitTest(shapes, p) {
  const pad = 6;
  for (let i = shapes.length - 1; i >= 0; i--) {
    const b = shapeBBox(shapes[i]);
    if (!b) continue;
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) {
      return i;
    }
  }
  return -1;
}

function translateShape(s, dx, dy) {
  if (s.tool === "pen") {
    s.points = s.points.map((pt) => ({ x: pt.x + dx, y: pt.y + dy }));
  } else if (s.tool === "text") {
    s.x += dx;
    s.y += dy;
  } else {
    s.x0 += dx;
    s.y0 += dy;
    s.x1 += dx;
    s.y1 += dy;
  }
}

// Open a textarea sized to the box the user just dragged, then turn what they
// type into a wrapped text annotation anchored to that box.
function openTextBox(box, cap) {
  const x = Math.min(box.x0, box.x1);
  const y = Math.min(box.y0, box.y1);
  let w = Math.abs(box.x1 - box.x0);
  let h = Math.abs(box.y1 - box.y0);

  const r = canvas.getBoundingClientRect();
  const scaleX = r.width / canvas.width; // displayed px per canvas px
  const scaleY = r.height / canvas.height;

  // Pick a canvas-space font size that reads ~16px on screen regardless of
  // how much the canvas is scaled down, so typing stays comfortable.
  const size = Math.max(10, Math.round(16 / scaleX));

  // A bare click (or a tiny drag) falls back to a sensible default box.
  if (w < 40) w = Math.round(220 / scaleX);
  if (h < size) h = Math.round(size * 1.4);

  const input = $("text-input");
  input.value = "";
  input.style.left = r.left + x * scaleX + "px";
  input.style.top = r.top + y * scaleY + "px";
  input.style.width = w * scaleX + "px";
  input.style.height = h * scaleY + "px";
  input.style.fontSize = size * scaleX + "px";
  input.style.lineHeight = "1.25";
  input.style.color = tool.color;
  input.classList.remove("hidden");

  let done = false;
  const close = () => {
    done = true;
    input.classList.add("hidden");
    input.onblur = null;
    input.onkeydown = null;
    input.style.width = "";
    input.style.height = "";
  };
  const commit = () => {
    if (done) return;
    const text = input.value.replace(/\s+$/, "");
    close();
    if (text && cap) {
      cap.shapes.push({ tool: "text", color: tool.color, x, y, w, size, text });
      redraw();
    }
  };

  input.onkeydown = (ev) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      close();
    } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
      ev.preventDefault(); // ⌘/Ctrl+Enter places it; plain Enter is a newline
      commit();
    }
  };

  // Defer focus past the click that opened the box — focusing during the
  // pointer event gets undone by the browser's own focus handling, which would
  // blur immediately and commit empty text.
  requestAnimationFrame(() => {
    if (done) return;
    input.focus();
    input.onblur = commit;
  });
}

function redraw() {
  if (!baseImage) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(baseImage, 0, 0);
  const c = activeCap();
  const shapes = c ? c.shapes : [];
  const all = tool.current ? shapes.concat([tool.current]) : shapes;
  for (const s of all) drawShape(ctx, s, baseImage);
}

function drawShape(g, s, baseImg) {
  g.save();
  g.strokeStyle = s.color;
  g.fillStyle = s.color;
  g.lineWidth = s.size || 4;
  g.lineJoin = "round";
  g.lineCap = "round";

  if (s.tool === "rect") {
    g.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.tool === "arrow") {
    drawArrow(g, s.x0, s.y0, s.x1, s.y1, s.size || 4);
  } else if (s.tool === "pen") {
    g.beginPath();
    s.points.forEach((pt, i) => (i ? g.lineTo(pt.x, pt.y) : g.moveTo(pt.x, pt.y)));
    g.stroke();
  } else if (s.tool === "text") {
    drawWrappedText(g, s);
  } else if (s.tool === "textbox") {
    // Live preview of the box being dragged out for the text tool.
    g.setLineDash([6, 4]);
    g.lineWidth = 1.5;
    g.strokeRect(Math.min(s.x0, s.x1), Math.min(s.y0, s.y1), Math.abs(s.x1 - s.x0), Math.abs(s.y1 - s.y0));
  } else if (s.tool === "blur") {
    const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
    const w = Math.abs(s.x1 - s.x0), h = Math.abs(s.y1 - s.y0);
    if (w > 1 && h > 1 && baseImg) {
      g.save();
      g.beginPath();
      g.rect(x, y, w, h);
      g.clip();
      g.filter = "blur(12px)";
      g.drawImage(baseImg, 0, 0);
      g.restore();
    }
  }
  g.restore();
}

// Split text into rendered lines, wrapping words at maxW (canvas units) and
// honoring explicit newlines. `g` must already have the target font set.
function wrapLines(g, text, maxW) {
  const out = [];
  for (const para of String(text).split("\n")) {
    if (!para) {
      out.push("");
      continue;
    }
    const words = para.split(" ");
    let line = "";
    for (const word of words) {
      const test = line ? line + " " + word : word;
      if (maxW && line && g.measureText(test).width > maxW) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    out.push(line);
  }
  return out;
}

function drawWrappedText(g, s) {
  const size = s.size || 22;
  g.save();
  g.font = `bold ${size}px -apple-system, sans-serif`;
  g.textBaseline = "top";
  g.lineJoin = "round";
  const lineHeight = size * 1.25;
  const lines = wrapLines(g, s.text, s.w || Infinity);
  let y = s.y;
  for (const line of lines) {
    g.lineWidth = 4;
    g.strokeStyle = "rgba(255,255,255,.9)";
    g.strokeText(line, s.x, y);
    g.fillStyle = s.color;
    g.fillText(line, s.x, y);
    y += lineHeight;
  }
  g.restore();
}

// Rendered width/height of a text shape, for hit-testing and selection.
function textMetrics(s) {
  const size = s.size || 22;
  ctx.save();
  ctx.font = `bold ${size}px -apple-system, sans-serif`;
  const lines = wrapLines(ctx, s.text, s.w || Infinity);
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, ctx.measureText(line).width);
  ctx.restore();
  return { w: widest, h: Math.max(1, lines.length) * size * 1.25 };
}

function drawArrow(g, x0, y0, x1, y1, size) {
  const head = Math.max(12, size * 3);
  const ang = Math.atan2(y1 - y0, x1 - x0);
  g.beginPath();
  g.moveTo(x0, y0);
  g.lineTo(x1, y1);
  g.stroke();
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x1 - head * Math.cos(ang - Math.PI / 6), y1 - head * Math.sin(ang - Math.PI / 6));
  g.lineTo(x1 - head * Math.cos(ang + Math.PI / 6), y1 - head * Math.sin(ang + Math.PI / 6));
  g.closePath();
  g.fill();
}

// Flatten a capture's annotations onto its image and return a PNG blob.
function flattenCapture(cap) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      for (const s of cap.shapes) drawShape(cx, s, img);
      c.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("toBlob failed"))), "image/png");
    };
    img.onerror = () => reject(new Error("Could not load image for flattening."));
    if (cap.dataUrl) img.src = cap.dataUrl;
    else if (cap.blob) img.src = URL.createObjectURL(cap.blob);
    else reject(new Error("Capture has no image data."));
  });
}

// ---------------------------------------------------------------------------
// Diagnostics (per active capture)
// ---------------------------------------------------------------------------
function renderDiagnostics(cap) {
  const m = cap.meta || {};
  const envRows = [
    ["URL", m.url],
    ["Title", m.title],
    ["User agent", m.userAgent],
    ["Platform", m.platform],
    ["Viewport", m.viewport ? `${m.viewport.width}×${m.viewport.height} @${m.viewport.dpr}x` : null],
    ["Screen", m.screen ? `${m.screen.width}×${m.screen.height}` : null],
    ["Language", m.language],
    ["Timezone", m.timezone],
    ["Network", m.connection ? m.connection.effectiveType : null],
    ["Online", m.online == null ? null : String(m.online)],
  ].filter(([, v]) => v != null && v !== "");
  $("env-body").innerHTML = envRows
    .map(([k, v]) => `<div class="env-row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`)
    .join("");
  $("env-count").textContent = envRows.length;

  const logs = cap.logs || [];
  const consoleLogs = logs.filter((l) => l.kind === "console" || l.kind === "error");
  $("console-count").textContent = consoleLogs.length;
  $("console-body").innerHTML =
    consoleLogs
      .map((l) => {
        if (l.kind === "error") {
          return `<div class="log-line error">⛔ ${esc(l.payload.message || "")}${l.payload.stack ? "\n" + esc(l.payload.stack) : ""}</div>`;
        }
        return `<div class="log-line lvl-${esc(l.payload.level)}">[${esc(l.payload.level)}] ${esc((l.payload.args || []).join(" "))}</div>`;
      })
      .join("") || `<div class="log-line">No console output captured.</div>`;

  const net = logs.filter((l) => l.kind === "network");
  $("network-count").textContent = net.length;
  $("network-body").innerHTML =
    net
      .map((l) => {
        const ok = l.payload.ok;
        return `<div class="net-line"><span class="net-status ${ok ? "ok" : "bad"}">${esc(l.payload.status || "ERR")}</span><span>${esc(l.payload.method || "")} ${esc(l.payload.url || "")} <span style="opacity:.6">(${esc(l.payload.durationMs ?? "?")}ms)</span></span></div>`;
      })
      .join("") || `<div class="log-line">No network requests captured.</div>`;
}

// ---------------------------------------------------------------------------
// Linear form
// ---------------------------------------------------------------------------
function prefillForm() {
  const m = (captures[0] && captures[0].meta) || {};
  const host = (() => {
    try {
      return new URL(m.url).host;
    } catch (_) {
      return "";
    }
  })();
  if (host && !$("title").value) $("title").value = `Bug on ${host}`;
}

async function loadLinear() {
  const { linearApiKey, defaultTeamId, defaultProjectId, defaultPriority, defaultStateId } =
    await chrome.storage.local.get(["linearApiKey", "defaultTeamId", "defaultProjectId", "defaultPriority", "defaultStateId"]);

  prefillForm();

  if (!linearApiKey) {
    $("no-key-warn").classList.remove("hidden");
    $("open-options").onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
    $("submit").disabled = true;
    return;
  }

  if (defaultPriority != null) $("priority").value = String(defaultPriority);

  try {
    const resp = await send({ type: "LINEAR_LIST_TEAMS" });
    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    const teamSel = $("team");
    teamSel.innerHTML = "";
    for (const t of resp.teams) {
      const o = document.createElement("option");
      o.value = t.id;
      o.textContent = `${t.name} (${t.key})`;
      teamSel.appendChild(o);
    }
    teamSel.value = defaultTeamId && resp.teams.some((t) => t.id === defaultTeamId) ? defaultTeamId : (resp.teams[0] && resp.teams[0].id) || "";
    teamSel.onchange = () => onTeamChange(teamSel.value);
    await onTeamChange(teamSel.value, defaultProjectId, defaultStateId);
    loadUsers(); // assignees are workspace-wide, independent of the team
  } catch (err) {
    setSubmitStatus("Couldn't load Linear teams: " + (err.message || err), "err");
  }
}

async function loadUsers() {
  try {
    const resp = await send({ type: "LINEAR_LIST_USERS" });
    if (!resp || !resp.ok) return;
    const sel = $("assignee");
    sel.innerHTML = '<option value="">Unassigned</option>';
    for (const u of resp.users) {
      const o = document.createElement("option");
      o.value = u.id;
      o.textContent = (u.displayName || u.name || u.email || "User") + (u.isMe ? " (me)" : "");
      sel.appendChild(o);
    }
  } catch (_) {}
}

async function onTeamChange(teamId, preselectProject, preselectState) {
  const projSel = $("project");
  const stateSel = $("state");
  projSel.innerHTML = '<option value="">—</option>';
  stateSel.innerHTML = '<option value="">Team default</option>';
  renderLabels([]);
  renderMilestones([]);
  if (!teamId) return;

  const [proj, labels, states] = await Promise.all([
    send({ type: "LINEAR_LIST_PROJECTS", teamId }),
    send({ type: "LINEAR_LIST_LABELS", teamId }),
    send({ type: "LINEAR_LIST_STATES", teamId }),
  ]);

  if (proj && proj.ok) {
    for (const p of proj.projects) {
      const o = document.createElement("option");
      o.value = p.id;
      o.textContent = p.name;
      projSel.appendChild(o);
    }
    if (preselectProject) projSel.value = preselectProject;
    // Milestones depend on the chosen project.
    projSel.onchange = () => loadMilestones(projSel.value);
    await loadMilestones(projSel.value);
  }
  if (states && states.ok) {
    for (const s of states.states) {
      const o = document.createElement("option");
      o.value = s.id;
      o.textContent = s.name;
      stateSel.appendChild(o);
    }
    if (preselectState && states.states.some((s) => s.id === preselectState)) {
      stateSel.value = preselectState;
    }
  }
  if (labels && labels.ok) renderLabels(labels.labels);
}

// Labels are rendered as themed checkbox chips (a native multi-select renders
// poorly in dark mode and hides the label colors).
function renderLabels(labels) {
  const wrap = $("labels");
  wrap.innerHTML = "";
  for (const l of labels) {
    const chip = document.createElement("label");
    chip.className = "chip";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.value = l.id;
    cb.onchange = () => chip.classList.toggle("checked", cb.checked);
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = l.color || "var(--muted)";
    chip.appendChild(cb);
    chip.appendChild(dot);
    chip.appendChild(document.createTextNode(l.name));
    wrap.appendChild(chip);
  }
}

function selectedLabelIds() {
  return Array.from($("labels").querySelectorAll("input:checked")).map((c) => c.value);
}

function renderMilestones(milestones) {
  const sel = $("milestone");
  sel.innerHTML = '<option value="">—</option>';
  for (const m of milestones) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.name;
    sel.appendChild(o);
  }
  sel.disabled = milestones.length === 0;
}

async function loadMilestones(projectId) {
  if (!projectId) return renderMilestones([]);
  try {
    const resp = await send({ type: "LINEAR_LIST_MILESTONES", projectId });
    renderMilestones(resp && resp.ok ? resp.milestones : []);
  } catch (_) {
    renderMilestones([]);
  }
}

function wireForm() {
  $("submit").onclick = onSubmit;
  $("new-report").onclick = async () => {
    await send({ type: "NEW_DRAFT" }).catch(() => {});
    setSubmitStatus("Started a new report — new captures won't be added to this tab.", "");
  };
}

async function onSubmit() {
  // Persist the caption currently being edited.
  if (activeIndex >= 0 && captures[activeIndex]) {
    captures[activeIndex].caption = $("caption").value;
  }

  const teamId = $("team").value;
  const title = $("title").value.trim();
  if (!teamId) return setSubmitStatus("Pick a team.", "err");
  if (!title) return setSubmitStatus("Add a title.", "err");
  if (!captures.length) return setSubmitStatus("Add at least one capture.", "err");

  $("submit").disabled = true;
  setSubmitStatus("Uploading captures & creating issue…", "busy");

  try {
    // Flatten annotations into each annotated screenshot before upload.
    for (const cap of captures) {
      if (cap.kind === "image" && cap.shapes && cap.shapes.length) {
        const blob = await flattenCapture(cap);
        cap.blob = blob;
        cap.dataUrl = await blobToDataUrl(blob);
        await putCapture({
          id: cap.id,
          kind: cap.kind,
          blob: cap.blob,
          dataUrl: cap.dataUrl,
          mimeType: cap.mimeType,
          createdAt: cap.createdAt,
          meta: cap.meta,
          logs: cap.logs,
          note: cap.note || null,
        });
      }
    }

    const labelIds = selectedLabelIds();
    const items = captures.map((c) => ({ captureId: c.id, caption: c.caption || "" }));

    const resp = await send({
      type: "CREATE_TICKET",
      draftId,
      title,
      description: $("description").value,
      teamId,
      projectId: $("project").value || null,
      projectMilestoneId: $("milestone").value || null,
      assigneeId: $("assignee").value || null,
      stateId: $("state").value || null,
      priority: Number($("priority").value || 0),
      labelIds,
      includeAttachments: $("include-attachment").checked,
      items,
    });

    if (!resp || !resp.ok) throw new Error(resp && resp.error);
    showSuccess(resp.issue);
  } catch (err) {
    setSubmitStatus("Failed: " + (err.message || err), "err");
    $("submit").disabled = false;
  }
}

function showSuccess(issue) {
  setSubmitStatus("", "");
  $("submit").classList.add("hidden");
  const el = $("success");
  el.classList.remove("hidden");
  el.innerHTML = `✅ Created <a href="${esc(issue.url)}" target="_blank">${esc(issue.identifier)}</a> — ${esc(issue.title)}<br><small>You can close this tab.</small>`;
  if (objUrl) URL.revokeObjectURL(objUrl);
  captures.forEach((c) => c._thumbUrl && URL.revokeObjectURL(c._thumbUrl));
}

function setSubmitStatus(text, kind) {
  const el = $("submit-status");
  el.textContent = text;
  el.className = `submit-status ${kind || ""}`;
}

// ---------------------------------------------------------------------------
// utils
// ---------------------------------------------------------------------------
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
