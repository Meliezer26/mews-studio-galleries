'use strict';
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

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
}

/* --- Configuration de l'application ------------------------ */
function config() { return readJson('config.json', {}); }
function saveConfig(c) { writeJson('config.json', c); }

/* --- Galeries ---------------------------------------------- */
function galleries() { return readJson('galleries.json', []); }
function saveGalleries(g) { writeJson('galleries.json', g); }

/* --- Jetons Google OAuth ----------------------------------- */
function tokens() { return readJson('tokens.json', null); }
function saveTokens(t) { writeJson('tokens.json', t); }

/* --- Liens de téléchargement temporaires (Drive) ------------ */
/* { [fileId]: { permissionId, url, until, grantedAt, name } } */
function grants() { return readJson('grants.json', {}); }
function saveGrants(g) { writeJson('grants.json', g); }

module.exports = {
  DATA_DIR,
  UPLOADS_DIR: path.join(DATA_DIR, 'uploads'),
  ensureDirs,
  config, saveConfig,
  galleries, saveGalleries,
  tokens, saveTokens,
  grants, saveGrants,
};
