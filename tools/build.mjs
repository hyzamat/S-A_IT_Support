#!/usr/bin/env node
// Encrypts content/*.md into docs/data.enc.json (the only content file that gets published).
//
//   npm run deploy          build + commit + push to GitHub   ← the one you normally use
//   npm run build           build only (test with "npm start")
//   npm run build:new       choose a NEW username / password
//   npm run setup-editing   turn on the website's "➕ Add" button (GitHub token)
//   npm run check           only check the Markdown for mistakes, nothing is written
//   npm run restore         decrypt the published data back into Markdown files
//
// Items added on the website are saved as content/online/*.md. Every build first downloads the
// latest published data from GitHub and copies new website items into content/online/, so a
// build from this PC never drops them.
//
// Automation / tests: ITS_USERNAME + ITS_PASSWORD (current login), ITS_NEW_USERNAME +
// ITS_NEW_PASSWORD (build:new), ITS_YES=1 (answer yes), ITS_GITHUB_REPO / ITS_GITHUB_BRANCH /
// ITS_GITHUB_TOKEN / ITS_GITHUB_STORE_TOKEN=no / ITS_GITHUB_API (setup-editing).

import { readdir, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseContent } from '../docs/assets/parser.js';
import { encryptPayload, unlock } from '../docs/assets/crypto.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT_DIR = path.join(ROOT, 'content');
const RESTORE_DIR = path.join(ROOT, 'content-restored');
const DATA_PATH = 'docs/data.enc.json';
const OUT_FILE = path.join(ROOT, DATA_PATH);
const ONLINE_DIR = 'online'; // content/online/ = items added on the website
const IMPORTED_FILE = path.join(CONTENT_DIR, '.online-imported.json');
const MIN_PASSWORD = 12;
const GITHUB_API = 'https://api.github.com';

const args = new Set(process.argv.slice(2));
const MODE = args.has('--restore') ? 'restore' : args.has('--check') ? 'check' : 'build';
const NEW_CREDENTIALS = args.has('--new');
const SETUP_EDITING = args.has('--setup-editing');
const DEPLOY = args.has('--deploy');
const FORCE = args.has('--force'); // build:new when the old login is forgotten
const OFFLINE = args.has('--offline'); // don't contact GitHub

const c = {
  ok: (s) => `\x1b[32m${s}\x1b[0m`,
  warn: (s) => `\x1b[33m${s}\x1b[0m`,
  err: (s) => `\x1b[31m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

main().catch((e) => {
  console.error('\n' + c.err('✖ ' + (e && e.message ? e.message : e)));
  process.exit(1);
});

async function main() {
  if (MODE === 'restore') return restore();
  if (MODE === 'check') {
    const files = await readContent();
    report(files, parseContent(files));
    return;
  }

  await assertContentIgnored();
  await requireContentDir();

  // 1. latest published data (from GitHub when possible) + the current login
  const latest = fetchLatestPublished();
  let current = null;
  if (latest.envelope && !(NEW_CREDENTIALS && FORCE)) current = await unlockCurrent(latest.envelope);
  if (NEW_CREDENTIALS && FORCE && latest.envelope) {
    console.log(c.warn('\n⚠ --force: items added on the website since your last deploy, and the website-editing settings, are not kept.'));
  }

  // 2. bring in items that were added on the website
  if (current) await importOnlineAdditions(current.data);

  // 3. read + check the Markdown
  const files = await readContent();
  report(files, parseContent(files));
  if (current) await confirmRemovals(current.data, files);

  // 4. settings for the website's "Add" button
  let github = (current && current.data && current.data.github) || null;
  if (SETUP_EDITING) github = await askGithubSettings(github);

  // 5. credentials: same login keeps the same key (salt) so open sessions + website edits keep working
  let creds;
  let keep = {};
  if (NEW_CREDENTIALS || !current) {
    creds = await askNewCredentials(Boolean(latest.envelope));
  } else {
    creds = current;
    keep = { salt: latest.envelope.salt, iterations: latest.envelope.iterations };
  }

  // 6. encrypt + verify
  const payload = { v: 1, built: new Date().toISOString(), files, ...(github ? { github } : {}) };
  const envelope = await encryptPayload(payload, creds.username, creds.password, keep);
  await writeFile(OUT_FILE, JSON.stringify(envelope) + '\n', 'utf8');
  const { data } = await unlock(envelope, creds.username, creds.password);
  if (!data || data.files.length !== files.length) throw new Error('Verification failed — the output did not decrypt correctly.');

  const kb = (Buffer.byteLength(JSON.stringify(envelope)) / 1024).toFixed(0);
  console.log(c.ok(`\n✔ Encrypted ${files.length} files → ${DATA_PATH} (${kb} KB)`));
  console.log(
    c.dim(
      github
        ? `  Website "Add" button: ON → ${github.owner}/${github.repo} (${github.branch})${github.token ? '' : ' — token asked on each save'}`
        : '  Website "Add" button: off (turn it on with: npm run setup-editing)',
    ),
  );

  if (DEPLOY) deploy(latest.upstreamSha);
  else console.log(c.dim('  Next: "npm start" to test locally, or "npm run deploy" to publish.'));
}

// ---- content ----------------------------------------------------------------
async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function requireContentDir() {
  const entries = (await exists(CONTENT_DIR)) ? await readdir(CONTENT_DIR) : [];
  if (!entries.some((n) => n.toLowerCase().endsWith('.md') && !n.startsWith('_'))) {
    throw new Error(
      'The content/ folder is missing or empty.\n' +
        '  • New PC? Run "npm run restore" to get your Markdown back from the published data.\n' +
        '  • Or create content/ and add .md files (see README.md).',
    );
  }
}

async function readContent() {
  await requireContentDir();
  const entries = await readdir(CONTENT_DIR, { recursive: true, withFileTypes: true });
  const files = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.md') || e.name.startsWith('_')) continue;
    const full = path.join(e.parentPath ?? e.path, e.name);
    const name = path.relative(CONTENT_DIR, full).split(path.sep).join('/');
    if (name.split('/').some((part) => part.startsWith('_') || part.startsWith('.'))) continue;
    files.push({ name, text: await readFile(full, 'utf8') });
  }
  files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  return files;
}

function report(files, { categories, items, warnings }) {
  console.log(c.bold(`\nContent: ${files.length} files, ${categories.length} categories, ${items.length} items`));
  const byType = items.reduce((acc, it) => ((acc[it.type] = (acc[it.type] || 0) + 1), acc), {});
  console.log(c.dim('  ' + Object.entries(byType).map(([t, n]) => `${t}: ${n}`).join(' · ')));
  for (const cat of categories) console.log(c.dim(`  ${cat.icon} ${cat.name.padEnd(34)} ${String(cat.count).padStart(3)}`));
  if (warnings.length) {
    console.log(c.warn(`\n⚠ ${warnings.length} warning(s):`));
    for (const w of warnings) console.log(c.warn(`  content/${w.file}:${w.line}  ${w.message}`));
  }
}

async function assertContentIgnored() {
  let gitignore = '';
  try {
    gitignore = await readFile(path.join(ROOT, '.gitignore'), 'utf8');
  } catch {
    /* missing */
  }
  if (!/^\s*\/?content\/?\s*$/m.test(gitignore)) {
    throw new Error('Safety stop: .gitignore must contain the line "/content/" so plain-text content is never pushed.');
  }
}

const titleOf = (text) => (/^##\s+(.+)$/m.exec(text) || [])[1] || '';

/** Copy items saved on the website (files under online/) into content/online/ — once each. */
async function importOnlineAdditions(data) {
  const online = (data.files || []).filter((f) => f.name.startsWith(`${ONLINE_DIR}/`));
  if (!online.length) return;
  let imported = [];
  try {
    imported = JSON.parse(await readFile(IMPORTED_FILE, 'utf8'));
  } catch {
    /* first time */
  }
  const done = new Set(imported);
  const added = [];
  for (const f of online) {
    if (done.has(f.name)) continue; // already imported earlier (maybe moved / deleted on purpose since)
    done.add(f.name);
    const dest = path.resolve(CONTENT_DIR, f.name);
    if (!dest.startsWith(CONTENT_DIR + path.sep) || (await exists(dest))) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.text, 'utf8');
    added.push(f);
  }
  await writeFile(IMPORTED_FILE, JSON.stringify([...done].sort(), null, 2) + '\n', 'utf8');
  if (added.length) {
    console.log(c.ok(`\n⬇ ${added.length} item(s) added on the website → content/${ONLINE_DIR}/`));
    for (const f of added) console.log(c.dim(`  ${f.name}   "${titleOf(f.text)}"`));
    console.log(c.dim('  Keep them there or move them into another file — they will not be imported again.'));
  }
}

/** Warn before a build removes files that are currently on the website. */
async function confirmRemovals(published, files) {
  const local = new Set(files.map((f) => f.name));
  const removed = (published.files || []).map((f) => f.name).filter((n) => !local.has(n));
  if (!removed.length) return;
  console.log(c.warn(`\n⚠ These files are on the website but not in content/ — they will be REMOVED from the website:`));
  for (const n of removed) console.log(c.warn(`  ${n}`));
  if (!(await confirm('Continue? [y/N] '))) throw new Error('Stopped — nothing was changed. (Run "npm run restore" to get missing files back.)');
}

// ---- git / GitHub -----------------------------------------------------------
function git(gitArgs, { inherit = false } = {}) {
  const r = spawnSync('git', gitArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: inherit ? ['inherit', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
  });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || (r.error ? r.error.message : '') };
}

function runGit(gitArgs, opts) {
  const r = git(gitArgs, opts);
  if (r.status !== 0) throw new Error(`git ${gitArgs.join(' ')} failed.\n${r.stderr.trim()}`);
  return r;
}

const isGitRepo = () => git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
const upstreamName = () => {
  const r = git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  return r.status === 0 ? r.stdout.trim() : '';
};

function readLocalEnvelope() {
  try {
    return JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/** The data file as it is on GitHub right now (falls back to the local copy). */
function fetchLatestPublished() {
  const local = { envelope: readLocalEnvelope(), upstreamSha: '' };
  if (OFFLINE || !isGitRepo()) return local;
  const upstream = upstreamName();
  if (!upstream) return local; // not pushed to GitHub yet
  console.log(c.dim(`Getting the latest published data from GitHub (${upstream})…`));
  if (git(['fetch', '--quiet'], { inherit: true }).status !== 0) {
    console.log(c.warn('⚠ Could not reach GitHub — using the local copy. Items added on the website will be picked up next time.'));
    return local;
  }
  const upstreamSha = git(['rev-parse', upstream]).stdout.trim();
  const show = git(['show', `${upstream}:${DATA_PATH}`]);
  if (show.status !== 0) return { ...local, upstreamSha };
  try {
    return { envelope: JSON.parse(show.stdout), upstreamSha };
  } catch {
    return { ...local, upstreamSha };
  }
}

function deploy(startSha) {
  console.log(c.bold('\nPublishing to GitHub…'));
  if (!isGitRepo()) throw new Error('This folder is not a git repository yet — see README step 2.');
  if (!git(['remote']).stdout.trim()) throw new Error('No GitHub remote yet — see README step 2 ("git remote add origin …").');
  const upstream = upstreamName();

  if (upstream && startSha) {
    git(['fetch', '--quiet'], { inherit: true });
    const now = git(['rev-parse', upstream]).stdout.trim();
    if (now && now !== startSha) {
      throw new Error('Something was saved on the website while you were building.\n  Run "npm run deploy" again — it will include it. (Nothing was published.)');
    }
  }

  runGit(['add', '-A']);
  if (git(['diff', '--cached', '--quiet']).status === 0) console.log(c.dim('  No changes to commit.'));
  else runGit(['commit', '--quiet', '-m', 'Update content']);

  if (upstream) {
    const behind = Number(git(['rev-list', '--count', `HEAD..${upstream}`]).stdout.trim() || 0);
    // Website saves are already inside the data file we just built, so on a conflict ours wins.
    if (behind > 0) runGit(['merge', '--quiet', '--no-edit', '-X', 'ours', upstream]);
    runGit(['push', '--quiet'], { inherit: true });
  } else {
    runGit(['push', '--quiet', '-u', 'origin', 'HEAD'], { inherit: true });
  }
  console.log(c.ok('✔ Published. The website updates in about a minute.'));
}

function detectGithubRepo() {
  const url = git(['remote', 'get-url', 'origin']).stdout.trim();
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(url);
  return m ? `${m[1]}/${m[2]}` : '';
}

function parseRepo(input) {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i.exec(input.trim());
  if (!m) throw new Error(`"${input}" is not a GitHub repository. Use the form owner/name, e.g. shainal/itsupport`);
  return { owner: m[1], repo: m[2] };
}

async function askGithubSettings(current) {
  const env = process.env;
  const api = (env.ITS_GITHUB_API || (current && current.api) || GITHUB_API).replace(/\/+$/, '');
  const fromEnv = Boolean(env.ITS_GITHUB_TOKEN);
  if (!fromEnv) requireTTY();

  console.log(c.bold('\nWebsite editing — lets you add commands from the website (any PC or phone).'));
  console.log(c.dim('  Create a token that can ONLY change this one repository:'));
  console.log(c.dim('   1. Open https://github.com/settings/personal-access-tokens/new'));
  console.log(c.dim('   2. Expiration: e.g. 1 year'));
  console.log(c.dim('   3. Repository access → Only select repositories → choose your site repo'));
  console.log(c.dim('   4. Permissions → Repository permissions → Contents → Read and write'));
  console.log(c.dim('   5. Generate token → copy it'));

  const suggested = (current && `${current.owner}/${current.repo}`) || detectGithubRepo();
  const repoAnswer = fromEnv ? env.ITS_GITHUB_REPO || suggested : (await ask(`GitHub repository (owner/name)${suggested ? ` [${suggested}]` : ''}: `)).trim() || suggested;
  if (!repoAnswer) throw new Error('A repository is needed, e.g. shainal/itsupport');
  const { owner, repo } = parseRepo(repoAnswer);
  const defBranch = (current && current.branch) || 'main';
  const branch = (fromEnv ? env.ITS_GITHUB_BRANCH || '' : (await ask(`Branch [${defBranch}]: `)).trim()) || defBranch;
  const token = (fromEnv ? env.ITS_GITHUB_TOKEN : await askHidden('Paste the token (leave empty to turn website editing OFF): ')).trim();
  if (!token) {
    console.log(c.warn('Website editing turned OFF.'));
    return null;
  }
  if (/^ghp_/.test(token)) {
    console.log(c.warn('⚠ This is a "classic" token — it can change ALL your repositories. A fine-grained token (github_pat_…) limited to this repo is much safer.'));
  }

  process.stdout.write(c.dim('Checking the token with GitHub…'));
  let res;
  try {
    res = await fetch(`${api}/repos/${owner}/${repo}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'itsupport-toolkit' },
    });
  } catch {
    process.stdout.write('\n');
    throw new Error('Could not reach GitHub to check the token. Check the internet connection and try again.');
  }
  process.stdout.write('\n');
  if (res.status === 401) throw new Error('GitHub says this token is invalid or expired.');
  if (res.status === 404) throw new Error(`Repository ${owner}/${repo} not found — or the token was not given access to it.`);
  if (!res.ok) throw new Error(`GitHub answered HTTP ${res.status} while checking the token.`);
  const info = await res.json().catch(() => ({}));
  if (info.permissions && info.permissions.push === false) {
    console.log(c.warn('⚠ Your account cannot push to this repository — saving from the website will fail.'));
  }
  console.log(c.ok(`✔ Token works for ${owner}/${repo}.`) + c.dim(' (Write access is checked on the first save from the website.)'));

  const store = fromEnv
    ? !/^(n|no|0|false)$/i.test(env.ITS_GITHUB_STORE_TOKEN || 'yes')
    : !/^n/i.test((await ask('Keep the token inside the encrypted data, so a client PC only needs the site login? [Y/n] ')).trim());
  if (!store) console.log(c.dim('  OK — the website will ask for the token each time you save (it is never stored).'));
  return { owner, repo, branch, ...(api !== GITHUB_API ? { api } : {}), ...(store ? { token } : {}) };
}

// ---- credentials ------------------------------------------------------------
function requireTTY() {
  if (!process.stdin.isTTY) {
    throw new Error('No interactive terminal. Run this in PowerShell / Terminal, or use the ITS_* environment variables.');
  }
}

async function unlockCurrent(envelope) {
  let username = process.env.ITS_USERNAME;
  let password = process.env.ITS_PASSWORD;
  if (!(username && password)) {
    requireTTY();
    if (NEW_CREDENTIALS) {
      console.log(c.bold('\nFirst enter the CURRENT login (so website additions and settings are kept).'));
      console.log(c.dim('  Forgot it? Run: npm run build:new -- --force'));
    } else {
      console.log(c.bold('\nEnter the website login (same one you use on the site).'));
      console.log(c.dim('  Want a new username/password instead? Press Ctrl+C and run: npm run build:new'));
    }
    username = (await ask('Username: ')).trim();
    password = await askHidden('Password: ');
  }
  process.stdout.write(c.dim('Checking…'));
  try {
    const { data } = await unlock(envelope, username, password);
    process.stdout.write(' ' + c.ok('ok') + '\n');
    return { username: username.trim(), password, data };
  } catch (e) {
    process.stdout.write('\n');
    if (e.code === 'BAD_LOGIN') {
      throw new Error(
        'That username/password does not match the published data.\n' +
          '  • Changed the password but not deployed yet? Enter the previous one.\n' +
          '  • To set a NEW login: npm run build:new',
      );
    }
    throw e;
  }
}

async function askNewCredentials(hadExisting) {
  const envUser = NEW_CREDENTIALS ? process.env.ITS_NEW_USERNAME : process.env.ITS_USERNAME;
  const envPass = NEW_CREDENTIALS ? process.env.ITS_NEW_PASSWORD : process.env.ITS_PASSWORD;
  if (envUser && envPass) {
    checkNewCredentials(envUser, envPass);
    return { username: envUser.trim(), password: envPass };
  }
  requireTTY();
  console.log(c.bold(hadExisting ? '\nChoose the NEW login for the website.' : '\nFirst build — choose the login for your website.'));
  console.log(c.dim(`  Password: at least ${MIN_PASSWORD} characters. A short sentence is easy to type and hard to guess.`));
  const username = (await ask('New username: ')).trim();
  const password = await askHidden('New password: ');
  checkNewCredentials(username, password);
  const again = await askHidden('Repeat password: ');
  if (again !== password) throw new Error('Passwords did not match. Nothing was changed.');
  return { username, password };
}

function checkNewCredentials(username, password) {
  if (!username.trim()) throw new Error('Username cannot be empty.');
  if (password.length < MIN_PASSWORD) {
    throw new Error(`Password is too short (${password.length}). Use at least ${MIN_PASSWORD} characters — the encrypted file is public, so a strong password is what protects it.`);
  }
}

async function confirm(question) {
  if (/^(1|y|yes|true)$/i.test(process.env.ITS_YES || '')) return true;
  if (!process.stdin.isTTY) return false;
  return /^y/i.test((await ask(question)).trim());
}

function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function askHidden(question) {
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    stdout.write(question);
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk) => {
      if (chunk.startsWith('\u001b')) return; // arrow keys etc.
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') {
          cleanup();
          stdout.write('\n');
          resolve(value);
          return;
        }
        if (ch === '\u0003') {
          cleanup();
          stdout.write('\n');
          process.exit(130);
        }
        if (ch === '\u007f' || ch === '\b') {
          if (value) {
            value = Array.from(value).slice(0, -1).join('');
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        value += ch;
        stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

// ---- restore ----------------------------------------------------------------
async function restore() {
  const { envelope } = fetchLatestPublished();
  if (!envelope) throw new Error(`${DATA_PATH} not found — nothing to restore.`);

  let username = process.env.ITS_USERNAME;
  let password = process.env.ITS_PASSWORD;
  if (!username || !password) {
    requireTTY();
    console.log(c.bold('\nEnter the website login to decrypt the published data'));
    username = (await ask('Username: ')).trim();
    password = await askHidden('Password: ');
  }
  const { data } = await unlock(envelope, username, password);

  const target = (await exists(CONTENT_DIR)) && (await readdir(CONTENT_DIR)).length ? RESTORE_DIR : CONTENT_DIR;
  const online = [];
  for (const file of data.files || []) {
    const dest = path.resolve(target, file.name);
    if (!dest.startsWith(target + path.sep)) continue; // refuse paths outside the target folder
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, file.text, 'utf8');
    if (file.name.startsWith(`${ONLINE_DIR}/`)) online.push(file.name);
  }
  if (target === CONTENT_DIR && online.length) {
    await writeFile(IMPORTED_FILE, JSON.stringify(online.sort(), null, 2) + '\n', 'utf8');
  }
  const rel = path.relative(ROOT, target);
  console.log(c.ok(`\n✔ Restored ${(data.files || []).length} files into ${rel}/`));
  if (target === RESTORE_DIR) console.log(c.dim('  content/ already existed, so nothing was overwritten. Compare and copy what you need.'));
}
