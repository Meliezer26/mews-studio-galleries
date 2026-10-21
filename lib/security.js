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
/**
 * Limiteur de tentatives par clé (adresse IP).
 *
 * Usage normal : `limiter(ip)` répond true/false et s'emploie tel quel.
 *
 * Deux compléments, ajoutés après le blocage du 21/10/2026 :
 *  - `limiter.reset(ip)` : une tentative RÉUSSIE remet le compteur à zéro.
 *    Sans cela, se connecter normalement dix fois dans l'heure finissait par
 *    bloquer le photographe lui-même, sans aucune attaque.
 *  - `limiter.retryAfter(ip)` : secondes restantes avant déblocage, pour dire
 *    au visiteur combien de temps attendre au lieu d'un « réessayez plus tard ».
 */
function rateLimiter({ windowMs = 5 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();
  function allow(key) {
    const now = Date.now();
    const rec = hits.get(key);
    if (!rec || now - rec.start > windowMs) {
      hits.set(key, { start: now, n: 1 });
      return true;
    }
    rec.n += 1;
    return rec.n <= max;
  }
  allow.reset = (key) => { hits.delete(key); };
  allow.retryAfter = (key) => {
    const rec = hits.get(key);
    if (!rec) return 0;
    const left = windowMs - (Date.now() - rec.start);
    return left > 0 ? Math.ceil(left / 1000) : 0;
  };
  allow.windowMs = windowMs;
  allow.max = max;
  return allow;
}

/** Message de blocage, avec le temps d'attente réel. */
function tooManyMessage(seconds) {
  if (!seconds || seconds < 60) {
    const s = Math.max(1, Math.round(seconds || 1));
    return 'Trop de tentatives. Réessayez dans ' + s + ' seconde' + (s > 1 ? 's' : '') + '.';
  }
  const m = Math.ceil(seconds / 60);
  return 'Trop de tentatives. Réessayez dans ' + m + ' minute' + (m > 1 ? 's' : '') + '.';
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

module.exports = {
  tooManyMessage, hashPassword, verifyPassword, sign, unsign, randomToken, rateLimiter, parseCookies };
