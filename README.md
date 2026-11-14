# Universal Page AI

A browser extension that works on **any website**. Open the side panel, ask about the page you're on, and have it write into text boxes and forms. It uses your own **xKiro** API key and free models by default.

Works in **Chrome, Edge, Brave, Opera, Vivaldi** (one build) and **Firefox** (its own build). Safari can be added later from the same code.

## What it does

- **Answers anything about the page:** summaries, explanations, "what do I need to fill in here?", comparisons.
- **Writes for you:** drafts replies, fills in forms from facts you saved, rewrites text you selected, inserts text where your cursor is.
- **Previews every change first.** Nothing on the page changes until you press **Apply**. Applied text can be undone with Ctrl+Z.
- **Right-click menu:** "Ask Universal Page AI about '…'", "Write here with Universal Page AI".
- **Shortcut:** Ctrl+Shift+Y (Cmd+Shift+Y on Mac) opens the panel.

## Speed

- **Streaming:** answers appear word by word as the model writes them, so the first words show up in about a second.
- **Right model for the job:** short questions go to a fast free model with a small reply budget; writing and long analysis use the strong free model.
- **Less to send:** on long pages only the opening and the paragraphs related to your question are sent.
- **Parallel start:** reading the page, loading the model list and your saved facts happen at the same time.
- **Stop button:** cancels an answer immediately (the request to xKiro is aborted).

The extension's own work (reading the page, checking suggestions, filling fields) takes a few milliseconds. Almost all waiting is the AI model itself, which is why these changes target that.

## Safety

- The page is read only when you send a message, and only the current tab.
- Password, card-number, hidden and file fields are never read or filled.
- It never clicks, submits, buys, sends or navigates.
- Instructions hidden in web pages are treated as plain text and ignored, and you're warned when a page contains them.
- Personal details (date of birth, ID numbers, and similar) are only filled when you provided them.
- Your key is stored in the browser's extension storage, is never visible to web pages, and is only sent to `api.xkiro.com`.

## Install for testing

```bash
npm run build          # creates dist/chromium and dist/firefox (+ zips)
```

- **Chrome / Edge / Brave / Opera:** open `chrome://extensions` (or `edge://extensions`, etc.), turn on **Developer mode**, click **Load unpacked**, choose `dist/chromium`.
- **Firefox:** open `about:debugging#/runtime/this-firefox` → **Load Temporary Add-on…** → choose `dist/firefox/manifest.json`. Then open the sidebar and press **Allow access to websites** once.

Click the toolbar icon to open the panel → **Settings** → paste your xKiro key → **Test connection**.

## Tests

```bash
npm test               # unit tests for the shared core (routing, safety checks, parsing)
npm run build && npm run e2e   # loads the real extension in Chromium against a mock xKiro and a test form
```

The end-to-end test (26 checks) covers streaming, fast/strong model choice, Stop, answering from page content, the free-model choice, prompt-injection warnings, the password field never leaving the page, filling inputs, dropdowns, textareas, rich editors and framework-controlled inputs, undo, and protected browser pages.

## Layout

| Path | Role |
|---|---|
| `src/lib/core.js` | Shared logic ported from Universal Doc AI: xKiro errors, model routing, prompts, untrusted-data wrapping, action validation |
| `src/background.js` | Talks to xKiro, reads pages via the content script, validates suggestions |
| `src/content.js` | Injected on demand: reads text/selection/fields, applies approved text like typing |
| `src/panel.*` | Side panel (Chromium) / sidebar (Firefox) UI |
| `scripts/build.mjs` | Builds per-browser manifests and zips |

## Publishing

- Chrome Web Store: one-time $5 developer fee. Upload `dist/universal-page-ai-chromium-<version>.zip`.
- Microsoft Edge Add-ons: free, same zip.
- Firefox Add-ons (AMO): free. Upload the firefox zip. Declare that it reads website content when you ask it to.
- Safari: convert with `xcrun safari-web-extension-converter dist/chromium` on a Mac (Apple Developer account).
