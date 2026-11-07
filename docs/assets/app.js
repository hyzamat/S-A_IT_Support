// IT Support Toolkit — client app. No backend: content is AES-256-GCM encrypted in
// data.enc.json and "logging in" means deriving the key from username + password.
import { parseContent, varPattern, slugify } from './parser.js';
import { unlock, decryptWithKey, encryptWithKey, exportKey, importKey } from './crypto.js';
import { DOWNLOADABLE_LANGS, buildCmdFile, saveFile } from './download.js';
import { ghReadFile, ghWriteFile } from './github.js';
import {
  startSessions, noteActivity, sessionsView, refreshSessions, endSession, revokeSession,
  signOutEverywhere, newSessionId, MIN_PASSWORD,
} from './sessions.js';

// ---- settings ---------------------------------------------------------------
const IDLE_MINUTES = 15; // auto-logout after this many minutes without activity
const DATA_URL = 'data.enc.json';
const COLLAPSE_AT = 18; // code blocks longer than this many lines start collapsed

const IDLE_MS = IDLE_MINUTES * 60_000;
const SS = {
  key: 'its.key', user: 'its.user', vars: 'its.vars', seen: 'its.seen', notice: 'its.notice',
  sid: 'its.sid', // this tab's id in the Profile → Sessions list
  rotated: 'its.rotated', // time this tab used "Sign out all other devices"
};
const THEME_KEY = 'its.theme';

const TYPE_TABS = [
  ['all', 'All'],
  ['command', 'Commands'],
  ['script', 'Scripts'],
  ['tip', 'Tips & Methods'],
  ['link', 'Links'],
];
const TYPE_LABEL = { command: 'Command', script: 'Script', tip: 'Tip', link: 'Link' };
const LANG_LABEL = {
  cmd: 'CMD', powershell: 'PowerShell', bash: 'Bash', zsh: 'Mac Terminal', run: 'Win + R',
  reg: 'Registry', text: 'Text', json: 'JSON', sql: 'SQL', ini: 'Config', xml: 'XML', yaml: 'YAML',
};
const COMMENT_RE = {
  powershell: /^\s*#/,
  bash: /^\s*#/,
  zsh: /^\s*#/,
  yaml: /^\s*#/,
  cmd: /^\s*(?:rem\b|::)/i,
};
const IS_APPLE = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const COPY_KEYS = IS_APPLE ? 'Cmd+C' : 'Ctrl+C';
// "Open" links only exist for Windows Settings pages: the browser hands ms-settings: to Windows,
// which asks the user to confirm. Nothing else on the page can launch programs.
const IS_WINDOWS = /Windows/i.test(navigator.userAgent);
const SETTINGS_URI_RE = /^ms-settings:[a-z0-9-]*$/i;
const settingsUri = (text) => {
  const t = String(text).trim();
  return IS_WINDOWS && SETTINGS_URI_RE.test(t) ? t : null;
};
const OPEN_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M14 3h7v7h-2V6.41l-9.29 9.3-1.42-1.42L17.59 5H14V3zM5 5h6v2H5v12h12v-6h2v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>';
const DOWNLOAD_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M11 3h2v9.17l3.59-3.58L18 10l-6 6-6-6 1.41-1.41L11 12.17V3zM5 19h14v2H5z"/></svg>';
const COPY_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" aria-hidden="true"><path fill="currentColor" d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12V1zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11v14z"/></svg>';

// ---- state ------------------------------------------------------------------
const state = {
  items: [],
  categories: [],
  catById: new Map(),
  catIndex: new Map(),
  blocks: new Map(),
  vars: {},
  q: '',
  type: 'all',
  cat: 'all',
  key: null, // AES key from the login (kept in memory to save edits)
  keyMeta: null, // { salt, iterations } the key was derived with
  github: null, // { owner, repo, branch, token? } for saving from the website
  sessionToken: '', // token typed on this tab when it is not stored (memory only)
};

const $ = (id) => document.getElementById(id);
const ui = {
  boot: $('boot'),
  login: $('login-view'),
  form: $('login-form'),
  user: $('login-user'),
  pass: $('login-pass'),
  pwToggle: $('pw-toggle'),
  caps: $('caps-warning'),
  error: $('login-error'),
  loginBtn: $('login-btn'),
  app: $('app-view'),
  search: $('search'),
  userLabel: $('user-label'),
  themeBtn: $('theme-btn'),
  logoutBtn: $('logout-btn'),
  catList: $('cat-list'),
  builtLabel: $('built-label'),
  tabs: $('type-tabs'),
  count: $('result-count'),
  results: $('results'),
  toast: $('toast'),
};

// ---- helpers ----------------------------------------------------------------
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function linkHtml(url, text) {
  const u = safeUrl(url);
  if (!u) return esc(text);
  return `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(text)}</a>`;
}

/** Minimal inline Markdown: `code` (click to copy), **bold**, [text](url) and bare URLs. */
function inline(src) {
  return String(src)
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
        const code = part.slice(1, -1);
        const uri = settingsUri(code);
        const open = uri
          ? `<a class="open-ic" href="${esc(uri)}" title="Open this Settings page" aria-label="Open ${esc(uri)}">↗</a>`
          : '';
        return `<code class="ic" tabindex="0" title="Click to copy">${esc(code)}</code>${open}`;
      }
      const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/[^\s<>()\[\]`]+[^\s<>()\[\]`.,;:!?'"])|\*\*([^*]+)\*\*/g;
      let html = '';
      let last = 0;
      let m;
      while ((m = re.exec(part))) {
        html += esc(part.slice(last, m.index));
        if (m[1]) html += linkHtml(m[2], m[1]);
        else if (m[3]) html += linkHtml(m[3], m[3]);
        else html += `<strong>${esc(m[4])}</strong>`;
        last = re.lastIndex;
      }
      return html + esc(part.slice(last));
    })
    .join('');
}

function fmtDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

let toastTimer;
function toast(message, kind = 'ok') {
  ui.toast.textContent = message;
  ui.toast.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (ui.toast.className = 'toast'), 1900);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for browsers / policies that block the async clipboard API.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.className = 'clip-helper';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

// ---- theme ------------------------------------------------------------------
function applyTheme(saved) {
  const theme =
    saved === 'light' || saved === 'dark'
      ? saved
      : matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark';
  document.documentElement.dataset.theme = theme;
}

// ---- session ----------------------------------------------------------------
let lastSeen = Date.now();
let lastSaved = 0;

function touch(force = false) {
  lastSeen = Date.now();
  noteActivity();
  if (force || lastSeen - lastSaved > 10_000) {
    sessionStorage.setItem(SS.seen, String(lastSeen));
    lastSaved = lastSeen;
  }
}

function idleExpired() {
  const seen = Number(sessionStorage.getItem(SS.seen));
  return !seen || Date.now() - seen > IDLE_MS;
}

function clearSession() {
  [SS.key, SS.user, SS.vars, SS.seen, SS.sid, SS.rotated].forEach((k) => sessionStorage.removeItem(k));
}

/** `why` ('logout' | 'idle') marks this tab's session as ended in the Profile list. */
let loggingOut = false;
async function logout(notice = '', clearClipboard = false, why = '') {
  if (loggingOut) return;
  loggingOut = true;
  if (clearClipboard && navigator.clipboard) {
    await Promise.race([navigator.clipboard.writeText('').catch(() => {}), sleep(300)]);
  }
  if (why) await Promise.race([endSession(why), sleep(2500)]);
  clearSession();
  if (notice) sessionStorage.setItem(SS.notice, notice);
  location.replace(location.pathname); // full reload wipes decrypted data from memory
}

function startIdleWatch() {
  const onActivity = () => touch();
  ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll'].forEach((ev) =>
    addEventListener(ev, onActivity, { passive: true, capture: true }),
  );
  const check = () => {
    if (Date.now() - lastSeen > IDLE_MS) logout(`Signed out after ${IDLE_MINUTES} minutes of inactivity.`, false, 'idle');
  };
  setInterval(check, 15_000);
  document.addEventListener('visibilitychange', () => !document.hidden && check());
}

// ---- data -------------------------------------------------------------------
const appError = (code, message) => Object.assign(new Error(message), { code });

async function fetchEnvelope() {
  let res;
  try {
    res = await fetch(DATA_URL, { cache: 'no-store' });
  } catch {
    throw appError('NETWORK', 'Could not load the data file — check the internet connection.');
  }
  if (res.status === 404) {
    throw appError('NO_DATA', 'No content published yet. Run "npm run build" on your PC and push to GitHub.');
  }
  if (!res.ok) throw appError('NETWORK', `Could not load the data file (HTTP ${res.status}).`);
  try {
    return await res.json();
  } catch {
    throw appError('BAD_DATA', 'The data file is damaged. Rebuild it with "npm run build".');
  }
}

// ---- login ------------------------------------------------------------------
function showLogin(message = '', kind = 'error') {
  ui.boot.hidden = true;
  ui.app.hidden = true;
  ui.login.hidden = false;
  setLoginMessage(message, kind);
  ui.user.focus();
}

function setLoginMessage(message, kind = 'error') {
  ui.error.textContent = message;
  ui.error.className = `login-error${kind === 'info' ? ' info' : ''}`;
  ui.error.hidden = !message;
}

function setBusy(busy) {
  ui.loginBtn.disabled = busy;
  ui.loginBtn.querySelector('.spinner').hidden = !busy;
  ui.loginBtn.querySelector('.label').textContent = busy ? 'Unlocking…' : 'Unlock';
}

function wireLogin() {
  ui.form.addEventListener('submit', onLoginSubmit);
  ui.pwToggle.addEventListener('click', () => {
    const show = ui.pass.type === 'password';
    ui.pass.type = show ? 'text' : 'password';
    ui.pwToggle.textContent = show ? 'Hide' : 'Show';
    ui.pwToggle.setAttribute('aria-pressed', String(show));
    ui.pwToggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
    ui.pass.focus();
  });
  const caps = (e) => {
    if (e.getModifierState) ui.caps.hidden = !e.getModifierState('CapsLock');
  };
  ui.pass.addEventListener('keydown', caps);
  ui.pass.addEventListener('keyup', caps);
}

async function onLoginSubmit(e) {
  e.preventDefault();
  const user = ui.user.value.trim();
  const pass = ui.pass.value;
  if (!user || !pass) return setLoginMessage('Enter your username and password.');
  setBusy(true);
  setLoginMessage('');
  try {
    const envelope = await fetchEnvelope();
    const { key, data } = await unlock(envelope, user, pass);
    sessionStorage.setItem(SS.key, await exportKey(key));
    sessionStorage.setItem(SS.user, user);
    state.key = key;
    state.keyMeta = { salt: envelope.salt, iterations: envelope.iterations };
    touch(true);
    ui.pass.value = '';
    ui.pass.type = 'password';
    startApp(data, user, true);
  } catch (err) {
    ui.pass.value = '';
    setLoginMessage(err.code === 'BAD_LOGIN' ? 'Incorrect username or password.' : err.message || 'Unlock failed.');
    ui.pass.focus();
  } finally {
    setBusy(false);
  }
}

// ---- app --------------------------------------------------------------------
let appWired = false;

function loadData(data) {
  const gh = data && data.github;
  state.github = gh && gh.owner && gh.repo ? gh : null;
  const { categories, items } = parseContent(Array.isArray(data && data.files) ? data.files : []);
  state.categories = categories;
  state.catById = new Map(categories.map((c) => [c.id, c]));
  state.catIndex = new Map(categories.map((c, i) => [c.id, i]));
  state.items = items;
  state.blocks = new Map();
  items.forEach((it, i) =>
    it.blocks.forEach((b, j) => {
      if (b.t === 'code') {
        b.id = `${i}-${j}`;
        b.itemTitle = b.label ? `${it.title} - ${b.label}` : it.title; // used for downloaded .cmd files
        b.admin = it.admin;
        state.blocks.set(b.id, b);
      }
    }),
  );
  const updated = data && (data.updated || data.built);
  ui.builtLabel.textContent = updated ? `Updated ${fmtDate(updated)}` : '';
}

function startApp(data, user, newLogin = false) {
  loadData(data);
  try {
    state.vars = JSON.parse(sessionStorage.getItem(SS.vars) || '{}') || {};
  } catch {
    state.vars = {};
  }

  ui.userLabel.textContent = user;
  ui.boot.hidden = true;
  ui.login.hidden = true;
  ui.app.hidden = false;

  if (!appWired) {
    wireApp();
    startIdleWatch();
    beginSessions(newLogin);
    appWired = true;
  }
  render();
  if (matchMedia('(pointer: fine)').matches) ui.search.focus();
}

function wireApp() {
  let searchTimer;
  ui.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => setQuery(ui.search.value), 70);
  });

  document.addEventListener('keydown', (e) => {
    if (ui.app.hidden || addUi.dialog.open || prof.dialog.open) return;
    const tag = document.activeElement && document.activeElement.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    if ((e.key === '/' && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k')) {
      e.preventDefault();
      ui.search.focus();
      ui.search.select();
    } else if (e.key === 'Escape' && document.activeElement === ui.search) {
      if (ui.search.value) {
        ui.search.value = '';
        setQuery('');
      } else {
        ui.search.blur();
      }
    }
  });

  ui.catList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-cat]');
    if (!btn) return;
    state.cat = btn.dataset.cat;
    render();
    scrollTo({ top: 0 });
  });

  ui.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-type]');
    if (!btn) return;
    state.type = btn.dataset.type;
    render();
  });

  ui.results.addEventListener('click', onResultsClick);
  ui.results.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('code.ic')) {
      e.preventDefault();
      e.target.click();
    }
  });
  ui.results.addEventListener('input', (e) => {
    if (e.target.matches('input[data-var]')) onVarInput(e.target);
  });

  ui.themeBtn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
  ui.logoutBtn.addEventListener('click', () => logout('You have been logged out.', true, 'logout'));
  wireAdd();
  wireProfile();
}

function setQuery(q) {
  const wasEmpty = !state.q;
  state.q = q.trim();
  if (state.q && wasEmpty) {
    // a new search looks everywhere; narrow it down afterwards with the sidebar / tabs
    state.cat = 'all';
    state.type = 'all';
  }
  if (window.scrollY > 0) scrollTo({ top: 0 }); // best match is always at the top
  render();
}

const tokenize = (q) => q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);

function score(item, terms) {
  if (!terms.length) return 0;
  const s = item.search;
  let total = 0;
  for (const t of terms) {
    if (s.title.includes(t)) total += s.title.startsWith(t) || s.title.includes(' ' + t) ? 12 : 9;
    else if (s.tags.includes(t)) total += 7;
    else if (s.code.includes(t)) total += 4;
    else if (s.text.includes(t)) total += 3;
    else if (s.extra.includes(t)) total += 2;
    else return -1;
  }
  return total + (item.pin ? 1 : 0);
}

function render() {
  const terms = tokenize(state.q);
  const inCat = (it) =>
    state.cat === 'all' || (state.cat === '__pinned' ? it.pin : it.category === state.cat);
  const inType = (it) => state.type === 'all' || it.type === state.type;

  const matched = [];
  for (const it of state.items) {
    const s = score(it, terms);
    if (s >= 0) matched.push({ it, s });
  }

  const typeCounts = { all: 0 };
  const catCounts = {};
  let allCount = 0;
  let pinCount = 0;
  for (const { it } of matched) {
    if (inCat(it)) {
      typeCounts.all++;
      typeCounts[it.type] = (typeCounts[it.type] || 0) + 1;
    }
    if (inType(it)) {
      allCount++;
      catCounts[it.category] = (catCounts[it.category] || 0) + 1;
      if (it.pin) pinCount++;
    }
  }

  const list = matched.filter(({ it }) => inCat(it) && inType(it));
  const grouped = !terms.length && state.cat === 'all';
  if (terms.length) list.sort((a, b) => b.s - a.s || a.it.order - b.it.order);
  else if (grouped) {
    list.sort(
      (a, b) => state.catIndex.get(a.it.category) - state.catIndex.get(b.it.category) || a.it.order - b.it.order,
    );
  }

  renderTabs(typeCounts);
  renderSidebar(catCounts, allCount, pinCount);
  ui.count.textContent = `${list.length} ${list.length === 1 ? 'item' : 'items'}`;

  if (!list.length) {
    ui.results.innerHTML = state.items.length
      ? `<div class="empty">No matches${state.q ? ` for “${esc(state.q)}”` : ''}.<br>Try fewer words, another category, or the “All” tab.</div>`
      : '<div class="empty">No content yet. Add Markdown files to <code class="ic">content/</code> and run <code class="ic">npm run build</code>.</div>';
    return;
  }

  let html = '';
  if (grouped) {
    let current = null;
    for (const { it } of list) {
      if (it.category !== current) {
        current = it.category;
        const c = state.catById.get(current);
        html += `<h2 class="group-title"><span>${esc(c.icon)}</span>${esc(c.name)}</h2>`;
      }
      html += cardHtml(it, false);
    }
  } else {
    const showCat = state.cat === 'all' || state.cat === '__pinned';
    html = list.map(({ it }) => cardHtml(it, showCat)).join('');
  }
  ui.results.innerHTML = html;
  if (terms.length) highlight(ui.results, terms);
}

function renderTabs(counts) {
  ui.tabs.innerHTML = TYPE_TABS.map(([id, label]) => {
    const active = state.type === id;
    return `<button type="button" role="tab" class="tab${active ? ' active' : ''}" aria-selected="${active}" data-type="${id}">${label}<span class="ct">${counts[id] || 0}</span></button>`;
  }).join('');
}

function renderSidebar(catCounts, allCount, pinCount) {
  const entry = (id, icon, name, count) =>
    `<button type="button" class="side-item${state.cat === id ? ' active' : ''}${count ? '' : ' zero'}" data-cat="${esc(id)}" title="${esc(name)}">` +
    `<span class="ic">${esc(icon)}</span><span class="nm">${esc(name)}</span><span class="ct">${count}</span></button>`;
  ui.catList.innerHTML =
    entry('all', '🗂️', 'All', allCount) +
    (state.items.some((i) => i.pin) ? entry('__pinned', '⭐', 'Pinned', pinCount) : '') +
    '<div class="side-sep"></div>' +
    state.categories.map((c) => entry(c.id, c.icon, c.name, catCounts[c.id] || 0)).join('');
}

function cardHtml(it, showCat) {
  const badges = [];
  if (it.pin) badges.push('<span class="badge pin" title="Pinned">★</span>');
  badges.push(`<span class="badge">${TYPE_LABEL[it.type]}</span>`);
  if (it.shell && LANG_LABEL[it.shell] && it.shell !== 'text') badges.push(`<span class="badge">${esc(LANG_LABEL[it.shell])}</span>`);
  if (it.admin) badges.push('<span class="badge admin" title="Open the terminal with “Run as administrator”">Run as admin</span>');

  const url = it.url && safeUrl(it.url);
  const title = url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(it.title)}</a>`
    : esc(it.title);
  const host = url ? `<div class="host">${esc(hostOf(url))} ↗</div>` : '';
  const linkActions = url
    ? `<div class="link-actions"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener noreferrer">Open ↗</a>` +
      `<button type="button" class="btn" data-copy="url" data-url="${esc(url)}">${COPY_ICON}<span>Copy link</span></button></div>`
    : '';

  const cat = state.catById.get(it.category);
  const tags = it.tags.map((t) => `<button type="button" class="tag" data-tag="${esc(t)}">#${esc(t)}</button>`).join('');
  const foot =
    showCat || tags
      ? `<footer class="card-foot">${showCat && cat ? `<span class="cat-chip">${esc(cat.icon)} ${esc(cat.name)}</span>` : ''}${tags}</footer>`
      : '';

  return (
    `<article class="card t-${it.type}">` +
    `<header class="card-head"><h3 class="card-title">${title}</h3><div class="badges">${badges.join('')}</div></header>` +
    `${host}<div class="card-body">${it.blocks.map(blockHtml).join('')}</div>${linkActions}${foot}</article>`
  );
}

function blockHtml(b) {
  switch (b.t) {
    case 'p':
      return `<p>${inline(b.text)}</p>`;
    case 'ol':
      return `<ol${b.start && b.start !== 1 ? ` start="${Number(b.start)}"` : ''}>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ol>`;
    case 'ul':
      return `<ul>${b.items.map((i) => `<li>${inline(i)}</li>`).join('')}</ul>`;
    case 'note': {
      const warn = /^(⚠|warning|caution|careful|danger|important)/i.test(b.text);
      return `<div class="note${warn ? ' warn' : ''}">${inline(b.text)}</div>`;
    }
    case 'code':
      return codeBlockHtml(b);
    default:
      return '';
  }
}

// ---- code blocks & variables ------------------------------------------------
function valueFor(block, name, occurrenceDefault) {
  const typed = String(state.vars[name] ?? '').trim();
  if (typed) return typed;
  if (occurrenceDefault !== undefined) return occurrenceDefault.trim();
  const v = block.vars.find((x) => x.name === name);
  return v && v.def !== undefined ? v.def : '';
}

function codeHtml(block) {
  const comment = COMMENT_RE[block.lang];
  return block.code
    .split('\n')
    .map((line) => {
      let out = '';
      let last = 0;
      for (const m of line.matchAll(varPattern())) {
        out += esc(line.slice(last, m.index));
        const typed = String(state.vars[m[1]] ?? '').trim();
        const shown = valueFor(block, m[1], m[2]);
        const cls = typed ? 'set' : shown ? 'def' : 'need';
        out += `<span class="var ${cls}" title="${esc(m[1])}">${esc(shown || m[1])}</span>`;
        last = m.index + m[0].length;
      }
      out += esc(line.slice(last));
      return comment && comment.test(line) ? `<span class="cm">${out}</span>` : out;
    })
    .join('\n');
}

function codeBlockHtml(block) {
  const lang = LANG_LABEL[block.lang] || block.lang.toUpperCase();
  const long = block.lineCount > COLLAPSE_AT;
  const uri = block.lang === 'run' && !block.vars.length ? settingsUri(block.code) : null;
  const openBtn = uri
    ? `<a class="open-btn" href="${esc(uri)}" title="Open this Settings page (Windows asks you to confirm)">${OPEN_ICON}<span>Open</span></a>`
    : '';
  const vars = block.vars.length
    ? `<div class="vars">${block.vars
        .map(
          (v) =>
            `<label class="var-field"><span>${esc(v.name)}</span><input type="text" data-var="${esc(v.name)}" value="${esc(state.vars[v.name] || '')}" placeholder="${esc(v.def !== undefined && v.def !== '' ? v.def : v.def === '' ? 'optional' : 'required')}" autocomplete="off" autocapitalize="off" spellcheck="false"></label>`,
        )
        .join('')}</div>`
    : '';
  return (
    `<div class="code${long ? ' collapsible' : ''}" data-block="${block.id}" data-vars="${esc(block.vars.map((v) => v.name).join(' '))}">` +
    `<div class="code-head"><span class="lang">${esc(lang)}</span>${block.label ? `<span class="code-label">${esc(block.label)}</span>` : ''}` +
    `<span class="code-actions">${openBtn}${
      DOWNLOADABLE_LANGS.has(block.lang)
        ? `<button type="button" class="dl-btn" data-download title="Download as a .cmd file. Double-click it to run${block.admin ? ' (asks for admin rights)' : ''}. It deletes itself afterwards.">${DOWNLOAD_ICON}<span>.cmd</span></button>`
        : ''
    }<button type="button" class="copy-btn" data-copy="block" aria-label="Copy code">${COPY_ICON}<span>Copy</span></button></span></div>` +
    `${vars}<pre><code>${codeHtml(block)}</code></pre>` +
    `${long ? `<button type="button" class="expand-btn" data-expand>Show all ${block.lineCount} lines</button>` : ''}</div>`
  );
}

function resolveCode(block) {
  const missing = block.vars.find((v) => v.def === undefined && !String(state.vars[v.name] ?? '').trim());
  if (missing) return { missing: missing.name };
  return { text: block.code.replace(varPattern(), (_, name, occ) => valueFor(block, name, occ)) };
}

/** Code with variables filled in, or null after pointing the user at the empty field. */
function resolveOrAsk(wrap, block) {
  const res = resolveCode(block);
  if (!res.missing) return res.text;
  const input = [...wrap.querySelectorAll('input[data-var]')].find((i) => i.dataset.var === res.missing);
  if (input) {
    input.classList.add('need');
    input.focus();
  }
  toast(`Fill in “${res.missing}” first`, 'warn');
  return null;
}

function downloadFromButton(btn) {
  const wrap = btn.closest('.code');
  const block = wrap && state.blocks.get(wrap.dataset.block);
  if (!block) return;
  const code = resolveOrAsk(wrap, block);
  if (code === null) return;
  const { fileName, text } = buildCmdFile({ title: block.itemTitle, lang: block.lang, code, admin: block.admin });
  saveFile(fileName, text);
  toast(`Downloaded ${fileName} — double-click it to run`);
}

let saveVarsTimer;
function onVarInput(input) {
  const name = input.dataset.var;
  const value = input.value;
  if (value.trim()) state.vars[name] = value;
  else delete state.vars[name];
  input.classList.remove('need');
  clearTimeout(saveVarsTimer);
  saveVarsTimer = setTimeout(() => sessionStorage.setItem(SS.vars, JSON.stringify(state.vars)), 300);

  // the same variable name is shared by every command (type a hostname once, use it everywhere)
  ui.results.querySelectorAll('input[data-var]').forEach((other) => {
    if (other !== input && other.dataset.var === name) other.value = value;
  });
  ui.results.querySelectorAll('.code[data-vars]').forEach((wrap) => {
    if (!wrap.dataset.vars.split(' ').includes(name)) return;
    const block = state.blocks.get(wrap.dataset.block);
    if (block) wrap.querySelector('pre code').innerHTML = codeHtml(block);
  });
}

async function onResultsClick(e) {
  const copyBtn = e.target.closest('[data-copy]');
  if (copyBtn) return copyFromButton(copyBtn);

  const dlBtn = e.target.closest('[data-download]');
  if (dlBtn) return downloadFromButton(dlBtn);

  const ic = e.target.closest('code.ic');
  if (ic) {
    if (await copyText(ic.textContent)) {
      ic.classList.add('flash');
      setTimeout(() => ic.classList.remove('flash'), 700);
      toast(`Copied: ${ic.textContent.length > 40 ? ic.textContent.slice(0, 40) + '…' : ic.textContent}`);
    } else {
      toast(`Copy failed — select the text and press ${COPY_KEYS}`, 'warn');
    }
    return;
  }

  const expand = e.target.closest('[data-expand]');
  if (expand) {
    const wrap = expand.closest('.code');
    const open = wrap.classList.toggle('expanded');
    const block = state.blocks.get(wrap.dataset.block);
    expand.textContent = open ? 'Show less' : `Show all ${block ? block.lineCount : ''} lines`;
    return;
  }

  const tag = e.target.closest('[data-tag]');
  if (tag) {
    ui.search.value = tag.dataset.tag;
    state.q = '';
    setQuery(tag.dataset.tag);
    scrollTo({ top: 0 });
  }
}

async function copyFromButton(btn) {
  let text;
  if (btn.dataset.copy === 'url') {
    text = btn.dataset.url;
  } else {
    const wrap = btn.closest('.code');
    const block = wrap && state.blocks.get(wrap.dataset.block);
    if (!block) return;
    text = resolveOrAsk(wrap, block);
    if (text === null) return;
  }

  const label = btn.querySelector('span');
  if (await copyText(text)) {
    const original = label.textContent;
    btn.classList.add('done');
    label.textContent = 'Copied';
    toast('Copied to clipboard');
    setTimeout(() => {
      btn.classList.remove('done');
      label.textContent = original;
    }, 1600);
  } else {
    toast(`Copy failed — select the text and press ${COPY_KEYS}`, 'warn');
  }
}

// ---- search highlighting ----------------------------------------------------
function highlight(root, terms) {
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement.closest('pre, code, button, .badges, .vars, .host')
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = node.data.split(re);
    if (parts.length < 2) continue;
    const frag = document.createDocumentFragment();
    parts.forEach((p, i) => {
      if (!p) return;
      if (i % 2) {
        const mark = document.createElement('mark');
        mark.textContent = p;
        frag.appendChild(mark);
      } else {
        frag.appendChild(document.createTextNode(p));
      }
    });
    node.replaceWith(frag);
  }
}

// ---- add from the website ---------------------------------------------------
// New items are saved as their own file (content/online/<time>-<title>.md) inside the encrypted
// data, committed straight to GitHub with the token. "npm run deploy" on the PC imports them.
const NEW_CAT = '__new';
const META_LINE = /^(type|shell|admin|tags|pin|url|id)\s*:/i;
const addUi = {
  dialog: $('add-dialog'),
  form: $('add-form'),
  setup: $('add-setup'),
  cat: $('add-cat'),
  newCatWrap: $('add-newcat-wrap'),
  newCat: $('add-newcat'),
  title: $('add-title'),
  desc: $('add-desc'),
  shell: $('add-shell'),
  admin: $('add-admin'),
  pin: $('add-pin'),
  code: $('add-code'),
  tags: $('add-tags'),
  url: $('add-url'),
  tokenWrap: $('add-token-wrap'),
  token: $('add-token'),
  preview: $('add-preview'),
  error: $('add-error'),
  save: $('add-save'),
  target: $('add-target'),
};
const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();

function wireAdd() {
  $('add-btn').addEventListener('click', openAddDialog);
  addUi.form.addEventListener('submit', onAddSubmit);
  addUi.dialog.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) addUi.dialog.close();
  });
  addUi.cat.addEventListener('change', () => {
    addUi.newCatWrap.hidden = addUi.cat.value !== NEW_CAT;
    if (!addUi.newCatWrap.hidden) addUi.newCat.focus();
  });
  let timer;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(updatePreview, 150);
  };
  addUi.form.addEventListener('input', later);
  addUi.form.addEventListener('change', later);
}

function openAddDialog() {
  const gh = state.github;
  addUi.setup.hidden = Boolean(gh);
  addUi.save.disabled = !gh;
  addUi.tokenWrap.hidden = !gh || Boolean(gh.token || state.sessionToken);
  addUi.target.textContent = gh ? `Saves to GitHub: ${gh.owner}/${gh.repo}` : '';

  const previous = addUi.cat.value;
  addUi.cat.innerHTML =
    state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.icon)} ${esc(c.name)}</option>`).join('') +
    `<option value="${NEW_CAT}">➕ New category…</option>`;
  const wanted = state.catById.has(state.cat) ? state.cat : previous;
  if (wanted && [...addUi.cat.options].some((o) => o.value === wanted)) addUi.cat.value = wanted;
  addUi.newCatWrap.hidden = addUi.cat.value !== NEW_CAT;

  setAddError('');
  updatePreview();
  if (typeof addUi.dialog.showModal === 'function') addUi.dialog.showModal();
  else addUi.dialog.setAttribute('open', '');
  addUi.title.focus();
}

/** Read the form. With strict=true, returns { error, field } when something required is missing. */
function readAddForm(strict = false) {
  const fail = (error, field) => (strict ? { error, field } : null);
  let category;
  if (addUi.cat.value === NEW_CAT) {
    category = oneLine(addUi.newCat.value).replace(/^#+\s*/, '');
    if (!category) {
      const f = fail('Type a name for the new category.', addUi.newCat);
      if (f) return f;
      category = '📁 New category';
    }
  } else {
    const c = state.catById.get(addUi.cat.value);
    category = c ? `${c.icon} ${c.name}` : '📁 General';
  }
  const title = oneLine(addUi.title.value).replace(/^#+\s*/, '');
  const desc = addUi.desc.value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  const code = addUi.code.value.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
  const url = addUi.url.value.trim();
  const tags = addUi.tags.value.split(',').map((t) => oneLine(t).replace(/^#/, '')).filter(Boolean);

  if (strict) {
    if (!title) return fail('Give it a title.', addUi.title);
    if (url && !/^https?:\/\/\S+$/i.test(url)) return fail('The link must start with https:// (or http://).', addUi.url);
    if (!code && !desc && !url) return fail('Add a command, a description or a link.', addUi.code);
  }
  return { category, title, desc, code, url, tags, shell: addUi.shell.value, admin: addUi.admin.checked, pin: addUi.pin.checked };
}

/** Turn the form into the same Markdown format as the files in content/. */
function itemMarkdown(f) {
  const lines = [`# ${f.category}`, '', `## ${f.title || 'Untitled'}`];
  if (f.tags.length) lines.push(`tags: ${f.tags.join(', ')}`);
  if (f.admin) lines.push('admin: yes');
  if (f.pin) lines.push('pin: yes');
  if (f.url) lines.push(`url: ${f.url}`);
  lines.push('');
  if (f.desc) {
    // a zero-width space stops a description line from being read as a heading, code fence or setting
    const guard = (line, i) => (/^\s*(#|`{3,}|~{3,}|<!--)/.test(line) || (i === 0 && META_LINE.test(line)) ? `​${line}` : line);
    lines.push(...f.desc.split('\n').map(guard), '');
  }
  if (f.code) {
    const longest = Math.max(2, ...(f.code.match(/`+/g) || []).map((s) => s.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    lines.push(fence + f.shell, f.code, fence, '');
  }
  return lines.join('\n');
}

function updatePreview() {
  const f = readAddForm();
  const empty = !f.title && !f.desc && !f.code && !f.url;
  if (empty) {
    addUi.preview.innerHTML = '<div class="muted small">Fill in the form — the card will appear here.</div>';
    return;
  }
  const { items } = parseContent([{ name: 'preview.md', text: itemMarkdown(f) }]);
  addUi.preview.innerHTML = items.length ? cardHtml(items[0], false) : '';
}

function setAddError(message) {
  addUi.error.textContent = message;
  addUi.error.hidden = !message;
}

function setAddBusy(busy) {
  addUi.save.disabled = busy;
  addUi.save.querySelector('.spinner').hidden = !busy;
  addUi.save.querySelector('.label').textContent = busy ? 'Saving…' : 'Save to website';
}

async function onAddSubmit(e) {
  e.preventDefault();
  const gh = state.github;
  if (!gh) return;
  const f = readAddForm(true);
  if (f.error) {
    setAddError(f.error);
    if (f.field) f.field.focus();
    return;
  }
  const token = (gh.token || state.sessionToken || addUi.token.value).trim();
  if (!token) {
    setAddError('Paste the GitHub token to save.');
    addUi.token.focus();
    return;
  }

  setAddError('');
  setAddBusy(true);
  try {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
    const file = { name: `online/${stamp}-${(slugify(f.title) || 'item').slice(0, 40)}.md`, text: itemMarkdown(f) };
    const data = await saveToGithub(gh, token, file, f.title);
    if (!gh.token) state.sessionToken = token; // remembered in memory for this tab only
    addUi.token.value = '';
    loadData(data);
    addUi.form.reset();
    addUi.dialog.close();
    ui.search.value = f.title;
    state.q = '';
    setQuery(f.title);
    toast('Saved — live on the website in about a minute');
  } catch (err) {
    if (err.code === 'GH_AUTH' && !gh.token) {
      state.sessionToken = '';
      addUi.tokenWrap.hidden = false;
    }
    setAddError(err.message || 'Saving failed.');
  } finally {
    setAddBusy(false);
    if (!state.github) addUi.save.disabled = true;
  }
}

/** Add one file to the published data: read the latest version, re-encrypt with the same key, commit. */
async function saveToGithub(gh, token, file, title) {
  const branch = gh.branch || 'main';
  for (let attempt = 1; ; attempt++) {
    // 1. the latest published version (a deploy may have happened since this page was opened)
    const cur = await ghReadFile(gh, token, 'docs/data.enc.json', branch);
    if (cur.status !== 'ok') {
      throw appError('GH_NOT_FOUND', 'The data file was not found on GitHub. Publish the site first with "npm run deploy".');
    }
    const envelope = JSON.parse(cur.text);
    if (!state.keyMeta || envelope.salt !== state.keyMeta.salt || envelope.iterations !== state.keyMeta.iterations) {
      throw appError('LOGIN_CHANGED', 'The site login was changed since you signed in. Log out, sign in again, then save.');
    }
    const data = await decryptWithKey(envelope, state.key);

    // 2. add the new file and encrypt again with the same key
    data.files = [...(data.files || []).filter((x) => x.name !== file.name), file];
    data.updated = new Date().toISOString();
    const next = await encryptWithKey(data, state.key, { salt: envelope.salt, iterations: envelope.iterations });

    // 3. commit — GitHub refuses if someone else changed the file in between, then retry
    const saved = await ghWriteFile(gh, token, 'docs/data.enc.json', {
      text: JSON.stringify(next) + '\n',
      sha: cur.sha,
      branch,
      message: `Add "${title}" (from website)`,
    });
    if (saved) return data;
    if (attempt >= 3) throw appError('GH_CONFLICT', 'GitHub was busy updating the same file. Wait a minute and press Save again.');
  }
}

// ---- profile & sessions -----------------------------------------------------
const prof = {
  btn: $('profile-btn'),
  count: $('session-count'),
  dialog: $('profile-dialog'),
  user: $('profile-user'),
  since: $('profile-since'),
  status: $('sess-status'),
  list: $('sess-list'),
  closedWrap: $('sess-closed'),
  closed: $('sess-closed-list'),
  refresh: $('sess-refresh'),
  zone: $('signout-zone'),
  form: $('signout-form'),
  pass: $('so-pass'),
  change: $('so-change'),
  newWrap: $('so-new-wrap'),
  newPass: $('so-new'),
  newPass2: $('so-new2'),
  error: $('so-error'),
  done: $('so-done'),
  submit: $('so-btn'),
};
const ENDED = { logout: 'Logged out', idle: 'Timed out', revoked: 'Revoked', 'signout-all': 'Signed out (all devices)' };

function beginSessions(newLogin) {
  let sid = sessionStorage.getItem(SS.sid);
  if (!sid || newLogin) {
    sid = newSessionId();
    sessionStorage.setItem(SS.sid, sid);
  }
  startSessions(
    {
      gh: state.github,
      getKey: () => state.key,
      getKeyMeta: () => state.keyMeta,
      setKey: async (key, keyMeta) => {
        state.key = key;
        state.keyMeta = keyMeta;
        sessionStorage.setItem(SS.key, await exportKey(key));
        sessionStorage.setItem(SS.rotated, String(Date.now()));
      },
      onForcedLogout: (message) => logout(message),
      onChange: renderSessions,
      activeMs: IDLE_MS + 7 * 60_000,
    },
    { sid, isNew: newLogin },
  );
}

function ago(ms) {
  const min = Math.round(ms / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function sessionRow(s, t) {
  const icon = /iPhone|iPad|Android/.test(s.dev) ? '📱' : '💻';
  const when =
    s.state === 'active' ? 'Active now'
    : s.state === 'idle' ? `Last active ${ago(t - s.seen)}`
    : s.state === 'expired' ? `Tab closed · last active ${ago(t - s.seen)}`
    : `${ENDED[s.why] || 'Ended'} ${ago(t - s.end)}`;
  const revoke = !s.me && (s.state === 'active' || s.state === 'idle')
    ? `<button type="button" class="btn ghost sm" data-revoke="${esc(s.id)}">Revoke</button>`
    : '';
  return (
    `<div class="sess${s.me ? ' me' : ''}"><span class="sess-ic" aria-hidden="true">${icon}</span>` +
    `<div class="sess-main"><div class="sess-name">${esc(s.dev)}${s.me ? ' <span class="pill">This device</span>' : ''}</div>` +
    `<div class="sess-meta">Signed in ${esc(fmtWhen(s.start))} · ${esc(when)}</div></div>${revoke}</div>`
  );
}

function renderSessions() {
  const v = sessionsView();
  prof.count.hidden = v.status === 'off' || !v.count;
  prof.count.textContent = String(v.count);
  prof.btn.title = v.status === 'off' ? 'Profile' : `Profile · ${v.count} signed-in session${v.count === 1 ? '' : 's'}`;
  if (!prof.dialog.open) return;

  const me = v.open.find((s) => s.me);
  prof.since.textContent = me ? `${me.dev} · signed in ${fmtWhen(me.start)}` : 'This device';
  prof.zone.hidden = v.status === 'off';
  prof.refresh.hidden = v.status === 'off';

  if (v.status === 'off') {
    prof.status.innerHTML =
      'The session list is off. It uses the GitHub token of the <strong>＋ Add</strong> button: on your PC run ' +
      '<code class="ic">npm run setup-editing</code> (answer <strong>Y</strong> to keep the token), then <code class="ic">npm run deploy</code>.';
    prof.list.innerHTML = '';
    prof.closedWrap.hidden = true;
    return;
  }
  prof.status.textContent =
    v.status === 'loading' && !v.open.length ? 'Loading sessions…'
    : v.status === 'error' ? `${v.error} Showing the last known list.`
    : `${v.count} signed-in session${v.count === 1 ? '' : 's'} (updated every minute)`;
  prof.status.className = `sess-status${v.status === 'error' ? ' warn' : ''}`;
  prof.list.innerHTML = v.open.map((s) => sessionRow(s, v.now)).join('') || '<div class="muted small">No active sessions.</div>';
  prof.closedWrap.hidden = !v.closed.length;
  prof.closed.innerHTML = v.closed.map((s) => sessionRow(s, v.now)).join('');
}

function openProfile() {
  prof.user.textContent = ui.userLabel.textContent;
  setSignoutMessage('');
  if (typeof prof.dialog.showModal === 'function') prof.dialog.showModal();
  else prof.dialog.setAttribute('open', '');
  renderSessions();
  refreshSessions();
}

function setSignoutMessage(error, done = '') {
  prof.error.textContent = error;
  prof.error.hidden = !error;
  prof.done.textContent = done;
  prof.done.hidden = !done;
}

function wireProfile() {
  prof.btn.addEventListener('click', openProfile);
  prof.refresh.addEventListener('click', () => refreshSessions());
  prof.dialog.addEventListener('click', async (e) => {
    if (e.target.closest('[data-close]')) return prof.dialog.close();
    const btn = e.target.closest('[data-revoke]');
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = 'Revoking…';
    try {
      await revokeSession(btn.dataset.revoke);
      toast('Revoked — that device signs out within a minute');
    } catch (err) {
      toast(err.message || 'Could not revoke', 'warn');
    }
    renderSessions();
  });
  prof.change.addEventListener('change', () => {
    prof.newWrap.hidden = !prof.change.checked;
    if (prof.change.checked) prof.newPass.focus();
  });
  prof.form.addEventListener('submit', onSignoutSubmit);
}

async function onSignoutSubmit(e) {
  e.preventDefault();
  const password = prof.pass.value;
  const change = prof.change.checked;
  const newPassword = change ? prof.newPass.value : '';
  if (!password) return setSignoutMessage('Type your current password.');
  if (change) {
    if (newPassword.length < MIN_PASSWORD) return setSignoutMessage(`The new password must be at least ${MIN_PASSWORD} characters.`);
    if (newPassword !== prof.newPass2.value) return setSignoutMessage('The new passwords do not match.');
    if (newPassword === password) return setSignoutMessage('The new password is the same as the current one.');
  }
  setSignoutMessage('');
  prof.submit.disabled = true;
  prof.submit.querySelector('.spinner').hidden = false;
  prof.submit.querySelector('.label').textContent = 'Working…';
  try {
    const username = sessionStorage.getItem(SS.user) || ui.userLabel.textContent;
    await signOutEverywhere({ username, password, newPassword });
    prof.form.reset();
    prof.newWrap.hidden = true;
    setSignoutMessage(
      '',
      'Done — every other device is signed out within a minute. The website finishes updating in about a minute.' +
        (change ? ' Use the NEW password from now on (also for "npm run deploy" on your PC).' : ''),
    );
    toast(change ? 'Password changed — other devices signed out' : 'All other devices signed out');
  } catch (err) {
    setSignoutMessage(err.message || 'Something went wrong. Nothing was changed.');
  } finally {
    prof.pass.value = '';
    prof.newPass.value = '';
    prof.newPass2.value = '';
    prof.submit.disabled = false;
    prof.submit.querySelector('.spinner').hidden = true;
    prof.submit.querySelector('.label').textContent = 'Sign out all other devices';
    renderSessions();
  }
}

// ---- boot -------------------------------------------------------------------
async function init() {
  applyTheme(localStorage.getItem(THEME_KEY));
  document.querySelectorAll('[data-idle]').forEach((el) => (el.textContent = String(IDLE_MINUTES)));
  wireLogin();

  if (!window.isSecureContext || !(globalThis.crypto && globalThis.crypto.subtle)) {
    showLogin('This page must be opened over HTTPS — encryption is not available on plain http://.');
    ui.loginBtn.disabled = true;
    return;
  }

  const notice = sessionStorage.getItem(SS.notice);
  sessionStorage.removeItem(SS.notice);

  const savedKey = sessionStorage.getItem(SS.key);
  if (savedKey && !idleExpired()) {
    try {
      const envelope = await fetchEnvelope();
      const key = await importKey(savedKey);
      const data = await decryptWithKey(envelope, key);
      state.key = key;
      state.keyMeta = { salt: envelope.salt, iterations: envelope.iterations };
      touch(true);
      startApp(data, sessionStorage.getItem(SS.user) || '');
      return;
    } catch {
      // content was rebuilt with new credentials, or the file is unavailable — ask again
      const rotated = Number(sessionStorage.getItem(SS.rotated));
      if (rotated && Date.now() - rotated < 10 * 60_000) {
        // this tab just changed the key; GitHub Pages still serves the old file for a minute
        showLogin('Your security change is still being published (about a minute). Reload this page shortly.', 'info');
        return;
      }
    }
  }
  clearSession();
  showLogin(notice || '', 'info');
}

init();
