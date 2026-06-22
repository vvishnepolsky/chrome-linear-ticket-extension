// content.js — isolated-world bridge. Injects inject.js into the page's
// main world and relays the events it posts to the service worker, which
// keeps a per-tab ring buffer. Also answers a metadata request from the
// editor/service worker.

(function () {
  // Inject the page-world hook as early as possible.
  try {
    const s = document.createElement("script");
    s.src = chrome.runtime.getURL("inject.js");
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
    s.onload = () => s.remove();
  } catch (_) {
    /* some pages (e.g. strict CSP) may block this — capture still works
       for screenshots/video, just without page-world console/network. */
  }

  // Relay page-world events to the background ring buffer.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.__captura !== true || data.src !== "captura-page") return;
    chrome.runtime
      .sendMessage({ type: "CAPTURA_EVENT", kind: data.kind, payload: data.payload, ts: data.ts })
      .catch(() => {});
  });

  // State used while stitching a full-page screenshot.
  const fp = { origX: 0, origY: 0, origBehavior: "", hiddenFixed: [], fixedHidden: false };

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "CAPTURA_COLLECT_META":
        sendResponse(collectMeta());
        return true;

      case "CAPTURA_PREPARE_FULLPAGE": {
        fp.origX = window.scrollX;
        fp.origY = window.scrollY;
        fp.origBehavior = document.documentElement.style.scrollBehavior;
        document.documentElement.style.scrollBehavior = "auto";
        fp.hiddenFixed = [];
        fp.fixedHidden = false;
        const de = document.documentElement;
        const b = document.body;
        const totalHeight = Math.max(
          de.scrollHeight, de.offsetHeight, de.clientHeight,
          b ? b.scrollHeight : 0, b ? b.offsetHeight : 0
        );
        const totalWidth = Math.max(de.scrollWidth, de.clientWidth, b ? b.scrollWidth : 0);
        sendResponse({
          totalHeight,
          totalWidth,
          viewportHeight: window.innerHeight,
          viewportWidth: document.documentElement.clientWidth,
          dpr: window.devicePixelRatio || 1,
        });
        return true;
      }

      case "CAPTURA_SCROLL_TO": {
        if (msg.hideFixed && !fp.fixedHidden) hideFixedElements();
        window.scrollTo(0, msg.y);
        // Two rAFs so the browser has actually painted at the new offset.
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            sendResponse({ scrollY: window.scrollY, scrollX: window.scrollX })
          )
        );
        return true;
      }

      case "CAPTURA_FINISH_FULLPAGE": {
        restoreFixedElements();
        window.scrollTo(fp.origX, fp.origY);
        document.documentElement.style.scrollBehavior = fp.origBehavior || "";
        sendResponse({ ok: true });
        return true;
      }

      case "CAPTURA_START_AREA_SELECT":
        startAreaSelect();
        sendResponse({ ok: true });
        return true;
    }
  });

  // Hide position:fixed / sticky elements so they aren't duplicated on every
  // stitched tile. The first tile is captured with them visible.
  function hideFixedElements() {
    fp.fixedHidden = true;
    const all = document.body ? document.body.getElementsByTagName("*") : [];
    for (const el of all) {
      let pos;
      try { pos = getComputedStyle(el).position; } catch (_) { continue; }
      if (pos === "fixed" || pos === "sticky") {
        fp.hiddenFixed.push([el, el.style.visibility]);
        el.style.visibility = "hidden";
      }
    }
  }
  function restoreFixedElements() {
    for (const [el, v] of fp.hiddenFixed) el.style.visibility = v;
    fp.hiddenFixed = [];
    fp.fixedHidden = false;
  }

  // Drag-to-select overlay for area capture. On mouseup it removes itself and
  // tells the service worker which viewport rectangle to crop.
  function startAreaSelect() {
    if (document.getElementById("__captura_area_overlay")) return;

    const overlay = document.createElement("div");
    overlay.id = "__captura_area_overlay";
    Object.assign(overlay.style, {
      position: "fixed", inset: "0", zIndex: "2147483647",
      cursor: "crosshair", background: "transparent",
    });

    const sel = document.createElement("div");
    Object.assign(sel.style, {
      position: "fixed", display: "none", left: "0", top: "0", width: "0", height: "0",
      border: "2px solid #5E6AD2", background: "rgba(94,106,210,0.10)",
      boxShadow: "0 0 0 100vmax rgba(0,0,0,0.30)", zIndex: "2147483647", pointerEvents: "none",
    });

    const hint = document.createElement("div");
    hint.textContent = "Drag to select an area · Esc to cancel";
    Object.assign(hint.style, {
      position: "fixed", top: "12px", left: "50%", transform: "translateX(-50%)",
      zIndex: "2147483647", background: "rgba(20,20,24,0.92)", color: "#fff",
      font: "13px -apple-system, sans-serif", padding: "7px 14px", borderRadius: "8px",
      pointerEvents: "none", boxShadow: "0 2px 12px rgba(0,0,0,0.4)",
    });

    overlay.appendChild(sel);
    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(hint);

    let startX = 0, startY = 0, dragging = false;

    const rectOf = (e) => {
      const x = Math.min(startX, e.clientX);
      const y = Math.min(startY, e.clientY);
      return { x, y, width: Math.abs(e.clientX - startX), height: Math.abs(e.clientY - startY) };
    };
    const paint = (r) => {
      sel.style.display = "block";
      sel.style.left = r.x + "px";
      sel.style.top = r.y + "px";
      sel.style.width = r.width + "px";
      sel.style.height = r.height + "px";
    };
    const cleanup = () => {
      overlay.remove();
      hint.remove();
      window.removeEventListener("mousemove", onMove, true);
      window.removeEventListener("mouseup", onUp, true);
      window.removeEventListener("keydown", onKey, true);
    };

    const onDown = (e) => {
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      paint(rectOf(e));
      e.preventDefault();
    };
    const onMove = (e) => { if (dragging) paint(rectOf(e)); };
    const onUp = (e) => {
      if (!dragging) return;
      dragging = false;
      const r = rectOf(e);
      cleanup();
      if (r.width < 5 || r.height < 5) {
        chrome.runtime.sendMessage({ type: "CAPTURA_AREA_CANCELLED" }).catch(() => {});
        return;
      }
      // Let the overlay removal paint before the worker captures the tab.
      requestAnimationFrame(() =>
        requestAnimationFrame(() =>
          chrome.runtime
            .sendMessage({ type: "CAPTURA_AREA_SELECTED", rect: r, dpr: window.devicePixelRatio || 1 })
            .catch(() => {})
        )
      );
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        cleanup();
        chrome.runtime.sendMessage({ type: "CAPTURA_AREA_CANCELLED" }).catch(() => {});
      }
    };

    overlay.addEventListener("mousedown", onDown, true);
    window.addEventListener("mousemove", onMove, true);
    window.addEventListener("mouseup", onUp, true);
    window.addEventListener("keydown", onKey, true);
  }

  function collectMeta() {
    const nav = navigator;
    const scr = window.screen || {};
    let connection = null;
    try {
      const c = nav.connection || nav.mozConnection || nav.webkitConnection;
      if (c) connection = { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt };
    } catch (_) {}
    return {
      url: location.href,
      title: document.title,
      userAgent: nav.userAgent,
      platform: nav.platform,
      language: nav.language,
      languages: nav.languages,
      cookiesEnabled: nav.cookieEnabled,
      online: nav.onLine,
      hardwareConcurrency: nav.hardwareConcurrency,
      deviceMemory: nav.deviceMemory,
      connection,
      viewport: { width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio },
      screen: { width: scr.width, height: scr.height, availWidth: scr.availWidth, availHeight: scr.availHeight, colorDepth: scr.colorDepth },
      timezone: (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return null; } })(),
      referrer: document.referrer,
    };
  }
})();
