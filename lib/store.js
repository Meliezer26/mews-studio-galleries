'use strict';
const fs = require('fs');
const path = require('path');
const events = require('events');

const DATA_DIR = path.join(__dirname, '..', 'data');
/** Émet « data-changed » après chaque écriture (utilisé par lib/backup.js). */
const dataEvents = new events.EventEmitter();

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
}

function readJson(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(name, obj) {
  const finalPath = path.join(DATA_DIR, name);
  const tmp = finalPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, finalPath);
  dataEvents.emit('data-changed', name);
}

/* --- Configuration de l'application ------------------------ */
function config() { return readJson('config.json', {}); }
function saveConfig(c) { writeJson('config.json', c); }

/* --- Galeries ---------------------------------------------- */
/** Tri « naturel » des photos : photo2.jpg avant photo10.jpg (les chiffres
 *  sont comparés comme nombres, pas caractère par caractère). */
function naturalCompareFiles(a, b) {
  return String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function galleries() {
  const all = readJson('galleries.json', []);
  // Ordre d'affichage garanti pour TOUTES les galeries (Drive et uploads),
  // même celles créées avant l'ajout du tri : les sélections client
  // référencent les photos par id, l'ordre est donc sans effet sur elles.
  for (const g of all) {
    if (Array.isArray(g.files) && g.files.length > 1) g.files.sort(naturalCompareFiles);
  }
  return all;
}
function saveGalleries(g) { writeJson('galleries.json', g); }

/** Écriture atomique « lire l'état FRAIS → muter → écrire ».
 *    Le mutateur est SYNCHRONE (pas d'await) : aucune autre écriture ne
 *    peut s'intercaler entre la lecture et l'écriture.
 *    À utiliser après un long await (API Drive, e-mails…) : réappliquer la
 *    modification sur l'état courant évite d'écraser les saves faits
 *    entre-temps (ex : un envoi client pendant le tri Drive).
 *    Renvoyer false annule l'écriture (objet introuvable, etc.). */
function updateGalleries(mutator) {
  const all = readJson('galleries.json', []);
  if (mutator(all) !== false) writeJson('galleries.json', all);
  return all;
}

/* --- Jetons Google OAuth ----------------------------------- */
function tokens() { return readJson('tokens.json', null); }
function saveTokens(t) { writeJson('tokens.json', t); }

/* --- Jeton Google OAuth du compte d'envoi d'e-mails (Gmail API) —
   indépendant du compte Drive (tri des albums). -------------- */
function tokensMail() { return readJson('tokens-mail.json', null); }
function saveTokensMail(t) { writeJson('tokens-mail.json', t); }

/* --- Liens de téléchargement temporaires (Drive) ------------ */
/* { [fileId]: { permissionId, url, until, grantedAt, name } } */
function grants() { return readJson('grants.json', {}); }
function saveGrants(g) { writeJson('grants.json', g); }

module.exports = {
  DATA_DIR,
  UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
  ensureDirs,
  config, saveConfig,
  galleries, saveGalleries, updateGalleries,
  tokens, saveTokens,
  tokensMail, saveTokensMail,
  grants, saveGrants,
  dataEvents,
};
