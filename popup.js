// popup.js — entry UI. Triggers screenshot / recording and reflects the
// current recording state (recording survives the popup closing because it
// runs in the offscreen document).

const $ = (id) => document.getElementById(id);
let timerInt = null;
let recStart = 0;

function send(msg) {
  return chrome.runtime.sendMessage(msg);
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function showStatus(text, kind = "info") {
  const el = $("status");
  el.textContent = text;
  el.className = `status ${kind}`;
  el.classList.remove("hidden");
}

function setView(recording) {
  $("idle-view").classList.toggle("hidden", recording);
  $("recording-view").classList.toggle("hidden", !recording);
}

function startTimer() {
  recStart = Date.now();
  const tick = () => {
    const s = Math.floor((Date.now() - recStart) / 1000);
    $("rec-timer").textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  tick();
  timerInt = setInterval(tick, 500);
}

function canCapture(tab) {
  if (!tab || !tab.url) return false;
  return /^https?:|^file:/.test(tab.url);
}

async function init() {
  // API key banner
  const { linearApiKey } = await chrome.storage.local.get("linearApiKey");
  if (!linearApiKey) $("no-key").classList.remove("hidden");

  // Reflect recording state
  try {
    const state = await send({ type: "GET_RECORDING_STATE" });
    if (state && state.recording) {
      setView(true);
      startTimer();
    }
  } catch (_) {}

  const tab = await activeTab();
  if (!canCapture(tab)) {
    ["btn-screenshot", "btn-fullpage", "btn-area", "btn-record"].forEach((id) => {
      $(id).disabled = true;
    });
    showStatus("This page can't be captured (try a regular http/https tab).", "info");
  }

  $("settings").onclick = () => chrome.runtime.openOptionsPage();
  $("open-options").onclick = (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  };

  $("btn-screenshot").onclick = async () => {
    $("btn-screenshot").disabled = true;
    showStatus("Capturing…");
    try {
      const tab = await activeTab();
      const resp = await send({ type: "CAPTURE_SCREENSHOT", tabId: tab.id });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      window.close(); // editor opens in a new tab
    } catch (err) {
      showStatus(String(err.message || err), "err");
      $("btn-screenshot").disabled = false;
    }
  };

  $("btn-fullpage").onclick = async () => {
    $("btn-fullpage").disabled = true;
    showStatus("Capturing full page… scrolling through the page, this can take a few seconds.", "info");
    try {
      const tab = await activeTab();
      // Background scrolls + stitches, then opens the editor itself.
      const resp = await send({ type: "CAPTURE_FULLPAGE", tabId: tab.id });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      window.close();
    } catch (err) {
      showStatus(String(err.message || err), "err");
      $("btn-fullpage").disabled = false;
    }
  };

  $("btn-area").onclick = async () => {
    showStatus("Starting area select…");
    try {
      const tab = await activeTab();
      const resp = await send({ type: "START_AREA_SELECT", tabId: tab.id });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      window.close(); // selection happens on the page; editor opens after
    } catch (err) {
      showStatus(String(err.message || err), "err");
    }
  };

  $("btn-record").onclick = async () => {
    $("btn-record").disabled = true;
    showStatus("Starting recorder…");
    try {
      const tab = await activeTab();
      const withAudio = $("with-audio").checked;
      const resp = await send({ type: "START_RECORDING", tabId: tab.id, withAudio });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      setView(true);
      startTimer();
      showStatus("Recording… you can close this popup. Reopen to stop.", "info");
    } catch (err) {
      showStatus(String(err.message || err), "err");
      $("btn-record").disabled = false;
    }
  };

  $("btn-stop").onclick = async () => {
    $("btn-stop").disabled = true;
    if (timerInt) clearInterval(timerInt);
    showStatus("Finishing recording…");
    try {
      const resp = await send({ type: "STOP_RECORDING" });
      if (!resp || !resp.ok) throw new Error(resp && resp.error);
      window.close(); // editor opens once the blob is saved
    } catch (err) {
      showStatus(String(err.message || err), "err");
      $("btn-stop").disabled = false;
    }
  };
}

init();
