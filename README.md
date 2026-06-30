# Captura — a Jam.dev-style bug reporter for Linear

A Manifest V3 Chrome extension that captures a **screenshot** or **screen recording** of
the current tab — automatically bundling **console logs, network requests, and environment
metadata** — then files it as a **Linear issue** in one click. Think [Jam.dev](https://jam.dev),
but the report lands directly in your Linear project with the capture attached.

## Features

- 📸 **Screenshot** the visible tab (`chrome.tabs.captureVisibleTab`).
- 📄 **Full-page screenshot** — auto-scrolls the page and stitches every viewport
  into one tall image on an `OffscreenCanvas` (fixed/sticky headers are hidden after
  the first tile so they aren't duplicated).
- ✂️ **Capture area** — drag to select a region on the page; only that rectangle is kept.
- 🎥 **Screen recording** of the tab as WebM, with optional tab audio
  (`chrome.tabCapture` → offscreen document → `MediaRecorder`).
- 🖊️ **Annotation editor** for screenshots — rectangle, arrow, freehand, **text**
  (drag a box, then type — it wraps to the box), and a **blur/redact** tool for hiding
  sensitive data. The **select** tool drags any annotation to reposition it; **undo** is on
  the toolbar and ⌘/Ctrl+Z.
- 🗂️ **Multiple captures per issue** — keep the editor open and take more
  screenshots/recordings; each is appended to the same report. Annotate every shot
  individually and give each its own note, on top of one general issue description.
- 🐞 **Automatic diagnostics** captured in the background, just like Jam:
  - `console.log/info/warn/error` + uncaught errors & promise rejections
  - `fetch` and `XMLHttpRequest` calls (method, status, duration)
  - environment: URL, user agent, viewport, screen, language, timezone, network type
- 🎯 **One-click Linear issue** — pick team, project, **status**, priority, and labels. The
  capture is uploaded to Linear's CDN and embedded; diagnostics are appended to the description.

## How it fits together

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, registrations |
| `background.js` | Service worker — orchestration, per-tab log ring buffer, Linear brokerage |
| `offscreen.html/js` | Offscreen document that runs `MediaRecorder` for tab video |
| `content.js` + `inject.js` | Capture console/network/errors from the page's main world |
| `popup.html/js/css` | Start a screenshot/recording; stop a recording |
| `editor.html/js/css` | Preview, annotate, and fill in the Linear issue form |
| `options.html/js/css` | Store the Linear API key and pick defaults |
| `linear.js` | Linear GraphQL client (upload + issue create) |
| `db.js` | IndexedDB store for capture blobs + drafts shared across contexts |

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`jam-linear`).
4. Pin the **Captura** icon to the toolbar.

## Connect Linear

1. In Linear: **Settings → Security & access → Personal API keys → New key**.
2. Click the Captura icon → ⚙ (or right-click → Options).
3. Paste the key, click **Save & verify**, then optionally pick a default team/project.

The key is stored with `chrome.storage.local` and is only ever sent to `api.linear.app`.

## Use it

1. Click the Captura icon on any `http(s)` page.
2. Choose a mode:
   - **Screenshot** — the currently visible area.
   - **Full page** — scrolls top-to-bottom and stitches it together (takes a few seconds;
     `captureVisibleTab` is rate-limited to ~2/sec, so each viewport is ~0.55s).
   - **Capture area** — drag a rectangle on the page; press **Esc** to cancel.
   - **Record screen** — records the tab as video; keeps going if you close the popup —
     reopen it and hit **Stop & edit**.
3. The editor opens: annotate (screenshots), review the captured console/network/env,
   write a title + description, pick team/project/priority/labels.
4. **Add more shots to the same issue** (optional): leave the editor tab open and capture
   again from the popup — the new capture is appended to the report and shown in the
   thumbnail strip at the bottom of the editor. Click a thumbnail to switch between shots;
   each keeps its own annotations and its own note. The popup shows a running count and an
   **Open editor** / **New** control; use **New report** to start a fresh, separate issue.
5. Click **Create issue** — every screenshot is embedded inline (in order, with its note)
   and attached; you'll get a link to the new Linear issue.

## Notes & limitations

- Capture works on regular `http(s)`/`file` pages; Chrome blocks it on `chrome://`,
  the Web Store, and other privileged pages.
- Page-world console/network capture is best-effort: very strict site CSPs can block the
  injected hook. Screenshot/video still work in that case.
- Console/network history lives in an in-memory ring buffer (last 500 events per tab) and
  resets on navigation — it reflects activity since the page loaded while the extension was active.
- Full-page capture stitches **vertically**; extremely tall pages are clamped to ~32,000px
  (a canvas dimension limit) and the editor flags it if truncation happened. A thin scrollbar
  may show at the right edge of stitched tiles. Lazy-loaded content is captured as it scrolls in.
- Captures are stored locally in IndexedDB and deleted after a successful issue is created
  (and pruned after 24h otherwise).

## Privacy

Everything runs locally. Captures and logs never leave your machine except the single
upload to Linear when you click **Create issue**.
