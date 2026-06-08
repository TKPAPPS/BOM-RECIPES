/**
 * password.js — local password hashing using Node's built-in scrypt.
 *
 * No external dependency (avoids native bcrypt build issues on Windows).
 * Stored format:  scrypt$N$<saltHex>$<hashHex>
 * Verification is constant-time via crypto.timingSafeEqual.
 */

const crypto = require('crypto');

const KEYLEN = 64;
const SCRYPT_N = 16384; // CPU/memory cost (2^14)

/** Hash a plaintext password → storable string. */
function hashPassword(plain) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(plain), salt, KEYLEN, { N: SCRYPT_N });
  return `scrypt$${SCRYPT_N}$${salt.toString('hex')}$${derived.toString('hex')}`;
}

/** Verify a plaintext password against a stored hash.  Safe on bad input. */
function verifyPassword(plain, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const N = parseInt(parts[1], 10) || SCRYPT_N;
  const salt = Buffer.from(parts[2], 'hex');
  const expected = Buffer.from(parts[3], 'hex');
  let derived;
  try {
    derived = crypto.scryptSync(String(plain), salt, expected.length, { N });
  } catch {
    return false;
  }
  return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
}

module.exports = { hashPassword, verifyPassword };
