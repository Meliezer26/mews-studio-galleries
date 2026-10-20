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

const crypto = require('crypto');

const BACKUP_NAME = 'mews-studio-data.json';

/* --- Jeton Gmail chiffré dans la sauvegarde --------------------
 * Le jeton du compte d'envoi vit dans data/tokens-mail.json, sur un disque
 * effacé à chaque déploiement. Sans sauvegarde, chaque mise en ligne
 * ressuscitait l'ancien jeton de la variable GOOGLE_MAIL_REFRESH_TOKEN
 * (éventuellement révoqué) par-dessus une reconnexion récente.
 * On le range donc dans la sauvegarde, chiffré (AES-256-GCM) avec une clé
 * dérivée de GOOGLE_CLIENT_SECRET — secret qui n'existe que dans
 * l'environnement de l'hébergeur, jamais dans le dépôt de sauvegarde.
 * ---------------------------------------------------------------- */
function mailKey() {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update('mews-mail-token:' + secret).digest();
}

function encryptMailToken(obj) {
  const key = mailKey();
  if (!key || !obj || !obj.refresh_token) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify({ refresh_token: obj.refresh_token, email: obj.email || null, connectedAt: obj.connectedAt || null });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decryptMailToken(b64) {
  try {
    const key = mailKey();
    if (!key || !b64) return null;
    const buf = Buffer.from(String(b64), 'base64');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    const o = JSON.parse(plain);
    return o && o.refresh_token ? o : null;
  } catch {
    return null;
  }
}
let lastBackupAt = null;
let lastBackupStore = null;
let timer = null;

/* --- Confiance dans les données locales ---------------------
 * `trusted` = false signifie : au démarrage, la restauration a échoué ALORS
 * QUE le disque était vide (donc l'état local ne contient que la galerie de
 * démonstration). Dans cet état, toute écriture écraserait la vraie
 * sauvegarde par un site vide : le garde-fou ci-dessous l'interdit.
 *
 * `lastRefusal` conserve la dernière écriture refusée, pour l'afficher dans
 * l'admin et éviter d'envoyer l'alerte en boucle (toutes les 5 minutes).
 * ---------------------------------------------------------------- */
let localTrusted = true;
let lastRefusal = null;
let alertCooldownUntil = 0;

function statsOf(data) {
  const gs = (data && Array.isArray(data.galleries)) ? data.galleries : [];
  return {
    galleries: gs.length,
    photos: gs.reduce((s, g) => s + ((g && g.files) ? g.files.length : 0), 0),
    savedAt: (data && data.savedAt) || null,
  };
}

/**
 * Prévient le photographe qu'un démarrage s'est fait SANS restaurer ses
 * données (disque vidé + restauration impossible). C'est l'alerte qui
 * manquait : ce cas n'écrivait qu'une ligne dans les journaux.
 */
async function notifyDegraded(reason) {
  const remote = await (async () => {
    try {
      const data = await githubGet();
      return data ? statsOf(data) : null;
    } catch { return null; }
  })();
  await alertOnce(
    '⚠ Restauration impossible au démarrage — vos données sont protégées (Mews Studio Galleries)',
    [
      'Bonjour,',
      '',
      'Le site Mews Studio Galleries vient de redémarrer sans pouvoir restaurer',
      'vos données depuis la sauvegarde GitHub.',
      '',
      'Raison : ' + (reason || 'inconnue'),
      '',
      'CE QUI S\'EST PASSÉ : le site fonctionne actuellement à vide (galerie de',
      'démonstration seulement). Vos galeries ne sont PAS perdues :',
      '  • les photos sont toujours sur votre Google Drive ;',
      '  • la sauvegarde en ligne contient ' + (remote ? remote.galleries + ' galerie(s) et ' + remote.photos + ' photos' : 'vos données (lecture impossible pour le moment)') + '.',
      '',
      'PROTECTION ACTIVE : la sauvegarde automatique est GELÉE — rien ne peut',
      'écraser la sauvegarde en ligne avec un site vide.',
      '',
      'QUE FAIRE : dans Render, ouvrez le service puis « Manual Deploy » →',
      '« Deploy latest commit ». Le redémarrage relancera la restauration.',
      'Si le problème persiste, transmettez ce message à votre assistant.',
      '',
      '— Mews Studio Galleries (message automatique)',
    ].join('\n'),
  );
}

/** Envoie une alerte par e-mail, au plus une fois par heure. */
async function alertOnce(subject, text) {
  if (Date.now() < alertCooldownUntil) return;
  alertCooldownUntil = Date.now() + 60 * 60 * 1000;
  try {
    const mailer = require('./mailer');
    const r = await mailer.sendAlert(subject, text);
    console.log('[backup] Alerte e-mail ' + (r.ok ? 'envoyée (' + r.via + ')' : 'IMPOSSIBLE : ' + r.error));
  } catch (e) {
    console.warn('[backup] Alerte e-mail impossible :', e.message);
  }
}

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

/**
 * Lit le contenu d'une entrée « contents » de l'API GitHub.
 *
 * ⚠️ L'API « contents » ne renvoie PAS le contenu des fichiers de plus de
 * 1 Mo : elle répond 200 avec encoding « none » et content vide. Passé ce
 * seuil (atteint le 20/10/2026, sauvegarde à 1,2 Mo), le fichier était donc
 * considéré comme absent — la restauration au démarrage devenait impossible
 * et le bilan de santé criait « fichier de sauvegarde absent » alors que la
 * sauvegarde était parfaitement saine.
 * Au-delà de 1 Mo, on lit donc le contenu par l'API Git Blobs (jusqu'à 100 Mo).
 */
async function readEntryText(entry) {
  if (entry && entry.content) {
    return Buffer.from(String(entry.content).replace(/\s/g, ''), 'base64').toString('utf8');
  }
  if (!entry || !entry.sha) return null;
  const res = await githubApi('/repos/' + process.env.GITHUB_BACKUP_REPO + '/git/blobs/' + entry.sha);
  if (!res.ok) throw new Error('lecture du contenu GitHub impossible (' + res.status + ')');
  const blob = await res.json();
  if (!blob || !blob.content) return null;
  const raw = String(blob.content).replace(/\s/g, '');
  return blob.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : String(blob.content);
}

/** Lit la sauvegarde depuis le dépôt GitHub (null si absente). */
async function githubGet() {
  const entry = await githubGetEntry();
  if (!entry) return null;
  const text = await readEntryText(entry);
  if (!text) return null;
  return JSON.parse(text);
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
  // Jeton Gmail : restauré AVANT l'hydratation par variable d'env (server.js),
  // pour que la dernière reconnexion faite dans l'admin l'emporte toujours.
  const tm = store.tokensMail();
  if (!(tm && tm.refresh_token) && data.mailToken) {
    const m = decryptMailToken(data.mailToken);
    if (m) {
      store.saveTokensMail({ refresh_token: m.refresh_token, email: m.email || null, connectedAt: m.connectedAt || null, access_token: null, expiry: null });
      console.log('[backup] Jeton du compte d\'envoi Gmail restauré depuis la sauvegarde' + (m.connectedAt ? ' (connecté le ' + m.connectedAt.slice(0, 10) + ')' : ''));
    }
  }
  return fileExists('galleries.json') && fileExists('config.json');
}

/**
 * Restaure les données locales si elles manquent (appelé au démarrage),
 * puis décide si l'état local est digne de confiance.
 *
 * Si le disque a été vidé ET que la restauration échoue, les données
 * locales ne contiennent plus que la galerie de démonstration : les
 * marquer « non fiables » empêche la sauvegarde automatique (déclenchée
 * quelques secondes plus tard) d'écraser la vraie sauvegarde par un site
 * vide. C'est le scénario qui, sans ce garde-fou, détruit tout.
 */
async function restoreIfNeeded() {
  const r = await restoreIfNeededInner();
  const real = (store.galleries() || []).filter((g) => g && g.mode !== 'demo').length;
  // Sans destination de sauvegarde, il n'y a rien à protéger : ne pas geler
  // les écritures (installation locale, démonstration).
  localTrusted = !canBackup() || !!(r.restored || real > 0);
  if (!localTrusted) {
    console.warn('[backup] DONNÉES LOCALES NON FIABLES (' + r.reason + ') : aucune galerie réelle en local — les écritures sont gelées pour ne pas écraser la sauvegarde.');
  }
  return r;
}

async function restoreIfNeededInner() {
  try {
    // « Présent » ne suffit pas : un galleries.json vide (écrit par un
    // démarrage raté) ne doit pas empêcher la restauration.
    const hasData = fileExists('galleries.json') && fileExists('config.json') && (store.galleries() || []).length > 0;
    if (hasData) {
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

function buildPayload(previous) {
  return JSON.stringify({
    version: 3,
    savedAt: new Date().toISOString(),
    config: store.config(),
    galleries: store.galleries(),
    // Jeton Gmail chiffré (null si non connecté ou clé indisponible).
    mailToken: encryptMailToken(store.tokensMail()),
    // Photo de l'état précédent : permet au bilan de santé de détecter une
    // chute brutale (site vide sauvegardé) sans avoir à interroger l'API.
    previous: previous || null,
  });
}

/**
 * Décide s'il est permis d'écrire par-dessus la sauvegarde distante.
 *
 * Principe : mieux vaut ne PAS sauvegarder que d'écraser des données saines.
 * Une écriture est refusée si :
 *  - la sauvegarde distante existe mais reste illisible (le bug du 20/10/2026) ;
 *  - les données locales ne sont pas fiables (restauration du démarrage échouée) ;
 *  - l'état local contiendrait nettement moins de galeries que la sauvegarde
 *    (site vide, ou chute de plus de 40 %).
 */
async function assessAgainstRemote(local, force) {
  if (force) return { allow: true, remote: null, forced: true };

  let entry;
  try {
    entry = await githubGetEntry();
  } catch (e) {
    return { allow: false, remote: null, reason: 'sauvegarde distante illisible (' + String(e.message).slice(0, 90) + ') — écriture annulée par précaution' };
  }
  if (!entry) return { allow: true, remote: null, first: true }; // première sauvegarde

  let remote;
  try {
    const text = await readEntryText(entry);
    if (!text) throw new Error('contenu vide');
    remote = statsOf(JSON.parse(text));
  } catch (e) {
    return { allow: false, remote: null, reason: 'sauvegarde distante illisible (' + String(e.message).slice(0, 90) + ') — écriture annulée par précaution' };
  }

  if (!localTrusted) {
    return {
      allow: false,
      remote,
      reason: 'restauration du démarrage impossible : la sauvegarde (' + remote.galleries + ' galerie(s), ' + remote.photos + ' photos) serait écrasée par ' + local.galleries + ' galerie(s) locale(s)',
    };
  }
  if (remote.galleries >= 2 && local.galleries < remote.galleries) {
    const catastrophic = local.galleries <= 1 || local.galleries < Math.ceil(remote.galleries * 0.6);
    if (catastrophic) {
      return {
        allow: false,
        remote,
        reason: 'chute brutale : ' + local.galleries + ' galerie(s) locale(s) contre ' + remote.galleries + ' dans la sauvegarde (suppression massive ou remise à zéro ?)',
      };
    }
  }
  return { allow: true, remote };
}

/**
 * Écrit la sauvegarde (GitHub si configuré, sinon Drive).
 * `force` court-circuite le garde-fou anti-écrasement (décision explicite
 * du photographe depuis l'admin, après lecture de l'alerte).
 */
async function now(opts = {}) {
  const force = !!(opts && opts.force);
  try {
    if (!canBackup()) return { ok: false, reason: 'Aucune sauvegarde configurée (GITHUB_BACKUP_TOKEN / GITHUB_BACKUP_REPO, ou Google Drive).' };
    // Garde-fou : ne jamais écraser une sauvegarde saine avec une config
    // incomplète (ex. démarrage où la restauration a échoué ou est incomplète).
    if (!store.config().adminPasswordHash) {
      return { ok: false, reason: 'config incomplète (mot de passe admin absent) — sauvegarde annulée pour protéger les données saines' };
    }

    if (githubConfigured()) {
      // 1) Le garde-fou décide AVANT de construire le contenu à écrire.
      const local = statsOf({ galleries: store.galleries() });
      const verdict = await assessAgainstRemote(local, force);
      if (!verdict.allow) {
        lastRefusal = { at: new Date().toISOString(), reason: verdict.reason, local, remote: verdict.remote || null };
        console.warn('[backup] ÉCRITURE REFUSÉE — ' + verdict.reason);
        await alertOnce(
          '⚠ Sauvegarde refusée — intervention nécessaire (Mews Studio Galleries)',
          [
            'Bonjour,',
            '',
            'La sauvegarde automatique de Mews Studio Galleries vient d\'être REFUSÉE',
            'pour protéger vos données. Rien n\'a été écrasé.',
            '',
            'Raison : ' + verdict.reason,
            '',
            'Sauvegarde en ligne : ' + (verdict.remote ? verdict.remote.galleries + ' galerie(s), ' + verdict.remote.photos + ' photos' : 'illisible'),
            'État du site : ' + local.galleries + ' galerie(s), ' + local.photos + ' photos',
            '',
            'Que faire :',
            '  • Si le site vous semble normal (photographies et clientes présentes),',
            '    ouvrez l\'admin → Sauvegarde → « Forcer une sauvegarde ».',
            '  • Si le site semble vide, ne forcez pas : redéployez le service Render',
            '    (Manual Deploy) pour relancer la restauration depuis la sauvegarde.',
            '',
            'Détail technique : ' + (verdict.remote ? 'sauvegarde distante ' + verdict.remote.galleries + ' galeries' : 'lecture distante en échec'),
            '',
            '— Mews Studio Galleries (message automatique)',
          ].join('\n'),
        );
        return { ok: false, refused: true, reason: verdict.reason };
      }
      if (force) localTrusted = true;

      // 2) Écriture, en mémorisant l'état précédent dans la sauvegarde.
      const payload = buildPayload(verdict.remote);
      await githubPut(payload);
      lastRefusal = null;
      lastBackupAt = new Date().toISOString();
      lastBackupStore = 'github';
      console.log('[backup] Sauvegarde GitHub OK (' + BACKUP_NAME + ') à ' + lastBackupAt);
      return { ok: true, at: lastBackupAt, store: 'github' };
    }

    const payload = buildPayload(null);

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
  githubGet,
  now, init, startPeriodicBackup, restoreIfNeeded, cleanupExpiredGrants, scheduleSoon,
  lastBackupAt: () => lastBackupAt,
  lastBackupStore: () => lastBackupStore,
  backupStore,
  githubConfigured,
  // Garde-fou anti-écrasement (état exposé à l'admin et au bilan de santé).
  localTrusted: () => localTrusted,
  lastRefusal: () => lastRefusal,
  statsOf,
  notifyDegraded,
};
