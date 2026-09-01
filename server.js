'use strict';
/**
 * Mews Studio Galleries — serveur
 * Galeries privées clients connectées à Google Drive.
 *
 * Mode démo (par défaut) : photos stockées localement, tout fonctionne.
 * Mode réel : renseignez GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET (.env),
 * puis connectez votre compte Google Drive depuis l'espace photographe.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const store = require('./lib/store');
const drive = require('./lib/drive');
const demo = require('./lib/demo');
const sec = require('./lib/security');
const mailer = require('./lib/mailer');
const backup = require('./lib/backup');
const { ALBUM_TYPES } = demo;

/* --- Chargement minimal de .env ---------------------------- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de fichier .env */ }

const PORT = process.env.PORT || 3000;
const DEMO_PHOTOS_DIR = path.join(__dirname, 'public', 'demo-photos');
const SESSION_COOKIE = 'mews_admin';
const UNLOCK_COOKIE = 'mews_unlocks';
const SESSION_MAX_AGE = 7 * 24 * 3600 * 1000;
const UNLOCK_MAX_AGE = 30 * 24 * 3600 * 1000;
const SYNC_TTL = 5 * 60 * 1000; // re-synchronisation Drive auto après 5 min

store.ensureDirs();
/* Ordre important : restaurer d'abord (si le disque a été réinitialisé),
 * puis seulement amorcer la démo. Sinon la démo recréée masquerait la
 * restauration des vraies galeries. */
(async () => {
  try {
    const r = await backup.restoreIfNeeded();
    if (r.restored) {
      console.log('[backup] Données restaurées (sauvegarde du ' + (r.savedAt || '?') + ') : ' + r.reason);
    } else {
      console.log('[backup] Restauration non nécessaire ou impossible : ' + r.reason);
    }
  } catch (err) {
    console.warn('[backup] Erreur de restauration :', err.message);
  }
  demo.seed();
  backup.cleanupExpiredGrants().catch(() => {});
  backup.startPeriodicBackup();
  backup.now(); // sauvegarde immédiate au démarrage
})();

const app = express();
app.disable('x-powered-by');
// Derrière un proxy (nginx, plateformes cloud) : utiliser l'IP réelle du visiteur.
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 40 * 1024 * 1024, files: 30 },
  fileFilter: (req, file, cb) =>
    /^image\/(jpeg|png|webp|gif|heic|heif|avif)$/i.test(file.mimetype)
      ? cb(null, true)
      : cb(new Error('Seules les images sont acceptées')),
});

const loginLimiter = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });
const unlockLimiter = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 20 });

/* ============================================================
 *  Utilitaires
 * ============================================================ */

function secret() { return store.config().secret; }
function cookiesOf(req) { return sec.parseCookies(req.headers.cookie); }

function requireAdmin(req, res, next) {
  const token = cookiesOf(req)[SESSION_COOKIE];
  const payload = sec.unsign(token, secret(), SESSION_MAX_AGE);
  if (!payload || payload.role !== 'admin') return res.status(401).json({ error: 'non-autorisé' });
  req.admin = payload;
  next();
}

function findGallery(slug) {
  return store.galleries().find((g) => g.slug === String(slug)) || null;
}

function isExpired(g) {
  return g.expiry && Date.now() > new Date(g.expiry).getTime();
}

function galleryLocked(g) {
  return isExpired(g) || !!(g.passwordHash && g.passwordHash.length > 0);
}

function isUnlocked(req, slug) {
  const token = cookiesOf(req)[UNLOCK_COOKIE];
  const payload = sec.unsign(token, secret());
  if (!payload || !payload.slugs || !payload.slugs[slug]) return false;
  return payload.slugs[slug] > Date.now();
}

function setUnlocked(req, res, slug) {
  const existing = sec.unsign(cookiesOf(req)[UNLOCK_COOKIE], secret()) || { slugs: {} };
  existing.slugs = { ...existing.slugs, [slug]: Date.now() + UNLOCK_MAX_AGE };
  // EMBED_MODE=1 : le site est intégré dans une iframe sur un autre domaine
  // (ex. page Showit) → le cookie doit être SameSite=None; Secure (HTTPS requis).
  const sameSite = process.env.EMBED_MODE === '1' ? 'None; Secure' : 'Lax';
  res.setHeader('Set-Cookie', `${UNLOCK_COOKIE}=${sec.sign(existing, secret())}; Path=/; HttpOnly; SameSite=${sameSite}; Max-Age=${UNLOCK_MAX_AGE / 1000}`);
}

function fileRecord(gallery, fileId) {
  return (gallery.files || []).find((f) => f.id === fileId) || null;
}

function safeFileName(name) {
  const base = String(name).replace(/[/\\]/g, '_').replace(/[\u0000-\u001f]/g, '');
  return base.slice(0, 180) || 'photo';
}

function noteNotify(ok, error) {
  const cfg = store.config();
  cfg.lastNotify = { ok: !!ok, date: Date.now(), error: error ? String(error).slice(0, 200) : null };
  store.saveConfig(cfg);
}

/** Prépare le contenu d'une notification de sélection d'albums. */
function buildNotificationInfo(req, g, clientName, albums) {
  const files = g.files || [];
  return {
    galleryName: g.name,
    clientName: clientName || null,
    galleryUrl: `${req.protocol}://${req.get('host')}/g/${g.slug}`,
    albums: ALBUM_TYPES.map((t) => {
      const entry = (albums || []).find((a) => a.typeId === t.id) || { photoIds: [] };
      return {
        label: t.label,
        count: entry.photoIds.length,
        photoIds: entry.photoIds,
        photos: entry.photoIds.map((id) => {
          const idx = files.findIndex((f) => f.id === id);
          return { index: idx > -1 ? idx + 1 : null, name: idx > -1 ? files[idx].name : id };
        }),
      };
    }),
  };
}

/** Envoie la notification en arrière-plan (n'interrompt jamais la réponse). */
function notifySelection(req, g, clientName, albums) {
  if (!mailer.isConfigured()) return;
  mailer.sendSelectionNotification(buildNotificationInfo(req, g, clientName, albums))
    .then(() => noteNotify(true))
    .catch((err) => {
      console.error('[notify]', err.message);
      noteNotify(false, err.message);
    });
}

/** Tri automatique sur le Drive du photographe (jamais bloquant). */
function maybeSortSelection(g, albums, clientName) {
  const cfg = store.config();
  if (!cfg.driveSort || !cfg.driveSort.enabled) return;
  drive.sortSelectionToDrive(g, albums)
    .then((r) => {
      if (!r || r.skipped) {
        if (r && r.reason) console.log('[drive-sort] ' + r.reason);
        return;
      }
      console.log('[drive-sort] OK — ' + r.folderUrl);
      if (mailer.isConfigured()) {
        mailer.sendDriveSortNotification({
          galleryName: g.name,
          clientName: clientName || null,
          folderUrl: r.folderUrl,
          albums: r.albums,
        }).catch((err) => console.error('[drive-sort] notification impossible :', err.message));
      }
    })
    .catch((err) => console.error('[drive-sort] erreur : ' + String(err.message).slice(0, 160)));
}

function demoFilePath(gallery, rec) {
  if (rec.storage === 'demo') {
    const p = path.join(DEMO_PHOTOS_DIR, path.basename(rec.name));
    if (fs.existsSync(p)) return p;
  }
  const p = path.join(store.UPLOADS_DIR, gallery.slug, path.basename(rec.name));
  if (fs.existsSync(p)) return p;
  return null;
}

async function syncGallery(g, force) {
  if (g.mode !== 'drive' || !drive.isConnected()) return g;
  if (!force && g.syncedAt && Date.now() - g.syncedAt < SYNC_TTL) return g;
  try {
    const driveFiles = await drive.listImages(g.folderId);
    g.files = driveFiles.map((f) => ({
      id: f.id,
      name: f.name,
      size: Number(f.size) || 0,
      mime: f.mimeType || 'image/jpeg',
      storage: 'drive',
      thumb: f.thumbnailLink || null,
    }));
    g.syncedAt = Date.now();
    const all = store.galleries();
    const idx = all.findIndex((x) => x.id === g.id);
    if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  } catch (err) {
    console.error('[sync]', g.slug, err.message);
  }
  return g;
}

function publicMeta(g) {
  const files = g.files || [];
  return {
    slug: g.slug,
    name: g.name,
    clientName: g.clientName || null,
    count: files.length,
    createdAt: g.createdAt,
    expiresAt: g.expiry || null,
  };
}

/* ============================================================
 *  Routes publiques
 * ============================================================ */

app.get('/api/status', (req, res) => {
  res.json({
    name: 'Mews Studio Galleries',
    demoMode: !drive.isConfigured(),
    driveConnected: drive.isConnected(),
    version: '1.0.0',
  });
});

app.get('/g/:slug', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'gallery.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

/* --- Galerie client ---------------------------------------- */

app.get('/api/g/:slug/info', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.json({ exists: false });
  const unlocked = isUnlocked(req, req.params.slug);
  res.json({
    exists: true,
    locked: galleryLocked(g) && !unlocked,
    expired: isExpired(g),
    unlocked,
    meta: publicMeta(g),
  });
});

app.post('/api/g/:slug/unlock', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!unlockLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (isExpired(g)) return res.status(403).json({ error: 'Cette galerie a expiré.' });
  if (sec.verifyPassword(req.body.password || '', g.passwordHash)) {
    setUnlocked(req, res, req.params.slug);
    return res.json({ ok: true });
  }
  res.status(403).json({ error: 'Mot de passe incorrect.' });
});

/* --- Connexion client : le visiteur tape le mot de passe de sa galerie,
       le serveur identifie la galerie et redirige vers elle (déverrouillée). */
const connexionLimiter = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 15 });

app.get('/connexion', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connexion.html'));
});

app.post('/api/connexion', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!connexionLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const password = String(req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'Veuillez saisir votre mot de passe.' });

  const matches = [];
  for (const g of store.galleries()) {
    if (g.passwordHash && !isExpired(g) && sec.verifyPassword(password, g.passwordHash)) {
      matches.push(g);
    }
    if (matches.length >= 20) break; // sécurité : on s'arrête à 20 correspondances
  }

  if (!matches.length) {
    return res.status(403).json({ error: 'Mot de passe incorrect. Vérifiez-le ou contactez votre photographe.' });
  }

  matches.forEach((g) => setUnlocked(req, res, g.slug));

  if (matches.length === 1) {
    return res.json({ ok: true, redirect: '/g/' + encodeURIComponent(matches[0].slug) });
  }
  res.json({
    ok: true,
    multiple: true,
    galleries: matches.map((g) => ({ slug: g.slug, name: g.name || g.slug }))
  });
});

app.get('/api/g/:slug/photos', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  await syncGallery(g);
  const files = (g.files || []).map((f, i) => ({
    id: f.id,
    name: f.name,
    size: f.size || 0,
    index: i,
    thumb: `/api/g/${g.slug}/photo/${encodeURIComponent(f.id)}/thumb`,
    full: `/api/g/${g.slug}/photo/${encodeURIComponent(f.id)}/thumb?size=1600`,
    download: `/api/g/${g.slug}/photo/${encodeURIComponent(f.id)}/download`,
  }));
  res.json({
    gallery: publicMeta(g),
    photos: files,
    downloads: g.downloadsEnabled !== false && store.config().globalDownloadsEnabled !== false,
    watermark: g.watermark && g.watermark.enabled
      ? { text: (g.watermark.text || 'Mews Studio').slice(0, 60) }
      : null,
    albums: g.albums && g.albums.enabled
      ? { types: ALBUM_TYPES, email: store.config().photographerEmail || '' }
      : null,
  });
});

/* --- Enregistrement d'une sélection d'albums ----------------- */

app.post('/api/g/:slug/selection', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  if (!g.albums || !g.albums.enabled) {
    return res.status(400).json({ error: 'La sélection d\u2019albums n\u2019est pas active sur cette galerie.' });
  }
  await syncGallery(g);
  const valid = new Set((g.files || []).map((f) => f.id));
  const albums = ALBUM_TYPES.map((t) => {
    const incoming = ((req.body && req.body.albums) || []).find((a) => a.typeId === t.id);
    const ids = Array.isArray(incoming && incoming.photoIds) ? incoming.photoIds : [];
    return { typeId: t.id, photoIds: ids.filter((id) => valid.has(id)).slice(0, t.capacity) };
  });
  if (albums.every((a) => a.photoIds.length === 0)) {
    return res.status(400).json({ error: 'La sélection est vide.' });
  }
  const sel = {
    id: sec.randomToken(8),
    date: Date.now(),
    name: String((req.body && req.body.name) || '').trim().slice(0, 80) || null,
    albums,
  };
  g.selections = g.selections || [];
  g.selections.unshift(sel);
  g.selections = g.selections.slice(0, 100);
  const all = store.galleries();
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  notifySelection(req, g, sel.name, albums);
  maybeSortSelection(g, albums, sel.name);
  res.json({ ok: true });
});

/* --- Comptes clients (identification + historique) ----------- */

const clientLimiter = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 30 });

function clientFromToken(req, g) {
  const token = req.headers['x-client-token'];
  if (!token) return null;
  const payload = sec.unsign(token, secret());
  if (!payload || payload.slug !== g.slug || !payload.clientId) return null;
  g.clients = g.clients || [];
  return g.clients.find((c) => c.id === payload.clientId) || null;
}

function clientPayload(c) {
  return {
    name: c.name,
    albums: c.albums || { checked: {}, photos: {} },
    selections: (c.selections || []).map((s) => ({ date: s.date, albums: s.albums })),
  };
}

function clientAlbumState(body, validIds) {
  const photos = {};
  ALBUM_TYPES.forEach((t) => {
    const ids = Array.isArray((body.photos || {})[t.id]) ? body.photos[t.id] : [];
    photos[t.id] = ids.filter((id) => validIds.has(id)).slice(0, t.capacity);
  });
  const checked = {};
  ALBUM_TYPES.forEach((t) => { checked[t.id] = !!((body.checked || {})[t.id]); });
  return { checked, photos };
}

app.post('/api/g/:slug/client/auth', async (req, res) => {
  const ip = req.ip || 'unknown';
  if (!clientLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  if (!g.albums || !g.albums.enabled) {
    return res.status(400).json({ error: 'La sélection d\u2019albums n\u2019est pas active sur cette galerie.' });
  }
  const name = String((req.body && req.body.name) || '').trim().slice(0, 60);
  const pin = String((req.body && req.body.pin) || '');
  if (name.length < 2) return res.status(400).json({ error: 'Entrez votre prénom.' });
  if (pin.length < 4) return res.status(400).json({ error: 'Le code personnel doit faire au moins 4 caractères.' });

  g.clients = g.clients || [];
  const norm = name.toLowerCase();
  let client = g.clients.find((c) => c.name.toLowerCase() === norm);
  if (client) {
    if (!sec.verifyPassword(pin, client.pinHash)) {
      return res.status(403).json({ error: 'Code personnel incorrect pour « ' + name + ' ».' });
    }
  } else {
    client = {
      id: sec.randomToken(10),
      name,
      pinHash: sec.hashPassword(pin),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      albums: { checked: {}, photos: {} },
      selections: [],
    };
    g.clients.push(client);
  }
  client.lastSeenAt = Date.now();
  const all = store.galleries();
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  const token = sec.sign({ slug: req.params.slug, clientId: client.id, iat: Date.now() }, secret());
  res.json({ ok: true, token, client: clientPayload(client) });
});

app.get('/api/g/:slug/client/me', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  const client = clientFromToken(req, g);
  if (!client) return res.status(401).json({ error: 'Non identifié.' });
  res.json({ client: clientPayload(client) });
});

app.post('/api/g/:slug/client/albums', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  const client = clientFromToken(req, g);
  if (!client) return res.status(401).json({ error: 'Non identifié.' });
  await syncGallery(g);
  const valid = new Set((g.files || []).map((f) => f.id));
  client.albums = clientAlbumState(req.body || {}, valid);
  client.lastSeenAt = Date.now();
  const all = store.galleries();
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  res.json({ ok: true });
});

app.post('/api/g/:slug/client/selection', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  const client = clientFromToken(req, g);
  if (!client) return res.status(401).json({ error: 'Non identifié.' });
  if (!g.albums || !g.albums.enabled) {
    return res.status(400).json({ error: 'La sélection d\u2019albums n\u2019est pas active sur cette galerie.' });
  }
  await syncGallery(g);
  const valid = new Set((g.files || []).map((f) => f.id));
  const albums = ALBUM_TYPES.map((t) => {
    const incoming = (((req.body || {}).albums) || []).find((a) => a.typeId === t.id);
    const ids = Array.isArray(incoming && incoming.photoIds) ? incoming.photoIds : [];
    return { typeId: t.id, photoIds: ids.filter((id) => valid.has(id)).slice(0, t.capacity) };
  });
  if (albums.every((a) => a.photoIds.length === 0)) {
    return res.status(400).json({ error: 'La sélection est vide.' });
  }
  const sel = { id: sec.randomToken(8), date: Date.now(), albums };
  client.selections = client.selections || [];
  client.selections.unshift(sel);
  client.selections = client.selections.slice(0, 50);
  client.lastSeenAt = Date.now();
  // Boîte de réception du photographe (vue admin)
  g.selections = g.selections || [];
  g.selections.unshift({ id: sel.id, date: sel.date, name: client.name, albums: sel.albums });
  g.selections = g.selections.slice(0, 100);
  const all = store.galleries();
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  notifySelection(req, g, client.name, albums);
  maybeSortSelection(g, albums, client.name);
  res.json({ ok: true });
});

/* --- Proxys photo (vignette / téléchargement) --------------- */

async function sendDriveThumb(res, rec, size) {
  try {
    const up = await drive.fetchThumbnail(rec.thumb || '', size);
    if (!up.ok) throw new Error('thumb ' + up.status);
    res.setHeader('Content-Type', up.headers.get('content-type') || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    const buf = Buffer.from(await up.arrayBuffer());
    res.end(buf);
  } catch {
    // Pas de vignette disponible (format sans aperçu, ex. RAW).
    // Pour ne pas gaspiller la bande passante, on ne proxifie l'original
    // QUE s'il est léger ; sinon on affiche un cartouche d'attente et le
    // client récupère le fichier via le bouton Télécharger (lien direct).
    if (!rec.size || Number(rec.size) <= 8 * 1024 * 1024) {
      return sendDriveMedia(res, rec);
    }
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">' +
      '<rect width="1200" height="800" fill="#14120f"/>' +
      '<g fill="#f4efe6" font-family="Georgia,serif">' +
      '<text x="600" y="380" font-size="34" text-anchor="middle">Aperçu non disponible pour ce format</text>' +
      '<text x="600" y="430" font-size="24" fill="#b57f2a" text-anchor="middle">Utilisez le bouton Télécharger pour voir la photo</text>' +
      '</g></svg>');
  }
}

async function sendDriveMedia(res, rec, asAttachment = false) {
  try {
    const up = await drive.fetchMedia(rec.id);
    if (!up.ok) return res.status(502).json({ error: 'Fichier inaccessible sur Google Drive.' });
    if (asAttachment) {
      res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeFileName(rec.name)));
    }
    res.setHeader('Content-Type', up.headers.get('content-type') || 'application/octet-stream');
    const buf = Buffer.from(await up.arrayBuffer());
    res.end(buf);
  } catch {
    res.status(502).json({ error: 'Connexion à Google Drive impossible.' });
  }
}

app.get('/api/g/:slug/photo/:fid/thumb', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  const rec = fileRecord(g, decodeURIComponent(req.params.fid));
  if (!rec) return res.status(404).json({ error: 'Photo introuvable.' });

  if (rec.storage === 'drive') {
    const size = Math.min(Math.max(parseInt(req.query.size || '400', 10) || 400, 80), 2000);
    return sendDriveThumb(res, rec, size);
  }
  const p = demoFilePath(g, rec);
  if (!p) return res.status(404).json({ error: 'Fichier local introuvable.' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(p);
});

app.get('/api/g/:slug/photo/:fid/download', async (req, res) => {
  const g = findGallery(req.params.slug);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!isUnlocked(req, req.params.slug)) {
    if (isExpired(g)) return res.status(410).json({ error: 'Galerie expirée.' });
    return res.status(403).json({ error: 'Verrouillé.' });
  }
  if (store.config().globalDownloadsEnabled === false) {
    return res.status(403).json({ error: 'Le téléchargement est désactivé pour toutes les galeries. Contactez votre photographe.' });
  }
  if (g.downloadsEnabled === false) {
    return res.status(403).json({ error: 'Le téléchargement est désactivé pour cette galerie. Contactez votre photographe.' });
  }
  const rec = fileRecord(g, decodeURIComponent(req.params.fid));
  if (!rec) return res.status(404).json({ error: 'Photo introuvable.' });

  if (rec.storage === 'drive') {
    // Mode par défaut : lien de téléchargement DIRECT chez Google (le fichier
    // est livré par les serveurs de Google — ne consomme pas la bande passante
    // de l'hébergeur). Permission publique temporaire, révoquée automatiquement
    // par le nettoyage périodique. En cas d'échec, repli sur le proxy serveur.
    if (store.config().directDownloads !== false) {
      try {
        const GRANT_TTL = 60 * 60 * 1000; // 1 heure
        const now = Date.now();
        const grants = store.grants();
        const existing = grants[rec.id];
        if (existing && existing.url && existing.until && existing.until > now + 5 * 60 * 1000) {
          return res.redirect(existing.url);
        }
        const link = await drive.createPublicDownload(rec.id);
        grants[rec.id] = {
          permissionId: link.permissionId,
          url: link.url,
          until: now + GRANT_TTL,
          grantedAt: now,
          name: rec.name || '',
        };
        store.saveGrants(grants);
        return res.redirect(link.url);
      } catch {
        /* repli : proxy serveur ci-dessous */
      }
    }
    return sendDriveMedia(res, rec, true);
  }
  const p = demoFilePath(g, rec);
  if (!p) return res.status(404).json({ error: 'Fichier local introuvable.' });
  res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(safeFileName(rec.name)));
  res.sendFile(p);
});

/* ============================================================
 *  OAuth Google Drive
 * ============================================================ */

app.get('/api/drive/connect', requireAdmin, (req, res) => {
  // Le compte de service lit les galeries ; la connexion OAuth du photographe
  // sert EN PLUS au tri automatique (le robot ne peut pas écrire sur le Drive).
  if (!drive.isConfigured() || !drive.redirectUri()) {
    return res.status(400).json({ error: 'Google OAuth non configuré (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET et BASE_URL requis). Voir SETUP.md.' });
  }
  const state = sec.randomToken(16);
  res.setHeader('Set-Cookie', `mews_oauth_state=${state}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600`);
  res.json({ url: drive.authUrl(state) });
});

app.get('/oauth2callback', async (req, res) => {
  const stateCookie = sec.parseCookies(req.headers.cookie)['mews_oauth_state'];
  if (!stateCookie || stateCookie !== req.query.state) {
    return res.status(400).send('<h2>Mews Studio — état OAuth invalide.</h2><p>Revenez dans l’espace photographe et réessayez.</p>');
  }
  if (req.query.error) {
    return res.status(400).send('<h2>Autorisation refusée.</h2><p>' + req.query.error + '</p>');
  }
  try {
    const data = await drive.exchangeCode(req.query.code);
    const account = await drive.driveAccount();
    store.saveTokens({
      access_token: data.access_token,
      refresh_token: data.refresh_token || (store.tokens() && store.tokens().refresh_token),
      expiry: Date.now() + (data.expires_in || 3600) * 1000,
      email: account ? account.emailAddress : null,
    });
    backup.now(); // première sauvegarde dès la connexion Drive
    res.setHeader('Set-Cookie', 'mews_oauth_state=; Path=/; Max-Age=0');
    res.send(`<!doctype html><html lang="fr"><meta charset="utf-8">
      <title>Connexion réussie</title>
      <body style="font-family:Georgia,serif;background:#14120f;color:#f4efe6;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center;padding:2rem">
        <h1 style="font-weight:500">Google Drive est connecté ✓</h1>
        <p>Vous pouvez fermer cet onglet et revenir à votre espace photographe.</p>
      </div></body></html>`);
  } catch (err) {
    res.status(500).send('<h2>La connexion a échoué.</h2><p>' + String(err.message).slice(0, 300) + '</p>');
  }
});

/* ============================================================
 *  Administration (session)
 * ============================================================ */

app.post('/api/admin/login', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!loginLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez dans 5 minutes.' });
  const cfg = store.config();
  if (sec.verifyPassword(req.body.password || '', cfg.adminPasswordHash)) {
    const token = sec.sign({ role: 'admin', iat: Date.now() }, secret());
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE / 1000}`);
    return res.json({ ok: true });
  }
  res.status(403).json({ error: 'Mot de passe incorrect.' });
});

app.post('/api/admin/logout', requireAdmin, (req, res) => {
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; Max-Age=0`);
  res.json({ ok: true });
});

app.post('/api/admin/password', requireAdmin, (req, res) => {
  const cfg = store.config();
  if (!sec.verifyPassword(req.body.current || '', cfg.adminPasswordHash)) {
    return res.status(403).json({ error: 'Mot de passe actuel incorrect.' });
  }
  const next = String(req.body.next || '');
  if (next.length < 6) return res.status(400).json({ error: 'Le nouveau mot de passe doit faire au moins 6 caractères.' });
  cfg.adminPasswordHash = sec.hashPassword(next);
  store.saveConfig(cfg);
  res.json({ ok: true });
});

app.post('/api/admin/drive-disconnect', requireAdmin, (req, res) => {
  store.saveTokens(null);
  res.json({ ok: true });
});

app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const cfg = store.config();
  const body = req.body || {};
  let changed = false;
  if (body.photographerEmail !== undefined) {
    const email = String(body.photographerEmail || '').trim().slice(0, 120);
    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Adresse e-mail invalide.' });
    }
    cfg.photographerEmail = email;
    changed = true;
  }
  if (body.defaultDownloadsEnabled !== undefined) {
    cfg.defaultDownloadsEnabled = !!body.defaultDownloadsEnabled;
    changed = true;
  }
  if (body.globalDownloadsEnabled !== undefined) {
    cfg.globalDownloadsEnabled = !!body.globalDownloadsEnabled;
    changed = true;
  }
  if (body.notifications !== undefined) {
    const n = body.notifications || {};
    const current = cfg.notifications || {};
    const next = {
      enabled: !!n.enabled,
      host: String(n.host || '').trim().slice(0, 120),
      port: Number(n.port) || 587,
      secure: !!n.secure,
      user: String(n.user || '').trim().slice(0, 120),
      from: String(n.from || '').trim().slice(0, 120),
      to: String(n.to || '').trim().slice(0, 120),
    };
    // Le mot de passe n'est mis à jour que s'il est renseigné
    next.pass = (typeof n.pass === 'string' && n.pass) ? n.pass.slice(0, 200) : (current.pass || '');
    cfg.notifications = next;
    changed = true;
  }
  if (body.driveSort !== undefined) {
    const s = body.driveSort || {};
    cfg.driveSort = {
      enabled: !!s.enabled,
      mode: s.mode === 'shortcut' ? 'shortcut' : 'copy',
      parentFolderId: String(s.parentFolderId || '').trim() || null,
      parentFolderName: String(s.parentFolderName || '').trim().slice(0, 200) || null,
      cleanupDays: Math.max(0, Math.min(365, Number(s.cleanupDays) || 0)),
    };
    changed = true;
  }
  if (changed) store.saveConfig(cfg);
  res.json({
    ok: true,
    photographerEmail: cfg.photographerEmail,
    defaultDownloadsEnabled: cfg.defaultDownloadsEnabled !== false,
    globalDownloadsEnabled: cfg.globalDownloadsEnabled !== false,
    notifications: {
      enabled: !!(cfg.notifications && cfg.notifications.enabled),
      host: (cfg.notifications && cfg.notifications.host) || '',
      port: (cfg.notifications && cfg.notifications.port) || 587,
      secure: !!(cfg.notifications && cfg.notifications.secure),
      user: (cfg.notifications && cfg.notifications.user) || '',
      from: (cfg.notifications && cfg.notifications.from) || '',
      to: (cfg.notifications && cfg.notifications.to) || '',
      passSet: !!(cfg.notifications && cfg.notifications.pass),
      configured: mailer.isConfigured(),
    },
    driveSort: {
      enabled: !!(cfg.driveSort && cfg.driveSort.enabled),
      mode: (cfg.driveSort && cfg.driveSort.mode) || 'copy',
      parentFolderId: (cfg.driveSort && cfg.driveSort.parentFolderId) || '',
      parentFolderName: (cfg.driveSort && cfg.driveSort.parentFolderName) || '',
      cleanupDays: (cfg.driveSort && cfg.driveSort.cleanupDays) || 0,
    },
  });
});

app.post('/api/admin/test-email', requireAdmin, async (req, res) => {
  try {
    await mailer.sendTest();
    noteNotify(true);
    res.json({ ok: true, to: mailer.recipient() });
  } catch (err) {
    noteNotify(false, err.message);
    res.status(502).json({ error: 'Envoi impossible : ' + err.message });
  }
});

app.get('/api/admin/status', requireAdmin, async (req, res) => {
  const acc = drive.isConnected() ? await drive.driveAccount() : null;
  const all = store.galleries();
  const n = store.config().notifications || {};
  res.json({
    demoMode: !drive.isConfigured(),
    driveConnected: drive.isConnected(),
    driveEmail: acc ? acc.emailAddress : null,
    driveName: acc ? acc.displayName : null,
    serviceAccount: drive.isServiceAccount(),
    oauthSortReady: drive.isOauthSortReady(),
    driveSort: store.config().driveSort || null,
    galleriesCount: all.length,
    photosCount: all.reduce((n, g) => n + (g.files ? g.files.length : 0), 0),
    photographerEmail: store.config().photographerEmail || '',
    defaultDownloadsEnabled: store.config().defaultDownloadsEnabled !== false,
    globalDownloadsEnabled: store.config().globalDownloadsEnabled !== false,
    notifications: {
      enabled: !!n.enabled,
      host: n.host || '',
      port: n.port || 587,
      secure: !!n.secure,
      user: n.user || '',
      from: n.from || '',
      to: n.to || '',
      passSet: !!n.pass,
      configured: mailer.isConfigured(),
      lastNotify: store.config().lastNotify || null,
    },
    // Sauvegarde automatique (voir lib/backup.js)
    backupEnabled: backup.backupStore() !== null,
    backupStore: backup.backupStore(),
    backupKey: drive.isServiceAccount() ? null : ((store.tokens() && store.tokens().refresh_token) || null),
    lastBackupAt: backup.lastBackupAt(),
  });
});

/* --- Sauvegarde Drive déclenchée à la demande ----------------- */
app.post('/api/admin/backup-now', requireAdmin, async (req, res) => {
  const r = await backup.now();
  res.json(r);
});

/* --- Récapitulatif des profils clients ----------------------- */

app.get('/api/admin/clients', requireAdmin, (req, res) => {
  const out = store.galleries()
    .filter((g) => g.albums && g.albums.enabled)
    .map((g) => ({
      id: g.id,
      slug: g.slug,
      name: g.name,
      clients: (g.clients || []).map((c) => ({
        name: c.name,
        createdAt: c.createdAt,
        lastSeenAt: c.lastSeenAt,
        selections: (c.selections || []).length,
        albums: c.albums || { checked: {}, photos: {} },
      })),
    }));
  res.json({ galleries: out });
});

app.get('/api/admin/drive-folders', requireAdmin, async (req, res) => {
  if (!drive.isConnected()) return res.json({ folders: [], error: 'Google Drive non connecté.' });
  try {
    const folders = await drive.listFolders();
    res.json({ folders });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* --- CRUD galeries ----------------------------------------- */

app.get('/api/admin/galleries/:id/photo/:fid/thumb', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  await syncGallery(g);
  const rec = fileRecord(g, decodeURIComponent(req.params.fid));
  if (!rec) return res.status(404).json({ error: 'Photo introuvable.' });
  if (rec.storage === 'drive') {
    const size = Math.min(Math.max(parseInt(req.query.size || '400', 10) || 400, 80), 2000);
    return sendDriveThumb(res, rec, size);
  }
  const p = demoFilePath(g, rec);
  if (!p) return res.status(404).json({ error: 'Fichier local introuvable.' });
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(p);
});

app.get('/api/admin/galleries', requireAdmin, (req, res) => {
  const all = store.galleries().map((g) => ({
    id: g.id,
    slug: g.slug,
    name: g.name,
    clientName: g.clientName,
    mode: g.mode,
    folderName: g.folderName,
    count: (g.files || []).length,
    createdAt: g.createdAt,
    expiry: g.expiry || null,
    url: '/g/' + g.slug,
    downloadsEnabled: g.downloadsEnabled !== false,
    albumsEnabled: !!(g.albums && g.albums.enabled),
    clientsCount: (g.clients || []).length,
    cover: g.files && g.files.length
      ? `/api/admin/galleries/${g.id}/photo/${encodeURIComponent(g.files[0].id)}/thumb?size=400`
      : null,
  }));
  res.json({ galleries: all });
});

app.post('/api/admin/galleries', requireAdmin, (req, res) => {
  const body = req.body || {};
  const name = String(body.name || '').trim();
  const password = String(body.password || '');
  if (!name) return res.status(400).json({ error: 'Le nom de la galerie est obligatoire.' });
  if (password.length < 4) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères.' });

  let slug = String(body.slug || '').trim().toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  if (!slug) {
    slug = name.toLowerCase()
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
  }
  if (!slug) slug = 'galerie-' + Date.now().toString(36);

  const all = store.galleries();
  if (all.some((g) => g.slug === slug)) {
    return res.status(400).json({ error: 'Ce lien est déjà pris, choisissez-en un autre.' });
  }

  const mode = body.mode === 'demo' || !drive.isConnected() ? 'demo' : 'drive';
  const folderId = mode === 'drive' ? String(body.folderId || '').trim() : null;
  if (mode === 'drive' && !folderId) {
    return res.status(400).json({ error: 'Choisissez un dossier Google Drive.' });
  }

  const gallery = {
    id: sec.randomToken(12),
    slug,
    name,
    clientName: String(body.clientName || '').trim() || null,
    passwordHash: sec.hashPassword(password),
    mode,
    folderId,
    folderName: body.folderName || (mode === 'demo' ? 'Photos locales (mode démo)' : folderId),
    createdAt: Date.now(),
    expiry: body.expiry ? new Date(body.expiry).getTime() : null,
    syncedAt: 0,
    files: [],
    downloadsEnabled: body.downloadsEnabled !== undefined
      ? !!body.downloadsEnabled
      : store.config().defaultDownloadsEnabled !== false,
    watermark: {
      enabled: !!body.watermarkEnabled,
      text: String(body.watermarkText || 'Mews Studio').trim().slice(0, 60),
    },
    albums: { enabled: !!body.albumsEnabled },
    selections: [],
  };
  all.push(gallery);
  store.saveGalleries(all);

  if (mode === 'drive') {
    syncGallery(gallery, true).then(() => {
      const g2 = store.galleries().find((x) => x.id === gallery.id);
      if (g2) gallery.files = g2.files;
    });
  }
  const { passwordHash, ...safeGallery } = gallery;
  res.status(201).json({ gallery: { ...safeGallery, url: '/g/' + slug } });
});

app.get('/api/admin/galleries/:id', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  await syncGallery(g);
  const { passwordHash, ...safeGallery } = g;
  if (Array.isArray(safeGallery.clients)) {
    safeGallery.clients = safeGallery.clients.map((c) => {
      const { pinHash, ...rest } = c;
      return rest;
    });
  }
  res.json({ gallery: safeGallery });
});

app.post('/api/admin/galleries/:id/update', requireAdmin, (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const body = req.body || {};

  if (body.name !== undefined) {
    const name = String(body.name || '').trim();
    if (!name) return res.status(400).json({ error: 'Le nom de la galerie est obligatoire.' });
    g.name = name;
  }
  if (body.clientName !== undefined) g.clientName = String(body.clientName || '').trim() || null;
  if (body.password !== undefined && body.password !== '') {
    if (String(body.password).length < 4) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères.' });
    g.passwordHash = sec.hashPassword(String(body.password));
  }
  if (body.expiry !== undefined) g.expiry = body.expiry ? new Date(body.expiry).getTime() : null;
  if (body.watermarkEnabled !== undefined) {
    g.watermark = {
      enabled: !!body.watermarkEnabled,
      text: String(body.watermarkText || g.watermark?.text || 'Mews Studio').trim().slice(0, 60),
    };
  }
  if (body.albumsEnabled !== undefined) {
    g.albums = { ...(g.albums || {}), enabled: !!body.albumsEnabled };
  }
  if (body.downloadsEnabled !== undefined) {
    g.downloadsEnabled = !!body.downloadsEnabled;
  }
  if (body.folderId !== undefined && body.folderId !== '') {
    g.mode = 'drive';
    g.folderId = String(body.folderId);
    if (body.folderName !== undefined) g.folderName = String(body.folderName);
    g.files = g.files || [];
    g.syncedAt = 0; // force la re-synchronisation immédiate du nouveau dossier
  }
  store.saveGalleries(all);
  res.json({ ok: true });
});

app.post('/api/admin/galleries/:id/sync', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (g.mode !== 'drive') return res.status(400).json({ error: 'La synchronisation concerne les galeries Drive.' });
  await syncGallery(g, true);
  let hint = null;
  if (!g.files.length) {
    try {
      const subs = await drive.listSubfolders(g.folderId);
      if (subs.length) {
        hint = 'Ce dossier ne contient pas de photos directement, mais ' + subs.length +
          ' sous-dossier(s) : « ' + subs.slice(0, 3).map((f) => f.name).join(' », « ') + ' ». ' +
          'Liez plutôt la galerie à un sous-dossier contenant les photos (Modifier la galerie → Dossier Google Drive).';
      }
    } catch { /* pas de diagnostic */ }
  }
  res.json({ ok: true, count: g.files.length, hint });
});

/* Tri automatique : applique (ou réapplique) une sélection sur le Drive */
app.post('/api/admin/galleries/:id/apply-drive-sort', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const selectionId = String((req.body || {}).selectionId || '').trim();
  const sel = selectionId
    ? (g.selections || []).find((s) => s.id === selectionId)
    : (g.selections || [])[0];
  if (!sel) return res.status(400).json({ error: 'Aucune sélection enregistrée pour cette galerie.' });
  try {
    const r = await drive.sortSelectionToDrive(g, sel.albums);
    if (r && r.skipped) return res.json({ ok: false, reason: r.reason });
    return res.json({ ok: true, ...r });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err.message).slice(0, 200) });
  }
});

app.post('/api/admin/galleries/:id/upload', requireAdmin, upload.array('photos', 30), async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'Aucun fichier reçu.' });

  const results = [];
  for (const f of req.files) {
    const name = safeFileName(f.originalname);
    if (g.mode === 'drive') {
      try {
        await drive.uploadToFolder(g.folderId, { buffer: f.buffer, filename: name, mimeType: f.mimetype });
        results.push({ name, ok: true });
      } catch (err) {
        results.push({ name, ok: false, error: err.message });
      }
    } else {
      const dir = path.join(store.UPLOADS_DIR, g.slug);
      fs.mkdirSync(dir, { recursive: true });
      let finalName = name;
      let n = 1;
      while (fs.existsSync(path.join(dir, finalName))) {
        const dot = name.lastIndexOf('.');
        finalName = dot > 0 ? `${name.slice(0, dot)}-${n}${name.slice(dot)}` : `${name}-${n}`;
        n++;
      }
      fs.writeFileSync(path.join(dir, finalName), f.buffer);
      g.files.push({ id: finalName, name: finalName, size: f.size, mime: f.mimetype, storage: 'uploads' });
      results.push({ name, ok: true });
    }
  }

  if (g.mode === 'drive') {
    await syncGallery(g, true);
  } else {
    g.syncedAt = Date.now();
    store.saveGalleries(all);
  }
  res.json({ ok: true, results, count: g.files.length });
});

app.post('/api/admin/galleries/:id/photo/:fid/delete', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const fid = decodeURIComponent(req.params.fid);
  const rec = fileRecord(g, fid);
  if (!rec) return res.status(404).json({ error: 'Photo introuvable.' });

  if (rec.storage === 'drive') {
    try { await drive.trashFile(rec.id); } catch (err) { return res.status(502).json({ error: err.message }); }
    await syncGallery(g, true);
  } else {
    const p = demoFilePath(g, rec);
    if (p) { try { fs.unlinkSync(p); } catch { /* déjà absent */ } }
    g.files = g.files.filter((f) => f.id !== fid);
    store.saveGalleries(all);
  }
  res.json({ ok: true });
});

app.delete('/api/admin/galleries/:id', requireAdmin, (req, res) => {
  let all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  all = all.filter((x) => x.id !== g.id);
  store.saveGalleries(all);
  if (g.mode === 'demo') {
    fs.rmSync(path.join(store.UPLOADS_DIR, g.slug), { recursive: true, force: true });
  }
  res.json({ ok: true });
});

/* --- Erreurs ------------------------------------------------ */
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 400).json({ error: err.message || 'Erreur inattendue.' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Mews Studio Galleries démarré sur le port ' + PORT);
  console.log('Mode :', drive.isConfigured() ? 'Google Drive (réel)' : 'démo (photos locales)');
  console.log('Démo  : /g/demo  (mot de passe : demo123)');
  console.log('Admin : /admin   (mot de passe : ' + (process.env.ADMIN_PASSWORD ? 'celui du .env' : 'admin123') + ')');
});
