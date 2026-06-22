// inject.js — runs in the PAGE's main world (injected by content.js).
// Monkeypatches console, fetch, XHR and listens for errors, then relays
// every event to the content script via window.postMessage. The content
// script forwards them to the service worker, which keeps a ring buffer.
(function () {
  if (window.__capturaInjected) return;
  window.__capturaInjected = true;

  const SRC = "captura-page";
  const MAX_STR = 4000; // cap any single serialized value

  function send(kind, payload) {
    try {
      window.postMessage({ __captura: true, src: SRC, kind, payload, ts: Date.now() }, "*");
    } catch (_) {
      /* posting failed (e.g. payload not cloneable) — drop it */
    }
  }

  function safeStringify(value) {
    try {
      if (typeof value === "string") return value.slice(0, MAX_STR);
      if (value instanceof Error) return (value.stack || value.message || String(value)).slice(0, MAX_STR);
      const seen = new WeakSet();
      const out = JSON.stringify(value, (k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "function") return "[Function]";
        if (typeof v === "bigint") return v.toString();
        return v;
      });
      return (out || String(value)).slice(0, MAX_STR);
    } catch (_) {
      try {
        return String(value).slice(0, MAX_STR);
      } catch (__) {
        return "[Unserializable]";
      }
    }
  }

  // ---- console ----
  ["log", "info", "warn", "error", "debug"].forEach((level) => {
    const original = console[level] ? console[level].bind(console) : function () {};
    console[level] = function (...args) {
      send("console", { level, args: args.map(safeStringify) });
      return original(...args);
    };
  });

  // ---- uncaught errors ----
  window.addEventListener("error", (e) => {
    send("error", {
      message: e.message,
      source: e.filename,
      line: e.lineno,
      col: e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, MAX_STR) : null,
    });
  });

  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    send("error", {
      message: "Unhandled promise rejection",
      stack: reason && reason.stack ? String(reason.stack).slice(0, MAX_STR) : safeStringify(reason),
    });
  });

  // ---- fetch ----
  const origFetch = window.fetch;
  if (origFetch) {
    window.fetch = function (...args) {
      const start = Date.now();
      let url = "";
      let method = "GET";
      try {
        const input = args[0];
        if (typeof input === "string") url = input;
        else if (input && input.url) url = input.url;
        method = (args[1] && args[1].method) || (input && input.method) || "GET";
      } catch (_) {}
      return origFetch
        .apply(this, args)
        .then((res) => {
          send("network", {
            type: "fetch",
            url,
            method,
            status: res.status,
            ok: res.ok,
            durationMs: Date.now() - start,
          });
          return res;
        })
        .catch((err) => {
          send("network", {
            type: "fetch",
            url,
            method,
            status: 0,
            ok: false,
            error: String(err && err.message ? err.message : err),
            durationMs: Date.now() - start,
          });
          throw err;
        });
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest;
  if (XHR) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url) {
      this.__captura = { method, url, start: 0 };
      return origOpen.apply(this, arguments);
    };
    XHR.prototype.send = function () {
      const meta = this.__captura;
      if (meta) {
        meta.start = Date.now();
        this.addEventListener("loadend", () => {
          send("network", {
            type: "xhr",
            url: meta.url,
            method: meta.method,
            status: this.status,
            ok: this.status >= 200 && this.status < 400,
            durationMs: Date.now() - meta.start,
          });
        });
      }
      return origSend.apply(this, arguments);
    };
  }
})();
