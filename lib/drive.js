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
const { tokens, saveTokens } = require('./store');

/** Base de l'API Google (surchargée par GOOGLE_API_BASE pour les tests). */
function apiBase() { return process.env.GOOGLE_API_BASE || 'https://www.googleapis.com'; }
/** URL d'échange des jetons OAuth (surchargée par GOOGLE_TOKEN_URL pour les tests). */
function tokenUrl() { return process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token'; }
/** URL d'autorisation OAuth (surchargée par GOOGLE_AUTH_URL pour les tests). */
function authUrlBase() { return process.env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth'; }

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
  // Envoi d'e-mails depuis le compte du photographe (API Gmail) — mode de
  // notification « Gmail » : fonctionne sur Render gratuit (HTTPS, aucun
  // port SMTP) et envoie depuis l'adresse Gmail du photographe.
  'https://www.googleapis.com/auth/gmail.send',
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
  const res = await fetch(tokenUrl(), {
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
  return authUrlBase() + '?' + params.toString();
}

async function exchangeCode(code) {
  const res = await fetch(tokenUrl(), {
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
  const res = await fetch(tokenUrl(), {
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
  let res = await fetch(apiBase() + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  if (res.status === 401) {
    // Le jeton a pu expirer entre-temps : on rafraîchit puis on réessaie.
    const refreshed = await refreshToken();
    if (refreshed) {
      res = await fetch(apiBase() + path, {
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
  const url = apiBase() + '/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media';
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
    apiBase() + '/upload/drive/v3/files?uploadType=multipart&fields=id,name',
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
    apiBase() + '/drive/v3/files/' + encodeURIComponent(fileId) +
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
    apiBase() + '/drive/v3/files/' + encodeURIComponent(fileId) +
    '/permissions/' + encodeURIComponent(permissionId) + '?fields=id',
    { method: 'DELETE', headers: { Authorization: 'Bearer ' + token } }
  );
  return res.ok || res.status === 404;
}

/* ------------------------------------------------------------------
 * Mode « compte utilisateur » (OAuth) — nécessaire pour ÉCRIRE dans
 * le Drive : créer des dossiers, copier des fichiers, des raccourcis.
 * Le compte de service n'a pas de quota de stockage (403) ; seul le
 * compte Google du photographe peut créer/copier des fichiers.
 * ------------------------------------------------------------------ */

/** Jeton d'accès du compte UTILISATEUR (OAuth), jamais celui du compte de service. */
async function userAccessToken() {
  const t = tokens();
  if (!t || !t.refresh_token) return null;
  if (t.access_token && t.expiry && Date.now() < t.expiry - 60 * 1000) return t.access_token;
  return refreshToken();
}

/** Vrai si le compte utilisateur est connecté (refresh token présent). */
function isUserConnected() {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) return false;
  const t = tokens();
  return !!(t && t.refresh_token);
}

/**
 * Force un rafraîchissement du jeton pour vérifier que la connexion tient
 * toujours (un jeton « Testing » expire au bout de 7 jours ; un jeton d'une
 * application publiée est permanent). Renvoie false si Google refuse.
 */
async function verifyUserConnection() {
  if (!isUserConnected()) return false;
  const refreshed = await refreshToken();
  return !!refreshed;
}

/** Appel Drive authentifié avec le compte utilisateur uniquement. */
async function userApi(path, init = {}) {
  const token = await userAccessToken();
  if (!token) throw new Error('GOOGLE_USER_NOT_CONNECTED');
  let res = await fetch(apiBase() + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + token, ...(init.headers || {}) },
  });
  if (res.status === 401) {
    const refreshed = await refreshToken();
    if (refreshed) {
      res = await fetch(apiBase() + path, {
        ...init,
        headers: { Authorization: 'Bearer ' + refreshed, ...(init.headers || {}) },
      });
    }
  }
  return res;
}

/** Identité du compte utilisateur connecté. */
async function userDriveAccount() {
  try {
    const res = await userApi('/drive/v3/about?fields=user(emailAddress,displayName)');
    if (!res.ok) return null;
    const data = await res.json();
    return data.user || null;
  } catch {
    return null;
  }
}

/** Liste les dossiers visibles par le compte utilisateur. */
async function listUserFolders() {
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.folder' and trashed=false");
  const res = await userApi('/drive/v3/files?q=' + q + '&fields=files(id,name)&pageSize=1000&orderBy=name');
  if (!res.ok) throw new Error('Liste des dossiers impossible (' + res.status + ')');
  const data = await res.json();
  return data.files || [];
}

/** Crée un dossier dans le Drive du compte utilisateur. */
async function createUserFolder(name, parentId) {
  const res = await userApi('/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: parentId ? [parentId] : undefined,
    }),
  });
  if (!res.ok) throw new Error('Création du dossier « ' + name + ' » refusée (' + res.status + ')');
  return res.json();
}

/** Copie un fichier existant dans un dossier (compte utilisateur). */
async function copyUserFile(fileId, newName, parentId) {
  const res = await userApi(
    '/drive/v3/files/' + encodeURIComponent(fileId) + '/copy?fields=id,name',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName, parents: parentId ? [parentId] : undefined }),
    }
  );
  if (!res.ok) throw new Error('Copie de « ' + newName + ' » refusée (' + res.status + ')');
  return res.json();
}

/** Crée un raccourci (0 Go) vers un fichier existant. */
async function createUserShortcut(targetId, name, parentId, targetMimeType) {
  const res = await userApi('/drive/v3/files?fields=id,name', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.shortcut',
      // Google exige les DEUX champs à la création (400 sinon).
      shortcutDetails: { targetId, targetMimeType: targetMimeType || 'image/jpeg' },
      parents: parentId ? [parentId] : undefined,
    }),
  });
  if (!res.ok) throw new Error('Raccourci « ' + name + ' » refusé (' + res.status + ')');
  return res.json();
}

/** Met un fichier/dossier à la corbeille (compte utilisateur). */
async function trashUserFile(fileId) {
  const res = await userApi('/drive/v3/files/' + encodeURIComponent(fileId), { method: 'DELETE' });
  if (!res.ok && res.status !== 404) throw new Error('Suppression impossible (' + res.status + ')');
}

module.exports = {
  isConfigured,
  isConnected,
  isServiceAccount,
  isUserConnected,
  verifyUserConnection,
  authUrl,
  exchangeCode,
  refreshToken,
  api,
  userApi,
  userAccessToken,
  driveAccount,
  userDriveAccount,
  listFolders,
  folderName,
  listSubfolders,
  listImages,
  listUserFolders,
  createUserFolder,
  copyUserFile,
  createUserShortcut,
  trashUserFile,
  fetchThumbnail,
  fetchMedia,
  uploadToFolder,
  trashFile,
  createPublicDownload,
  revokePublicDownload,
};
