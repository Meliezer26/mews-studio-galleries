'use strict';
/**
 * Sauvegarde automatique des données de l'application sur Google Drive.
 *
 * Pourquoi : sur un hébergeur « sans disque persistant » (Render gratuit,
 * Railway, Fly…), les fichiers locaux (data/*.json) peuvent être perdus
 * lors d'un redéploiement ou d'un redémarrage. Les photos restent sur
 * Google Drive, mais la configuration, les galeries, les comptes clients
 * et les jetons OAuth doivent survivre.
 *
 * Fonctionnement :
 *  - `restoreIfNeeded()` au démarrage : si les données locales sont
 *    absentes, on cherche « mews-studio-data.json » dans le Drive et on
 *    restaure.
 *  - `startPeriodicBackup()` : toutes les 5 minutes, si Drive est
 *    connecté, on écrit « mews-studio-data.json » dans le Drive.
 *  - `GOOGLE_REFRESH_TOKEN` (variable d'env) permet de ré-hydrater les
 *    jetons OAuth si le fichier tokens.json a été perdu.
 *
 * Jamais bloquant : toute erreur est avalée et journalisée.
 */
const drive = require('./drive');
const store = require('./store');
const fs = require('fs');
const path = require('path');

const BACKUP_NAME = 'mews-studio-data.json';
let lastBackupAt = null;
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

function canBackup() {
  return canAuthenticate();
}

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

/** Cherche le fichier de sauvegarde dans le Drive. */
async function findBackupFile() {
  const q = "name='" + BACKUP_NAME + "' and trashed=false";
  const res = await drive.api('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10');
  if (!res.ok) return null;
  const data = await res.json();
  return (data.files && data.files[0]) || null;
}

/** Restaure les données locales si elles manquent (appelé au démarrage). */
async function restoreIfNeeded() {
  try {
    if (!drive.isConfigured()) {
      return { restored: false, reason: 'OAuth Drive non configuré (variables d’env manquantes)' };
    }
    const needOAuth = !drive.isServiceAccount();
    if (needOAuth && !hasRefreshToken() && !process.env.GOOGLE_REFRESH_TOKEN) {
      return { restored: false, reason: 'aucun jeton Drive disponible (première connexion à faire)' };
    }
    const gExists = fileExists('galleries.json');
    const cExists = fileExists('config.json');
    if (gExists && cExists) {
      return { restored: false, reason: 'données locales déjà présentes' };
    }
    if (needOAuth) {
      if (!hasRefreshToken()) await hydrateTokensFromEnv();
      if (!hasRefreshToken()) return { restored: false, reason: 'hydratation des jetons impossible' };
    }
    const file = await findBackupFile();
    if (!file) return { restored: false, reason: 'aucune sauvegarde « ' + BACKUP_NAME + ' » dans le Drive' };
    const dl = await drive.api('/drive/v3/files/' + encodeURIComponent(file.id) + '?alt=media');
    if (!dl.ok) return { restored: false, reason: 'téléchargement de la sauvegarde impossible (' + dl.status + ')' };
    const data = JSON.parse(await dl.text());
    if (!gExists && Array.isArray(data.galleries)) store.saveGalleries(data.galleries);
    if (!cExists && data.config && typeof data.config === 'object') store.saveConfig(data.config);
    const ok = fileExists('galleries.json') && fileExists('config.json');
    return { restored: ok, savedAt: data.savedAt || null, reason: ok ? 'restauré depuis le Drive' : 'sauvegarde incomplète' };
  } catch (err) {
    return { restored: false, reason: 'erreur : ' + String(err.message).slice(0, 120) };
  }
}

/** Écrit (ou met à jour) la sauvegarde dans le Drive. */
async function now() {
  try {
    if (!canBackup()) return { ok: false, reason: 'Drive non connecté' };
    const payload = JSON.stringify({
      version: 1,
      savedAt: new Date().toISOString(),
      config: store.config(),
      galleries: store.galleries(),
    });
    const buf = Buffer.from(payload, 'utf8');
    const existing = await findBackupFile();
    if (existing) {
      const up = await drive.api(
        '/upload/drive/v3/files/' + encodeURIComponent(existing.id) + '?uploadType=media',
        { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: buf }
      );
      if (!up.ok) return { ok: false, reason: 'mise à jour refusée (' + up.status + ')' };
    } else {
      const boundary = 'mews' + Date.now().toString(36);
      const meta = JSON.stringify({ name: BACKUP_NAME, mimeType: 'application/json' });
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
      if (!create.ok) return { ok: false, reason: 'création refusée (' + create.status + ')' };
    }
    lastBackupAt = new Date().toISOString();
    console.log('[backup] Sauvegarde Drive OK (' + BACKUP_NAME + ') à ' + lastBackupAt);
    return { ok: true, at: lastBackupAt };
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
    const now = Date.now();
    let changed = false;
    for (const fileId of Object.keys(grants)) {
      const g = grants[fileId];
      if (!g || !g.until || g.until > now) continue;
      let revoked = false;
      try {
        revoked = await drive.revokePublicDownload(fileId, g.permissionId);
      } catch {
        revoked = false;
      }
      if (revoked || now - (g.grantedAt || 0) > 24 * 3600 * 1000) {
        delete grants[fileId];
        changed = true;
      }
    }
    if (changed) store.saveGrants(grants);
  } catch (err) {
    console.warn('[grants] Nettoyage impossible :', err.message);
  }
}

/** Sauvegarde périodique toutes les 5 minutes (si Drive connecté). */
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
 * données déclenche donc une sauvegarde Drive ~20 s plus tard.
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
    console.log('[backup] Données restaurées depuis Google Drive (sauvegarde du ' + (r.savedAt || '?') + ')');
  } else if (r.reason) {
    console.log('[backup] Restauration non nécessaire ou impossible : ' + r.reason);
  }
  await cleanupExpiredGrants();
  startPeriodicBackup();
  now(); // sauvegarde immédiate au démarrage (le disque peut être réinitialisé à tout moment)
}

module.exports = { now, init, startPeriodicBackup, restoreIfNeeded, cleanupExpiredGrants, scheduleSoon, lastBackupAt: () => lastBackupAt };
