// Small GitHub REST helper shared by the "＋ Add" button and the session list.
// Only the "Contents: Read and write" permission of a fine-grained token is needed.

export const GITHUB_API = 'https://api.github.com';

const codeError = (code, message) => Object.assign(new Error(message), { code });
const dec = new TextDecoder();

export const ghHeaders = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});

export function repoUrl(gh, rest = '') {
  const api = String(gh.api || GITHUB_API).replace(/\/+$/, '');
  return `${api}/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}${rest}`;
}

export const contentsUrl = (gh, path) => repoUrl(gh, `/contents/${path}`);

export async function ghFetch(url, options, allow = []) {
  let res;
  try {
    res = await fetch(url, { ...options, cache: 'no-store' });
  } catch {
    throw codeError('GH_NETWORK', 'Could not reach GitHub (api.github.com). This network may block it — try again on another network or your phone.');
  }
  if (res.ok || allow.includes(res.status)) return res;
  if (res.status === 401) {
    throw codeError('GH_AUTH', 'GitHub rejected the token (expired or deleted). On your PC run "npm run setup-editing" with a new token, then "npm run deploy".');
  }
  if (res.status === 403) {
    if (res.headers.get('x-ratelimit-remaining') === '0') throw codeError('GH_LIMIT', 'GitHub rate limit reached — try again in a few minutes.');
    throw codeError('GH_FORBIDDEN', 'The token is not allowed to change this repository. It needs "Contents: Read and write" for this repo.');
  }
  if (res.status === 404) {
    throw codeError('GH_NOT_FOUND', 'Repository or file not found on GitHub. Check the repo in "npm run setup-editing" and that the site has been deployed.');
  }
  throw codeError('GH_HTTP', `GitHub answered HTTP ${res.status}. Try again in a minute.`);
}

function base64ToText(b64) {
  const bin = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return dec.decode(bytes);
}

/**
 * Read a text file through the contents API.
 * Returns { status: 'ok', text, sha, etag } · { status: 'missing' } · { status: 'unchanged' } (when `etag` still matches).
 */
export async function ghReadFile(gh, token, path, ref, { etag = '' } = {}) {
  const url = `${contentsUrl(gh, path)}?ref=${encodeURIComponent(ref)}`;
  const headers = ghHeaders(token);
  const res = await ghFetch(url, { headers: etag ? { ...headers, 'If-None-Match': etag } : headers }, [304, 404]);
  if (res.status === 304) return { status: 'unchanged' };
  if (res.status === 404) return { status: 'missing' };
  const meta = await res.json();
  let text = meta.encoding === 'base64' && meta.content ? base64ToText(meta.content) : '';
  if (!text) {
    // files over 1 MB come without inline content
    const raw = await ghFetch(url, { headers: { ...headers, Accept: 'application/vnd.github.raw+json' } });
    text = await raw.text();
  }
  return { status: 'ok', text, sha: meta.sha, etag: res.headers.get('etag') || '' };
}

/**
 * Create or update a file. Returns the GitHub response, or null when someone else changed the
 * file in between (409 / 422) — read it again and retry.
 */
export async function ghWriteFile(gh, token, path, { text, sha, branch, message }) {
  const res = await ghFetch(
    contentsUrl(gh, path),
    {
      method: 'PUT',
      headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, content: btoa(text), branch, ...(sha ? { sha } : {}) }),
    },
    [409, 422],
  );
  return res.ok ? res.json() : null;
}

/** Make sure `branch` exists; it is created from `fromBranch` the first time. */
export async function ghEnsureBranch(gh, token, branch, fromBranch) {
  const headers = ghHeaders(token);
  const have = await ghFetch(repoUrl(gh, `/git/ref/heads/${encodeURIComponent(branch)}`), { headers }, [404]);
  if (have.ok) return;
  const base = await (await ghFetch(repoUrl(gh, `/git/ref/heads/${encodeURIComponent(fromBranch)}`), { headers })).json();
  await ghFetch(
    repoUrl(gh, '/git/refs'),
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: base.object.sha }),
    },
    [422], // 422 = it was created a moment ago by another tab
  );
}
