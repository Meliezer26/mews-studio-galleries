'use strict';
/**
 * Tri automatique des sélections d'albums sur le Drive du photographe.
 *
 * Quand un client envoie sa sélection, ce module crée (via le compte
 * UTILISATEUR — OAuth, seul compte autorisé à écrire) :
 *   <dossier racine>/Sélection — <galerie> — <date> <heure>/
 *     Album 200 photos (N)/
 *       001 — MEWS1495.JPG   (copie réelle ou raccourci selon le mode)
 *       002 — …
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
const { config, saveConfig, galleries, saveGalleries } = require('./store');

const ALBUM_LABELS = {
  '200': 'Album 200 photos',
  '150': 'Album 150 photos',
  '100': 'Album 100 photos',
};

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

  const d = new Date(selection.date || Date.now());
  const folderName = 'Sélection — ' + cleanName(gallery.name) + ' — ' +
    d.toISOString().slice(0, 10) + ' ' + pad2(d.getHours()) + 'h' + pad2(d.getMinutes());

  const main = await drive.createUserFolder(folderName, rootId);
  const files = gallery.files || [];
  const fileMap = {};
  files.forEach((f) => { fileMap[f.id] = f; });

  const subfolders = [];
  let total = 0;
  const allErrors = [];

  for (const album of (selection.albums || [])) {
    const ids = (album.photoIds || []).filter((id) => fileMap[id]);
    if (!ids.length) continue;
    const label = ALBUM_LABELS[album.typeId] || ('Album ' + album.typeId);
    const sub = await drive.createUserFolder(label + ' (' + ids.length + ' photos)', main.id);
    const errors = await runPool(ids, 5, async (id, i) => {
      const rec = fileMap[id];
      const target = String(i + 1).padStart(3, '0') + ' — ' + cleanName(rec.name);
      if (mode === 'shortcut') await drive.createUserShortcut(id, target, sub.id);
      else await drive.copyUserFile(id, target, sub.id);
    });
    allErrors.push(...errors);
    total += ids.length;
    subfolders.push({ typeId: album.typeId, label, count: ids.length, folderId: sub.id });
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
  const all = galleries();
  let cleaned = 0;
  for (const g of all) {
    let changed = false;
    for (const sel of (g.selections || [])) {
      if (sel.driveFolderId && !sel.driveCleanedAt && (sel.date || 0) < cutoff) {
        try {
          await drive.trashUserFile(sel.driveFolderId);
          sel.driveCleanedAt = Date.now();
          changed = true;
          cleaned++;
        } catch { /* on retentera plus tard */ }
      }
    }
    if (changed) saveGalleries(all);
  }
  return { cleaned };
}

module.exports = { isReady, enqueue, applySelection, setStatus, cleanupSelectionFolders, ALBUM_LABELS };
