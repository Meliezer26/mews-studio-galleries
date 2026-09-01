'use strict';
/**
 * Intégration Google Drive (API REST v3) — aucune dépendance externe.
 * Utilise fetch() natif de Node >= 18.
 *
 * Deux modes d'authentification :
 *  1. Compte de service (GOOGLE_SERVICE_ACCOUNT_JSON) — RECOMMANDÉ :
 *     connexion automatique par clé JSON, sans écran de consentement,
 *     sans expiration. Le photographe partage ses dossiers Drive avec
 *     l'adresse e-mail du compte de service (en « Éditeur »).
 *  2. OAuth classique (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) :
 *     bouton « Se connecter avec Google » dans l'espace photographe.
 *     Note : pour une appli non vérifiée par Google (usage personnel),
 *     le jeton de renouvellement expire tous les 7 jours et il faut
 *     re-cliquer le bouton (un bandeau le rappelle dans l'admin).
 */
const crypto = require('crypto');
const store = require('./store');
const { tokens, saveTokens } = store;

const SCOPES = [
  'https://www.googleapis.com/auth/drive.readonly', // lister, vignettes, lecture
  'https://www.googleapis.com/auth/drive.file',     // uploader dans les dossiers choisis
  // Accès complet au Drive du photographe : nécessaire uniquement pour créer
  // des liens de téléchargement TEMPORAIRES (permission "public en lecture"
  // posée puis révoquée automatiquement). Sans ce scope, les téléchargements
  // transiteraient par le serveur de l'hébergeur et consommeraient sa bande
  // passante. Avec ce scope, c'est Google qui livre le fichier au client :
  // le serveur ne transmet plus les fichiers lourds (dossiers de 8–15 Go
  // sans surcoût de bande passante).
  'https://www.googleapis.com/auth/drive',
].join(' ');

function saConfig() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return null;
  try {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  } catch {
    return null;
  }
}

function isServiceAccount() {
  return !!saConfig();
}

function isConfigured() {
  return isServiceAccount() || !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

/* --- Compte de service : jeton d'accès par JWT (RS256) ------ */

let saTokenCache = { token: null, expiry: 0 };

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function jwtAccessToken() {
  const sa = saConfig();
  if (!sa || !sa.client_email || !sa.private_key) return null;
  if (saTokenCache.token && Date.now() < saTokenCache.expiry - 60 * 1000) return saTokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: SCOPES,
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }));
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(header + '.' + claims);
  const sig = signer.sign(sa.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const assertion = header + '.' + claims + '.' + sig;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  saTokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 };
  return data.access_token;
}

function redirectUri() {
  if (process.env.GOOGLE_REDIRECT_URI) return process.env.GOOGLE_REDIRECT_URI;
  if (process.env.BASE_URL) return process.env.BASE_URL.replace(/\/+$/, '') + '/oauth2callback';
  return null;
}

function authUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  return 'https://accounts.google.com/o/oauth2/v2/auth?' + params.toString();
}

async function exchangeCode(code) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(),
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error('Échange du code OAuth refusé (' + res.status + '): ' + text.slice(0, 200));
  }
  return res.json();
}

async function refreshToken() {
  const t = tokens();
  if (!t || !t.refresh_token) return null;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  t.access_token = data.access_token;
  t.expiry = Date.now() + (data.expires_in || 3600) * 1000;
  saveTokens(t);
  return t.access_token;
}

async function accessToken() {
  if (isServiceAccount()) return jwtAccessToken();
  const t = tokens();
  if (!t || !t.access_token) return null;
  if (t.expiry && Date.now() < t.expiry - 60 * 1000) return t.access_token;
  return refreshToken();
}

function isConnected() {
  if (!isConfigured()) return false;
  if (isServiceAccount()) return true; // le jeton JWT est obtenu à la demande
  return !!tokens() && !!tokens().access_token;
}

async function api(path, init = {}) {
  const token = await accessToken();
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED');
  let res = await fetch('https://www.googleapis.com' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  if (res.status === 401) {
    // Le jeton a pu expirer entre-temps : on rafraîchit puis on réessaie.
    const refreshed = await refreshToken();
    if (refreshed) {
      res = await fetch('https://www.googleapis.com' + path, {
        ...init,
        headers: { Authorization: 'Bearer ' + refreshed, ...(init.headers || {}) },
      });
    }
  }
  return res;
}

async function driveAccount() {
  if (isServiceAccount()) {
    const sa = saConfig();
    return {
      emailAddress: sa.client_email,
      displayName: 'Compte de service Google',
    };
  }
  try {
    const res = await api('/drive/v3/about?fields=user(emailAddress,displayName)');
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

async function listFolders() {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false");
  const res = await api('/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=1000&orderBy=name');
  if (!res.ok) throw new Error('Liste des dossiers Drive impossible (' + res.status + ')');
  const data = await res.json();
  return data.files || [];
}

async function folderName(folderId) {
  try {
    const res = await api('/drive/v3/files/' + encodeURIComponent(folderId) + '?fields=id,name');
    if (!res.ok) return folderId;
    const data = await res.json();
    return data.name || folderId;
  } catch {
    return folderId;
  }
}

/** Liste les sous-dossiers directs d'un dossier Drive. */
async function listSubfolders(folderId) {
  const q = encodeURIComponent(
    "'" + folderId + "' in parents and trashed=false and mimeType='application/vnd.google-apps.folder'"
  );
  const res = await api('/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=100&orderBy=name');
  if (!res.ok) throw new Error('Lecture des sous-dossiers impossible (' + res.status + ')');
  const data = await res.json();
  return data.files || [];
}

async function listImages(folderId) {
  const q = encodeURIComponent(
    "'" + folderId + "' in parents and trashed=false and mimeType contains 'image/'"
  );
  const res = await api(
    '/drive/v3/files?q=' + q +
    '&fields=files(id,name,mimeType,size,thumbnailLink,createdTime)&pageSize=1000&orderBy=name'
  );
  if (!res.ok) throw new Error('Lecture du dossier Drive impossible (' + res.status + ')');
  const data = await res.json();
  return data.files || [];
}

/** Récupère une vignette Drive (authentifiée), taille paramétrable. */
async function fetchThumbnail(thumbnailLink, size = 400) {
  const url = String(thumbnailLink).replace(/=s\d+/, '=s' + size);
  const token = await accessToken();
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED');
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } });
}

/** Récupère le fichier original (authentifié). */
async function fetchMedia(fileId) {
  const token = await accessToken();
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED');
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media';
  return fetch(url, { headers: { Authorization: 'Bearer ' + token } });
}

/** Upload d'un fichier dans un dossier Drive (multipart/related). */
async function uploadToFolder(folderId, { buffer, filename, mimeType }) {
  const token = await accessToken();
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED');
  const boundary = 'mews' + Date.now().toString(36);
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  const res = await fetch(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name',
    {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'multipart/related; boundary=' + boundary,
      },
      body,
    }
  );
  if (!res.ok) throw new Error('Upload Drive échoué (' + res.status + ')');
  return res.json();
}

/** Déplace un fichier Drive vers la corbeille. */
async function trashFile(fileId) {
  const res = await api('/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error('Suppression Drive impossible (' + res.status + ')');
}

/**
 * Crée un lien de téléchargement public TEMPORAIRE pour un fichier Drive.
 * - pose une permission « anyone/lecteur » (public avec le lien),
 * - renvoie l'URL directe de téléchargement chez Google (le fichier est
 *   livré par les serveurs de Google, pas par le nôtre),
 * - la permission doit être révoquée ensuite (voir revokePublicDownload).
 */
async function createPublicDownload(fileId) {
  const token = await accessToken();
  if (!token) throw new Error('GOOGLE_NOT_CONNECTED');
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '/permissions?sendNotificationEmail=false&fields=id,type,role',
    {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'anyone', role: 'reader' }),
    }
  );
  if (!res.ok) throw new Error('Permission refusée (' + res.status + ')');
  const perm = await res.json();
  return {
    permissionId: perm.id,
    url: 'https://drive.usercontent.google.com/download?id=' +
      encodeURIComponent(fileId) + '&export=download',
  };
}

/** Révoque le lien public temporaire d'un fichier (supprime la permission). */
async function revokePublicDownload(fileId, permissionId) {
  if (!fileId || !permissionId) return false;
  const token = await accessToken();
  if (!token) return false;
  const res = await fetch(
    'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) +
    '/permissions/' + encodeURIComponent(permissionId) + '?fields=id',
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
  );
  return res.ok || res.status === 404;
}

/* ----------------------------------------------------------------
 * Tri automatique des sélections (compte Google du photographe).
 *
 * Le compte de service ne peut PAS créer de fichiers (pas de quota) :
 * le tri est donc effectué avec le jeton OAuth du photographe
 * (bouton « Se connecter avec Google » de l'espace photographe),
 * qui, lui, possède son quota personnel. Les deux modes coexistent :
 * le compte de service lit les galeries, le compte OAuth écrit les
 * dossiers triés.
 * ---------------------------------------------------------------- */

let oauthTokenCache = { token: null, expiry: 0 };

/** Jeton d'accès du COMPTE OAuth (photographe), indépendant du compte de service. */
async function oauthAccessToken() {
  const t = tokens();
  if (!t || !t.refresh_token) return null;
  if (oauthTokenCache.token && Date.now() < oauthTokenCache.expiry - 60 * 1000) return oauthTokenCache.token;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: t.refresh_token,
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) return null;
  const data = await res.json();
  oauthTokenCache = { token: data.access_token, expiry: Date.now() + (data.expires_in || 3600) * 1000 };
  return oauthTokenCache.token;
}

function isOauthSortReady() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && tokens() && tokens().refresh_token);
}

async function oauthApi(path, init = {}) {
  const token = await oauthAccessToken();
  if (!token) throw new Error('GOOGLE_OAUTH_NOT_CONNECTED');
  return fetch('https://www.googleapis.com' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
}

function jsonInit(obj) {
  return { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

async function oauthFindFolder(name, parentId) {
  const q = "name='" + name.replace(/'/g, "\\'") + "' and mimeType='application/vnd.google-apps.folder' and trashed=false";
  const res = await oauthApi('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,modifiedTime)&pageSize=10');
  if (!res.ok) throw new Error('recherche de dossier Drive impossible (' + res.status + ')');
  const data = await res.json();
  const list = data.files || [];
  if (!parentId) return list[0] || null;
  // Vérifie le parent (un nom peut exister à plusieurs endroits)
  for (const f of list) {
    const r2 = await oauthApi('/drive/v3/files/' + f.id + '?fields=parents');
    const d2 = await r2.json();
    if ((d2.parents || []).includes(parentId)) return f;
  }
  return null;
}

async function oauthCreateFolder(name, parentId) {
  const res = await oauthApi('/drive/v3/files?fields=id,name', {
    method: 'POST',
    ...jsonInit({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  if (!res.ok) throw new Error('création du dossier Drive impossible (' + res.status + ')');
  return res.json();
}

async function oauthListFolderFiles(folderId) {
  const q = "'" + folderId + "' in parents and trashed=false";
  const res = await oauthApi('/drive/v3/files?q=' + encodeURIComponent(q) + '&fields=files(id,name,mimeType,modifiedTime)&pageSize=500');
  if (!res.ok) throw new Error('lecture du dossier Drive impossible (' + res.status + ')');
  return ((await res.json()).files || []).map((f) => ({ id: f.id, name: f.name, mimeType: f.mimeType, modifiedTime: f.modifiedTime }));
}

async function oauthCopyFile(fileId, name, folderId) {
  const res = await oauthApi('/drive/v3/files/' + encodeURIComponent(fileId) + '/copy?fields=id,name', {
    method: 'POST',
    ...jsonInit({ name, parents: [folderId] }),
  });
  if (!res.ok) throw new Error('copie Drive impossible (' + res.status + ')');
  return res.json();
}

async function oauthCreateShortcut(fileId, name, folderId) {
  const res = await oauthApi('/drive/v3/files?fields=id,name', {
    method: 'POST',
    ...jsonInit({
      name,
      mimeType: 'application/vnd.google-apps.shortcut',
      parents: [folderId],
      shortcutDetails: { targetId: fileId },
    }),
  });
  if (!res.ok) throw new Error('raccourci Drive impossible (' + res.status + ')');
  return res.json();
}

async function oauthDeleteFile(fileId) {
  const res = await oauthApi('/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error('suppression Drive impossible (' + res.status + ')');
  return true;
}

/** Nom unique dans un dossier (gère les doublons de noms de fichiers). */
function uniqueNames(wanted) {
  const seen = {};
  return wanted.map((w) => {
    const base = w.name;
    const n = seen[base] = (seen[base] || 0) + 1;
    return { id: w.id, name: n === 1 ? base : base + ' — ' + String(w.id).slice(0, 6) };
  });
}

/**
 * Applique une sélection d'albums sur le Drive du photographe :
 * crée « Sélections / Sélection — <galerie> / Album N photos » et y
 * place une copie (ou un raccourci) de chaque photo choisie. Le dossier
 * de la galerie est synchronisé avec la DERNIÈRE sélection reçue.
 */
async function sortSelectionToDrive(gallery, albums) {
  const cfg = store.config().driveSort || {};
  if (!cfg.enabled) return { skipped: true, reason: 'Tri automatique désactivé dans les réglages.' };
  if (!isOauthSortReady()) {
    return { skipped: true, reason: 'Compte Google du photographe non connecté (bouton « Se connecter avec Google »).' };
  }
  const mode = cfg.mode === 'shortcut' ? 'shortcut' : 'copy';
  const parentId = cfg.parentFolderId || null;

  const root = await oauthFindFolder('Sélections', parentId) || await oauthCreateFolder('Sélections', parentId);
  const galName = 'Sélection — ' + (gallery.name || gallery.slug);
  let gFolder = await oauthFindFolder(galName, root.id);
  if (!gFolder) gFolder = await oauthCreateFolder(galName, root.id);

  const result = { ok: true, folderId: gFolder.id, folderUrl: 'https://drive.google.com/drive/folders/' + gFolder.id, albums: {} };

  for (const album of albums || []) {
    if (!album.photoIds || !album.photoIds.length) continue;
    const label = 'Album ' + album.typeId + ' photos';
    let aFolder = await oauthFindFolder(label, gFolder.id);
    if (!aFolder) aFolder = await oauthCreateFolder(label, gFolder.id);

    const wanted = uniqueNames(
      album.photoIds
        .map((id) => (gallery.files || []).find((f) => f.id === id))
        .filter(Boolean)
        .map((f) => ({ id: f.id, name: f.name }))
    );
    if (!wanted.length) continue;

    const existing = await oauthListFolderFiles(aFolder.id);
    const wantedNames = new Set(wanted.map((w) => w.name));
    let added = 0, removed = 0, errors = 0;

    // Retire les fichiers qui ne sont plus dans la sélection (mise à jour)
    for (const e of existing) {
      if (wantedNames.has(e.name)) continue;
      try { await oauthDeleteFile(e.id); removed++; } catch { errors++; }
    }
    // Ajoute les fichiers manquants
    const have = new Set(existing.map((e) => e.name));
    for (const w of wanted) {
      if (have.has(w.name)) continue;
      try {
        if (mode === 'shortcut') await oauthCreateShortcut(w.id, w.name, aFolder.id);
        else await oauthCopyFile(w.id, w.name, aFolder.id);
        added++;
      } catch { errors++; }
    }
    result.albums[album.typeId] = { label, folderId: aFolder.id, added, removed, errors };
  }
  return result;
}

/** Supprime les dossiers de sélection plus vieux que cleanupDays jours. */
async function cleanupOldSelections() {
  try {
    const cfg = store.config().driveSort || {};
    const days = Number(cfg.cleanupDays);
    if (!cfg.enabled || !days || days <= 0) return null;
    if (!isOauthSortReady()) return null;
    const root = await oauthFindFolder('Sélections', cfg.parentFolderId || null);
    if (!root) return null;
    const subs = await oauthListFolderFiles(root.id);
    const limit = Date.now() - days * 86400000;
    let removed = 0;
    for (const f of subs) {
      if (f.mimeType !== 'application/vnd.google-apps.folder') continue;
      if (!f.modifiedTime || new Date(f.modifiedTime).getTime() > limit) continue;
      await oauthDeleteFile(f.id);
      removed++;
    }
    return { removed };
  } catch {
    return null;
  }
}

module.exports = {
  isConfigured,
  isConnected,
  isServiceAccount,
  isOauthSortReady,
  authUrl,
  exchangeCode,
  refreshToken,
  api,
  driveAccount,
  listFolders,
  folderName,
  listSubfolders,
  listImages,
  fetchThumbnail,
  fetchMedia,
  uploadToFolder,
  trashFile,
  createPublicDownload,
  revokePublicDownload,
  sortSelectionToDrive,
  cleanupOldSelections,
};
