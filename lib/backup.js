'use strict';
/**
 * Sauvegarde automatique des données de l'application.
 *
 * Pourquoi : sur un hébergeur « sans disque persistant » (Render gratuit,
 * Railway, Fly…), les fichiers locaux (data/*.json) sont perdus à chaque
 * redéploiement ou mise en veille. Les photos restent sur Google Drive,
 * mais la configuration, les galeries, les comptes clients et les jetons
 * OAuth doivent survivre.
 *
 * Deux destinations possibles (la première configurée gagne) :
 *  1. GitHub (recommandé) — un dépôt PRIVÉ dédié (ex. mews-studio-backup).
 *     Variables : GITHUB_BACKUP_TOKEN (Personal Access Token « fine-grained »
 *     avec permission Contents:Read and write sur ce dépôt) et
 *     GITHUB_BACKUP_REPO (ex. « Meliezer26/mews-studio-backup »).
 *     Fonctionne toujours, y compris en mode « compte de service ».
 *  2. Google Drive — fichier « mews-studio-data.json » écrit dans un
 *     dossier partagé. ⚠️ Ne fonctionne qu'en mode OAuth classique :
 *     un compte de service n'a PAS de quota de stockage et ne peut pas
 *     créer de fichiers.
 *
 * Déclencheurs : au démarrage, toutes les 5 minutes, et ~20 s après
 * chaque modification des données locales.
 *
 * Jamais bloquant : toute erreur est avalée et journalisée.
 */
const drive = require('./drive');
const store = require('./store');
const fs = require('fs');
const path = require('path');

const BACKUP_NAME = 'mews-studio-data.json';
let lastBackupAt = null;
let lastBackupStore = null;
let timer = null;

function fileExists(name) {
  return fs.existsSync(path.join(store.DATA_DIR, name));
}

function hasRefreshToken() {
  const t = store.tokens();
  return !!(t && t.refresh_token);
}

/** Vrai si le Drive est configuré ET authentifiable (OAuth ou compte de service). */
function canAuthenticate() {
  return drive.isConfigured() && (drive.isServiceAccount() || hasRefreshToken());
}

/* --- GitHub -------------------------------------------------- */

function githubConfigured() {
  return !!(process.env.GITHUB_BACKUP_TOKEN && process.env.GITHUB_BACKUP_REPO);
}

function canBackup() {
  return githubConfigured() || canAuthenticate();
}

function backupStore() {
  if (githubConfigured()) return 'github';
  if (canAuthenticate()) return 'drive';
  return null;
}

async function githubApi(pathname, init = {}) {
  return fetch('https://api.github.com' + pathname, {
    ...init,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_BACKUP_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  });
}

/** Récupère l'entrée brute (avec sha) du fichier de sauvegarde, ou null. */
async function githubGetEntry() {
  const res = await githubApi('/repos/' + process.env.GITHUB_BACKUP_REPO + '/contents/' + BACKUP_NAME);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('lecture GitHub impossible (' + res.status + ')');
  return res.json();
}

/** Écrit (crée ou met à jour) la sauvegarde dans le dépôt GitHub. */
async function githubPut(payload) {
  // Pour une mise à jour, GitHub exige le sha de la version actuelle.
  let sha = null;
  try {
    const entry = await githubGetEntry();
    if (entry && entry.sha) sha = entry.sha;
  } catch { /* le fichier n'existe peut-être pas encore */ }
  const body = {
    message: 'Sauvegarde automatique Mews Studio — ' + new Date().toISOString(),
    content: Buffer.from(payload, 'utf8').toString('base64'),
  };
  if (sha) body.sha = sha;
  const res = await githubApi('/repos/' + process.env.GITHUB_BACKUP_REPO + '/contents/' + BACKUP_NAME, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error('GitHub a refusé (' + res.status + ') : ' + t.slice(0, 140));
  }
  return res.json();
}

/** Lit la sauvegarde depuis le dépôt GitHub (null si absente). */
async function githubGet() {
  const data = await githubGetEntry();
  if (!data || !data.content) return null;
  return JSON.parse(Buffer.from(String(data.content).replace(/\s/g, ''), 'base64').toString('utf8'));
}

/* --- Drive --------------------------------------------------- */

/** Ré-hydrate les jetons OAuth depuis l'environnement (disque perdu). */
async function hydrateTokensFromEnv() {
  if (store.tokens() || !process.env.GOOGLE_REFRESH_TOKEN) return store.tokens();
  store.saveTokens({
    access_token: null,
    refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
    expiry: null,
    email: null,
  });
  try {
    await drive.refreshToken();
  } catch {
    /* le jeton d'accès sera rafraîchi à la prochaine tentative */
  }
  return store.tokens();
}

async function findBackupInFolder(folderId) {
  const q = "name='" + BACKUP_NAME + "' and '" + folderId + "' in parents and trashed=false";
  const res = await drive.api('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10');
  if (!res.ok) throw new Error('recherche de la sauvegarde impossible (' + res.status + ')');
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

/** Cherche le fichier de sauvegarde dans le Drive (n'importe où). */
async function findBackupFile() {
  const q = "name='" + BACKUP_NAME + "' and trashed=false";
  const res = await drive.api('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10');
  if (!res.ok) return null;
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

/* --- Restauration ------------------------------------------- */

/** Applique des données restaurées aux fichiers locaux manquants. */
function applyRestored(data) {
  if (!fileExists('galleries.json') && Array.isArray(data.galleries)) store.saveGalleries(data.galleries);
  if (!fileExists('config.json') && data.config && typeof data.config === 'object') store.saveConfig(data.config);
  return fileExists('galleries.json') && fileExists('config.json');
}

/** Restaure les données locales si elles manquent (appelé au démarrage). */
async function restoreIfNeeded() {
  try {
    const gExists = fileExists('galleries.json');
    const cExists = fileExists('config.json');
    if (gExists && cExists) {
      return { restored: false, reason: 'données locales déjà présentes' };
    }
    // 1) GitHub (si configuré)
    if (githubConfigured()) {
      const data = await githubGet();
      if (!data) return { restored: false, reason: 'aucune sauvegarde « ' + BACKUP_NAME + ' » dans le dépôt GitHub' };
      const ok = applyRestored(data);
      return { restored: ok, savedAt: data.savedAt || null, reason: ok ? 'restauré depuis GitHub' : 'sauvegarde GitHub incomplète' };
    }
    // 2) Google Drive (mode OAuth)
    if (!drive.isConfigured()) {
      return { restored: false, reason: 'aucune destination de sauvegarde configurée (GITHUB_BACKUP_TOKEN ou OAuth Drive)' };
    }
    if (!drive.isServiceAccount()) {
      if (!hasRefreshToken()) await hydrateTokensFromEnv();
      if (!hasRefreshToken()) return { restored: false, reason: 'hydratation des jetons impossible' };
    }
    const file = await findBackupFile();
    if (!file) return { restored: false, reason: 'aucune sauvegarde « ' + BACKUP_NAME + ' » dans le Drive' };
    const dl = await drive.api('/drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media');
    if (!dl.ok) return { restored: false, reason: 'téléchargement de la sauvegarde impossible (' + dl.status + ')' };
    const data = JSON.parse(await dl.text());
    const ok = applyRestored(data);
    return { restored: ok, savedAt: data.savedAt || null, reason: ok ? 'restauré depuis le Drive' : 'sauvegarde incomplète' };
  } catch (err) {
    return { restored: false, reason: 'erreur : ' + String(err.message).slice(0, 120) };
  }
}

/* --- Écriture ------------------------------------------------ */

function buildPayload() {
  return JSON.stringify({
    version: 2,
    savedAt: new Date().toISOString(),
    config: store.config(),
    galleries: store.galleries(),
  });
}

/** Écrit la sauvegarde (GitHub si configuré, sinon Drive). */
async function now() {
  try {
    if (!canBackup()) return { ok: false, reason: 'Aucune sauvegarde configurée (GITHUB_BACKUP_TOKEN / GITHUB_BACKUP_REPO, ou Google Drive).' };
    const payload = buildPayload();

    if (githubConfigured()) {
      await githubPut(payload);
      lastBackupAt = new Date().toISOString();
      lastBackupStore = 'github';
      console.log('[backup] Sauvegarde GitHub OK (' + BACKUP_NAME + ') à ' + lastBackupAt);
      return { ok: true, at: lastBackupAt, store: 'github' };
    }

    // Destination Drive (uniquement utile en OAuth classique).
    const cfg = store.config();
    const candidates = [];
    if (cfg.backupFolderId) candidates.push(cfg.backupFolderId);
    if (process.env.BACKUP_FOLDER_ID && !candidates.includes(process.env.BACKUP_FOLDER_ID)) {
      candidates.push(process.env.BACKUP_FOLDER_ID);
    }
    try {
      for (const f of await drive.listFolders()) {
        if (!candidates.includes(f.id)) candidates.push(f.id);
      }
    } catch { /* dossier Drive indisponible : on continue avec les candidats connus */ }
    if (!candidates.length) {
      return { ok: false, reason: 'Aucun dossier Drive partagé avec le robot.' };
    }
    const buf = Buffer.from(payload, 'utf8');
    let lastErr = null;
    for (const folderId of candidates) {
      try {
        const existing = await findBackupInFolder(folderId);
        if (existing) {
          const up = await drive.api(
            '/upload/drive/v3/files/' + encodeURIComponent(existing.id) + '?uploadType=media',
            { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: buf }
          );
          if (!up.ok) throw new Error('mise à jour refusée (' + up.status + ')');
        } else {
          const boundary = 'mews' + Date.now().toString(36);
          const meta = JSON.stringify({ name: BACKUP_NAME, mimeType: 'application/json', parents: [folderId] });
          const body = Buffer.concat([
            Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
            Buffer.from(`--${boundary}\r\nContent-Type: application/json\r\n\r\n`),
            buf,
            Buffer.from(`\r\n--${boundary}--\r\n`),
          ]);
          const create = await drive.api('/upload/drive/v3/files?uploadType=multipart&fields=id,name', {
            method: 'POST',
            headers: { 'Content-Type': 'multipart/related; boundary=' + boundary },
            body,
          });
          if (!create.ok) throw new Error('création refusée (' + create.status + ')');
        }
        if (cfg.backupFolderId !== folderId) {
          cfg.backupFolderId = folderId;
          store.saveConfig(cfg);
        }
        lastBackupAt = new Date().toISOString();
        lastBackupStore = 'drive';
        let label = folderId;
        try { label = await drive.folderName(folderId); } catch { /* on garde l'id */ }
        console.log('[backup] Sauvegarde Drive OK (' + BACKUP_NAME + ') dans « ' + label + ' » à ' + lastBackupAt);
        return { ok: true, at: lastBackupAt, store: 'drive', folder: label };
      } catch (err) {
        lastErr = err;
      }
    }
    console.warn('[backup] Échec (non bloquant) : ' + (lastErr ? lastErr.message : ''));
    return { ok: false, reason: String(lastErr && lastErr.message).slice(0, 160) };
  } catch (err) {
    console.warn('[backup] Échec (non bloquant) :', err.message);
    return { ok: false, reason: String(err.message).slice(0, 120) };
  }
}

/**
 * Révoque les permissions Drive des liens de téléchargement temporaires
 * arrivés à expiration (ou dépassant 24 h si la révocation échoue).
 */
async function cleanupExpiredGrants() {
  try {
    const grants = store.grants();
    const nowTs = Date.now();
    let changed = false;
    for (const fileId of Object.keys(grants)) {
      const g = grants[fileId];
      if (!g || !g.until || g.until > nowTs) continue;
      let revoked = false;
      try {
        revoked = await drive.revokePublicDownload(fileId, g.permissionId);
      } catch {
        revoked = false;
      }
      if (revoked || nowTs - (g.grantedAt || 0) > 24 * 3600 * 1000) {
        delete grants[fileId];
        changed = true;
      }
    }
    if (changed) store.saveGrants(grants);
  } catch (err) {
    console.warn('[grants] Nettoyage impossible :', err.message);
  }
}

/** Sauvegarde périodique toutes les 5 minutes (si configurée). */
function startPeriodicBackup(intervalMs = 5 * 60 * 1000) {
  if (timer) return;
  timer = setInterval(() => {
    cleanupExpiredGrants();
    now();
  }, intervalMs);
  timer.unref && timer.unref();
}

/* --- Sauvegarde différée après chaque écriture locale --------
 * Le disque d'un hébergeur gratuit peut être réinitialisé à tout
 * moment (redéploiement, mise en veille). Chaque modification des
 * données déclenche donc une sauvegarde ~20 s plus tard.
 * -------------------------------------------------------------- */
let debounceTimer = null;
function scheduleSoon(delayMs = 20 * 1000) {
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { now(); }, delayMs);
  debounceTimer.unref && debounceTimer.unref();
}
store.dataEvents.on('data-changed', () => scheduleSoon());

async function init() {
  const r = await restoreIfNeeded();
  if (r.restored) {
    console.log('[backup] Données restaurées (sauvegarde du ' + (r.savedAt || '?') + ') : ' + r.reason);
  } else if (r.reason) {
    console.log('[backup] Restauration non nécessaire ou impossible : ' + r.reason);
  }
  await cleanupExpiredGrants();
  startPeriodicBackup();
  now(); // sauvegarde immédiate au démarrage (le disque peut être réinitialisé à tout moment)
}

module.exports = {
  now, init, startPeriodicBackup, restoreIfNeeded, cleanupExpiredGrants, scheduleSoon,
  lastBackupAt: () => lastBackupAt,
  lastBackupStore: () => lastBackupStore,
  backupStore,
  githubConfigured,
};
