// background.js — service worker. Orchestrates capture (screenshot + video),
// keeps a per-tab ring buffer of console/network events, brokers all Linear
// API calls, and opens the editor.

import { putCapture, getCapture, deleteCapture, pruneCaptures } from "./db.js";
import * as linear from "./linear.js";

const RING_LIMIT = 500; // max console/network events kept per tab
const ringBuffers = new Map(); // tabId -> [{kind, payload, ts}]
const pendingMeta = new Map(); // captureId -> {meta, logs} stashed for the offscreen recorder

// ---------------------------------------------------------------------------
// Ring buffer of page events
// ---------------------------------------------------------------------------
function pushEvent(tabId, evt) {
  if (tabId == null) return;
  let buf = ringBuffers.get(tabId);
  if (!buf) {
    buf = [];
    ringBuffers.set(tabId, buf);
  }
  buf.push(evt);
  if (buf.length > RING_LIMIT) buf.splice(0, buf.length - RING_LIMIT);
}

chrome.tabs.onRemoved.addListener((tabId) => ringBuffers.delete(tabId));
chrome.tabs.onUpdated.addListener((tabId, info) => {
  // Clear the buffer on a full navigation so logs map to the current page.
  if (info.status === "loading" && info.url) ringBuffers.delete(tabId);
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return;

  switch (msg.type) {
    case "CAPTURA_EVENT": {
      const tabId = sender.tab && sender.tab.id;
      pushEvent(tabId, { kind: msg.kind, payload: msg.payload, ts: msg.ts });
      return false;
    }

    case "CAPTURE_SCREENSHOT":
      handleScreenshot(msg.tabId)
        .then((id) => sendResponse({ ok: true, captureId: id }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "CAPTURE_FULLPAGE":
      handleFullPage(msg.tabId)
        .then((id) => sendResponse({ ok: true, captureId: id }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "START_AREA_SELECT":
      startAreaSelect(msg.tabId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "CAPTURA_AREA_SELECTED":
      handleAreaCapture(sender.tab, msg.rect, msg.dpr).catch((err) =>
        console.warn("Area capture failed:", errStr(err))
      );
      return false;

    case "CAPTURA_AREA_CANCELLED":
      return false;

    case "START_RECORDING":
      handleStartRecording(msg.tabId, msg.withAudio !== false)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "STOP_RECORDING":
      chrome.runtime
        .sendMessage({ target: "offscreen", type: "OFFSCREEN_STOP" })
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "GET_RECORDING_STATE":
      sendResponse({ ok: true, recording: recordingState.active, tabId: recordingState.tabId });
      return false;

    case "GET_PENDING_CAPTURE": {
      sendResponse(pendingMeta.get(msg.captureId) || {});
      return false;
    }

    case "RECORDING_COMPLETE":
      pendingMeta.delete(msg.captureId);
      recordingState.active = false;
      recordingState.tabId = null;
      updateBadge(false);
      openEditor(msg.captureId);
      closeOffscreenSoon();
      return false;

    case "GET_CAPTURE":
      getCapture(msg.captureId)
        .then((cap) => sendResponse({ ok: true, capture: serializeCapture(cap) }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "DELETE_CAPTURE":
      deleteCapture(msg.captureId)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    // ---- Linear brokerage ----
    case "LINEAR_VERIFY":
      withKey((key) => linear.getViewer(key))
        .then((viewer) => sendResponse({ ok: true, viewer }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "LINEAR_LIST_TEAMS":
      withKey((key) => linear.listTeams(key))
        .then((teams) => sendResponse({ ok: true, teams }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "LINEAR_LIST_PROJECTS":
      withKey((key) => linear.listProjects(key, msg.teamId))
        .then((projects) => sendResponse({ ok: true, projects }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "LINEAR_LIST_LABELS":
      withKey((key) => linear.listLabels(key, msg.teamId))
        .then((labels) => sendResponse({ ok: true, labels }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "LINEAR_LIST_STATES":
      withKey((key) => linear.listStates(key, msg.teamId))
        .then((states) => sendResponse({ ok: true, states }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    case "CREATE_TICKET":
      handleCreateTicket(msg)
        .then((issue) => sendResponse({ ok: true, issue }))
        .catch((err) => sendResponse({ ok: false, error: errStr(err) }));
      return true;

    default:
      return false;
  }
});

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------
async function handleScreenshot(tabId) {
  const tab = await getTab(tabId);
  const meta = await collectMeta(tab.id);
  const logs = (ringBuffers.get(tab.id) || []).slice();

  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
    format: "png",
  });

  const id = newId();
  await putCapture({
    id,
    kind: "image",
    dataUrl,
    mimeType: "image/png",
    createdAt: Date.now(),
    meta,
    logs,
  });
  await openEditor(id);
  return id;
}

// ---------------------------------------------------------------------------
// Full-page screenshot — scroll the page in viewport-high steps, capture each,
// and stitch the tiles onto one tall OffscreenCanvas.
// ---------------------------------------------------------------------------
const MAX_CANVAS_DIM = 32000; // Chrome canvas dimension ceiling (with headroom)

async function handleFullPage(tabId) {
  const tab = await getTab(tabId);
  const meta = await collectMeta(tab.id);
  const logs = (ringBuffers.get(tab.id) || []).slice();

  let dims;
  try {
    dims = await chrome.tabs.sendMessage(tab.id, { type: "CAPTURA_PREPARE_FULLPAGE" });
  } catch (_) {
    throw new Error("Full-page capture isn't available on this page.");
  }
  if (!dims) throw new Error("Couldn't measure the page.");

  const dpr = dims.dpr || 1;
  const vh = dims.viewportHeight;
  let totalHeight = Math.min(dims.totalHeight, Math.floor(MAX_CANVAS_DIM / dpr));
  const canvasW = Math.round(dims.viewportWidth * dpr);
  const canvasH = Math.round(totalHeight * dpr);

  const oc = new OffscreenCanvas(canvasW, canvasH);
  const cx = oc.getContext("2d");
  let truncated = totalHeight < dims.totalHeight;

  try {
    let y = 0;
    let first = true;
    let lastY = -1;
    while (y < totalHeight) {
      const res = await chrome.tabs.sendMessage(tab.id, {
        type: "CAPTURA_SCROLL_TO",
        y,
        hideFixed: !first,
      });
      const actualY = res ? res.scrollY : y;
      if (!first && actualY === lastY) break; // reached the bottom

      await delay(550); // respect the ~2/sec captureVisibleTab rate limit + repaint
      const dataUrl = await captureWithRetry(tab.windowId);
      const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
      cx.drawImage(bmp, 0, Math.round(actualY * dpr));
      if (bmp.close) bmp.close();

      lastY = actualY;
      first = false;
      if (actualY + vh >= totalHeight) break;
      y = actualY + vh;
    }
  } finally {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: "CAPTURA_FINISH_FULLPAGE" });
    } catch (_) {}
  }

  const blob = await oc.convertToBlob({ type: "image/png" });
  const id = newId();
  await putCapture({
    id,
    kind: "image",
    blob,
    mimeType: "image/png",
    createdAt: Date.now(),
    meta,
    logs,
    note: truncated ? "Page exceeded the max capture height and was truncated." : null,
  });
  await openEditor(id);
  return id;
}

// ---------------------------------------------------------------------------
// Area capture — content script collects a viewport rectangle, we capture the
// visible tab and crop to it.
// ---------------------------------------------------------------------------
async function startAreaSelect(tabId) {
  const tab = await getTab(tabId);
  await chrome.tabs.sendMessage(tab.id, { type: "CAPTURA_START_AREA_SELECT" });
}

async function handleAreaCapture(tab, rect, dpr) {
  if (!tab) return;
  const meta = await collectMeta(tab.id);
  const logs = (ringBuffers.get(tab.id) || []).slice();

  const dataUrl = await captureWithRetry(tab.windowId);
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());

  const sx = Math.round(rect.x * dpr);
  const sy = Math.round(rect.y * dpr);
  const sw = Math.max(1, Math.round(rect.width * dpr));
  const sh = Math.max(1, Math.round(rect.height * dpr));

  const oc = new OffscreenCanvas(sw, sh);
  const cx = oc.getContext("2d");
  cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
  if (bmp.close) bmp.close();

  const blob = await oc.convertToBlob({ type: "image/png" });
  const id = newId();
  await putCapture({ id, kind: "image", blob, mimeType: "image/png", createdAt: Date.now(), meta, logs });
  await openEditor(id);
}

// captureVisibleTab is rate-limited; retry once after a pause on overflow.
async function captureWithRetry(windowId) {
  try {
    return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
  } catch (err) {
    if (/MAX_CAPTURE|exceeded|quota/i.test(errStr(err))) {
      await delay(700);
      return await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
    }
    throw err;
  }
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Video recording (via offscreen document)
// ---------------------------------------------------------------------------
const recordingState = { active: false, tabId: null };

async function handleStartRecording(tabId, withAudio) {
  if (recordingState.active) throw new Error("Already recording");
  const tab = await getTab(tabId);

  await ensureOffscreen();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });

  // Stash meta + logs now so the offscreen doc can enrich the capture on stop.
  const captureId = newId();
  const meta = await collectMeta(tab.id);
  const logs = (ringBuffers.get(tab.id) || []).slice();
  pendingMeta.set(captureId, { meta, logs });

  const resp = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: "OFFSCREEN_START",
    streamId,
    captureId,
    withAudio,
  });
  if (!resp || !resp.ok) {
    pendingMeta.delete(captureId);
    throw new Error((resp && resp.error) || "Failed to start the recorder");
  }

  recordingState.active = true;
  recordingState.tabId = tab.id;
  updateBadge(true);
}

async function ensureOffscreen() {
  const has = await chrome.offscreen.hasDocument();
  if (has) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA", "DISPLAY_MEDIA"],
    justification: "Record the active tab for a bug report.",
  });
}

let closeTimer = null;
function closeOffscreenSoon() {
  if (closeTimer) clearTimeout(closeTimer);
  closeTimer = setTimeout(async () => {
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch (_) {}
  }, 2000);
}

// ---------------------------------------------------------------------------
// Linear ticket creation
// ---------------------------------------------------------------------------
async function handleCreateTicket(msg) {
  const key = await getKey();
  if (!key) throw new Error("No Linear API key set. Open the extension options.");

  const cap = await getCapture(msg.captureId);
  if (!cap) throw new Error("Capture not found (it may have expired).");

  let assetUrl = null;
  if (msg.includeAttachment !== false) {
    const blob = await captureToBlob(cap);
    const filename =
      cap.kind === "video" ? `captura-${cap.id}.webm` : `captura-${cap.id}.png`;
    assetUrl = await linear.uploadFile(key, blob, filename);
  }

  const description = buildDescription(msg.description, cap, assetUrl);

  const input = {
    teamId: msg.teamId,
    title: msg.title || "Bug report",
    description,
  };
  if (msg.projectId) input.projectId = msg.projectId;
  if (msg.stateId) input.stateId = msg.stateId;
  if (typeof msg.priority === "number") input.priority = msg.priority;
  if (Array.isArray(msg.labelIds) && msg.labelIds.length) input.labelIds = msg.labelIds;

  const issue = await linear.createIssue(key, input);

  // Best-effort cleanup once the ticket exists.
  try {
    await deleteCapture(cap.id);
  } catch (_) {}

  return issue;
}

function buildDescription(userText, cap, assetUrl) {
  const parts = [];
  if (userText && userText.trim()) parts.push(userText.trim());

  if (assetUrl) {
    if (cap.kind === "video") {
      parts.push(`\n**🎥 Screen recording:** [Watch](${assetUrl})`);
    } else {
      parts.push(`\n![screenshot](${assetUrl})`);
    }
  }

  const m = cap.meta || {};
  const envRows = [];
  if (m.url) envRows.push(`| URL | ${m.url} |`);
  if (m.userAgent) envRows.push(`| User agent | ${m.userAgent} |`);
  if (m.platform) envRows.push(`| Platform | ${m.platform} |`);
  if (m.viewport) envRows.push(`| Viewport | ${m.viewport.width}×${m.viewport.height} @${m.viewport.dpr}x |`);
  if (m.screen) envRows.push(`| Screen | ${m.screen.width}×${m.screen.height} |`);
  if (m.language) envRows.push(`| Language | ${m.language} |`);
  if (m.timezone) envRows.push(`| Timezone | ${m.timezone} |`);
  if (m.connection && m.connection.effectiveType) envRows.push(`| Network | ${m.connection.effectiveType} |`);
  if (cap.kind === "video" && cap.durationMs) envRows.push(`| Recording length | ${(cap.durationMs / 1000).toFixed(1)}s |`);

  if (envRows.length) {
    parts.push(`\n### Environment\n\n| | |\n|---|---|\n${envRows.join("\n")}`);
  }

  const logs = cap.logs || [];
  const consoleLines = logs
    .filter((l) => l.kind === "console" || l.kind === "error")
    .slice(-50)
    .map((l) => {
      if (l.kind === "error") return `[error] ${l.payload.message || ""} ${l.payload.stack ? "\n" + l.payload.stack : ""}`;
      return `[${l.payload.level}] ${(l.payload.args || []).join(" ")}`;
    });
  if (consoleLines.length) {
    parts.push(`\n### Console (last ${consoleLines.length})\n\n\`\`\`\n${truncate(consoleLines.join("\n"), 6000)}\n\`\`\``);
  }

  const netLines = logs
    .filter((l) => l.kind === "network")
    .slice(-50)
    .map((l) => `${l.payload.status || "ERR"} ${l.payload.method || ""} ${l.payload.url || ""} (${l.payload.durationMs || "?"}ms)`);
  if (netLines.length) {
    parts.push(`\n### Network (last ${netLines.length})\n\n\`\`\`\n${truncate(netLines.join("\n"), 6000)}\n\`\`\``);
  }

  parts.push(`\n<sub>Filed with Captura 🐛</sub>`);
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function captureToBlob(cap) {
  if (cap.blob) return cap.blob;
  if (cap.dataUrl) {
    const res = await fetch(cap.dataUrl);
    return await res.blob();
  }
  throw new Error("Capture has no data");
}

function serializeCapture(cap) {
  if (!cap) return null;
  // Blobs aren't structured-cloneable across the messaging boundary in a way
  // the editor can rebuild a URL from, so hand back an object URL for video.
  const out = {
    id: cap.id,
    kind: cap.kind,
    mimeType: cap.mimeType,
    durationMs: cap.durationMs || null,
    createdAt: cap.createdAt,
    meta: cap.meta || null,
    logs: cap.logs || [],
  };
  if (cap.dataUrl) out.dataUrl = cap.dataUrl;
  // For video, the editor reads the blob itself from IndexedDB (see editor.js).
  return out;
}

async function collectMeta(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "CAPTURA_COLLECT_META" });
  } catch (_) {
    // Content script may not be present (e.g. chrome:// pages).
    try {
      const tab = await chrome.tabs.get(tabId);
      return { url: tab.url, title: tab.title };
    } catch (__) {
      return {};
    }
  }
}

async function getTab(tabId) {
  if (tabId != null) return chrome.tabs.get(tabId);
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!active) throw new Error("No active tab");
  return active;
}

async function openEditor(captureId) {
  const url = chrome.runtime.getURL(`editor.html?id=${encodeURIComponent(captureId)}`);
  await chrome.tabs.create({ url });
}

async function getKey() {
  const { linearApiKey } = await chrome.storage.local.get("linearApiKey");
  return linearApiKey || null;
}

async function withKey(fn) {
  const key = await getKey();
  if (!key) throw new Error("No Linear API key set. Open the extension options.");
  return fn(key);
}

function updateBadge(recording) {
  try {
    chrome.action.setBadgeText({ text: recording ? "REC" : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#E5484D" });
  } catch (_) {}
}

function newId() {
  return `cap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n) + "\n…(truncated)" : s;
}

function errStr(err) {
  return String(err && err.message ? err.message : err);
}

// Housekeeping on startup.
chrome.runtime.onStartup.addListener(() => pruneCaptures().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => pruneCaptures().catch(() => {}));
