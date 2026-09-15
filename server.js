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

/* --- Chargement minimal de .env (AVANT les autres modules,
 * car certains lisent process.env au moment du require) ----- */
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* pas de fichier .env */ }

const express = require('express');
const multer = require('multer');

const store = require('./lib/store');
const drive = require('./lib/drive');
const demo = require('./lib/demo');
const sec = require('./lib/security');
const mailer = require('./lib/mailer');
const backup = require('./lib/backup');
const driveSort = require('./lib/drive-sort');
const { PACKAGE_DEFS, packageCapacity, packageLabel, sanitizePackages } = require('./lib/packages');
const { ALBUM_TYPES } = demo;

/** Formats d'albums génériques (rétro-compat pour les galeries créées
    avant les packages : « Album 200 photos » etc.). */
function galleryAlbumTypes(g) {
  if (!g || !g.albums || !Array.isArray(g.albums.types) || !g.albums.types.length) return ALBUM_TYPES;
  return ALBUM_TYPES.filter((t) => g.albums.types.includes(t.id));
}

/** Tous les formats sélectionnables côté client : UNE CARTE PAR PACKAGE
    VENDU, avec son descriptif exact (ex : « Album 30×60 — 150 photos »).
    Capacité d'un album = nombre de photos du package ; capacité d'un
    poster/agrandissement = quantité commandée (2 posters → 2 photos). */
function allSelectableTypes(g) {
  const pk = (g && g.packages) || {};
  const out = [];
  for (const def of PACKAGE_DEFS) {
    if (def.type === 'check') {
      if (pk[def.id]) {
        out.push({ id: def.id, label: def.label, capacity: packageCapacity(def.id), print: false });
      }
    } else if (Number(pk[def.id]) > 0) {
      out.push({ id: def.id, label: def.label, capacity: Math.min(999, Number(pk[def.id])), print: true });
    }
  }
  // Rétro-compat : galerie sans aucun package → formats génériques d'albums.
  if (!out.length) return galleryAlbumTypes(g);
  return out;
}

/** Nettoie la liste des formats envoyée par l'admin (ids valides, pas de doublons). */
function sanitizeAlbumTypes(input) {
  const list = Array.isArray(input) ? input : [];
  const out = [];
  ALBUM_TYPES.forEach((t) => { if (list.includes(t.id) && out.indexOf(t.id) === -1) out.push(t.id); });
  return out;
}

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
  // Ré-hydrate le jeton OAuth du compte utilisateur (disque éphémère).
  try {
    const t = store.tokens() || {};
    const cfg = store.config();
    if (!t.refresh_token && (cfg.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN)) {
      t.refresh_token = cfg.googleRefreshToken || process.env.GOOGLE_REFRESH_TOKEN;
      if (t.refresh_token) store.saveTokens(t);
    }
    // Le jeton ne doit plus rester dans config.json : la sauvegarde GitHub
    // refuse tout contenu contenant un secret (détection automatique).
    if (cfg.googleRefreshToken) {
      delete cfg.googleRefreshToken;
      store.saveConfig(cfg);
    }
    // Idem pour le jeton du compte d'envoi d'e-mails (Gmail API).
    const tm = store.tokensMail() || {};
    if (!tm.refresh_token && process.env.GOOGLE_MAIL_REFRESH_TOKEN) {
      tm.refresh_token = process.env.GOOGLE_MAIL_REFRESH_TOKEN;
      store.saveTokensMail(tm);
    }
  } catch (err) {
    console.warn('[oauth] Ré-hydratation impossible :', err.message);
  }
  // Auto-réparation : si la restauration a laissé une config sans mot de passe
  // admin (config.json vide/incomplet), il est rétabli depuis l'env ADMIN_PASSWORD
  // (source de vérité, même principe que les jetons Google).
  try {
    const cfgH = store.config();
    if (!cfgH.adminPasswordHash && process.env.ADMIN_PASSWORD) {
      cfgH.adminPasswordHash = sec.hashPassword(process.env.ADMIN_PASSWORD);
      if (!cfgH.secret) cfgH.secret = sec.randomToken(32);
      store.saveConfig(cfgH);
      console.log('[startup] Config réparée : mot de passe admin rétabli depuis ADMIN_PASSWORD.');
    }
  } catch (err) {
    console.warn('[startup] Réparation de la config impossible :', err.message);
  }
  demo.seed();
  backup.cleanupExpiredGrants().catch(() => {});
  backup.startPeriodicBackup();
  backup.now(); // sauvegarde immédiate au démarrage
  // Tâches quotidiennes : nettoyage des dossiers triés trop anciens +
  // vérification que la connexion Google du photographe tient toujours
  // (un jeton d'application « Testing » expire après 7 jours → alerte e-mail).
  driveSort.cleanupSelectionFolders().catch((err) => console.warn('[drive-sort]', err.message));
  setInterval(() => {
    driveSort.cleanupSelectionFolders().catch(() => {});
    checkDriveUserHealth().catch(() => {});
  }, 24 * 3600 * 1000);
})();

const app = express();
app.disable('x-powered-by');
// Derrière un proxy (nginx, plateformes cloud) : utiliser l'IP réelle du visiteur.
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// Fichiers de l'interface (HTML/JS/CSS) : toujours revalidés, pour que les
// téléphones ne servent pas d'anciennes versions après une mise à jour.
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html',
  setHeaders(res, filePath) {
    if (/\.(html|js|css)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  },
}));

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
  // Galerie désactivée (toggle admin) = invisible côté client, comme introuvable.
  return store.galleries().find((g) => g.slug === String(slug) && g.enabled !== false) || null;
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
    albums: allSelectableTypes(g).map((t) => {
      const entry = (albums || []).find((a) => a.typeId === t.id) || { photoIds: [] };
      const coverIdx = files.findIndex((f) => f.id === (entry.coverId || ''));
      return {
        label: t.label,
        count: entry.photoIds.length,
        photoIds: entry.photoIds,
        cover: entry.coverId
          ? { index: coverIdx > -1 ? coverIdx + 1 : null, name: coverIdx > -1 ? files[coverIdx].name : entry.coverId }
          : null,
        photos: entry.photoIds.map((id) => {
          const idx = files.findIndex((f) => f.id === id);
          return { index: idx > -1 ? idx + 1 : null, name: idx > -1 ? files[idx].name : id };
        }),
      };
    }),
    // Options vendues avec quantité (posters, agrandissements) — rappelées dans l'e-mail.
    options: galleryOptions(g),
  };
}

/** Envoie la notification en arrière-plan (n'interrompt jamais la réponse). */
async function notifySelection(req, g, clientName, albums) {
  if (!mailer.isConfigured()) return false;
  try {
    await mailer.sendSelectionNotification(buildNotificationInfo(req, g, clientName, albums));
    noteNotify(true);
    return true;
  } catch (err) {
    console.error('[notify]', err.message);
    noteNotify(false, err.message);
    return false;
  }
}

/** Récapitulatif de la sélection envoyé AU CLIENT (sa propre adresse e-mail). */
async function notifyClientSelection(req, g, client, sel) {
  if (!mailer.isConfigured() || !client || !client.email) return false;
  try {
    await mailer.sendClientSelectionConfirmation({
      clientName: client.name,
      clientEmail: client.email,
      galleryName: g.name,
      galleryUrl: `${req.protocol}://${req.get('host')}/g/${g.slug}`,
      albums: (sel.albums || []).map((a) => {
        const t = allSelectableTypes(g).find((x) => x.id === a.typeId);
        const files = g.files || [];
        const coverIdx = files.findIndex((f) => f.id === (a.coverId || ''));
        return {
          label: t ? t.label : a.typeId,
          count: (a.photoIds || []).length,
          cover: a.coverId
            ? { index: coverIdx > -1 ? coverIdx + 1 : null, name: coverIdx > -1 ? files[coverIdx].name : a.coverId }
            : null,
          // Liste des numéros choisis (demande explicite du client)
          photos: (a.photoIds || []).map((id) => {
            const idx = files.findIndex((f) => f.id === id);
            return { index: idx > -1 ? idx + 1 : null, name: idx > -1 ? files[idx].name : id };
          }),
        };
      }),
      options: galleryOptions(g),
    });
    noteNotify(true);
    return true;
  } catch (err) {
    console.error('[notify-client]', err.message);
    noteNotify(false, err.message);
    return false;
  }
}

/** Options vendues avec quantité (posters, agrandissements) de la galerie. */
function galleryOptions(g) {
  const labels = { 'posters-30x45': 'Posters 30\u00d745', 'agrandissements-20x30': 'Agrandissements 20\u00d730' };
  const out = [];
  Object.entries((g && g.packages) || {}).forEach(([id, n]) => {
    if (typeof n === 'number' && n > 0) out.push({ label: labels[id] || id, qty: n });
  });
  return out;
}

/* --- Tri automatique des sélections sur Drive ---------------- */

/** Lance (en file d'attente) le tri Drive d'une sélection enregistrée. */
function scheduleDriveApply(galleryId, selId) {
  if (!driveSort.isReady()) return;
  driveSort.enqueue(async () => {
    const all = store.galleries();
    const g = all.find((x) => x.id === galleryId);
    if (!g) return;
    const sel = (g.selections || []).find((s) => s.id === selId);
    if (!sel) return;
    driveSort.setStatus(sel, 'pending');
    store.saveGalleries(all);
    try {
      const result = await driveSort.applySelection(g, sel);
      driveSort.setStatus(sel, result.errors.length ? 'partial' : 'ok', {
        driveFolderId: result.folderId,
        driveFolderName: result.folderName,
        driveFolderUrl: result.folderUrl,
        driveMode: result.mode,
        driveError: result.errors.length ? result.errors.map((e) => e.name + ' : ' + e.message).join(' ; ').slice(0, 400) : null,
        driveAppliedAt: Date.now(),
      });
      store.saveGalleries(all);
      if (mailer.isConfigured()) {
        mailer.sendDriveFolderNotification({
          galleryName: g.name,
          folderName: result.folderName,
          folderUrl: result.folderUrl,
          mode: result.mode,
          total: result.total,
          subfolders: result.subfolders,
        }).catch((err) => console.error('[drive-sort][mail]', err.message));
      }
    } catch (err) {
      driveSort.setStatus(sel, 'error', {
        driveError: String(err.message).slice(0, 200),
        driveAppliedAt: Date.now(),
      });
      store.saveGalleries(all);
      console.error('[drive-sort]', err.message);
      // Connexion expirée ? On prévient le photographe par e-mail (1 alerte max / 6 h).
      if (/GOOGLE_USER_NOT_CONNECTED|invalid_grant|401|refresh|expired/i.test(String(err.message))) {
        warnDriveAuthFailure(err.message);
      }
    }
  }).catch(() => {});
}

/* --- Santé de la connexion Google (tri automatique) ------------ */

/** Une seule alerte e-mail par tranche de 6 heures, pour ne pas spammer. */
function warnDriveAuthFailure(detail) {
  const cfg = store.config();
  if (cfg.lastDriveAuthWarningAt && Date.now() - cfg.lastDriveAuthWarningAt < 6 * 3600 * 1000) return;
  if (!mailer.isConfigured()) return;
  cfg.lastDriveAuthWarningAt = Date.now();
  store.saveConfig(cfg);
  mailer.sendDriveAuthWarning({ detail: String(detail || '').slice(0, 200) })
    .catch((err) => console.error('[drive-sort][mail]', err.message));
}

/**
 * Vérifie (en forçant un rafraîchissement) que le jeton du compte
 * utilisateur est toujours valide. Sinon, prévient le photographe par e-mail.
 */
async function checkDriveUserHealth() {
  if (!driveSort.isReady()) return;
  try {
    const ok = await drive.verifyUserConnection();
    if (!ok) warnDriveAuthFailure('Google a refusé le renouvellement du jeton (application en mode « Testing » ou autorisation révoquée).');
  } catch (err) {
    warnDriveAuthFailure(err.message);
  }
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
  const contactEmail = store.config().photographerEmail || 'mewstudiofrance@gmail.com';
  if (!g) {
    // Galerie inexistante OU désactivée : le client doit rester sur l'écran
    // de connexion avec un message de contact — jamais renvoyé sur l'accueil.
    const raw = store.galleries().find((x) => x.slug === req.params.slug);
    return res.json({ exists: false, disabled: !!raw, contactEmail });
  }
  const unlocked = isUnlocked(req, req.params.slug);
  res.json({
    exists: true,
    locked: galleryLocked(g) && !unlocked,
    expired: isExpired(g),
    unlocked,
    meta: publicMeta(g),
    contactEmail,
  });
});

app.post('/api/g/:slug/unlock', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!unlockLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const g = findGallery(req.params.slug);
  const contactEmail = store.config().photographerEmail || 'mewstudiofrance@gmail.com';
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.', contactEmail });
  if (isExpired(g)) return res.status(403).json({ error: 'Cette galerie a expiré.', contactEmail });
  if (sec.verifyPassword(req.body.password || '', g.passwordHash)) {
    setUnlocked(req, res, req.params.slug);
    return res.json({ ok: true });
  }
  res.status(403).json({ error: 'Mot de passe incorrect.', contactEmail });
});

/* --- Connexion client : le visiteur tape le mot de passe de sa galerie,
       le serveur identifie la galerie et redirige vers elle (déverrouillée). */
const connexionLimiter = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 15 });

app.get('/connexion', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'connexion.html'));
});

/* Page « Politique de confidentialité » — également servie SANS extension,
   car c'est l'URL déclarée à Google (Branding → privacy policy link).
   Tolérante : casse, accent (« confidentialité »), barre oblique finale,
   variante longue. */
const PRIVACY_REGEX = /^\/(politique-de-)?confidentialit(e|é)?\/?$/i;
app.use((req, res, next) => {
  // Décode les caractères accentués encodés par le navigateur (é → %C3%A9)
  // pour que la route ci-dessous les reconnaisse.
  try { if (req.url.includes('%')) req.url = decodeURIComponent(req.url); } catch (e) { /* URL malformée : laisser tel quel */ }
  next();
});
app.get(PRIVACY_REGEX, (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'confidentialite.html'));
});

app.post('/api/connexion', (req, res) => {
  const ip = req.ip || 'unknown';
  if (!connexionLimiter(ip)) return res.status(429).json({ error: 'Trop de tentatives, réessayez plus tard.' });
  const password = String(req.body.password || '').trim();
  if (!password) return res.status(400).json({ error: 'Veuillez saisir votre mot de passe.' });

  const matches = [];
  for (const g of store.galleries()) {
    if (g.passwordHash && g.enabled !== false && !isExpired(g) && sec.verifyPassword(password, g.passwordHash)) {
      matches.push(g);
    }
    if (matches.length >= 20) break; // sécurité : on s'arrête à 20 correspondances
  }

  if (!matches.length) {
    return res.status(403).json({
      error: 'Mot de passe incorrect. Vérifiez-le ou contactez Mews Studio à ' +
        (store.config().photographerEmail || 'mewstudiofrance@gmail.com') + '.',
      contactEmail: store.config().photographerEmail || 'mewstudiofrance@gmail.com',
    });
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
    albums: (function () {
      const types = g.albums && g.albums.enabled ? allSelectableTypes(g) : [];
      return types.length
        ? { types, email: store.config().photographerEmail || 'mewstudiofrance@gmail.com' }
        : null;
    })(),
    // Photos déjà dans au moins un album envoyé (tous clients confondus) :
    // sert au petit ✦ informatif (« déjà dans un album »), jamais un blocage.
    sentInAlbums: (function () {
      const s = new Set();
      (g.clients || []).forEach((c) => (c.selections || []).forEach((sel) =>
        (sel.albums || []).forEach((a) => (a.photoIds || []).forEach((id) => s.add(id)))));
      return Array.from(s);
    })(),
    // Formats d'album déjà envoyés (TOUS clients confondus) — le verrou,
    // visible même pour un visiteur non identifié.
    sentByType: sentStateForGallery(g).byType,
    // Options vendues avec quantité (posters, agrandissements) — récapitulatif côté client.
    options: (function () {
      const out = {};
      Object.entries(g.packages || {}).forEach(([id, n]) => {
        if (typeof n === 'number' && n > 0) out[id] = n;
      });
      return out;
    })(),
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
  const albums = allSelectableTypes(g).map((t) => {
    const incoming = ((req.body && req.body.albums) || []).find((a) => a.typeId === t.id);
    const ids = Array.isArray(incoming && incoming.photoIds) ? incoming.photoIds : [];
    const photoIds = ids.filter((id) => valid.has(id)).slice(0, t.capacity);
    // La couverture est libre : n'importe quelle photo de la galerie (pas
    // besoin qu'elle soit dans la sélection de l'album).
    const coverId = (!t.print && incoming && typeof incoming.coverId === 'string' && valid.has(incoming.coverId))
      ? incoming.coverId : null;
    return { typeId: t.id, photoIds, coverId };
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
  const emailSent = await notifySelection(req, g, sel.name, albums);
  scheduleDriveApply(g.id, sel.id); // tri automatique sur Drive (si activé)
  res.json({ ok: true, emailSent });
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
    email: c.email || '',
    albums: c.albums || { checked: {}, photos: {}, covers: {} },
    selections: (c.selections || []).map((s) => ({ date: s.date, albums: s.albums })),
  };
}

/** Photos déjà envoyées par un client (toutes sélections confondues),
    par type d'album — pour afficher « déjà envoyé » et marquer les photos.
    NB : une même photo peut exister dans plusieurs albums (pas de verrou). */
function sentStateForClient(g, client) {
  const all = new Set();
  const byType = {};
  (client.selections || []).forEach((s) => {
    (s.albums || []).forEach((a) => {
      const t = allSelectableTypes(g).find((x) => x.id === a.typeId);
      if (!t) return;
      (a.photoIds || []).forEach((id) => all.add(id));
      if (!byType[t.id]) byType[t.id] = { count: 0, lastDate: 0, albumsSent: 0 };
      if ((a.photoIds || []).length) byType[t.id].albumsSent++;
      byType[t.id].count += (a.photoIds || []).length;
      if ((s.date || 0) > byType[t.id].lastDate) byType[t.id].lastDate = s.date || 0;
    });
  });
  return { all: Array.from(all), byType };
}

/** Photos déjà envoyées dans la galerie (TOUS les clients confondus),
    par type d'album — c'est le verrou : un format d'album ne peut être
    envoyé qu'UNE FOIS par galerie, par qui que ce soit (même avec une
    autre adresse e-mail). (Une même photo reste libre entre albums.) */
function sentStateForGallery(g) {
  const all = new Set();
  const byType = {};
  const sendersByType = {};
  (g.clients || []).forEach((c) => {
    (c.selections || []).forEach((s) => {
      (s.albums || []).forEach((a) => {
        const t = allSelectableTypes(g).find((x) => x.id === a.typeId);
        if (!t) return;
        (a.photoIds || []).forEach((id) => all.add(id));
        if (!byType[t.id]) byType[t.id] = { count: 0, lastDate: 0, albumsSent: 0 };
        if ((a.photoIds || []).length) {
          byType[t.id].albumsSent++;
          sendersByType[t.id] = Array.from(new Set([...(sendersByType[t.id] || []), c.name || c.email || 'inconnu']));
        }
        byType[t.id].count += (a.photoIds || []).length;
        if ((s.date || 0) > byType[t.id].lastDate) byType[t.id].lastDate = s.date || 0;
      });
    });
  });
  return { all: Array.from(all), byType, sendersByType };
}

function clientAlbumState(albumTypes, body, validIds) {
  const photos = {};
  albumTypes.forEach((t) => {
    const ids = Array.isArray((body.photos || {})[t.id]) ? body.photos[t.id] : [];
    photos[t.id] = ids.filter((id) => validIds.has(id)).slice(0, t.capacity);
  });
  const checked = {};
  albumTypes.forEach((t) => { checked[t.id] = !!((body.checked || {})[t.id]); });
  const covers = {};
  albumTypes.forEach((t) => {
    if (t.print) return; // les impressions (posters, agrandissements) n'ont pas de couverture
    const c = (body.covers || {})[t.id];
    // Couverture libre : n'importe quelle photo de la galerie.
    if (typeof c === 'string' && validIds.has(c)) covers[t.id] = c;
  });
  return { checked, photos, covers };
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
  if (name.length < 2) return res.status(400).json({ error: 'Entrez votre nom.' });
  const email = String((req.body && req.body.email) || '').trim().slice(0, 120).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return res.status(400).json({ error: 'Entrez une adresse e-mail valide (elle sert à retrouver vos sélections).' });
  }

  g.clients = g.clients || [];
  // L'e-mail est la clé d'identité : le client retrouve ses sélections
  // (et ses photos déjà envoyées) quel que soit l'appareil.
  let client = g.clients.find((c) => (c.email || '').toLowerCase() === email);
  if (!client) client = g.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (!client) {
    client = {
      id: sec.randomToken(10),
      name,
      email,
      emails: [email],
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      albums: { checked: {}, photos: {}, covers: {} },
      selections: [],
    };
    g.clients.push(client);
  } else {
    if ((client.email || '').toLowerCase() !== email) client.email = email;
    client.emails = Array.from(new Set([...(client.emails || []), email]));
    if (name && name.toLowerCase() !== client.name.toLowerCase()) client.name = name;
  }
  client.lastSeenAt = Date.now();
  const all = store.galleries();
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  const token = sec.sign({ slug: req.params.slug, clientId: client.id, iat: Date.now() }, secret());
  const payload = clientPayload(client);
  const sent = sentStateForGallery(g);
  payload.sentIds = sent.all;
  payload.sentByType = sent.byType;
  res.json({ ok: true, token, client: payload });
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
  const payload = clientPayload(client);
  const sent = sentStateForGallery(g);
  payload.sentIds = sent.all;
  payload.sentByType = sent.byType;
  res.json({ client: payload });
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
  client.albums = clientAlbumState(allSelectableTypes(g), req.body || {}, valid);
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
  // Verrou strict PAR GALERIE : un format d'album déjà envoyé par QUELQU'UN
  // ne peut plus être envoyé — même avec une autre adresse e-mail.
  // (Une même photo peut en revanche figurer dans des albums de formats
  //  DIFFÉRENTS, ex. 150 photos + 200 photos.)
  const sentState = sentStateForGallery(g);
  const lockedTypes = new Set(Object.keys(sentState.byType).filter((t) => sentState.byType[t].albumsSent > 0));
  let lockedRejected = null;
  const albums = allSelectableTypes(g).map((t) => {
    const incoming = (((req.body || {}).albums) || []).find((a) => a.typeId === t.id);
    const ids = Array.isArray(incoming && incoming.photoIds) ? incoming.photoIds : [];
    if (lockedTypes.has(t.id) && ids.length) lockedRejected = t;
    const photoIds = lockedTypes.has(t.id) ? [] : ids.filter((id) => valid.has(id)).slice(0, t.capacity);
    // Couverture libre : n'importe quelle photo de la galerie.
    const coverId = (!t.print && incoming && typeof incoming.coverId === 'string' && valid.has(incoming.coverId))
      ? incoming.coverId : null;
    return { typeId: t.id, photoIds, coverId };
  });
  if (albums.every((a) => a.photoIds.length === 0)) {
    return res.status(400).json({
      error: lockedRejected
        ? 'L\u2019album « ' + lockedRejected.label + ' » a déjà été envoyé à Mews Studio.'
        : 'La sélection est vide.',
    });
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
  const emailSent = await notifySelection(req, g, client.name, albums);
  // Récapitulatif au client (sa propre adresse e-mail) — ne bloque pas l'envoi au photographe.
  const clientEmailSent = await notifyClientSelection(req, g, client, sel);
  scheduleDriveApply(g.id, sel.id); // tri automatique sur Drive (si activé)
  const sentNow = sentStateForGallery(g);
  res.json({ ok: true, emailSent, clientEmailSent, sentIds: sentNow.all, sentByType: sentNow.byType });
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
  if (drive.isServiceAccount()) {
    return res.status(400).json({ error: 'Mode compte de service actif : la connexion est automatique, aucune connexion OAuth n’est nécessaire.' });
  }
  if (!drive.isConfigured() || !drive.redirectUri()) {
    return res.status(400).json({ error: 'Google OAuth non configuré (CLIENT_ID, CLIENT_SECRET et BASE_URL requis). Voir SETUP.md.' });
  }
  // Même mécanisme d'état que /api/admin/drive-user/connect : le retour est
  // validé par /oauth2callback (jeton oauthState dans data/tokens.json).
  const state = sec.randomToken(16);
  const t = store.tokens() || {};
  t.oauthState = state;
  store.saveTokens(t);
  res.json({ url: drive.authUrl(state) });
});

/* ============================================================
 *  OAuth compte utilisateur (Google) — nécessaire pour ÉCRIRE
 *  dans le Drive : tri automatique des sélections d'albums.
 *  (Le compte de service ne sait que lire : pas de quota.)
 * ============================================================ */

/** Retour du consentement Google : échange du code → jeton stocké.
 *  Deux flux possibles, distingués par l'état (state) enregistré :
 *   - flux Drive  (tokens.json)      → /admin#drive=…
 *   - flux envoi  (tokens-mail.json) → /admin#mail=…  */
app.get('/oauth2callback', async (req, res) => {
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const tm = store.tokensMail() || {};
  const isMailFlow = !!(tm.oauthState && state && state === tm.oauthState);
  const t = isMailFlow ? tm : (store.tokens() || {});
  if (!code) return res.redirect(isMailFlow ? '/admin#mail=annule' : '/admin#drive=annule');
  if (t.oauthState && state !== t.oauthState) {
    return res.redirect((isMailFlow ? '/admin#mail=err&m=' : '/admin#drive=err&m=') + encodeURIComponent('État OAuth invalide, réessayez.'));
  }
  try {
    const data = await (isMailFlow ? drive.exchangeMailCode(code) : drive.exchangeCode(code));
    t.access_token = data.access_token;
    t.expiry = Date.now() + (data.expires_in || 3600) * 1000;
    if (data.refresh_token) t.refresh_token = data.refresh_token;
    delete t.oauthState;
    if (isMailFlow) {
      store.saveTokensMail(t);
      // Capturer l'adresse du compte d'envoi tout de suite (sert au statut
      // et à l'envoi, même si l'API de profil est instable plus tard).
      const acc = await drive.mailAccount();
      if (acc && acc.emailAddress) { t.email = acc.emailAddress; store.saveTokensMail(t); }
    } else {
      store.saveTokens(t);
    }
    res.redirect(isMailFlow ? '/admin#mail=ok' : '/admin#drive=ok');
  } catch (err) {
    res.redirect((isMailFlow ? '/admin#mail=err&m=' : '/admin#drive=err&m=') + encodeURIComponent(String(err.message).slice(0, 120)));
  }
});

/** Démarre la connexion OAuth du compte utilisateur (bouton admin). */
app.post('/api/admin/drive-user/connect', requireAdmin, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Identifiants OAuth Google absents (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
  }
  const state = sec.randomToken(16);
  const t = store.tokens() || {};
  t.oauthState = state;
  store.saveTokens(t);
  res.json({ url: drive.authUrl(state) });
});

/** État de la connexion du compte utilisateur. */
app.get('/api/admin/drive-user/status', requireAdmin, async (req, res) => {
  const account = drive.isUserConnected() ? await drive.userDriveAccount() : null;
  res.json({
    configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected: drive.isUserConnected(),
    email: account ? account.emailAddress : null,
    serviceAccountMode: drive.isServiceAccount(),
    // Admin uniquement (session protégée) : sert à reporter le jeton de
    // renouvellement dans la variable GOOGLE_REFRESH_TOKEN de l'hébergeur.
    refreshToken: (store.tokens() && store.tokens().refresh_token) || null,
  });
});

/** Déconnexion du compte utilisateur. */
app.post('/api/admin/drive-user/disconnect', requireAdmin, (req, res) => {
  const t = store.tokens() || {};
  delete t.refresh_token;
  delete t.access_token;
  delete t.expiry;
  store.saveTokens(t);
  const cfg = store.config();
  cfg.googleRefreshToken = null;
  store.saveConfig(cfg);
  res.json({ ok: true });
});

/* ============================================================
 *  OAuth compte d'ENVOI d'e-mails (API Gmail) — indépendant du
 *  compte Drive. Permet de trier les albums sur le Drive d'un
 *  compte et de faire partir les e-mails d'un autre compte.
 * ============================================================ */

/** Démarre la connexion OAuth du compte d'envoi (bouton admin). */
app.post('/api/admin/mail/connect', requireAdmin, (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(400).json({ error: 'Identifiants OAuth Google absents (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).' });
  }
  const state = sec.randomToken(16);
  const t = store.tokensMail() || {};
  t.oauthState = state;
  store.saveTokensMail(t);
  res.json({ url: drive.mailAuthUrl(state) });
});

/** État du compte d'envoi. */
app.get('/api/admin/mail/status', requireAdmin, async (req, res) => {
  const connected = drive.isMailConnected();
  const account = connected ? await drive.mailAccount() : null;
  // Le profil API exige un scope > gmail.send : en secours, l'adresse du champ Expéditeur.
  const m = /<([^<>]+)>/.exec(String((store.config().notifications || {}).from || ''));
  const fallbackEmail = m ? m[1].trim() : '';
  res.json({
    configured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
    connected,
    email: (account && account.emailAddress) || (connected ? fallbackEmail : null),
    accountError: (account && account.error) || null,
    // Admin uniquement : à reporter dans la variable GOOGLE_MAIL_REFRESH_TOKEN
    // de l'hébergeur pour survivre aux redéploiements (comme GOOGLE_REFRESH_TOKEN).
    refreshToken: (store.tokensMail() && store.tokensMail().refresh_token) || null,
  });
});

/** Déconnexion du compte d'envoi. */
app.post('/api/admin/mail/disconnect', requireAdmin, (req, res) => {
  store.saveTokensMail(null);
  res.json({ ok: true });
});

/** Dossiers du compte utilisateur (pour choisir la racine des tris). */
app.get('/api/admin/drive-user/folders', requireAdmin, async (req, res) => {
  try {
    const folders = await drive.listUserFolders();
    res.json({ folders: folders.map((f) => ({ id: f.id, name: f.name })) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/** Relance manuellement le tri Drive d'une sélection précise. */
app.post('/api/admin/galleries/:id/selections/:selId/drive-apply', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const sel = (g.selections || []).find((s) => s.id === req.params.selId);
  if (!sel) return res.status(404).json({ error: 'Sélection introuvable.' });
  if (!drive.isUserConnected()) {
    return res.status(400).json({ error: 'Compte Google non connecté : Admin → Réglages → Se connecter avec Google.' });
  }
  driveSort.setStatus(sel, 'pending');
  store.saveGalleries(all);
  try {
    const result = await driveSort.applySelection(g, sel);
    driveSort.setStatus(sel, result.errors.length ? 'partial' : 'ok', {
      driveFolderId: result.folderId,
      driveFolderName: result.folderName,
      driveFolderUrl: result.folderUrl,
      driveMode: result.mode,
      driveError: result.errors.length ? result.errors.map((e) => e.name + ' : ' + e.message).join(' ; ').slice(0, 400) : null,
      driveAppliedAt: Date.now(),
    });
    store.saveGalleries(all);
    res.json({ ok: true, folderUrl: result.folderUrl, folderName: result.folderName, total: result.total, mode: result.mode, errors: result.errors.length });
  } catch (err) {
    driveSort.setStatus(sel, 'error', { driveError: String(err.message).slice(0, 200), driveAppliedAt: Date.now() });
    store.saveGalleries(all);
    res.status(502).json({ error: err.message });
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
    // Idem pour la clé API Resend (vide = conserver l'existante)
    next.apiKey = (typeof n.apiKey === 'string' && n.apiKey.trim()) ? n.apiKey.trim().slice(0, 200) : (current.apiKey || '');
    // Mode « envoyer via mon compte Google » (API Gmail)
    next.gmailMode = !!n.gmailMode;
    cfg.notifications = next;
    changed = true;
  }
  if (body.selectionDriveMode !== undefined) {
    const mode = ['off', 'copy', 'shortcut'].includes(String(body.selectionDriveMode))
      ? String(body.selectionDriveMode) : 'off';
    cfg.selectionDriveMode = mode;
    changed = true;
  }
  if (body.selectionRootFolderId !== undefined) {
    cfg.selectionRootFolderId = String(body.selectionRootFolderId || '').trim() || null;
    changed = true;
  }
  if (body.selectionCleanupDays !== undefined) {
    cfg.selectionCleanupDays = Math.max(0, Math.min(365, Number(body.selectionCleanupDays) || 0));
    changed = true;
  }
  if (changed) store.saveConfig(cfg);
  res.json({
    ok: true,
    photographerEmail: cfg.photographerEmail,
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
      resendSet: !!(cfg.notifications && cfg.notifications.apiKey),
      gmailMode: !!(cfg.notifications && cfg.notifications.gmailMode),
      provider: mailer.provider(),
      configured: mailer.isConfigured(),
    },
    selectionDriveMode: cfg.selectionDriveMode || 'off',
    selectionRootFolderId: cfg.selectionRootFolderId || '',
    selectionCleanupDays: Number(cfg.selectionCleanupDays || 0),
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

/** Envoie un rappel Google Agenda (bouton « Ajouter à l'agenda ») à l'adresse demandée. */
app.post('/api/admin/reminder/send', requireAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const to = String(body.to || '').trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return res.status(400).json({ error: 'Adresse de destination manquante ou invalide.' });
    const start = String(body.start || '');
    const end = String(body.end || '');
    if (!/^\d{8}T\d{6}$/.test(start) || !/^\d{8}T\d{6}$/.test(end)) return res.status(400).json({ error: 'Heures invalides — format attendu AAAAMMJJTHHMMSS (ex. 20260921T100000).' });
    await mailer.sendReminder({
      to,
      title: String(body.title || 'Rappel — Mews Studio').slice(0, 200),
      startLocal: start,
      endLocal: end,
      details: String(body.details || '').slice(0, 1000),
      ctz: String(body.ctz || 'Europe/Paris').slice(0, 40),
    });
    res.json({ ok: true, to });
  } catch (err) {
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
    galleriesCount: all.length,
    photosCount: all.reduce((n, g) => n + (g.files ? g.files.length : 0), 0),
    photographerEmail: store.config().photographerEmail || '',
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
      resendSet: !!n.apiKey,
      gmailMode: !!n.gmailMode,
      provider: mailer.provider(),
      configured: mailer.isConfigured(),
      lastNotify: store.config().lastNotify || null,
    },
    // Compte d'envoi d'e-mails (connexion dédiée, distincte du compte Drive)
    mailConnected: drive.isMailConnected(),
    // Sauvegarde automatique (voir lib/backup.js)
    backupEnabled: backup.backupStore() !== null,
    backupStore: backup.backupStore(),
    backupKey: drive.isServiceAccount() ? null : ((store.tokens() && store.tokens().refresh_token) || null),
    lastBackupAt: backup.lastBackupAt(),
    // Tri automatique des sélections sur Drive (compte utilisateur OAuth)
    driveUserConnected: drive.isUserConnected(),
    driveUserEmail: null,
    selectionDriveMode: store.config().selectionDriveMode || 'off',
    selectionRootFolderId: store.config().selectionRootFolderId || '',
    selectionCleanupDays: Number(store.config().selectionCleanupDays || 0),
    oauthClientConfigured: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
  });
});

/* --- Sauvegarde Drive déclenchée à la demande ----------------- */
app.post('/api/admin/backup-now', requireAdmin, async (req, res) => {
  const r = await backup.now();
  res.json(r);
});

/* --- Comptes clients côté photographe ------------------------ */
/* Création d'un client depuis l'admin + envoi immédiat de l'e-mail
   d'accès (lien, mot de passe de la galerie, code personnel). */

function clientAccessInfo(g, clientName, clientEmail, galleryPassword) {
  const base = process.env.BASE_URL || `http://localhost:${PORT}`;
  return {
    clientName,
    clientEmail,
    galleryName: g.name,
    galleryUrl: base + '/g/' + g.slug,
    galleryPassword: galleryPassword || '',
  };
}

/** Lien mailto: de secours quand SMTP n'est pas configuré. */
function buildClientAccessMailto(info) {
  const { subject, text } = mailer.buildClientAccessContent(info);
  return 'mailto:' + encodeURIComponent(info.clientEmail) +
    '?subject=' + encodeURIComponent(subject) +
    '&body=' + encodeURIComponent(text);
}

/** Parse une liste d'adresses e-mails (chaîne ou tableau) — séparateurs : virgule, point-virgule, espaces, retours à la ligne. */
function parseEmailList(input) {
  const joined = Array.isArray(input) ? input.map((x) => String(x)).join(',') : String(input || '');
  const out = [];
  const seen = new Set();
  joined.split(/[,;\s\n]+/).map((s) => s.trim()).filter(Boolean).forEach((addr) => {
    if (addr.length > 200 || !/^\S+@\S+\.\S+$/.test(addr)) return;
    const k = addr.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(addr); }
  });
  return out.slice(0, 25); // sécurité : max 25 adresses par envoi
}

/** Capacités d'albums dérivées des packages vendus (suffixe -100/-150/-200 de l'id).
    Un package album coché ⇒ la sélection des photos côté client est activée
    pour cette capacité. Posters/agrandissements (suffixes -45/-30) ne comptent pas. */
function albumTypesFromPackages(packages) {
  const out = [];
  for (const [id, v] of Object.entries(packages || {})) {
    if (!v) continue;
    const m = id.match(/-(\d+)$/);
    if (!m) continue;
    const n = Number(m[1]);
    if ([100, 150, 200].includes(n) && out.indexOf(String(n)) === -1) out.push(String(n));
  }
  return out.sort((a, b) => Number(b) - Number(a)); // 200 → 150 → 100
}

app.post('/api/admin/galleries/:id/clients', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const body = req.body || {};
  const name = String(body.name || '').trim().slice(0, 60);
  const emails = parseEmailList(body.emails || body.email);
  const galleryPassword = String(body.galleryPassword || '').trim().slice(0, 80);
  if (name.length < 2) return res.status(400).json({ error: 'Entrez le nom du client.' });
  if (!emails.length) return res.status(400).json({ error: 'Au moins une adresse e-mail valide est requise.' });
  // Si un mot de passe est saisi (champ pré-rempli avec l'actuel), il DEVIENT
  // réellement le mot de passe de la galerie — sinon l'e-mail annoncerait un
  // mdp que le verrou ne connaît pas.
  if (galleryPassword) {
    if (galleryPassword.length < 4) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères.' });
    g.passwordHash = sec.hashPassword(galleryPassword);
    g.passwordRef = galleryPassword;
  }
  g.clients = g.clients || [];
  if (g.clients.some((c) => c.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: 'Un client portant ce nom existe déjà sur cette galerie. Utilisez « Envoyer l\'accès » sur sa ligne.' });
  }
  const client = {
    id: sec.randomToken(10),
    name,
    email: emails[0],
    emails,
    createdAt: Date.now(),
    lastSeenAt: null,
    albums: { checked: {}, photos: {} },
    selections: [],
  };
  g.clients.push(client);
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }

  let sentCount = 0;
  let failedCount = 0;
  let sendError = null;
  const mailto = buildClientAccessMailto(clientAccessInfo(g, name, emails[0], galleryPassword));
  if (mailer.isConfigured()) {
    for (const e of emails) {
      try {
        await mailer.sendClientAccessEmail(clientAccessInfo(g, name, e, galleryPassword));
        sentCount++;
      } catch (err) {
        failedCount++;
        sendError = String(err.message).slice(0, 160);
      }
    }
  }
  res.status(201).json({ ok: true, sent: sentCount > 0, sentCount, failedCount, sendError, mailto });
});

app.post('/api/admin/galleries/:id/clients/:clientId/send-access', requireAdmin, async (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const client = (g.clients || []).find((c) => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  const body = req.body || {};
  const emails = parseEmailList(body.emails || body.email);
  const galleryPassword = String(body.galleryPassword || '').trim().slice(0, 80);
  if (!emails.length) return res.status(400).json({ error: 'Au moins une adresse e-mail valide est requise.' });
  // Même règle que « Nouveau client » : un mdp saisi devient le mdp réel de la galerie.
  if (galleryPassword) {
    if (galleryPassword.length < 4) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères.' });
    g.passwordHash = sec.hashPassword(galleryPassword);
    g.passwordRef = galleryPassword;
  }
  if (emails[0].toLowerCase() !== String(client.email || '').toLowerCase()) client.email = emails[0];
  client.emails = Array.from(new Set([...(client.emails || (client.email ? [client.email] : [])), ...emails].map((x) => String(x).toLowerCase())));
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }

  let sentCount = 0;
  let failedCount = 0;
  let sendError = null;
  const mailto = buildClientAccessMailto(clientAccessInfo(g, client.name, emails[0], galleryPassword));
  if (mailer.isConfigured()) {
    for (const e of emails) {
      try {
        await mailer.sendClientAccessEmail(clientAccessInfo(g, client.name, e, galleryPassword));
        sentCount++;
      } catch (err) {
        failedCount++;
        sendError = String(err.message).slice(0, 160);
      }
    }
  }
  res.json({ ok: true, sent: sentCount > 0, sentCount, failedCount, sendError, mailto });
});

/* Réinitialise les envois d'un client (déverrouille ses photos) —
   à utiliser si un envoi a été confirmé mais l'e-mail n'est pas parti. */
app.post('/api/admin/galleries/:id/clients/:clientId/reset-selections', requireAdmin, (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const client = (g.clients || []).find((c) => c.id === req.params.clientId);
  if (!client) return res.status(404).json({ error: 'Client introuvable.' });
  client.selections = [];
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  res.json({ ok: true });
});

/* Supprime un client identifié (profil + historique). */
app.delete('/api/admin/galleries/:id/clients/:clientId', requireAdmin, (req, res) => {
  const all = store.galleries();
  const g = all.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: 'Galerie introuvable.' });
  const before = (g.clients || []).length;
  g.clients = (g.clients || []).filter((c) => c.id !== req.params.clientId);
  if (g.clients.length === before) return res.status(404).json({ error: 'Client introuvable.' });
  const idx = all.findIndex((x) => x.id === g.id);
  if (idx > -1) { all[idx] = g; store.saveGalleries(all); }
  res.json({ ok: true });
});

/* --- Récapitulatif des profils clients ----------------------- */

app.get('/api/admin/clients', requireAdmin, (req, res) => {
  const out = store.galleries()
    .filter((g) => g.albums && g.albums.enabled)
    .map((g) => ({
      id: g.id,
      slug: g.slug,
      name: g.name,
      passwordRef: g.passwordRef || null,
      // Formats déjà envoyés (par qui) — verrou par galerie.
      gallerySentByType: (function () {
        const s = sentStateForGallery(g);
        const types = allSelectableTypes(g);
        const out = {};
        Object.keys(s.byType).forEach((t) => {
          if (s.byType[t].albumsSent > 0) {
            const tt = types.find((x) => x.id === t);
            out[t] = { label: tt ? tt.label : t, date: s.byType[t].lastDate, senders: s.sendersByType[t] || [] };
          }
        });
        return out;
      })(),
      clients: (g.clients || []).map((c) => {
        let sentPhotos = 0;
        (c.selections || []).forEach((s) => (s.albums || []).forEach((a) => { sentPhotos += (a.photoIds || []).length; }));
        return {
          id: c.id,
          name: c.name,
          email: c.email || null,
          emails: c.emails || (c.email ? [c.email] : []),
          createdAt: c.createdAt,
          lastSeenAt: c.lastSeenAt,
          selections: (c.selections || []).length,
          sentPhotos,
          albums: c.albums || { checked: {}, photos: {} },
        };
      }),
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

/* Aperçu d'un dossier Drive (nb de photos directes + sous-dossiers) —
   permet de repérer AVANT création le mauvais niveau (dossier parent vide). */
app.get('/api/admin/drive-folder-preview', requireAdmin, async (req, res) => {
  const id = String(req.query.id || '');
  if (!id) return res.json({ ok: false, reason: '' });
  if (!drive.isConnected()) return res.json({ ok: false, reason: 'Google Drive non connecté.' });
  try {
    const [images, subfolders] = await Promise.all([drive.listImages(id), drive.listSubfolders(id)]);
    res.json({
      ok: true,
      photos: images.length,
      subfolders: subfolders.map((f) => f.name),
    });
  } catch (err) {
    res.status(502).json({ ok: false, reason: err.message });
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
    enabled: g.enabled !== false,
    packages: g.packages || {},
    downloadsEnabled: g.downloadsEnabled !== false,
    albumsEnabled: !!(g.albums && g.albums.enabled),
    albumTypes: (g.albums && Array.isArray(g.albums.types) && g.albums.types.length)
      ? g.albums.types
      : ((g.albums && g.albums.enabled) ? ALBUM_TYPES.map((t) => t.id) : null),
    // Descriptifs exacts des albums vendus (packages cochés) — pour la carte galerie.
    albumPackages: (function () {
      const pk = g.packages || {};
      const out = [];
      for (const def of PACKAGE_DEFS) {
        if (def.type === 'check' && pk[def.id]) out.push(def.label);
      }
      return out;
    })(),
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
    eventName: String(body.eventName || '').trim() || null,
    passwordHash: sec.hashPassword(password),
    passwordRef: password,
    mode,
    folderId,
    folderName: body.folderName || (mode === 'demo' ? 'Photos locales (mode démo)' : folderId),
    createdAt: Date.now(),
    expiry: body.expiry ? new Date(body.expiry).getTime() : null,
    syncedAt: 0,
    files: [],
    downloadsEnabled: body.downloadsEnabled !== false, // activé par défaut, modifiable à la création
    watermark: {
      enabled: !!body.watermarkEnabled,
      text: String(body.watermarkText || 'Mews Studio').trim().slice(0, 60),
    },
    selections: [],
  };
  const packages = sanitizePackages(body.packages);
  const explicitTypes = sanitizeAlbumTypes(body.albumTypes);
  const albumTypes = explicitTypes.length ? explicitTypes : albumTypesFromPackages(packages);
  gallery.packages = packages;
  gallery.albums = { enabled: albumTypes.length > 0, types: albumTypes };
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
  // Descriptif exact de chaque album/impression des sélections (package ou
  // ancien format générique) — l'admin n'a plus à deviner le typeId.
  const enrichSel = (sel) => Object.assign({}, sel, {
    albums: (sel.albums || []).map((a) => Object.assign({}, a, { label: packageLabel(a.typeId) })),
  });
  if (Array.isArray(safeGallery.selections)) {
    safeGallery.selections = safeGallery.selections.map(enrichSel);
  }
  if (Array.isArray(safeGallery.clients)) {
    safeGallery.clients = safeGallery.clients.map((c) => {
      const { pinHash, ...rest } = c;
      if (Array.isArray(rest.selections)) rest.selections = rest.selections.map(enrichSel);
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
  if (body.eventName !== undefined) g.eventName = String(body.eventName || '').trim() || null;
  if (body.password !== undefined && body.password !== '') {
    if (String(body.password).length < 4) return res.status(400).json({ error: 'Le mot de passe doit faire au moins 4 caractères.' });
    g.passwordHash = sec.hashPassword(String(body.password));
    g.passwordRef = String(body.password); // référence lisible (admin uniquement) pour pré-remplir « Envoyer l'accès »
  }
  if (body.expiry !== undefined) g.expiry = body.expiry ? new Date(body.expiry).getTime() : null;
  if (body.watermarkEnabled !== undefined) {
    g.watermark = {
      enabled: !!body.watermarkEnabled,
      text: String(body.watermarkText || g.watermark?.text || 'Mews Studio').trim().slice(0, 60),
    };
  }
  if (body.albumTypes !== undefined) {
    const types = sanitizeAlbumTypes(body.albumTypes);
    g.albums = { ...(g.albums || {}), enabled: types.length > 0, types };
  }
  if (body.downloadsEnabled !== undefined) {
    g.downloadsEnabled = !!body.downloadsEnabled;
  }
  if (body.enabled !== undefined) {
    g.enabled = !!body.enabled;
  }
  if (body.packages !== undefined) {
    g.packages = sanitizePackages(body.packages);
    // Les packages cochés pilotent la sélection d'albums côté client.
    // (Sauf si la demande porte aussi un choix explicite de formats.)
    if (body.albumTypes === undefined) {
      const types = albumTypesFromPackages(g.packages);
      g.albums = { enabled: types.length > 0, types };
    }
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
/* 404 : jamais mis en cache, pour qu'un lien corrigé entre-temps
   redevienne immédiatement visible. */
app.use((req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.status(404).send('Cannot GET ' + req.path);
});

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
