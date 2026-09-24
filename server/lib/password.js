// Password hashing helpers built on Node's built-in crypto.scrypt, so no
// extra dependency (and no native build step) is required.
//
// Stored format: "scrypt:<N>:<saltHex>:<hashHex>"
// N is the scrypt CPU/memory cost parameter, stored alongside the hash so
// it can be tuned later without breaking verification of older hashes.
const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const SCRYPT_N = 16384; // 2^14 — a reasonably slow default cost for scrypt
const SALT_BYTES = 16;
const KEY_LENGTH = 64;

async function hashPassword(plainPassword) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const derivedKey = await scrypt(plainPassword, salt, KEY_LENGTH, { N: SCRYPT_N });
  return `scrypt:${SCRYPT_N}:${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

// Stays synchronous (scryptSync): callers — including
// test/auth-register.test.js, which is out of scope for this change —
// use it as a plain boolean-returning function, not a Promise.
function verifyPassword(plainPassword, storedHash) {
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const [, nStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  const actual = crypto.scryptSync(plainPassword, salt, expected.length, { N });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Async counterpart of verifyPassword, using the promisified (non-blocking)
// crypto.scrypt. Same parsing/validation and timingSafeEqual comparison;
// resolves false (never rejects) for a malformed/unrecognised stored hash.
async function verifyPasswordAsync(plainPassword, storedHash) {
  if (typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const [, nStr, saltHex, hashHex] = parts;
  const N = Number(nStr);
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');

  const actual = await scrypt(plainPassword, salt, expected.length, { N });
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword, verifyPasswordAsync };
