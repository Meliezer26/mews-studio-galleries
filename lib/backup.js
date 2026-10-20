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

/* --- Jetons OAuth chiffrés dans la sauvegarde -------------------
 * Les jetons vivent dans data/tokens.json (Drive) et data/tokens-mail.json
 * (envoi Gmail), sur un disque effacé à chaque déploiement. Sans copie dans
 * la sauvegarde, chaque mise en ligne ressuscitait l'ancien jeton de la
 * variable d'environnement — éventuellement révoqué, ou remplacé depuis par
 * une reconnexion faite dans l'admin : celle-ci était alors perdue, et le
 * site repartait avec un jeton mort (galeries vides).
 *
 * On les range donc dans la sauvegarde, chiffrés (AES-256-GCM) avec une clé
 * dérivée de GOOGLE_CLIENT_SECRET — secret qui n'existe que dans
 * l'environnement de l'hébergeur, jamais dans le dépôt de sauvegarde.
 * Le contenu chiffré ne déclenche pas la détection de secrets de GitHub.
 *
 * ⚠️ Si GOOGLE_CLIENT_SECRET est un jour changé, les anciennes copies
 * chiffrées deviennent indéchiffrables (repli silencieux sur la variable
 * d'environnement, avec un message dans les journaux).
 * ---------------------------------------------------------------- */
/* Clé de chiffrement des jetons.
 *
 * Idéalement une clé DÉDIÉE (variable MEWS_TOKEN_KEY), indépendante du secret
 * OAuth : changer GOOGLE_CLIENT_SECRET — une opération banale chez Google —
 * ne doit pas rendre les jetons sauvegardés illisibles.
 *
 * Compatibilité : la liste peut contenir plusieurs clés séparées par des
 * virgules ; TOUTES servent à déchiffrer, la PREMIÈRE à chiffrer. On peut
 * donc faire tourner la clé sans rien perdre : on préfixe la nouvelle, on
 * garde l'ancienne le temps que la sauvegarde soit réécrite.
 *
 * Les sauvegardes produites avant cette évolution (chiffrées avec une clé
 * dérivée de GOOGLE_CLIENT_SECRET) restent déchiffrables : voir candidates().
 */
function dedicatedKeys() {
  const raw = String(process.env.MEWS_TOKEN_KEY || '');
  return raw.split(',').map((s) => s.trim()).filter(Boolean)
    .map((v) => crypto.createHash('sha256').update('mews-dedicated-token:' + v).digest());
}

/** Ancienne dérivation (compatibilité ascendante uniquement). */
function tokenKey(kind) {
  const secret = process.env.GOOGLE_CLIENT_SECRET;
  if (!secret) return null;
  return crypto.createHash('sha256').update('mews-' + kind + '-token:' + secret).digest();
}

/** Mode de chiffrement effectif (affiché dans l'admin et le bilan). */
function keyMode() {
  if (dedicatedKeys().length) return 'dedicated';
  if (process.env.GOOGLE_CLIENT_SECRET) return 'client-secret';
  return 'none';
}

/** Clés à essayer pour déchiffrer, dans l'ordre. */
function candidates(kind) {
  const out = dedicatedKeys().map((key, i) => ({ key, tag: 'd' + (i + 1) + ':' }));
  const legacy = tokenKey(kind);
  if (legacy) {
    out.push({ key: legacy, tag: '' });
    // Une sauvegarde ancienne peut contenir l'autre type de jeton : on essaie
    // aussi l'autre dérivation, sans risque (le tag GCM rejette une clé fausse).
    const other = kind === 'drive' ? 'mail' : 'drive';
    const k2 = tokenKey(other);
    if (k2) out.push({ key: k2, tag: '' });
  }
  return out;
}

/** Chiffre { refresh_token, email, connectedAt } ; null si non connecté. */
function encryptToken(kind, obj) {
  const keys = candidates(kind);
  if (!keys.length || !obj || !obj.refresh_token) return null;
  const { key, tag } = keys[0]; // clé dédiée si disponible, sinon l'ancienne
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plain = JSON.stringify({ refresh_token: obj.refresh_token, email: obj.email || null, connectedAt: obj.connectedAt || null });
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  // Préfixe « d1: » = chiffré avec la 1re clé dédiée (les valeurs antérieures,
  // sans préfixe, sont déchiffrées avec l'ancienne dérivation).
  return tag + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

function decryptToken(kind, b64) {
  if (!b64) return null;
  // Retire un éventuel préfixe « d1: » / « d2: » (indique la clé dédiée).
  const raw = String(b64).replace(/^d\d+:/, '');
  let buf;
  try { buf = Buffer.from(raw, 'base64'); } catch { return null; }
  if (buf.length < 29) return null;
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ct = buf.subarray(28);
  // Toutes les clés connues sont essayées : migration transparente.
  for (const { key } of candidates(kind)) {
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(authTag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
      const o = JSON.parse(plain);
      if (o && o.refresh_token) return o;
    } catch { /* mauvaise clé : on essaie la suivante */ }
  }
  return null;
}

/* Compatibilité : la sauvegarde publiée utilise déjà la clé « mail ». */
function encryptMailToken(obj) { return encryptToken('mail', obj); }
function decryptMailToken(b64) { return decryptToken('mail', b64); }

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

/**
 * Alerte « sauvegarde refusée ». Le texte distingue deux situations tres
 * differentes, pour ne pas inquieter inutilement :
 *  - coupure reseau / redemarrage : transitoire, aucune action ;
 *  - contenu reellement douteux : la, une decision humaine est utile.
 */
async function alertRefusal(verdict, local) {
  const lastOk = lastBackupAt ? new Date(lastBackupAt).toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }) : 'inconnue';
  const lines = [
    'Bonjour,',
    '',
    'La sauvegarde automatique de Mews Studio Galleries est bloquée depuis',
    'plusieurs cycles. Rien n\'a été écrasé : vos données sont protégées.',
    '',
    'Raison : ' + verdict.reason,
    '',
    'Dernière sauvegarde réussie : ' + lastOk,
    'État du site : ' + local.galleries + ' galerie(s), ' + local.photos + ' photos.',
    'Copie en ligne : ' + (verdict.remote ? verdict.remote.galleries + ' galerie(s), ' + verdict.remote.photos + ' photos' : 'non vérifiable pour le moment'),
    '',
  ];
  if (verdict.transport) {
    lines.push(
      'IL S\'AGIT D\'UNE COUPURE DE CONNEXION, pas d\'une corruption :',
      'le service n\'a pas pu lire la copie en ligne (redémarrage de',
      'l\'hébergeur ou incident réseau passager). Le site réessaie tout seul',
      'toutes les 5 minutes.',
      '',
      'Aucune action de votre part pour l\'instant.',
      'Si ce message se répète pendant plus d\'une heure, transmettez-le à',
      'votre assistant.',
    );
  } else {
    lines.push(
      'CETTE FOIS, LA VÉRIFICATION A ÉCHOUÉ POUR UNE RAISON DE FOND :',
      'le contenu de la copie en ligne et l\'état du site ne concordent pas.',
      '',
      'Que faire :',
      '  • Si le site vous semble normal (photographies et clientes présentes),',
      '    ouvrez l\'admin, section Drive, bouton « Sauvegarder maintenant »,',
      '    puis confirmez le forçage : cela réécrit la copie en ligne.',
      '  • Si le site semble vide ou incomplet, NE FORCEZ PAS : transmettez ce',
      '    message à votre assistant, qui restaurera une version antérieure.',
    );
  }
  lines.push('', '— Mews Studio Galleries (message automatique)');
  await alertOnce(
    (verdict.transport ? '⚠ Sauvegarde suspendue — coupure de connexion' : '⚠ Sauvegarde bloquée — vérification impossible') + ' (Mews Studio Galleries)',
    lines.join('\n'),
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Requête GET avec réessais et délai maximal.
 *
 * Un redémarrage de l'hébergeur coupe les connexions en cours : le fetch
 * échoue alors avec « terminated »/« aborted » alors que la sauvegarde
 * distante est parfaitement saine. Un incident réseau de 2 secondes ne doit
 * ni bloquer l'écriture ni réveiller le photographe.
 */
async function fetchRetry(url, init = {}, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 25000);
    try {
      const res = await fetch(url, { ...init, signal: ctl.signal });
      clearTimeout(t);
      if ((res.status >= 500 || res.status === 429) && i < attempts - 1) {
        lastErr = new Error('HTTP ' + res.status);
        await sleep(2000 * (i + 1));
        continue;
      }
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (i < attempts - 1) await sleep(1500 * (i + 1));
    }
  }
  throw lastErr;
}

/** Traduit une erreur réseau en libellé lisible (jamais de « terminated » brut). */
function netLabel(e) {
  const m = String((e && e.message) || e);
  if (/terminated|aborted|socket hang up|ECONNRESET/i.test(m)) return 'connexion coupée (redémarrage du service ou incident réseau)';
  if (/timeout|ETIMEDOUT/i.test(m)) return 'délai dépassé';
  if (/ENOTFOUND|EAI_AGAIN/i.test(m)) return 'nom de domaine introuvable (DNS)';
  return m.slice(0, 90);
}

async function githubApi(pathname, init = {}) {
  const url = 'https://api.github.com' + pathname;
  const options = {
    ...init,
    headers: {
      Authorization: 'Bearer ' + process.env.GITHUB_BACKUP_TOKEN,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(init.headers || {}),
    },
  };
  // Les lectures sont réessayées ; les écritures jamais (un doublon de
  // commit serait créé à chaque tentative).
  return (init.method || 'GET') === 'GET' ? fetchRetry(url, options) : fetch(url, options);
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
  // Jeton Drive (compte Google du photographe) : restauré AVANT l'hydratation
  // par variable d'env (server.js), pour que la dernière reconnexion faite
  // dans l'admin l'emporte toujours sur une variable devenue obsolète.
  const td = store.tokens();
  if (!(td && td.refresh_token) && data.driveToken) {
    const d = decryptToken('drive', data.driveToken);
    if (d) {
      store.saveTokens({ refresh_token: d.refresh_token, email: d.email || null, connectedAt: d.connectedAt || null, access_token: null, expiry: null });
      console.log('[backup] Jeton du compte Drive restauré depuis la sauvegarde' + (d.connectedAt ? ' (connecté le ' + d.connectedAt.slice(0, 10) + ')' : ''));
    } else {
      console.warn('[backup] Jeton Drive présent dans la sauvegarde mais indéchiffrable (GOOGLE_CLIENT_SECRET a-t-il changé ?) — repli sur la variable d\'environnement.');
    }
  }
  // Jeton Gmail : idem, pour le compte d'envoi.
  const tm = store.tokensMail();
  if (!(tm && tm.refresh_token) && data.mailToken) {
    const m = decryptMailToken(data.mailToken);
    if (m) {
      store.saveTokensMail({ refresh_token: m.refresh_token, email: m.email || null, connectedAt: m.connectedAt || null, access_token: null, expiry: null });
      console.log('[backup] Jeton du compte d\'envoi Gmail restauré depuis la sauvegarde' + (m.connectedAt ? ' (connecté le ' + m.connectedAt.slice(0, 10) + ')' : ''));
    }
  }
  // La copie en ligne vient d'être restaurée : son empreinte est connue.
  // Sans cela, chaque redémarrage réécrivait 1,2 Mo alors que rien n'avait
  // changé (des dizaines de redémarrages par mois).
  try {
    lastPutHash = contentHash(buildProbe());
    lastPutAt = data.savedAt ? new Date(data.savedAt).getTime() : Date.now();
  } catch { /* empreinte indisponible : une écriture aura lieu, sans conséquence */ }
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
    version: 4,
    savedAt: new Date().toISOString(),
    config: store.config(),
    galleries: store.galleries(),
    // Jetons chiffrés (null si non connecté ou clé indisponible).
    // driveToken = compte Google du photographe (lecture des galeries).
    // Sans lui, un jeton révoqué ou une reconnexion non reportée dans les
    // variables de l'hébergeur laissait le site sans accès au Drive.
    driveToken: encryptToken('drive', store.tokens()),
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
/**
 * Décide s'il est permis d'écrire par-dessus la sauvegarde distante.
 *
 * Principe : mieux vaut ne PAS sauvegarder que d'écraser des données saines.
 * Une écriture est refusée si :
 *  - la sauvegarde distante existe mais reste illisible (bug du 20/10/2026) ;
 *  - les données locales ne sont pas fiables (restauration du démarrage échouée) ;
 *  - l'état local contiendrait nettement moins de galeries que la sauvegarde.
 *
 * Nuance ajoutée le 20/10/2026 : une COUPURE RÉSEAU (redémarrage du service,
 * incident passager) n'est pas une sauvegarde corrompue. Si la dernière
 * lecture réussie date de moins d'une heure et que l'état local n'a pas
 * diminué depuis, on autorise l'écriture — sinon un simple redémarrage
 * bloquerait les sauvegardes pendant des heures.
 */
let remoteCache = { sha: null, stats: null, at: 0 };
/** Nombre de refus consécutifs (l'alerte ne part qu'au 3e, ~15 min). */
let refusalStreak = 0;

/* --- Économie de bande passante ---------------------------------
 * La sauvegarde était réécrite toutes les 5 minutes MÊME SANS AUCUN
 * CHANGEMENT : 1,2 Mo envoyés à GitHub, 12 fois par heure, nuit et jour,
 * soit ~10 Go/mois. C'est du trafic sortant (compté « NAT » par Render) et
 * la cause réelle de la consommation de bande passante (70 % des 5 Go).
 *
 * Désormais on compare une empreinte du CONTENU (sans l'horodatage) à la
 * dernière écriture réussie : si rien n'a changé, aucune requête n'est
 * envoyée. Les modifications restent sauvegardées en ~20 s (déclencheur
 * après écriture), et un battement de cœur toutes les 12 h maintient la
 * fraîcheur de la copie en ligne.
 * ---------------------------------------------------------------- */
const HEARTBEAT_MS = 12 * 60 * 60 * 1000;
let lastPutHash = null;
let lastPutAt = 0;
let lastSkipAt = 0;

/**
 * Empreinte stable du contenu sauvegardable.
 *
 * Deux pièges à éviter, tous deux rencontrés le 20/10/2026 :
 *  1. L'horodatage (savedAt) change à chaque appel → exclu.
 *  2. Les jetons sont chiffrés avec un NONCE ALÉATOIRE : le texte chiffré
 *     diffère à chaque fois, même pour un jeton identique. Comparer le
 *     chiffré revenait à écrire à chaque cycle. On compare donc une
 *     empreinte du jeton EN CLAIR (qui ne quitte jamais le serveur).
 *  3. « syncedAt » n'est qu'un horodatage de cache (remis à jour à chaque
 *     consultation d'une galerie) : l'exclure évite une réécriture par visite.
 */
function tokenFingerprint(tok) {
  const rt = tok && tok.refresh_token;
  return rt ? crypto.createHash('sha256').update('rt:' + rt).digest('hex').slice(0, 32) : null;
}

function contentHash(payloadStr) {
  let o;
  try { o = JSON.parse(payloadStr); } catch { return null; }
  const galleries = (o.galleries || []).map((g) => {
    const copy = { ...g };
    delete copy.syncedAt;
    return copy;
  });
  const canonical = JSON.stringify({
    config: o.config,
    galleries,
    driveToken: o.driveToken,   // déjà une empreinte (voir buildProbe)
    mailToken: o.mailToken,
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/** Contenu « à comparer » : comme buildPayload, mais jetons remplacés par
 *  leur empreinte et sans horodatage. */
function buildProbe() {
  return JSON.stringify({
    config: store.config(),
    galleries: store.galleries(),
    driveToken: tokenFingerprint(store.tokens()),
    mailToken: tokenFingerprint(store.tokensMail()),
  });
}

async function assessAgainstRemote(local, force) {
  if (force) return { allow: true, remote: null, forced: true };

  const cacheFresh = () => remoteCache.stats && (Date.now() - remoteCache.at) < 60 * 60 * 1000;

  let entry;
  try {
    entry = await githubGetEntry();
  } catch (e) {
    return transportFallback(local, e);
  }
  if (!entry) return { allow: true, remote: null, first: true }; // première sauvegarde

  // Empreinte inchangée depuis la dernière lecture : inutile de retélécharger
  // 1,2 Mo toutes les 5 minutes (moins d'appels, donc moins d'occasions
  // d'être coupé en plein transfert).
  let remote;
  if (remoteCache.sha && entry.sha === remoteCache.sha && remoteCache.stats) {
    remote = remoteCache.stats;
  } else {
    try {
      const text = await readEntryText(entry);
      if (!text) throw new Error('contenu vide');
      remote = statsOf(JSON.parse(text));
      remoteCache = { sha: entry.sha, stats: remote, at: Date.now() };
    } catch (e) {
      // Contenu réellement illisible (200 avec contenu vide, JSON cassé) :
      // là, on ne peut PAS vérifier ce qu'on écraserait → refus.
      if (!/JSON|contenu vide/i.test(String(e.message))) return transportFallback(local, e);
      return { allow: false, remote: null, transport: false, reason: 'sauvegarde distante illisible (' + netLabel(e) + ') — écriture annulée par précaution' };
    }
  }

  return compare(local, remote);
}

/** Écriture autorisée malgré une lecture impossible ? (coupure réseau) */
function transportFallback(local, err) {
  const cached = remoteCache.stats;
  const ageMin = cached ? Math.round((Date.now() - remoteCache.at) / 60000) : null;
  if (cached && localTrusted && local.galleries >= cached.galleries && (Date.now() - remoteCache.at) < 60 * 60 * 1000) {
    console.warn('[backup] Lecture distante indisponible (' + netLabel(err) + ') mais état local cohérent : ' +
      local.galleries + ' galerie(s) ≥ ' + cached.galleries + ' de la dernière lecture (il y a ' + ageMin + ' min) → écriture autorisée.');
    return { allow: true, remote: cached, transport: true };
  }
  return {
    allow: false,
    remote: cached || null,
    transport: true,
    reason: 'lecture de la sauvegarde impossible (' + netLabel(err) + ')' +
      (cached ? ' ; dernière lecture il y a ' + ageMin + ' min' : ' ; aucune lecture récente') +
      ' — écriture annulée par précaution',
  };
}

/** Comparaison stricte : l'état local peut-il remplacer la sauvegarde ? */
function compare(local, remote) {
  if (!localTrusted) {
    return {
      allow: false,
      remote,
      transport: false,
      reason: 'restauration du démarrage impossible : la sauvegarde (' + remote.galleries + ' galerie(s), ' + remote.photos + ' photos) serait écrasée par ' + local.galleries + ' galerie(s) locale(s)',
    };
  }
  if (remote.galleries >= 2 && local.galleries < remote.galleries) {
    const catastrophic = local.galleries <= 1 || local.galleries < Math.ceil(remote.galleries * 0.6);
    if (catastrophic) {
      return {
        allow: false,
        remote,
        transport: false,
        reason: 'chute brutale : ' + local.galleries + ' galerie(s) locale(s) contre ' + remote.galleries + ' dans la sauvegarde (suppression massive ou remise à zéro ?)',
      };
    }
  }
  return { allow: true, remote };
}

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
      const local = statsOf({ galleries: store.galleries() });

      // 0) Économie de bande passante : si le contenu n'a pas changé depuis
      //    la dernière écriture réussie, ne rien envoyer du tout.
      const probeHash = contentHash(buildProbe());
      const fresh = (Date.now() - lastPutAt) < HEARTBEAT_MS;
      if (!force && probeHash && probeHash === lastPutHash && fresh) {
        lastSkipAt = Date.now();
        return { ok: true, unchanged: true, at: new Date(lastPutAt).toISOString(), reason: 'aucune modification — rien à envoyer' };
      }

      // 1) Le garde-fou décide AVANT de construire le contenu à écrire.
      const verdict = await assessAgainstRemote(local, force);
      if (!verdict.allow) {
        refusalStreak += 1;
        lastRefusal = { at: new Date().toISOString(), reason: verdict.reason, local, remote: verdict.remote || null, streak: refusalStreak };
        console.warn('[backup] ÉCRITURE REFUSÉE (' + refusalStreak + ' d\'affilée) — ' + verdict.reason);
        // Ne déranger le photographe qu'à partir de 3 refus consécutifs (~15 min).
        // Une coupure de 20 secondes pendant un redémarrage ne doit pas
        // déclencher un e-mail alarmant : le cycle suivant suffit.
        if (refusalStreak >= 3) await alertRefusal(verdict, local);
        return { ok: false, refused: true, reason: verdict.reason, streak: refusalStreak };
      }
      // Retour à la normale après un blocage : le dire, une fois.
      if (refusalStreak > 0) {
        const n = refusalStreak;
        refusalStreak = 0;
        lastRefusal = null;
        alertOnce(
          '✓ Sauvegarde de nouveau normale (Mews Studio Galleries)',
          [
            'Bonjour,',
            '',
            'La sauvegarde automatique de Mews Studio Galleries fonctionne de nouveau.',
            '',
            'Le blocage précédent (' + n + ' tentative' + (n > 1 ? 's' : '') + ') est levé : la sauvegarde en ligne est à jour.',
            'État actuel : ' + local.galleries + ' galerie(s), ' + local.photos + ' photos.',
            '',
            'Aucune action de votre part. Ce message est envoyé une seule fois.',
            '',
            '— Mews Studio Galleries (message automatique)',
          ].join('\n'),
        ).catch(() => {});
      }

      if (force) localTrusted = true;

      // 2) Écriture, en mémorisant l'état précédent dans la sauvegarde.
      const payload = buildPayload(verdict.remote);
      const putRes = await githubPut(payload);
      lastPutHash = contentHash(buildProbe());
      lastPutAt = Date.now();
      lastRefusal = null;
      // L'empreinte du nouveau contenu est connue : le prochain contrôle
      // n'aura pas à retélécharger le fichier.
      remoteCache = {
        sha: (putRes && putRes.content && putRes.content.sha) || null,
        stats: statsOf(JSON.parse(payload)),
        at: Date.now(),
      };
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
  // Dernière activité de sauvegarde = écriture réelle OU vérification
  // « rien à envoyer » (l'une comme l'autre prouve que le mécanisme vit).
  lastActivityAt: () => Math.max(lastPutAt, lastSkipAt) || null,
  lastPutAt: () => lastPutAt || null,
  backupStore,
  githubConfigured,
  // Garde-fou anti-écrasement (état exposé à l'admin et au bilan de santé).
  localTrusted: () => localTrusted,
  lastRefusal: () => lastRefusal,
  statsOf,
  notifyDegraded,
  keyMode,
};
