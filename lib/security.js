'use strict';
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1 };

/** Hache un mot de passe (scrypt + sel aléatoire). */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64, SCRYPT).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/** Vérifie un mot de passe contre un hash stocké. */
function verifyPassword(pw, stored) {
  try {
    const [scheme, salt, hash] = String(stored).split(':');
    if (scheme !== 'scrypt' || !salt || !hash) return false;
    const test = crypto.scryptSync(String(pw), salt, 64, SCRYPT).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(test, 'hex'));
  } catch {
    return false;
  }
}

function hmac(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('base64url');
}

/** Signe un payload JSON (jeton HMAC). */
function sign(payload, secret) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(body, secret)}`;
}

/** Vérifie un jeton HMAC ; renvoie le payload ou null. */
function unsign(token, secret, maxAgeMs) {
  try {
    const [body, sig] = String(token).split('.');
    if (!body || !sig) return null;
    const expected = Buffer.from(sig);
    const actual = Buffer.from(hmac(body, secret));
    if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (maxAgeMs && payload.iat && Date.now() - payload.iat > maxAgeMs) return null;
    return payload;
  } catch {
    return null;
  }
}

function randomToken(bytes = 24) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Petit limiteur de débit en mémoire (par clé, ex. IP). */
function rateLimiter({ windowMs = 5 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();
  return (key) => {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    rec.n += 1;
    return rec.n <= max;
  };
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

module.exports = { hashPassword, verifyPassword, sign, unsign, randomToken, rateLimiter, parseCookies };
