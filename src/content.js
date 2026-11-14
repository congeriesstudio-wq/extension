/**
 * content.js - injected into the page only when the user asks something in the panel.
 * Reads the page (text, selection, editable fields) and applies text the user approved.
 * It never clicks, submits or navigates.
 */
(function () {
  'use strict';
  if (window.__upaContentLoaded) return;
  window.__upaContentLoaded = true;

  const api = globalThis.browser || globalThis.chrome;
  const MAX_TEXT = 24000;
  const MAX_FIELDS = 150;
  let nextId = 1;
  let lastFocused = null;
  let savedSel = null;

  document.addEventListener('focusin', function (e) { if (isEditable(e.target)) lastFocused = e.target; }, true);

  // ---------- helpers ----------

  const TEXT_TYPES = ['text', 'search', 'email', 'url', 'tel', 'number', 'date', 'datetime-local', 'month', 'week', 'time', ''];

  function isTextInput(el) { return el && el.tagName === 'INPUT' && TEXT_TYPES.indexOf((el.getAttribute('type') || '').toLowerCase()) >= 0; }
  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === 'TEXTAREA' || isTextInput(el)) return true;
    return el.isContentEditable === true;
  }
  function visible(el) {
    if (!el.getClientRects().length) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  }
  function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

  function blockedField(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    const hint = (el.name || '') + ' ' + (el.id || '') + ' ' + ac;
    return type === 'password' || type === 'hidden' || type === 'file' || /^cc-/.test(ac) || /(card.?num|cardnumber|cvv|cvc|security.?code|password|passwd)/i.test(hint);
  }

  function labelFor(el) {
    const al = el.getAttribute('aria-label'); if (al) return norm(al);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) { const t = lb.split(/\s+/).map(function (id) { const n = document.getElementById(id); return n ? n.textContent : ''; }).join(' '); if (norm(t)) return norm(t); }
    if (el.id) { try { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l && norm(l.textContent)) return norm(l.textContent); } catch (e) { /* ignore */ } }
    const wrap = el.closest('label'); if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
    const ph = el.getAttribute('placeholder') || el.getAttribute('data-placeholder'); if (ph) return norm(ph);
    if (el.title) return norm(el.title);
    // Nearest preceding text in the same block (common for unlabelled forms).
    let p = el.previousElementSibling;
    for (let i = 0; i < 3 && p; i++, p = p.previousElementSibling) { const t = norm(p.textContent); if (t && t.length < 120) return t; }
    const par = el.parentElement; if (par) { const t = norm(Array.prototype.map.call(par.childNodes, function (n) { return n.nodeType === 3 ? n.textContent : ''; }).join(' ')); if (t) return t.slice(0, 120); }
    return el.name || el.id || '';
  }

  function valueOf(el) {
    if (el.isContentEditable) return el.innerText || '';
    return el.value || '';
  }

  function idOf(el) {
    let id = el.getAttribute('data-upa-id');
    if (!id) { id = 'f' + (nextId++); el.setAttribute('data-upa-id', id); }
    return id;
  }

  function mainText() {
    const cands = ['article', 'main', '[role="main"]'];
    let root = null;
    for (let i = 0; i < cands.length; i++) {
      const n = document.querySelector(cands[i]);
      if (n && norm(n.innerText).length > 400) { root = n; break; }
    }
    const t = (root || document.body).innerText || '';
    const lines = t.split('\n').map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); });
    const out = []; let blank = 0;
    lines.forEach(function (l) { if (!l) { if (blank++ < 1) out.push(''); } else { blank = 0; out.push(l); } });
    let s = out.join('\n').trim();
    if (s.length > MAX_TEXT) s = s.slice(0, MAX_TEXT) + '\n[...page continues; only the first part was read]';
    return s;
  }

  function captureSelection() {
    savedSel = null;
    const ae = document.activeElement;
    if (ae && (ae.tagName === 'TEXTAREA' || isTextInput(ae)) && ae.selectionStart != null && ae.selectionEnd > ae.selectionStart) {
      savedSel = { kind: 'input', el: ae, start: ae.selectionStart, end: ae.selectionEnd };
      return ae.value.slice(ae.selectionStart, ae.selectionEnd);
    }
    const sel = window.getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const r = sel.getRangeAt(0);
      savedSel = { kind: 'range', range: r.cloneRange(), editable: isEditable(r.commonAncestorContainer.nodeType === 1 ? r.commonAncestorContainer : r.commonAncestorContainer.parentElement) || !!(r.commonAncestorContainer.parentElement && r.commonAncestorContainer.parentElement.closest('[contenteditable=""],[contenteditable="true"]')) };
      return sel.toString();
    }
    return '';
  }

  // ---------- scan ----------

  function scan() {
    const selection = captureSelection();
    const focusEl = isEditable(document.activeElement) ? document.activeElement : lastFocused;
    const nodes = document.querySelectorAll('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
    const fields = [];
    for (let i = 0; i < nodes.length && fields.length < MAX_FIELDS; i++) {
      const el = nodes[i];
      if (el.disabled || el.readOnly || !visible(el)) continue;
      if (el.tagName === 'INPUT' && !isTextInput(el) && !blockedField(el)) continue; // buttons, checkboxes, radios
      if (el.getAttribute('role') === 'textbox' && !el.isContentEditable && el.tagName !== 'TEXTAREA' && el.tagName !== 'INPUT') continue;
      if (el.isContentEditable && el.parentElement && el.parentElement.isContentEditable) continue; // inner nodes of one editor
      const blocked = blockedField(el);
      const f = {
        id: idOf(el),
        kind: el.tagName === 'SELECT' ? 'select' : el.tagName === 'TEXTAREA' ? 'textarea' : el.isContentEditable ? 'richtext' : 'input',
        inputType: el.tagName === 'INPUT' ? (el.getAttribute('type') || 'text').toLowerCase() : '',
        label: labelFor(el).slice(0, 160),
        value: blocked ? '' : valueOf(el).slice(0, 2000),
        focused: el === focusEl,
        blocked: blocked
      };
      if (el.tagName === 'SELECT') f.options = Array.prototype.map.call(el.options, function (o) { return norm(o.textContent); }).filter(Boolean).slice(0, 40);
      fields.push(f);
    }
    return {
      url: location.href, title: document.title, text: mainText(), selection: selection.slice(0, 8000),
      hasSelection: !!selection, selectionEditable: !!(savedSel && (savedSel.kind === 'input' || savedSel.editable)),
      fields: fields, canvasEditor: /docs\.google\.com\/(document|spreadsheets|presentation)/.test(location.href)
    };
  }

  // ---------- writing into the page ----------

  function flash(el) {
    const prev = el.style.outline; const prevOff = el.style.outlineOffset;
    el.style.outline = '2px solid #2f6fed'; el.style.outlineOffset = '2px';
    setTimeout(function () { el.style.outline = prev; el.style.outlineOffset = prevOff; }, 1600);
  }

  function nativeSet(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Insert like typing so Ctrl+Z works and frameworks (React, Vue) see the change. */
  function typeInto(text) {
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (e) { ok = false; }
    return ok;
  }

  function setField(el, text) {
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (el.tagName === 'SELECT') {
      const opt = Array.prototype.filter.call(el.options, function (o) { return norm(o.textContent) === text || o.value === text; })[0];
      if (!opt) throw new Error('That choice is not in the list.');
      nativeSet(el, opt.value);
      flash(el);
      return el.value === opt.value;
    }
    el.focus();
    if (el.isContentEditable) {
      const r = document.createRange(); r.selectNodeContents(el);
      const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      if (!typeInto(text)) { el.textContent = text; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text })); }
      flash(el);
      return norm(el.innerText) === norm(text);
    }
    el.select && el.select();
    if (!typeInto(text) || el.value !== text) nativeSet(el, text);
    flash(el);
    return el.value === text;
  }

  function replaceSelection(text) {
    if (!savedSel) throw new Error('The selection is gone. Select the text again and ask again.');
    if (savedSel.kind === 'input') {
      const el = savedSel.el;
      if (!document.contains(el)) throw new Error('The text box with your selection is gone.');
      el.focus(); el.setSelectionRange(savedSel.start, savedSel.end);
      if (!typeInto(text)) { const v = el.value; nativeSet(el, v.slice(0, savedSel.start) + text + v.slice(savedSel.end)); }
      flash(el);
      return true;
    }
    if (!savedSel.editable) throw new Error('The selected text is not editable on this page. Use Copy instead.');
    const s = window.getSelection(); s.removeAllRanges(); s.addRange(savedSel.range);
    const host = savedSel.range.commonAncestorContainer.parentElement;
    const ed = host && host.closest('[contenteditable=""],[contenteditable="true"]');
    if (ed) ed.focus();
    s.removeAllRanges(); s.addRange(savedSel.range);
    if (!typeInto(text)) { savedSel.range.deleteContents(); savedSel.range.insertNode(document.createTextNode(text)); }
    if (ed) flash(ed);
    return true;
  }

  function insertAtCursor(text) {
    const el = lastFocused && document.contains(lastFocused) ? lastFocused : null;
    if (!el) throw new Error('Click into the box you want to write in, then press Apply again.');
    el.focus();
    if (!typeInto(text)) {
      if (el.isContentEditable) { el.textContent += text; el.dispatchEvent(new Event('input', { bubbles: true })); }
      else { const st = el.selectionStart != null ? el.selectionStart : el.value.length; nativeSet(el, el.value.slice(0, st) + text + el.value.slice(el.selectionEnd != null ? el.selectionEnd : st)); }
    }
    flash(el);
    return true;
  }

  function apply(action) {
    if (action.type === 'fill') {
      const el = document.querySelector('[data-upa-id="' + String(action.field).replace(/[^a-z0-9]/gi, '') + '"]');
      if (!el) throw new Error('That field is no longer on the page. Ask again to rescan.');
      if (blockedField(el)) throw new Error('Protected fields (passwords, card numbers) are never filled.');
      if (action.expectOld != null && valueOf(el).slice(0, 2000) !== action.expectOld) throw new Error('This field changed since the suggestion was made. Ask again to get a fresh one.');
      return { ok: true, verified: setField(el, action.text) };
    }
    if (action.type === 'replaceSelection') return { ok: true, verified: replaceSelection(action.text) };
    if (action.type === 'insert') return { ok: true, verified: insertAtCursor(action.text) };
    throw new Error('Unknown action.');
  }

  function highlight(fieldId) {
    const el = document.querySelector('[data-upa-id="' + String(fieldId).replace(/[^a-z0-9]/gi, '') + '"]');
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(el); }
    return { ok: !!el };
  }

  api.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || sender.id !== api.runtime.id) return false;
    try {
      if (msg.type === 'upa:scan') sendResponse({ ok: true, data: scan() });
      else if (msg.type === 'upa:apply') sendResponse({ ok: true, data: apply(msg.action) });
      else if (msg.type === 'upa:highlight') sendResponse({ ok: true, data: highlight(msg.field) });
      else return false;
    } catch (e) {
      sendResponse({ ok: false, error: { code: 'PAGE', message: String(e && e.message || e) } });
    }
    return false;
  });
})();
