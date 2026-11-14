/* app.js - installable web app version (for Chromebooks where extensions are blocked).
 * Same core as the extension (../src/lib/core.js). It cannot read or type into other sites:
 * pages come in through Chrome's Share menu or by pasting, results go out with Copy. */
(function () {
  'use strict';
  const C = globalThis.UPACore;
  const $ = function (id) { return document.getElementById(id); };
  const state = { history: [], busy: false, cancel: null };
  const LS = 'upa.';

  // ---------- storage (per-device, wrapped: storage can be blocked) ----------
  function get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }
  function put(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function del(k) { try { localStorage.removeItem(LS + k); } catch (e) { /* ignore */ } }
  const settings = function () { return C.mergeSettings(get('settings', {})); };

  // ---------- helpers ----------
  function h(tag, props, kids) {
    const e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      const v = props[k];
      if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function flash(id, kind, text) { const m = $(id); m.className = 'msg ' + kind; m.textContent = text; m.hidden = !text; }
  function scrollDown() { const l = $('log'); l.scrollTop = l.scrollHeight; }
  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Select and copy'; }
    setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
  }
  function inline(text) {
    const frag = document.createDocumentFragment(); const re = /\*\*([^*]+)\*\*|`([^`]+)`/g; let last = 0; let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(m[1] ? h('strong', { text: m[1] }) : h('code', { text: m[2] })); last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }
  function renderText(text) {
    const box = h('div', { class: 'answer' }); let list = null; let para = [];
    const flushPara = function () { if (para.length) { const p = h('p'); p.appendChild(inline(para.join(' '))); box.appendChild(p); para = []; } };
    String(text || '').split('\n').forEach(function (line) {
      const t = line.trim(); const b = t.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (b) { flushPara(); if (!list) { list = h('ul'); box.appendChild(list); } const li = h('li'); li.appendChild(inline(b[1])); list.appendChild(li); return; }
      list = null; if (!t) { flushPara(); return; } para.push(t);
    });
    flushPara();
    if (!box.childNodes.length) box.appendChild(h('p', { text: '…' }));
    return box;
  }

  // ---------- xKiro ----------
  const BASE = C.UPA.BASE_URL;

  function netError(e) {
    if (e && e.name === 'AbortError') return C.err('STOPPED', 'Stopped.');
    if (!navigator.onLine) return C.err('NETWORK', 'You appear to be offline. Reconnect and try again.', { retryable: true });
    return C.err('BROWSER_BLOCKED', 'The request to xKiro was blocked. Either the network is down, or xKiro does not accept requests made directly from a web page. If Test connection in Settings shows the same message, use the browser extension or the Docs add-on instead.', { retryable: true });
  }

  async function xk(method, path, body, signal) {
    const key = get('apiKey', '');
    if (!key) throw C.err('NO_KEY', 'Add your xKiro API key in Settings first.');
    let resp;
    try {
      resp = await fetch(BASE + path, { method: method, signal: signal, credentials: 'omit', redirect: 'error',
        headers: Object.assign({ 'x-api-key': key, 'Accept': body && body.stream ? 'text/event-stream, application/json' : 'application/json' }, body ? { 'Content-Type': 'application/json' } : {}),
        body: body ? JSON.stringify(body) : undefined });
    } catch (e) { throw netError(e); }
    if (!resp.ok) throw C.mapError(resp.status, await resp.text(), key);
    return resp;
  }

  async function catalog(force) {
    const cached = get('catalog', null);
    if (!force && cached && Date.now() - cached.fetchedAt < C.UPA.CATALOG_TTL_MS) return cached;
    try {
      const j = await (await xk('GET', C.UPA.ENDPOINTS.models)).json();
      const arr = Array.isArray(j) ? j : (j.data || j.models || []);
      const cat = { fetchedAt: Date.now(), models: arr.map(C.normalizeModel).filter(Boolean) };
      put('catalog', cat); return cat;
    } catch (e) { if (cached && ['NETWORK', 'SERVER', 'RATE_LIMIT'].indexOf(e.code) >= 0) return cached; throw e; }
  }

  async function streamChat(messages, plan, signal, onDelta) {
    const chain = C.pickModels((await catalog(false)).models, settings(), plan.task, C.estimateTokens(messages));
    const tried = []; let last = null; const key = get('apiKey', '');
    for (const model of chain) {
      let text = '';
      try {
        const resp = await xk('POST', C.UPA.ENDPOINTS.chat, { model: model, messages: messages, temperature: 0.4, max_tokens: plan.maxTokens, stream: true }, signal);
        if ((resp.headers.get('content-type') || '').indexOf('text/event-stream') < 0 || !resp.body) {
          const j = await resp.json(); const ch = j && j.choices && j.choices[0];
          let c = ch && ch.message && ch.message.content;
          if (Array.isArray(c)) c = c.map(function (p) { return typeof p === 'string' ? p : (p && p.text) || ''; }).join('');
          if (typeof c !== 'string' || !c.trim()) throw C.err('MALFORMED', 'xKiro returned an empty answer.', { retryable: true });
          onDelta(c); return { text: c, model: model };
        }
        const reader = resp.body.getReader(); const dec = new TextDecoder(); let buf = '';
        for (;;) {
          const r = await reader.read(); if (r.done) break;
          buf += dec.decode(r.value, { stream: true }); let nl;
          while ((nl = buf.indexOf('\n')) >= 0) { const d = C.sseDelta(buf.slice(0, nl)); buf = buf.slice(nl + 1); if (d) { text += d; onDelta(text); } }
        }
        const tail = C.sseDelta(buf); if (tail) { text += tail; onDelta(text); }
        if (!text.trim()) throw C.err('MALFORMED', 'xKiro returned an empty answer.', { retryable: true });
        return { text: C.redact(text, key), model: model };
      } catch (e) {
        if (e && e.name === 'AbortError') throw C.err('STOPPED', 'Stopped.');
        last = e; tried.push(model);
        if (text || C.FALLBACK_CODES.indexOf(e.code) < 0) throw e;
      }
    }
    throw C.err(last ? last.code : 'MODEL_UNAVAILABLE', (last ? last.message : 'No model answered.') + ' Tried: ' + tried.join(', ') + '.', { retryable: true });
  }

  /** Read a link through xKiro's fetch endpoint (browsers block reading other sites directly). */
  async function readUrl() {
    const url = $('pageUrl').value.trim();
    if (!/^https?:\/\//i.test(url)) { flash('pageMsg', 'err', 'Enter a link that starts with http:// or https://'); return; }
    flash('pageMsg', 'warn', 'Reading the link…');
    try {
      const j = await (await xk('POST', '/fetch', { url: url })).json();
      const txt = String(j.content || j.text || j.markdown || '').trim();
      if (!txt) throw C.err('EMPTY', 'empty');
      $('pageText').value = txt.slice(0, 60000);
      if (j.title) state.title = String(j.title).slice(0, 200);
      flash('pageMsg', 'ok', 'Read ' + txt.length.toLocaleString() + ' characters from the link.');
      pageInfo();
    } catch (e) {
      flash('pageMsg', 'warn', e.code === 'NO_KEY' ? e.message : 'Could not read that link through xKiro (' + (e.code === 'ENDPOINT_NOT_FOUND' ? 'your account has no page-reading feature' : e.message) + '). Open the page, select the text (Ctrl+A), copy it and paste it here.');
    }
  }

  // ---------- page box ----------
  function pageInfo() {
    const t = $('pageText').value.trim(); const u = $('pageUrl').value.trim();
    $('pageInfo').textContent = (state.title ? state.title + ' · ' : '') + (t ? t.length.toLocaleString() + ' characters of page text' : u ? 'Link only (no page text yet)' : 'Share a page here from Chrome, or paste a link or text.');
  }

  function takeShare() {
    const p = new URLSearchParams(location.search);
    const title = p.get('title') || ''; let text = p.get('text') || ''; let url = p.get('url') || '';
    if (!url) { const m = text.match(/https?:\/\/\S+/); if (m) { url = m[0]; text = text.replace(m[0], '').trim(); } }
    if (!title && !text && !url) return;
    state.title = title.slice(0, 200);
    if (url) $('pageUrl').value = url;
    if (text) $('pageText').value = text;
    history.replaceState(null, '', location.pathname);
    pageInfo();
    if (url && !text && get('apiKey', '')) readUrl();
  }

  // ---------- chat ----------
  function addUser(text) { $('empty').hidden = true; $('log').appendChild(h('div', { class: 'msgu', text: text })); scrollDown(); }

  function errorBox(e, retry) {
    const box = h('div', { class: 'msg err' }, [h('div', { text: e.message || 'Something went wrong.' })]);
    const row = h('div', { class: 'row' });
    if (e.code === 'NO_KEY' || e.code === 'INVALID_KEY') row.appendChild(h('button', { type: 'button', text: 'Open Settings', onclick: function () { showSettings(true); } }));
    if (retry && (e.retryable || ['NETWORK', 'RATE_LIMIT', 'SERVER', 'MALFORMED', 'MODEL_UNAVAILABLE'].indexOf(e.code) >= 0)) row.appendChild(h('button', { type: 'button', text: 'Try again', onclick: function () { box.remove(); retry(); } }));
    if (row.childNodes.length) box.appendChild(row);
    return box;
  }

  const KIND = { fill: 'Text for', replaceSelection: 'Replacement text', insert: 'Text to paste' };

  async function ask(question) {
    question = String(question || '').trim();
    if (!question || state.busy) return;
    state.busy = true; $('send').textContent = 'Stop'; $('send').classList.add('stop');
    addUser(question);
    const run = async function () {
      const wrap = h('div', { class: 'msga' }, [h('div', { class: 'thinking' }, [h('span', { class: 'dots', text: 'Thinking' })])]);
      $('log').appendChild(wrap); scrollDown();
      const ctrl = new AbortController(); state.cancel = function () { ctrl.abort(); };
      try {
        const text = $('pageText').value;
        const page = { url: $('pageUrl').value.trim(), title: state.title || '', text: text, selection: '', fields: [] };
        const warn = C.scanInjection(text);
        if (warn.length) wrap.insertBefore(h('div', { class: 'msg warn', text: 'The page text contains instructions aimed at AI assistants. They were treated as plain text and ignored.' }), wrap.firstChild);
        const messages = C.buildMessages(page, question + (text.trim() ? '' : '\n(No page text was provided; answer from general knowledge and say so.)'), state.history, get('facts', ''));
        const plan = C.classifyTask(question);
        const t0 = Date.now(); let live = null; let pending = null;
        const paint = function () {
          if (pending == null) return; const fresh = renderText(pending); fresh.classList.add('streaming'); pending = null;
          if (live) live.replaceWith(fresh); else { const th = wrap.querySelector('.thinking'); if (th) th.remove(); wrap.appendChild(fresh); }
          live = fresh; scrollDown();
        };
        const r = await streamChat(messages, plan, ctrl.signal, function (soFar) { const first = pending == null; pending = C.visibleAnswer(soFar); if (first) requestAnimationFrame(paint); });
        paint();
        const parsed = C.parseReply(r.text);
        const fin = renderText(parsed.answer);
        if (live) live.replaceWith(fin); else { const th = wrap.querySelector('.thinking'); if (th) th.remove(); wrap.appendChild(fin); }
        // Suggested text (the extension would type it in; here it is copied).
        parsed.actions.slice(0, 20).forEach(function (a) {
          const t = String(a && a.text || '');
          if (!t.trim() || C.looksLikeSecret(t, get('apiKey', ''))) return;
          const btn = h('button', { type: 'button', class: 'primary', text: 'Copy' });
          btn.addEventListener('click', function () { copy(t, btn); });
          wrap.appendChild(h('div', { class: 'copyblock' }, [h('div', { class: 'kind', text: (KIND[a.type] || 'Text') + (a.label ? ' · ' + String(a.label).slice(0, 80) : '') }), h('div', { class: 'new', text: t }), h('div', { class: 'row' }, [btn])]));
        });
        const cbtn = h('button', { type: 'button', class: 'ghost', text: 'Copy' });
        cbtn.addEventListener('click', function () { copy(parsed.answer, cbtn); });
        wrap.appendChild(h('div', { class: 'meta' }, [h('span', { text: 'Answered by ' + r.model + ' in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' }), cbtn]));
        state.history.push({ role: 'user', content: question }, { role: 'assistant', content: parsed.answer });
        state.history = state.history.slice(-12);
      } catch (e) {
        const th = wrap.querySelector('.thinking'); if (th) th.remove();
        if (e.code === 'STOPPED') wrap.appendChild(h('div', { class: 'meta', text: 'Stopped.' }));
        else wrap.appendChild(errorBox(e, function () { state.busy = true; $('send').textContent = 'Stop'; run().finally(done); }));
        scrollDown();
      }
    };
    const done = function () { state.busy = false; state.cancel = null; $('send').textContent = 'Send'; $('send').classList.remove('stop'); };
    await run().finally(done);
  }

  // ---------- settings ----------
  function showSettings(on) {
    $('settingsView').hidden = !on; $('chatView').hidden = on;
    $('settingsBtn').textContent = on ? 'Back to chat' : 'Settings'; $('settingsBtn').setAttribute('aria-expanded', String(on));
  }
  function loadSettings() {
    const k = get('apiKey', ''); const s = settings();
    $('keyState').textContent = k ? 'A key is saved (••••••••' + k.slice(-4) + '). Paste a new one to replace it.' : 'No key saved yet.';
    $('freeOnly').checked = s.freeOnly; $('allowPaid').checked = s.allowPaid; $('allowPaid').disabled = s.freeOnly;
    $('facts').value = get('facts', '');
    $('version').textContent = 'Version ' + C.UPA.VERSION;
    const b = $('banner'); b.innerHTML = '';
    if (!k) { b.appendChild(h('div', { text: 'Add your xKiro API key to start.' })); b.appendChild(h('button', { type: 'button', class: 'primary', text: 'Open Settings', onclick: function () { showSettings(true); } })); b.hidden = false; }
    else b.hidden = true;
  }
  function saveSettings(patch) { put('settings', C.mergeSettings(Object.assign({}, settings(), patch))); loadSettings(); }

  // ---------- wiring ----------
  $('composer').addEventListener('submit', function (e) { e.preventDefault(); if (state.busy) { if (state.cancel) state.cancel(); return; } const v = $('q').value; $('q').value = ''; ask(v); });
  $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });
  document.querySelectorAll('.chip').forEach(function (c) { c.addEventListener('click', function () { ask(c.getAttribute('data-prompt')); }); });
  $('newChat').addEventListener('click', function () { state.history = []; Array.prototype.slice.call($('log').children).forEach(function (c) { if (c.id !== 'empty') c.remove(); }); $('empty').hidden = false; });
  $('settingsBtn').addEventListener('click', function () { showSettings($('settingsView').hidden); });
  $('readUrl').addEventListener('click', readUrl);
  $('pageText').addEventListener('input', pageInfo);
  $('pageUrl').addEventListener('input', pageInfo);
  $('saveKey').addEventListener('click', function () {
    const k = $('apiKey').value.trim();
    if (!k || /\s/.test(k) || k.length < 8 || k.length > 300) { flash('keyMsg', 'err', 'That does not look like an API key (no spaces, 8 to 300 characters).'); return; }
    if (!put('apiKey', k)) { flash('keyMsg', 'err', 'This browser is blocking storage for this site, so the key could not be saved.'); return; }
    del('catalog'); $('apiKey').value = ''; loadSettings(); flash('keyMsg', 'ok', 'Key saved. Press Test connection to check it.');
  });
  $('apiKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('saveKey').click(); });
  $('testKey').addEventListener('click', async function () {
    flash('keyMsg', 'warn', 'Testing…');
    try { const t0 = Date.now(); const c = await catalog(true); const n = c.models.filter(function (m) { return C.isEligible(m, settings()); }).length; flash('keyMsg', n ? 'ok' : 'warn', 'Connected to xKiro: ' + c.models.length + ' models, ' + n + ' usable with your settings (' + (Date.now() - t0) + ' ms).'); }
    catch (e) { flash('keyMsg', 'err', e.message); }
  });
  $('clearKey').addEventListener('click', function () { del('apiKey'); del('catalog'); loadSettings(); flash('keyMsg', 'ok', 'Key removed from this device.'); });
  $('freeOnly').addEventListener('change', function () { saveSettings({ freeOnly: this.checked, allowPaid: false }); });
  $('allowPaid').addEventListener('change', function () { if (this.checked) { this.checked = false; $('paidConfirm').hidden = false; } else saveSettings({ allowPaid: false }); });
  $('paidYes').addEventListener('click', function () { $('paidConfirm').hidden = true; saveSettings({ allowPaid: true }); });
  $('paidNo').addEventListener('click', function () { $('paidConfirm').hidden = true; });
  $('saveFacts').addEventListener('click', function () { flash('factsMsg', put('facts', $('facts').value.slice(0, 4000)) ? 'ok' : 'err', 'Saved on this device.'); });

  // Install button (Chrome fires beforeinstallprompt when the app can be installed).
  let installEvt = null;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); installEvt = e; $('installBtn').hidden = false; });
  $('installBtn').addEventListener('click', function () { if (installEvt) { installEvt.prompt(); installEvt.userChoice.finally(function () { installEvt = null; $('installBtn').hidden = true; }); } });
  window.addEventListener('appinstalled', function () { $('installBtn').hidden = true; });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(function () { /* app still works online */ });

  loadSettings(); takeShare(); pageInfo();
})();
