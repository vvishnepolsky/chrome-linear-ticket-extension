// db.js — tiny IndexedDB wrapper for stashing capture blobs between
// the service worker, the offscreen recorder, and the editor tab.
// chrome.storage.local has a ~10MB quota and chokes on big video blobs,
// so captures live in IndexedDB instead.

const DB_NAME = "captura";
const DB_VERSION = 2;
const STORE = "captures";
const DRAFT_STORE = "drafts";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      // A draft groups one or more captures into a single Linear issue.
      if (!db.objectStoreNames.contains(DRAFT_STORE)) {
        db.createObjectStore(DRAFT_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function putCapture(capture) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(capture);
    tx.oncomplete = () => resolve(capture.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCapture(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteCapture(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---- drafts ----------------------------------------------------------------
// A draft is { id, captureIds: [...], createdAt }. Captures are stored
// individually (above); the draft just records their order/membership.

export async function putDraft(draft) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).put(draft);
    tx.oncomplete = () => resolve(draft.id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getDraft(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readonly");
    const req = tx.objectStore(DRAFT_STORE).get(id);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

export async function deleteDraft(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DRAFT_STORE, "readwrite");
    tx.objectStore(DRAFT_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Drop captures and drafts older than `maxAgeMs` so abandoned reports don't
// pile up.
export async function pruneCaptures(maxAgeMs = 24 * 60 * 60 * 1000) {
  const db = await openDB();
  const cutoff = Date.now() - maxAgeMs;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([STORE, DRAFT_STORE], "readwrite");
    const prune = (storeName) => {
      const req = tx.objectStore(storeName).openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) return;
        if ((cursor.value.createdAt || 0) < cutoff) cursor.delete();
        cursor.continue();
      };
    };
    prune(STORE);
    prune(DRAFT_STORE);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
