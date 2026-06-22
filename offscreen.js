// offscreen.js — performs tab video recording. Service workers can't hold a
// MediaStream/MediaRecorder, so the actual recording happens here in an
// offscreen document. The finished blob is written straight to IndexedDB
// (messaging can't carry a Blob), and we notify the worker with the id.

import { putCapture } from "./db.js";

let recorder = null;
let chunks = [];
let stream = null;
let audioCtx = null;
let currentCaptureId = null;
let startedAt = 0;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return;

  if (msg.type === "OFFSCREEN_START") {
    startRecording(msg.streamId, msg.captureId, msg.withAudio)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message ? err.message : err) }));
    return true; // async
  }

  if (msg.type === "OFFSCREEN_STOP") {
    stopRecording();
    sendResponse({ ok: true });
    return false;
  }
});

async function startRecording(streamId, captureId, withAudio) {
  if (recorder) throw new Error("A recording is already in progress");

  const video = {
    mandatory: {
      chromeMediaSource: "tab",
      chromeMediaSourceId: streamId,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFrameRate: 30,
    },
  };
  const constraints = { video };
  if (withAudio) {
    constraints.audio = {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    };
  }

  stream = await navigator.mediaDevices.getUserMedia(constraints);

  // Capturing tab audio mutes the tab for the user; re-route it to the
  // default output so playback stays audible while we record.
  if (withAudio && stream.getAudioTracks().length) {
    audioCtx = new AudioContext();
    const source = audioCtx.createMediaStreamSource(stream);
    source.connect(audioCtx.destination);
  }

  const mimeType = pickMimeType();
  recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  chunks = [];
  currentCaptureId = captureId;
  startedAt = Date.now();

  recorder.ondataavailable = (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };
  recorder.onstop = onStop;

  // If the user stops sharing via Chrome's native bar, end gracefully.
  stream.getVideoTracks()[0].addEventListener("ended", () => stopRecording());

  recorder.start(1000); // gather data every second
}

function stopRecording() {
  try {
    if (recorder && recorder.state !== "inactive") recorder.stop();
  } catch (_) {}
}

async function onStop() {
  const durationMs = Date.now() - startedAt;
  const type = (recorder && recorder.mimeType) || "video/webm";
  const blob = new Blob(chunks, { type });

  // Tear down the stream/audio graph.
  try {
    if (stream) stream.getTracks().forEach((t) => t.stop());
  } catch (_) {}
  try {
    if (audioCtx) await audioCtx.close();
  } catch (_) {}

  const captureId = currentCaptureId;
  recorder = null;
  stream = null;
  audioCtx = null;
  chunks = [];

  try {
    const existing = await chrome.runtime.sendMessage({ type: "GET_PENDING_CAPTURE", captureId }).catch(() => null);
    await putCapture({
      id: captureId,
      kind: "video",
      blob,
      mimeType: type,
      durationMs,
      createdAt: Date.now(),
      meta: existing && existing.meta ? existing.meta : null,
      logs: existing && existing.logs ? existing.logs : [],
    });
  } catch (_) {
    // Fall back to a minimal record if we couldn't enrich it.
    await putCapture({ id: captureId, kind: "video", blob, mimeType: type, durationMs, createdAt: Date.now() });
  }

  chrome.runtime.sendMessage({ type: "RECORDING_COMPLETE", captureId, durationMs });
}

function pickMimeType() {
  const candidates = [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const c of candidates) {
    if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
  }
  return "";
}
