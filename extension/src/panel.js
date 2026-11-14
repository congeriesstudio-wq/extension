/* panel.js - the side panel (Chrome/Edge/Brave/Opera) or sidebar (Firefox). */
(function () {
  'use strict';
  const api = globalThis.browser || globalThis.chrome;
  const $ = function (id) { return document.getElementById(id); };
  const state = { history: [], busy: false, settings: null, hasKey: false };

  // ---------- plumbing ----------

  function call(type, data) {
    return api.runtime.sendMessage(Object.assign({ type: type }, data || {})).then(function (r) {
      if (r && r.ok) return r.data;
      throw (r && r.error) || { code: 'UNKNOWN', message: 'The extension did not answer. Reload it and try again.' };
    });
  }

  function h(tag, props, kids) {
    const e = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      const v = props[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }

  async function activeTab() {
    // ?tab=<id> lets the automated tests open the panel as a normal tab and point it at a test page.
    const forced = Number(new URLSearchParams(location.search).get('tab'));
    if (forced) return api.tabs.get(forced);
    const tabs = await api.tabs.query({ active: true, currentWindow: true });
    return tabs[0];
  }

  function scrollDown() { const l = $('log'); l.scrollTop = l.scrollHeight; }

  async function copy(text, btn) {
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copied'; }
    catch (e) { btn.textContent = 'Copy failed'; }
    setTimeout(function () { btn.textContent = 'Copy'; }, 1500);
  }

  // ---------- tiny safe markdown (bold, code, bullets, paragraphs) ----------

  function inline(text) {
    const frag = document.createDocumentFragment();
    const re = /\*\*([^*]+)\*\*|`([^`]+)`/g; let last = 0; let m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      frag.appendChild(m[1] ? h('strong', { text: m[1] }) : h('code', { text: m[2] }));
      last = re.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    return frag;
  }

  function renderText(text) {
    const box = h('div', { class: 'answer' });
    let list = null; let para = [];
    const flushPara = function () { if (para.length) { const p = h('p'); p.appendChild(inline(para.join(' '))); box.appendChild(p); para = []; } };
    String(text || '').split('\n').forEach(function (line) {
      const t = line.trim();
      const b = t.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (b) { flushPara(); if (!list) { list = h('ul'); box.appendChild(list); } const li = h('li'); li.appendChild(inline(b[1])); list.appendChild(li); return; }
      list = null;
      if (!t) { flushPara(); return; }
      para.push(t);
    });
    flushPara();
    if (!box.childNodes.length) box.appendChild(h('p', { text: '(No answer text.)' }));
    return box;
  }

  // ---------- banners ----------

  async function hasSiteAccess() {
    try { return await api.permissions.contains({ origins: ['<all_urls>'] }); } catch (e) { return true; }
  }

  function requestAccess() {
    // Must run directly inside the click for Firefox to show its prompt.
    return api.permissions.request({ origins: ['<all_urls>'] }).then(function (ok) { refreshBanner(); return ok; });
  }

  async function refreshBanner() {
    const b = $('banner'); b.innerHTML = '';
    if (!state.hasKey) {
      b.appendChild(h('div', { text: 'Add your xKiro API key to start.' }));
      b.appendChild(h('button', { type: 'button', class: 'primary', text: 'Open Settings', onclick: function () { showSettings(true); } }));
      b.hidden = false; return;
    }
    if (!(await hasSiteAccess())) {
      b.appendChild(h('div', { text: 'Universal Page AI needs permission to read the websites you ask it about.' }));
      b.appendChild(h('button', { type: 'button', class: 'primary', text: 'Allow access to websites', onclick: requestAccess }));
      b.hidden = false; return;
    }
    b.hidden = true;
  }

  async function refreshPageLine() {
    const t = await activeTab().catch(function () { return null; });
    const pl = $('pageLine');
    if (!t || !t.title) { pl.hidden = true; return; }
    pl.textContent = 'Reading: ' + t.title;
    pl.title = t.url || '';
    pl.hidden = false;
  }

  // ---------- chat ----------

  function addUser(text) {
    $('empty').hidden = true;
    $('log').appendChild(h('div', { class: 'msgu', text: text }));
    scrollDown();
  }

  function errorBox(e, retry) {
    const box = h('div', { class: 'msg err' }, [h('div', { text: e.message || 'Something went wrong.' })]);
    const row = h('div', { class: 'row' });
    if (e.code === 'NO_KEY' || e.code === 'INVALID_KEY') row.appendChild(h('button', { type: 'button', text: 'Open Settings', onclick: function () { showSettings(true); } }));
    if (e.code === 'NO_PAGE_ACCESS') row.appendChild(h('button', { type: 'button', class: 'primary', text: 'Allow access to websites', onclick: function () { requestAccess().then(function (ok) { if (ok && retry) { box.remove(); retry(); } }); } }));
    if (retry && (e.retryable || ['NETWORK', 'RATE_LIMIT', 'SERVER', 'MALFORMED', 'MODEL_UNAVAILABLE', 'UNKNOWN'].indexOf(e.code) >= 0)) row.appendChild(h('button', { type: 'button', text: 'Try again', onclick: function () { box.remove(); retry(); } }));
    if (row.childNodes.length) box.appendChild(row);
    return box;
  }

  const KIND = { fill: 'Fill field', replaceSelection: 'Replace selection', insert: 'Insert at cursor' };

  function actionCard(a, tabId) {
    const status = h('div', { class: 'msg', hidden: true });
    const applyBtn = h('button', { type: 'button', class: 'primary', text: 'Apply' });
    const copyBtn = h('button', { type: 'button', text: 'Copy' });
    const card = h('div', { class: 'action' }, [
      h('div', { class: 'kind', text: KIND[a.type] + (a.label ? ' · ' + a.label : '') }),
      a.old ? h('div', { class: 'old', text: a.old }) : null,
      h('div', { class: 'new', text: a.text }),
      a.warnings && a.warnings.length ? h('div', { class: 'meta', text: '⚠ ' + a.warnings.join(' · ') }) : null,
      h('div', { class: 'row' }, [applyBtn, copyBtn, a.type === 'fill' ? h('button', { type: 'button', class: 'ghost', text: 'Show field', onclick: function () { call('upa:highlight', { tabId: tabId, field: a.field }).catch(function () {}); } }) : null]),
      status
    ]);
    copyBtn.addEventListener('click', function () { copy(a.text, copyBtn); });
    card.apply = function () {
      if (card.classList.contains('done')) return Promise.resolve(true);
      applyBtn.disabled = true;
      return call('upa:apply', { tabId: tabId, action: a }).then(function (r) {
        card.classList.add('done'); applyBtn.textContent = 'Applied';
        status.className = 'msg ok'; status.textContent = r && r.verified === false ? 'Applied. The site may have reformatted it: check the field.' : 'Applied. Press Ctrl+Z (Cmd+Z) in the page to undo.';
        status.hidden = false; return true;
      }, function (e) {
        applyBtn.disabled = false; status.className = 'msg err'; status.textContent = e.message; status.hidden = false; return false;
      });
    };
    applyBtn.addEventListener('click', card.apply);
    return card;
  }

  /** Finish an answer bubble: replace the streamed text with the final one, then add action cards. */
  function addAnswer(r, tabId, wrap) {
    if (!wrap) { wrap = h('div', { class: 'msga' }); (r.warnings || []).forEach(function (w) { wrap.appendChild(h('div', { class: 'msg warn', text: w })); }); }
    const live = wrap.querySelector('.answer');
    const fin = renderText(r.answer + (r.followUp ? '\n\n' + r.followUp : ''));
    if (live) live.replaceWith(fin); else wrap.appendChild(fin);
    const cards = (r.actions || []).map(function (a) { return actionCard(a, tabId); });
    cards.forEach(function (c) { wrap.appendChild(c); });
    if (cards.length > 1) wrap.appendChild(h('button', { type: 'button', class: 'applyall', text: 'Apply all ' + cards.length, onclick: function () {
      cards.reduce(function (p, c) { return p.then(function () { return c.apply(); }); }, Promise.resolve());
    } }));
    if (r.rejected && r.rejected.length) wrap.appendChild(h('div', { class: 'msg warn', text: r.rejected.length + ' suggestion(s) were blocked by safety checks: ' + r.rejected.slice(0, 3).join('; ') + '.' }));
    const copyBtn = h('button', { type: 'button', class: 'ghost', text: 'Copy' });
    copyBtn.addEventListener('click', function () { copy(r.answer, copyBtn); });
    wrap.appendChild(h('div', { class: 'meta' }, [
      h('span', { text: (r.model ? 'Answered by ' + r.model : '') + (r.ms ? ' in ' + (r.ms / 1000).toFixed(1) + ' s' : '') }),
      h('span', { text: r.page ? 'read ' + r.page.chars.toLocaleString() + ' characters' + (r.page.fields ? ', ' + r.page.fields + ' fields' : '') + (r.page.selection ? ', your selection' : '') : '' }),
      copyBtn
    ]));
    if (!wrap.isConnected) $('log').appendChild(wrap);
    scrollDown();
  }

  /** Stream one request over a port: words appear as the model writes them. */
  function streamAsk(tabId, question, wrap) {
    return new Promise(function (resolve, reject) {
      const port = api.runtime.connect({ name: 'upa:ask' });
      let live = null; let pending = null; let finished = false;
      // A port never reports its own disconnect, so Stop rejects through this.
      state.cancelStream = function () { if (finished) return; finished = true; try { port.disconnect(); } catch (e) { /* closed */ } reject({ code: 'STOPPED', message: 'Stopped.' }); };
      const paint = function () {
        if (pending == null) return;
        const fresh = renderText(pending); fresh.classList.add('streaming'); pending = null;
        if (live) live.replaceWith(fresh); else { const th = wrap.querySelector('.thinking'); if (th) th.remove(); wrap.appendChild(fresh); }
        live = fresh; scrollDown();
      };
      port.onMessage.addListener(function (m) {
        if (m.type === 'warnings') m.warnings.forEach(function (w) { wrap.insertBefore(h('div', { class: 'msg warn', text: w }), wrap.firstChild); });
        else if (m.type === 'status') { const th = wrap.querySelector('.thinking span'); if (th) th.textContent = m.text; }
        else if (m.type === 'delta') { const first = pending == null; pending = m.text; if (first) requestAnimationFrame(paint); }
        else if (m.type === 'done') { if (finished) return; finished = true; paint(); port.disconnect(); resolve(m.result); }
        else if (m.type === 'error') { if (finished) return; finished = true; port.disconnect(); reject(m.error); }
      });
      port.onDisconnect.addListener(function () {
        if (!finished) { finished = true; reject({ code: 'UNKNOWN', message: 'The connection to the extension closed. Try again.', retryable: true }); }
      });
      port.postMessage({ type: 'ask', tabId: tabId, question: question, history: state.history });
    });
  }

  function setBusy(on) {
    state.busy = on;
    const b = $('send');
    b.textContent = on ? 'Stop' : 'Send';
    b.classList.toggle('stop', on);
  }

  async function ask(question) {
    if (state.busy) return;
    question = String(question || '').trim();
    if (!question) return;
    setBusy(true);
    addUser(question);
    const attempt = async function () {
      const wrap = h('div', { class: 'msga' }, [h('div', { class: 'thinking' }, [h('span', { class: 'dots', text: 'Reading the page' })])]);
      $('log').appendChild(wrap); scrollDown();
      try {
        const tab = await activeTab();
        if (!tab) throw { code: 'PAGE', message: 'No open tab found in this window.' };
        const r = await streamAsk(tab.id, question, wrap);
        addAnswer(r, tab.id, wrap);
        state.history.push({ role: 'user', content: question });
        const actTxt = (r.actions || []).map(function (a) { return '[proposed ' + a.type + (a.label ? ' "' + a.label + '"' : '') + ': ' + a.text.slice(0, 300) + ']'; }).join('\n');
        state.history.push({ role: 'assistant', content: r.answer + (actTxt ? '\n' + actTxt : '') });
        state.history = state.history.slice(-12);
      } catch (e) {
        const th = wrap.querySelector('.thinking'); if (th) th.remove();
        if (e.code === 'STOPPED') { wrap.appendChild(h('div', { class: 'meta', text: 'Stopped.' })); return; }
        wrap.appendChild(errorBox(e, function () { setBusy(true); attempt().finally(function () { setBusy(false); }); }));
        scrollDown();
      }
    };
    await attempt().finally(function () { setBusy(false); });
  }

  function newChat() {
    state.history = [];
    Array.prototype.slice.call($('log').children).forEach(function (c) { if (c.id !== 'empty') c.remove(); });
    $('empty').hidden = false;
    $('q').focus();
  }

  // ---------- settings ----------

  function showSettings(on) {
    $('settingsView').hidden = !on; $('chatView').hidden = on;
    $('settingsBtn').textContent = on ? 'Back to chat' : 'Settings';
    $('settingsBtn').setAttribute('aria-expanded', String(on));
    if (on) loadModels(false);
  }

  function flash(id, kind, text) { const m = $(id); m.className = 'msg ' + kind; m.textContent = text; m.hidden = false; }

  async function loadState() {
    const s = await call('upa:state');
    state.hasKey = s.hasKey; state.settings = s.settings;
    $('keyState').textContent = s.hasKey ? 'A key is saved (' + s.maskedKey + '). Paste a new one to replace it.' : 'No key saved yet.';
    $('freeOnly').checked = s.settings.freeOnly;
    $('allowPaid').checked = s.settings.allowPaid; $('allowPaid').disabled = s.settings.freeOnly;
    $('modelMode').value = s.settings.modelMode; $('manualWrap').hidden = s.settings.modelMode !== 'manual';
    $('facts').value = s.facts;
    $('version').textContent = 'Version ' + s.version;
    refreshBanner();
  }

  async function saveSettings(patch) {
    state.settings = await call('upa:saveSettings', { patch: patch });
    $('freeOnly').checked = state.settings.freeOnly; $('allowPaid').checked = state.settings.allowPaid; $('allowPaid').disabled = state.settings.freeOnly;
    loadModels(false);
  }

  async function loadModels(force) {
    const box = $('models');
    if (!state.hasKey) { box.innerHTML = ''; return; }
    box.textContent = 'Loading models…';
    try {
      const r = await call('upa:models', { force: force });
      box.innerHTML = '';
      const t = h('table', null, [h('tr', null, ['Model', 'Price', 'Used'].map(function (x) { return h('th', { text: x }); }))]);
      r.models.forEach(function (m) { t.appendChild(h('tr', null, [h('td', { text: m.id }), h('td', { text: m.free === true ? 'free' : m.free === false ? 'paid' : 'unknown' }), h('td', { class: 'num', text: m.eligible ? 'yes' : 'no' })])); });
      box.appendChild(t);
      const sel = $('manualModel'); sel.innerHTML = '';
      r.models.filter(function (m) { return m.eligible; }).forEach(function (m) { sel.appendChild(h('option', { value: m.id, text: m.id })); });
      if (state.settings && state.settings.manualModel) sel.value = state.settings.manualModel;
    } catch (e) { box.innerHTML = ''; box.appendChild(h('div', { class: 'msg err', text: e.message })); }
  }

  // ---------- wiring ----------

  function wire() {
    $('composer').addEventListener('submit', function (e) {
      e.preventDefault();
      if (state.busy) { if (state.cancelStream) state.cancelStream(); return; }
      const v = $('q').value; $('q').value = ''; ask(v);
    });
    $('q').addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); $('composer').requestSubmit(); } });
    $('q').addEventListener('input', function () { this.style.height = 'auto'; this.style.height = Math.min(160, this.scrollHeight) + 'px'; });
    document.querySelectorAll('.chip').forEach(function (c) { c.addEventListener('click', function () { ask(c.getAttribute('data-prompt')); }); });
    $('newChat').addEventListener('click', newChat);
    $('settingsBtn').addEventListener('click', function () { showSettings($('settingsView').hidden); });

    $('saveKey').addEventListener('click', async function () {
      try { await call('upa:saveKey', { key: $('apiKey').value }); $('apiKey').value = ''; await loadState(); flash('keyMsg', 'ok', 'Key saved. Press Test connection to check it.'); }
      catch (e) { flash('keyMsg', 'err', e.message); }
    });
    $('apiKey').addEventListener('keydown', function (e) { if (e.key === 'Enter') $('saveKey').click(); });
    $('testKey').addEventListener('click', async function () {
      flash('keyMsg', 'warn', 'Testing…');
      try { const r = await call('upa:test'); flash('keyMsg', r.eligible ? 'ok' : 'warn', 'Connected to xKiro: ' + r.modelCount + ' models, ' + r.eligible + ' usable with your settings (' + r.ms + ' ms).'); loadModels(false); }
      catch (e) { flash('keyMsg', 'err', e.message); }
    });
    $('clearKey').addEventListener('click', async function () { await call('upa:clearKey'); await loadState(); flash('keyMsg', 'ok', 'Key removed from this browser.'); $('models').innerHTML = ''; });

    $('freeOnly').addEventListener('change', function () { saveSettings({ freeOnly: this.checked, allowPaid: false }); });
    $('allowPaid').addEventListener('change', function () {
      if (this.checked) { this.checked = false; $('paidConfirm').hidden = false; } else saveSettings({ allowPaid: false });
    });
    $('paidYes').addEventListener('click', function () { $('paidConfirm').hidden = true; saveSettings({ allowPaid: true }); });
    $('paidNo').addEventListener('click', function () { $('paidConfirm').hidden = true; });
    $('modelMode').addEventListener('change', function () { $('manualWrap').hidden = this.value !== 'manual'; saveSettings({ modelMode: this.value, manualModel: $('manualModel').value }); });
    $('manualModel').addEventListener('change', function () { saveSettings({ manualModel: this.value }); });
    $('refreshModels').addEventListener('click', function () { loadModels(true); });
    $('saveFacts').addEventListener('click', async function () {
      try { await call('upa:saveFacts', { facts: $('facts').value }); flash('factsMsg', 'ok', 'Saved. Only used when a page needs your details.'); }
      catch (e) { flash('factsMsg', 'err', e.message); }
    });

    api.tabs.onActivated.addListener(refreshPageLine);
    api.tabs.onUpdated.addListener(function (id, info) { if (info.title || info.status === 'complete') refreshPageLine(); });
    api.storage.onChanged.addListener(function (ch, area) { if (area === 'local' && ch.pendingPrompt && ch.pendingPrompt.newValue) takePending(); });
  }

  async function takePending() {
    const { pendingPrompt } = await api.storage.local.get('pendingPrompt');
    if (!pendingPrompt || Date.now() - pendingPrompt.at > 60000) return;
    await api.storage.local.remove('pendingPrompt');
    showSettings(false);
    if (pendingPrompt.autoSend && state.hasKey) ask(pendingPrompt.text);
    else { $('q').value = pendingPrompt.text; $('q').focus(); }
  }

  wire();
  loadState().then(function () { refreshPageLine(); takePending(); }).catch(function (e) { $('log').appendChild(errorBox(e)); });
})();
