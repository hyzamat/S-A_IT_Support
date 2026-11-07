// Signed-in sessions for the Profile dialog. There is no server, so the list lives in the site's
// GitHub repo: an encrypted file (same key as the content) on its own branch, so it never
// triggers a website rebuild. Every tab:
//   • adds itself when you sign in,
//   • updates its "last active" time every few minutes while you are using it,
//   • checks the list every minute (and when you come back to the tab) — if it was revoked, or the
//     key was changed with "Sign out all other devices", it signs itself out.
// This is a "please sign out" signal for normal browser tabs. Someone who already knows the
// password could still decrypt the public file without the website — changing the password
// (with "Sign out all other devices") is what really locks them out.

import { decryptWithKey, encryptWithKey, deriveKey, unlock, toBase64, fromBase64, KDF_ITERATIONS } from './crypto.js';
import { ghReadFile, ghWriteFile, ghEnsureBranch } from './github.js';

export const SESSIONS_BRANCH = 'itsupport-sessions';
const FILE = 'sessions.enc.json';
const DATA_FILE = 'docs/data.enc.json';
const POLL_MS = 60_000;
const HEARTBEAT_MS = 5 * 60_000;
const NOW_MS = 7 * 60_000; // "active now" (a used tab reports in every ~5 minutes)
const KEEP_ENDED_MS = 7 * 86_400_000;
const KEEP_STALE_MS = 86_400_000;
const MAX_ENTRIES = 60;
export const MIN_PASSWORD = 12;

const codeError = (code, message) => Object.assign(new Error(message), { code });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const S = {
  ctx: null, // { gh, token, getKey, getKeyMeta, onForcedLogout, onChange, activeMs }
  sid: '',
  doc: null,
  etag: '',
  skew: 0, // GitHub time minus this PC's clock (client PCs often have the wrong time)
  status: 'off', // off | loading | ok | error
  error: '',
  lastBeat: 0,
  lastActivity: Date.now(),
  rotated: false, // this tab changed the key — an old-key file is replaced, not a reason to sign out
  timer: null,
  polling: false,
  stopped: false,
};

const now = () => Date.now() + S.skew;
const branchOf = () => S.ctx.gh.branch || 'main';
const emit = () => S.ctx && S.ctx.onChange && S.ctx.onChange();

export function newSessionId() {
  const b = globalThis.crypto.getRandomValues(new Uint8Array(9));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function deviceName(ua = navigator.userAgent) {
  const os = /iPhone/.test(ua) ? 'iPhone'
    : /iPad/.test(ua) ? 'iPad'
    : /Android/.test(ua) ? 'Android'
    : /Windows/.test(ua) ? 'Windows'
    : /CrOS/.test(ua) ? 'ChromeOS'
    : /Mac OS X|Macintosh/.test(ua) ? 'Mac'
    : /Linux/.test(ua) ? 'Linux'
    : 'unknown device';
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Safari\//.test(ua) ? 'Safari'
    : 'Browser';
  return `${browser} on ${os}`;
}

// ---- public API -------------------------------------------------------------

/**
 * Start tracking this tab. `ctx.gh` needs a stored token (npm run setup-editing → keep the token);
 * without it the list is simply off and the rest of the site works as before.
 */
export function startSessions(ctx, { sid, isNew }) {
  S.ctx = { ...ctx, token: ctx.gh && ctx.gh.token };
  S.sid = sid;
  if (!ctx.gh || !ctx.gh.token) {
    S.status = 'off';
    emit();
    return;
  }
  S.status = 'loading';
  emit();
  const begin = isNew ? register() : poll(true);
  begin.catch(fail).finally(() => {
    if (S.stopped) return;
    S.timer = setInterval(() => poll().catch(fail), POLL_MS);
    document.addEventListener('visibilitychange', () => !document.hidden && poll().catch(fail));
    addEventListener('focus', () => poll().catch(fail));
  });
}

/** Called on mouse / keyboard activity, so only tabs that are really used send "last active". */
export function noteActivity() {
  S.lastActivity = Date.now();
}

export function sessionsView() {
  const list = (S.doc && S.doc.sessions) || [];
  const t = now();
  const activeMs = (S.ctx && S.ctx.activeMs) || 20 * 60_000;
  const rows = list
    .map((s) => {
      const state = s.end ? 'ended' : t - s.seen > activeMs ? 'expired' : t - s.seen > NOW_MS ? 'idle' : 'active';
      return { ...s, state, me: s.id === S.sid };
    })
    .sort((a, b) => Number(b.me) - Number(a.me) || b.seen - a.seen);
  const open = rows.filter((r) => r.state === 'active' || r.state === 'idle');
  return {
    status: S.status,
    error: S.error,
    now: t,
    open,
    closed: rows.filter((r) => r.state === 'ended' || r.state === 'expired'),
    count: open.length,
  };
}

export const refreshSessions = () => poll(true).catch(fail);

/** Mark this tab's session as ended (log out / idle). Never throws. */
export async function endSession(why) {
  stop();
  if (!S.ctx || !S.ctx.gh || !S.ctx.gh.token || S.status === 'off') return;
  try {
    await update((doc, t) => {
      const me = doc.sessions.find((s) => s.id === S.sid);
      if (!me || me.end) return false;
      me.seen = t;
      me.end = t;
      me.why = why;
    });
  } catch {
    /* offline — it will show as expired after a while */
  }
}

/** Revoke another session. Its tab signs itself out within about a minute. */
export async function revokeSession(id) {
  if (id === S.sid) throw codeError('SELF', 'Use "Log out" for this device.');
  await update((doc, t) => {
    const s = doc.sessions.find((x) => x.id === id);
    if (!s || s.end) return false;
    s.end = t;
    s.why = 'revoked';
  });
}

/**
 * Lock the content with a NEW key (optionally a new password too). Every other tab and every
 * saved key stops working; this tab switches to the new key. Returns { key, keyMeta }.
 */
export async function signOutEverywhere({ username, password, newPassword = '' }) {
  if (!S.ctx || !S.ctx.gh || !S.ctx.gh.token) throw codeError('OFF', 'Website editing is not set up.');
  if (newPassword && newPassword.length < MIN_PASSWORD) {
    throw codeError('WEAK', `The new password must be at least ${MIN_PASSWORD} characters.`);
  }
  const { gh, token } = S.ctx;
  const branch = branchOf();

  for (let attempt = 1; attempt <= 3; attempt++) {
    // 1. the published content, checked with the password that was typed
    const file = await ghReadFile(gh, token, DATA_FILE, branch);
    if (file.status !== 'ok') throw codeError('GH_NOT_FOUND', 'The data file was not found on GitHub.');
    let data;
    try {
      ({ data } = await unlock(JSON.parse(file.text), username, password));
    } catch (e) {
      if (e.code === 'BAD_LOGIN') throw codeError('BAD_PASSWORD', 'That password is not correct.');
      throw e;
    }

    // 2. a brand-new key (new salt), with the new password if one was given
    const keyMeta = { salt: toBase64(globalThis.crypto.getRandomValues(new Uint8Array(16))), iterations: KDF_ITERATIONS };
    const key = await deriveKey(username, newPassword || password, fromBase64(keyMeta.salt), keyMeta.iterations);
    data.updated = new Date().toISOString();
    const next = await encryptWithKey(data, key, keyMeta);
    const saved = await ghWriteFile(gh, token, DATA_FILE, {
      text: JSON.stringify(next) + '\n',
      sha: file.sha,
      branch,
      message: newPassword ? 'Change password (from website)' : 'New key (from website)',
    });
    if (!saved) {
      await sleep(500 * attempt); // something was saved at the same moment — start again
      continue;
    }

    // 3. switch this tab over, then rewrite the session list (history kept) with the new key
    const old = await read(true).catch(() => null);
    await S.ctx.setKey(key, keyMeta);
    S.rotated = true;
    try {
      await update((doc, t) => {
        if (old && old.doc && !old.keyChanged && !old.unchanged) doc.sessions = old.doc.sessions;
        for (const s of doc.sessions) {
          if (s.id !== S.sid && !s.end) {
            s.end = t;
            s.why = 'signout-all';
          }
        }
      });
    } catch {
      /* the list is rewritten with the new key on the next heartbeat */
    }
    return { key, keyMeta };
  }
  throw codeError('GH_CONFLICT', 'GitHub was busy updating the same file. Wait a minute and try again.');
}

// ---- internals --------------------------------------------------------------

function fail(err) {
  if (S.stopped) return;
  S.status = 'error';
  S.error = (err && err.message) || 'Could not load the session list.';
  emit();
}

function stop() {
  S.stopped = true;
  clearInterval(S.timer);
}

function blankDoc() {
  return { v: 1, sessions: [] };
}

/** Read the session list. Returns null when this tab's key can no longer decrypt it. */
async function read(force) {
  const { gh, token, getKey } = S.ctx;
  const file = await ghReadFile(gh, token, FILE, SESSIONS_BRANCH, { etag: force ? '' : S.etag });
  if (file.status === 'unchanged') return { doc: S.doc, sha: null, unchanged: true };
  if (file.status === 'missing') return { doc: blankDoc(), sha: '', missing: true };
  try {
    const doc = await decryptWithKey(JSON.parse(file.text), getKey());
    if (!doc || !Array.isArray(doc.sessions)) return { doc: blankDoc(), sha: file.sha, etag: file.etag };
    return { doc, sha: file.sha, etag: file.etag };
  } catch (e) {
    if (e.code !== 'BAD_LOGIN') throw e;
    // encrypted with another key: either someone used "Sign out all other devices" (→ sign out),
    // or this tab did that itself and the old list is still there (→ replace it)
    return S.rotated ? { doc: blankDoc(), sha: file.sha, etag: file.etag } : { doc: null, keyChanged: true };
  }
}

function prune(doc, t) {
  doc.sessions = doc.sessions
    .filter((s) => (s.end ? t - s.end < KEEP_ENDED_MS : t - s.seen < KEEP_STALE_MS || s.id === S.sid))
    .sort((a, b) => b.seen - a.seen)
    .slice(0, MAX_ENTRIES);
}

function setSkew(saved) {
  const server = Date.parse(saved && saved.commit && saved.commit.committer && saved.commit.committer.date);
  if (!Number.isNaN(server)) {
    const diff = server - Date.now();
    S.skew = Math.abs(diff) > 30_000 ? diff : 0;
  }
}

/** Read → change → write, retrying when another tab wrote at the same moment. */
async function update(change) {
  const { gh, token, getKey, getKeyMeta } = S.ctx;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const cur = await read(true);
    if (cur.keyChanged) throw codeError('KEY_CHANGED', 'The key was changed on another device.');
    if (cur.missing) await ghEnsureBranch(gh, token, SESSIONS_BRANCH, branchOf());
    const doc = cur.doc;
    const t = now();
    if (change(doc, t) === false) {
      S.doc = doc;
      return doc;
    }
    prune(doc, t);
    const envelope = await encryptWithKey(doc, getKey(), getKeyMeta());
    const saved = await ghWriteFile(gh, token, FILE, {
      text: JSON.stringify(envelope) + '\n',
      sha: cur.sha,
      branch: SESSIONS_BRANCH,
      message: 'Update', // the repo is public: keep commit messages neutral
    });
    if (saved) {
      setSkew(saved);
      S.doc = doc;
      S.etag = '';
      S.rotated = false;
      S.status = 'ok';
      S.error = '';
      emit();
      return doc;
    }
    await sleep(250 * attempt + Math.random() * 400);
  }
  throw codeError('GH_CONFLICT', 'GitHub was busy — the session list will update in a minute.');
}

async function register() {
  const add = (doc, t) => {
    doc.sessions = doc.sessions.filter((s) => s.id !== S.sid);
    doc.sessions.push({ id: S.sid, dev: deviceName(), start: t, seen: t });
  };
  const before = S.skew;
  await update(add);
  S.lastBeat = Date.now();
  // this PC's clock was wrong: store the corrected times
  if (Math.abs(S.skew - before) > 60_000) {
    await update((doc, t) => {
      const me = doc.sessions.find((s) => s.id === S.sid);
      if (!me) return false;
      me.start = t;
      me.seen = t;
    });
  }
}

async function poll(force = false) {
  if (S.stopped || S.polling || !S.ctx || S.status === 'off') return;
  S.polling = true;
  try {
    const cur = await read(force);
    if (S.stopped) return;
    if (cur.keyChanged) {
      stop();
      S.ctx.onForcedLogout('You were signed out because the login was changed on another device. Sign in again.');
      return;
    }
    if (!cur.unchanged) {
      S.doc = cur.doc;
      S.etag = cur.etag || '';
    }
    const me = S.doc && S.doc.sessions.find((s) => s.id === S.sid);
    if (me && me.end) {
      stop();
      S.ctx.onForcedLogout(
        me.why === 'revoked'
          ? 'This session was revoked from another device.'
          : me.why === 'signout-all'
            ? 'You were signed out from another device. Sign in again.'
            : 'This session has ended. Sign in again.',
      );
      return;
    }
    S.status = 'ok';
    S.error = '';
    emit();

    if (!me) {
      await register(); // first visit after the list was reset (or the first save failed)
    } else if (Date.now() - S.lastBeat > HEARTBEAT_MS && S.lastActivity > S.lastBeat) {
      S.lastBeat = Date.now();
      await update((doc, t) => {
        const m = doc.sessions.find((s) => s.id === S.sid);
        if (!m || m.end) return false;
        m.seen = t;
      });
    }
  } finally {
    S.polling = false;
  }
}
