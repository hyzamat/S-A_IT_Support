// Encryption helpers shared by the browser app and the Node build script.
//
// There is no server, so "login" works like this: the username + password are turned into
// an AES-256 key with PBKDF2-SHA256 (600k iterations). That key decrypts data.enc.json.
// Wrong credentials = the decryption fails. The password itself is never stored anywhere.

const enc = new TextEncoder();
const dec = new TextDecoder();
const AAD = enc.encode('itsupport-toolkit:v1');

export const FORMAT = 'itsupport-toolkit';
export const KDF_ITERATIONS = 600_000;

function codeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) throw codeError('NO_CRYPTO', 'Encryption is not available here — open the site over HTTPS.');
  return s;
}

export function toBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function fromBase64(str) {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function credentialBytes(username, password) {
  const user = String(username).normalize('NFC').trim().toLowerCase();
  return enc.encode(`${user}\n${String(password).normalize('NFC')}`);
}

export async function deriveKey(username, password, salt, iterations = KDF_ITERATIONS) {
  const base = await subtle().importKey('raw', credentialBytes(username, password), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    true,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt with an already-derived key. `salt` (base64) + `iterations` must be the ones the key came from. */
export async function encryptWithKey(payload, key, { salt, iterations }) {
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12)); // fresh IV every time
  const cipher = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: AAD },
    key,
    enc.encode(JSON.stringify(payload)),
  );
  return {
    format: FORMAT,
    version: 1,
    kdf: 'PBKDF2-SHA256',
    iterations,
    cipher: 'AES-256-GCM',
    salt,
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(cipher)),
  };
}

/**
 * Encrypt with username + password. Pass the previous `salt` / `iterations` to keep the same key
 * (open browser sessions and edits made on the website keep working); omit them for a brand-new key.
 */
export async function encryptPayload(payload, username, password, { salt, iterations } = {}) {
  const saltBytes = salt ? fromBase64(salt) : globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iters = iterations || KDF_ITERATIONS;
  const key = await deriveKey(username, password, saltBytes, iters);
  return encryptWithKey(payload, key, { salt: toBase64(saltBytes), iterations: iters });
}

function checkEnvelope(env) {
  const ok =
    env &&
    env.format === FORMAT &&
    env.version === 1 &&
    Number.isInteger(env.iterations) &&
    env.iterations >= 100_000 &&
    env.iterations <= 10_000_000 &&
    typeof env.salt === 'string' &&
    typeof env.iv === 'string' &&
    typeof env.data === 'string';
  if (!ok) throw codeError('BAD_DATA', 'The data file is not in the expected format. Rebuild it with "npm run build".');
}

export async function decryptWithKey(env, key) {
  checkEnvelope(env);
  let plain;
  try {
    plain = await subtle().decrypt(
      { name: 'AES-GCM', iv: fromBase64(env.iv), additionalData: AAD },
      key,
      fromBase64(env.data),
    );
  } catch {
    throw codeError('BAD_LOGIN', 'Incorrect username or password.');
  }
  return JSON.parse(dec.decode(plain));
}

/** Derive the key from the credentials and decrypt. Throws code BAD_LOGIN on wrong credentials. */
export async function unlock(env, username, password) {
  checkEnvelope(env);
  const key = await deriveKey(username, password, fromBase64(env.salt), env.iterations);
  return { key, data: await decryptWithKey(env, key) };
}

export async function exportKey(key) {
  return toBase64(new Uint8Array(await subtle().exportKey('raw', key)));
}

export async function importKey(b64) {
  return subtle().importKey('raw', fromBase64(b64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
