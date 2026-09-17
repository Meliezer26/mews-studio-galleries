'use strict';
/**
 * Tri automatique des sélections d'albums sur le Drive du photographe.
 *
 * Quand un client envoie sa sélection, ce module crée (via le compte
 * UTILISATEUR — OAuth, seul compte autorisé à écrire) :
 *   <dossier racine>/Sélection — <nom> — <date> <heure>/
 *     Album 200 photos (N)/
 *       MEWS1495.JPG   (copie réelle ou raccourci selon le mode —
 *       MEWS1496.JPG    noms d'origine conservés, pas de renumérotation)
 *       cover pic/     (la couverture choisie par le client, si définie)
 *     Album 150 photos (N)/…
 *
 * Modes (config.selectionDriveMode) :
 *  - 'copy'     : copie réelle de chaque fichier (prêt pour le labo,
 *                 consomme l'espace Drive) ;
 *  - 'shortcut' : raccourcis Drive (0 Go, mais certains outils de labo
 *                 ne les gèrent pas) ;
 *  - 'off'      : tri désactivé.
 *
 * Le nettoyage automatique (config.selectionCleanupDays > 0) met les
 * dossiers de sélections trop anciens à la corbeille.
 */
const drive = require('./drive');
const { config, saveConfig, galleries, saveGalleries, updateGalleries } = require('./store');

const { packageLabel } = require('./packages');

/** Prêt à fonctionner : OAuth configuré + compte utilisateur connecté + mode actif. */
function isReady() {
  const mode = String(config().selectionDriveMode || 'off');
  return mode !== 'off' && drive.isUserConnected();
}

/** File d'attente : les tris sont exécutés l'un après l'autre. */
let queue = Promise.resolve();
function enqueue(task) {
  const run = queue.then(task, task);
  queue = run.catch(() => {});
  return run;
}

/** Nom de dossier sûr pour Google Drive. */
function cleanName(name) {
  return String(name || 'galerie')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .slice(0, 120);
}

function pad2(n) { return String(n).padStart(2, '0'); }

/** Vérifie que le dossier racine existe, sinon le crée (racine du Drive). */
async function ensureRootFolder() {
  const cfg = config();
  if (cfg.selectionRootFolderId) {
    try {
      const res = await drive.userApi('/drive/v3/files/' + encodeURIComponent(cfg.selectionRootFolderId) + '?fields=id,name');
      if (res.ok) return cfg.selectionRootFolderId;
    } catch { /* dossier disparu : on en recrée un */ }
  }
  const created = await drive.createUserFolder('Mews Studio — Sélections triées', null);
  cfg.selectionRootFolderId = created.id;
  saveConfig(cfg);
  return created.id;
}

/** Exécute les tâches par petits paquets pour ne pas saturer l'API. */
async function runPool(items, size, worker) {
  const errors = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        await worker(items[idx], idx);
      } catch (err) {
        errors.push({ index: idx, name: (items[idx] && items[idx].name) || '?', message: String(err.message).slice(0, 160) });
      }
    }
  }
  const lanes = [];
  for (let l = 0; l < Math.min(size, items.length); l++) lanes.push(next());
  await Promise.all(lanes);
  return errors;
}

/** Nom du dossier trié : nom de l'expéditeur → nom de l'événement → nom du
 *  client de la galerie → nom de la galerie, puis date/heure (unicité). */
function selectionFolderName(gallery, selection) {
  const d = new Date(selection.date || Date.now());
  const galleryName = cleanName((gallery && gallery.name) || '');
  const displayName = cleanName(
    (selection && selection.name) || (gallery && (gallery.eventName || gallery.clientName)) || (gallery && gallery.name)
  );
  // « Sélection — <galerie> — <client> — <date> » : le nom de la galerie en
  // tête regroupe toutes les sélections d'un même mariage dans le Drive.
  const parts = ['Sélection'];
  if (galleryName) parts.push(galleryName);
  if (displayName && displayName !== galleryName) parts.push(displayName);
  parts.push(d.toISOString().slice(0, 10) + ' ' + pad2(d.getHours()) + 'h' + pad2(d.getMinutes()));
  return parts.join(' — ').slice(0, 200);
}

/**
 * Crée le dossier trié d'une sélection.
 * @param {object} gallery  galerie (avec .files)
 * @param {object} selection sélection { id, date, name, albums:[{typeId, photoIds}] }
 * @returns {Promise<object>} { folderId, folderName, folderUrl, mode, total, subfolders, errors }
 */
async function applySelection(gallery, selection) {
  if (!drive.isUserConnected()) throw new Error('Compte Google non connecté (Admin → Réglages → Se connecter avec Google).');
  const mode = String(config().selectionDriveMode || 'copy');
  const rootId = await ensureRootFolder();

  const folderName = selectionFolderName(gallery, selection);

  const main = await drive.createUserFolder(folderName, rootId);
  const files = gallery.files || [];
  const fileMap = {};
  files.forEach((f) => { fileMap[f.id] = f; });

  const subfolders = [];
  let total = 0;
  const allErrors = [];

  // « names.txt » : les prénoms saisis par le client (mariés, enfant pour
  // bar/brit mila…) — joint au dossier pour la mise en page par le graphiste.
  if (selection.eventNames) {
    try {
      const content =
        'Prénoms : ' + selection.eventNames + '\n' +
        'Galerie : ' + ((gallery && gallery.name) || '') + '\n';
      await drive.createUserTextFile('names.txt', main.id, content);
    } catch (err) {
      allErrors.push({ index: -1, name: 'names.txt', message: String(err.message).slice(0, 160) });
    }
  }

  for (const album of (selection.albums || [])) {
    const ids = (album.photoIds || []).filter((id) => fileMap[id]);
    if (!ids.length) continue;
    const label = packageLabel(album.typeId);
    const sub = await drive.createUserFolder(label + ' (' + ids.length + ' photo' + (ids.length > 1 ? 's' : '') + ')', main.id);
    const errors = await runPool(ids, 5, async (id) => {
      const rec = fileMap[id];
      // Nom de fichier d'origine conservé tel quel (ex. MEWS1498.JPG) —
      // pas de renumérotation : le photographe retrouve ses propres noms.
      const target = cleanName(rec.name);
      if (mode === 'shortcut') await drive.createUserShortcut(id, target, sub.id, rec.mime || 'image/jpeg');
      else await drive.copyUserFile(id, target, sub.id);
    });
    allErrors.push(...errors);
    total += ids.length;
    // Sous-dossier « cover pic » : la couverture choisie par le client.
    // Elle peut être HORS de la sélection de l'album : dans ce cas la photo
    // n'existe que dans ce sous-dossier.
    let coverFolderId = null;
    if (album.coverId && fileMap[album.coverId]) {
      try {
        const coverSub = await drive.createUserFolder('cover pic', sub.id);
        const coverRec = fileMap[album.coverId];
        const target = cleanName(coverRec.name);
        if (mode === 'shortcut') await drive.createUserShortcut(album.coverId, target, coverSub.id, coverRec.mime || 'image/jpeg');
        else await drive.copyUserFile(album.coverId, target, coverSub.id);
        coverFolderId = coverSub.id;
      } catch (err) {
        allErrors.push({ index: -1, name: 'cover pic (' + label + ')', message: String(err.message).slice(0, 160) });
      }
    }
    subfolders.push({ typeId: album.typeId, label, count: ids.length, folderId: sub.id, coverFolderId });
  }

  return {
    folderId: main.id,
    folderName,
    folderUrl: 'https://drive.google.com/drive/folders/' + main.id,
    mode,
    total,
    subfolders,
    errors: allErrors,
  };
}

/** Marque le statut Drive d'une sélection (ok / partial / error / pending). */
function setStatus(selection, status, extra = {}) {
  selection.driveStatus = status;
  Object.assign(selection, extra);
}

/** Nettoyage des dossiers de sélection trop anciens (si activé). */
async function cleanupSelectionFolders() {
  const days = Number(config().selectionCleanupDays || 0);
  if (days <= 0 || !drive.isUserConnected()) return { cleaned: 0 };
  const cutoff = Date.now() - days * 86400000;
  // Collecte d'abord, corbeille ensuite : chaque marquage passe par
  // updateGalleries (état FRAIS) — les appels Drive en attente peuvent
  // prendre du temps, un snapshot réécrit en fin de boucle écraserait
  // les saves concurrents.
  const candidates = [];
  for (const g of galleries()) {
    for (const sel of (g.selections || [])) {
      if (sel.driveFolderId && !sel.driveCleanedAt && (sel.date || 0) < cutoff) {
        candidates.push({ galleryId: g.id, selId: sel.id, folderId: sel.driveFolderId });
      }
    }
  }
  let cleaned = 0;
  for (const c of candidates) {
    try {
      await drive.trashUserFile(c.folderId);
      updateGalleries((all) => {
        const g = all.find((x) => x.id === c.galleryId);
        const sel = g && (g.selections || []).find((s) => s.id === c.selId);
        if (sel) sel.driveCleanedAt = Date.now();
      });
      cleaned++;
    } catch { /* on retentera plus tard */ }
  }
  return { cleaned };
}

module.exports = { isReady, enqueue, applySelection, selectionFolderName, setStatus, cleanupSelectionFolders, packageLabel };
