/**
 * background.js - the only part that talks to xKiro. Holds the key, picks the model,
 * reads the page through content.js, validates the model's proposed actions.
 * Chrome/Edge/Brave/Opera load it as a service worker; Firefox as a background script.
 */
/* global UPACore */
if (typeof importScripts === 'function' && typeof UPACore === 'undefined') importScripts('lib/core.js');

const api = globalThis.browser || globalThis.chrome;
const C = UPACore;
const IS_FIREFOX = typeof globalThis.browser !== 'undefined' && !!(globalThis.browser.runtime && globalThis.browser.runtime.getBrowserInfo);

// ---------- storage ----------

async function getLocal(keys) { return api.storage.local.get(keys); }
async function setLocal(obj) { return api.storage.local.set(obj); }

async function getKey() {
  const { apiKey } = await getLocal('apiKey');
  if (!apiKey) throw C.err('NO_KEY', 'Add your xKiro API key in Settings first.');
  return apiKey;
}

async function getSettings() { const { settings } = await getLocal('settings'); return C.mergeSettings(settings); }

async function baseUrl() {
  // devBaseUrl exists only for the automated tests (a local mock server). It is never set by the UI.
  const { devBaseUrl } = await getLocal('devBaseUrl');
  return devBaseUrl && /^http:\/\/(127\.0\.0\.1|localhost):\d+\/v1$/.test(devBaseUrl) ? devBaseUrl : C.UPA.BASE_URL;
}

// ---------- xKiro ----------

async function xk(method, path, payload, retries) {
  const key = await getKey();
  const url = (await baseUrl()) + path;
  const max = retries == null ? 1 : retries;
  for (let attempt = 0; ; attempt++) {
    let resp;
    try {
      resp = await fetch(url, {
        method: method,
        headers: Object.assign({ 'x-api-key': key, 'Accept': 'application/json' }, payload ? { 'Content-Type': 'application/json' } : {}),
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: 'error',
        credentials: 'omit'
      });
    } catch (e) {
      if (attempt < max) { await sleep(800 * Math.pow(2, attempt)); continue; }
      throw C.err('NETWORK', 'Could not reach xKiro. Check your internet connection and try again.', { retryable: true });
    }
    const text = await resp.text();
    if (resp.ok) {
      try { return JSON.parse(text); } catch (e) { throw C.err('MALFORMED', 'xKiro sent a reply that is not valid JSON.', { retryable: true }); }
    }
    const e = C.mapError(resp.status, text, key);
    if ((e.code === 'RATE_LIMIT' || e.code === 'SERVER') && attempt < max) {
      const ra = Number(resp.headers.get('retry-after'));
      await sleep(Math.min(10000, ra ? ra * 1000 : 1000 * Math.pow(2, attempt)));
      continue;
    }
    throw e;
  }
}

function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

async function refreshCatalog() {
  const resp = await xk('GET', C.UPA.ENDPOINTS.models, null, 1);
  const arr = Array.isArray(resp) ? resp : (resp.data || resp.models || []);
  if (!Array.isArray(arr)) throw C.err('MALFORMED', 'xKiro returned the model list in an unexpected shape.');
  const catalog = { fetchedAt: Date.now(), models: arr.map(C.normalizeModel).filter(Boolean) };
  await setLocal({ catalog: catalog });
  return catalog;
}

async function getCatalog(force) {
  const { catalog } = await getLocal('catalog');
  if (!force && catalog && Date.now() - catalog.fetchedAt < C.UPA.CATALOG_TTL_MS) return catalog;
  try { return await refreshCatalog(); }
  catch (e) { if (catalog && ['NETWORK', 'SERVER', 'RATE_LIMIT'].indexOf(e.code) >= 0) return catalog; throw e; }
}

/**
 * Streaming chat: calls onDelta(textSoFar) as words arrive. Falls back to the next model only
 * if a model fails before sending anything. Servers that ignore "stream" still work (plain JSON).
 */
async function streamChat(messages, task, opts, onDelta) {
  opts = opts || {};
  const [s, cat, key, base] = await Promise.all([getSettings(), getCatalog(false), getKey(), baseUrl()]);
  const chain = C.pickModels(cat.models, s, task, C.estimateTokens(messages));
  const tried = []; let last = null;
  for (const model of chain) {
    let text = '';
    try {
      const resp = await fetch(base + C.UPA.ENDPOINTS.chat, {
        method: 'POST', redirect: 'error', credentials: 'omit', signal: opts.signal,
        headers: { 'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'text/event-stream, application/json' },
        body: JSON.stringify({ model: model, messages: messages, temperature: opts.temperature == null ? 0.4 : opts.temperature, max_tokens: opts.maxTokens || 1500, stream: true })
      }).catch(function (e) {
        if (e && e.name === 'AbortError') throw C.err('STOPPED', 'Stopped.');
        throw C.err('NETWORK', 'Could not reach xKiro. Check your internet connection and try again.', { retryable: true });
      });
      if (!resp.ok) throw C.mapError(resp.status, await resp.text(), key);
      const type = resp.headers.get('content-type') || '';
      if (type.indexOf('text/event-stream') < 0 || !resp.body) {
        const j = JSON.parse(await resp.text());
        const ch = j && j.choices && j.choices[0];
        let c = ch && ch.message && ch.message.content;
        if (Array.isArray(c)) c = c.map(function (p) { return typeof p === 'string' ? p : (p && p.text) || ''; }).join('');
        if (typeof c !== 'string' || !c.trim()) throw C.err('MALFORMED', 'xKiro returned an empty answer.', { retryable: true });
        onDelta(c);
        return { text: c, model: model };
      }
      const reader = resp.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
          const d = C.sseDelta(line);
          if (d) { text += d; onDelta(text); }
        }
      }
      const tail = C.sseDelta(buf); if (tail) { text += tail; onDelta(text); }
      if (!text.trim()) throw C.err('MALFORMED', 'xKiro returned an empty answer.', { retryable: true });
      return { text: text, model: model };
    } catch (e) {
      if (e && e.name === 'AbortError') throw C.err('STOPPED', 'Stopped.');
      last = e; tried.push(model);
      if (text || C.FALLBACK_CODES.indexOf(e.code) < 0) throw e; // never switch models mid-answer
    }
  }
  throw C.err(last ? last.code : 'MODEL_UNAVAILABLE', (last ? last.message : 'No model answered.') + ' Tried: ' + tried.join(', ') + '.', { retryable: true });
}

// ---------- page access ----------

const BLOCKED_PAGE = /^(chrome|edge|brave|opera|vivaldi|about|moz-extension|chrome-extension|view-source|devtools):|^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|addons\.mozilla\.org|microsoftedge\.microsoft\.com\/addons)/i;

async function scanTab(tabId) {
  const tab = await api.tabs.get(tabId);
  if (!tab.url || BLOCKED_PAGE.test(tab.url)) {
    throw C.err('PAGE_BLOCKED', 'Browsers do not let extensions read this kind of page (settings, new-tab or extension store pages). Open a normal website and ask again.');
  }
  try {
    await api.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
  } catch (e) {
    const m = String(e && e.message || e);
    if (/permission|Cannot access|host/i.test(m)) throw C.err('NO_PAGE_ACCESS', 'Universal Page AI does not have permission to read this site yet. Press "Allow access to websites" at the top of the panel.');
    throw C.err('PAGE', 'Could not read this page: ' + C.clip(m, 160));
  }
  const res = await api.tabs.sendMessage(tabId, { type: 'upa:scan' });
  if (!res || !res.ok) throw C.err('PAGE', (res && res.error && res.error.message) || 'The page did not answer.');
  return res.data;
}

async function applyToTab(tabId, action) {
  await api.scripting.executeScript({ target: { tabId: tabId }, files: ['content.js'] });
  const res = await api.tabs.sendMessage(tabId, { type: 'upa:apply', action: action });
  if (!res || !res.ok) throw C.err('PAGE', (res && res.error && res.error.message) || 'The page did not answer.');
  return res.data;
}

// ---------- the main request ----------

/**
 * One request. onEvent receives {type:'status'|'delta'|'warnings', ...} while it runs.
 * Page scan, model catalog and saved facts load in parallel to save time.
 */
async function ask(msg, onEvent) {
  onEvent = onEvent || function () {};
  const question = String(msg.question || '').trim();
  if (!question) throw C.err('BAD_INPUT', 'Type what you want to know or do.');
  const t0 = Date.now();
  const [key, page, st] = await Promise.all([getKey(), scanTab(msg.tabId), getLocal('facts'), getCatalog(false)]);
  const facts = st.facts || '';
  const warnings = [];
  const inj = C.scanInjection(page.text + '\n' + page.selection);
  if (inj.length) warnings.push('This page contains text aimed at AI assistants. It was treated as plain page content and ignored.');
  if (page.canvasEditor) warnings.push('Google Docs/Sheets/Slides draw their pages on a canvas, so only part of the content may be readable. Select text and copy it into your question if something is missing.');
  if (warnings.length) onEvent({ type: 'warnings', warnings: warnings });

  const messages = C.buildMessages(page, question, msg.history, facts);
  const plan = C.classifyTask(question);
  onEvent({ type: 'status', text: 'Thinking' });
  let lastSent = 0;
  const r = await streamChat(messages, plan.task, { maxTokens: plan.maxTokens, signal: msg.signal }, function (soFar) {
    const vis = C.redact(C.visibleAnswer(soFar), key);
    if (vis.length !== lastSent) { lastSent = vis.length; onEvent({ type: 'delta', text: vis }); }
  });
  const parsed = C.parseReply(r.text);
  const v = C.validateActions(parsed.actions, page, { facts: facts || '', userText: question + '\n' + (msg.history || []).map(function (h) { return h.role === 'user' ? h.content : ''; }).join('\n'), hasSelection: page.selectionEditable, key: key });
  v.accepted.forEach(function (a) { if (a.type === 'fill') a.expectOld = a.old; });
  return {
    answer: C.redact(parsed.answer, key), followUp: parsed.followUp, actions: v.accepted,
    rejected: v.rejected.map(function (x) { return x.reason; }).concat(parsed.badActions ? ['the suggested edits were not readable'] : []),
    model: r.model, warnings: warnings, task: plan.task, ms: Date.now() - t0,
    page: { title: page.title, url: page.url, fields: page.fields.length, chars: page.text.length, selection: !!page.selection }
  };
}

// Streaming channel: the panel opens a port, sends one question, receives deltas then the result.
api.runtime.onConnect.addListener(function (port) {
  if (port.name !== 'upa:ask') return;
  const own = api.runtime.getURL('');
  if (!port.sender || port.sender.id !== api.runtime.id || !port.sender.url || port.sender.url.indexOf(own) !== 0) { port.disconnect(); return; }
  const ctrl = new AbortController();
  let open = true;
  port.onDisconnect.addListener(function () { open = false; ctrl.abort(); });
  const post = function (m) { if (open) { try { port.postMessage(m); } catch (e) { open = false; } } };
  port.onMessage.addListener(function (m) {
    if (!m || m.type !== 'ask') return;
    ask({ tabId: m.tabId, question: m.question, history: m.history, signal: ctrl.signal }, post).then(function (result) {
      post({ type: 'done', result: result });
    }, function (e) {
      getLocal('apiKey').then(function (st) {
        post({ type: 'error', error: { code: e && e.code || 'UNEXPECTED', message: C.redact(e && e.message || String(e), st.apiKey), retryable: !!(e && e.retryable) } });
      });
    });
  });
});

// ---------- messages from the panel ----------

const HANDLERS = {
  'upa:ask': function (m) { return ask(m); },
  'upa:apply': async function (m) { return applyToTab(m.tabId, m.action); },
  'upa:highlight': async function (m) {
    await api.scripting.executeScript({ target: { tabId: m.tabId }, files: ['content.js'] });
    return api.tabs.sendMessage(m.tabId, { type: 'upa:highlight', field: m.field });
  },
  'upa:state': async function () {
    const st = await getLocal(['apiKey', 'facts', 'catalog']);
    const k = st.apiKey || '';
    return { hasKey: !!k, maskedKey: k ? '••••••••' + k.slice(-4) : '', settings: await getSettings(), facts: st.facts || '', modelCount: st.catalog ? st.catalog.models.length : 0, version: C.UPA.VERSION, firefox: IS_FIREFOX };
  },
  'upa:saveKey': async function (m) {
    const key = String(m.key || '').trim();
    if (!key || /\s/.test(key) || key.length < 8 || key.length > 300) throw C.err('BAD_INPUT', 'That does not look like an API key (no spaces, 8 to 300 characters).');
    await setLocal({ apiKey: key });
    await api.storage.local.remove('catalog');
    return { maskedKey: '••••••••' + key.slice(-4) };
  },
  'upa:clearKey': async function () { await api.storage.local.remove(['apiKey', 'catalog']); return { cleared: true }; },
  'upa:saveSettings': async function (m) {
    const cur = await getSettings();
    const p = m.patch || {};
    const next = C.mergeSettings(Object.assign({}, cur, {
      freeOnly: 'freeOnly' in p ? !!p.freeOnly : cur.freeOnly,
      allowPaid: 'allowPaid' in p ? !!p.allowPaid : cur.allowPaid,
      modelMode: p.modelMode === 'manual' ? 'manual' : p.modelMode === 'auto' ? 'auto' : cur.modelMode,
      manualModel: 'manualModel' in p ? String(p.manualModel || '') : cur.manualModel
    }));
    await setLocal({ settings: next });
    return next;
  },
  'upa:saveFacts': async function (m) { const f = String(m.facts || '').slice(0, 4000); await setLocal({ facts: f }); return { facts: f }; },
  'upa:test': async function () {
    const t0 = Date.now(); const cat = await refreshCatalog();
    const s = await getSettings();
    const elig = cat.models.filter(function (m) { return C.isEligible(m, s); }).length;
    return { modelCount: cat.models.length, eligible: elig, ms: Date.now() - t0 };
  },
  'upa:models': async function (m) {
    const cat = await getCatalog(!!m.force); const s = await getSettings();
    return { fetchedAt: cat.fetchedAt, models: cat.models.map(function (x) { return { id: x.id, free: x.free, eligible: C.isEligible(x, s), context: x.context }; })
      .sort(function (a, b) { return (b.eligible - a.eligible) || a.id.localeCompare(b.id); }).slice(0, 120) };
  }
};

api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || !HANDLERS[msg.type]) return false;
  // Only the extension's own pages (the panel) may call these; content scripts run with the web page's URL.
  const own = api.runtime.getURL('');
  if (sender.id !== api.runtime.id || !sender.url || sender.url.indexOf(own) !== 0) { sendResponse({ ok: false, error: { code: 'FORBIDDEN', message: 'Not allowed.' } }); return false; }
  HANDLERS[msg.type](msg).then(function (data) { sendResponse({ ok: true, data: data }); }, function (e) {
    getLocal('apiKey').then(function (st) {
      sendResponse({ ok: false, error: { code: e && e.code || 'UNEXPECTED', message: C.redact(e && e.message || String(e), st.apiKey), retryable: !!(e && e.retryable) } });
    });
  });
  return true; // async response
});

// ---------- opening the panel ----------

function openPanel(tab) {
  if (api.sidePanel && api.sidePanel.open) return api.sidePanel.open({ windowId: tab.windowId });
  if (api.sidebarAction && api.sidebarAction.open) return api.sidebarAction.open();
  return Promise.resolve();
}

if (api.sidePanel && api.sidePanel.setPanelBehavior) {
  api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(function () {});
} else if (api.action && api.sidebarAction) {
  api.action.onClicked.addListener(function () { api.sidebarAction.toggle(); });
}

api.runtime.onInstalled.addListener(function () {
  api.contextMenus.removeAll(function () {
    api.contextMenus.create({ id: 'upa-selection', title: 'Ask Universal Page AI about "%s"', contexts: ['selection'] });
    api.contextMenus.create({ id: 'upa-editable', title: 'Write here with Universal Page AI', contexts: ['editable'] });
    api.contextMenus.create({ id: 'upa-page', title: 'Ask Universal Page AI about this page', contexts: ['page'] });
  });
});

api.contextMenus.onClicked.addListener(function (info, tab) {
  // Open first: the panel can only be opened directly inside the click.
  const opened = openPanel(tab);
  const prompt = info.menuItemId === 'upa-selection' ? 'Explain or help with the text I selected.'
    : info.menuItemId === 'upa-editable' ? 'Help me write in the box I clicked. ' : '';
  setLocal({ pendingPrompt: { text: prompt, tabId: tab.id, at: Date.now(), autoSend: info.menuItemId === 'upa-selection' } });
  return opened;
});

if (api.commands) {
  api.commands.onCommand.addListener(function (cmd, tab) { if (cmd === 'open-panel' && tab) openPanel(tab); });
}
