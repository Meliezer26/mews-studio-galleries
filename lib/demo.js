'use strict';
const fs = require('fs');
const path = require('path');
const { galleries, saveGalleries, config, saveConfig } = require('./store');
const { hashPassword, randomToken } = require('./security');

const DEMO_PHOTOS_DIR = path.join(__dirname, '..', 'public', 'demo-photos');

const ALBUM_TYPES = [
  { id: '200', label: 'Album 200 photos', capacity: 200 },
  { id: '150', label: 'Album 150 photos', capacity: 150 },
  { id: '100', label: 'Album 100 photos', capacity: 100 },
];

/** Prépare la configuration initiale et la galerie de démonstration. */
function seed() {
  const cfg = config();
  let cfgChanged = false;

  if (!cfg.secret) { cfg.secret = randomToken(32); cfgChanged = true; }
  if (!cfg.adminPasswordHash) {
    cfg.adminPasswordHash = hashPassword(process.env.ADMIN_PASSWORD || 'admin123');
    cfgChanged = true;
  }
  if (!cfg.photographerEmail) {
    cfg.photographerEmail = 'mewstudiofrance@gmail.com';
    cfgChanged = true;
  }
  if (cfg.defaultDownloadsEnabled === undefined) {
    cfg.defaultDownloadsEnabled = true;
    cfgChanged = true;
  }
  if (cfg.globalDownloadsEnabled === undefined) {
    cfg.globalDownloadsEnabled = true;
    cfgChanged = true;
  }
  if (cfgChanged) saveConfig(cfg);

  const all = galleries();
  const DEMO_NAMES = ['demo', 'Demo'];

  if (!all.some((g) => g.slug === 'demo')) {
    let files = [];
    try {
      files = fs.readdirSync(DEMO_PHOTOS_DIR)
        .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
        .sort()
        .map((name) => {
          const st = fs.statSync(path.join(DEMO_PHOTOS_DIR, name));
          return { id: name, name, size: st.size, mime: 'image/jpeg', storage: 'demo' };
        });
    } catch { /* dossier absent : rien à faire */ }

    all.push({
      id: 'demo',
      slug: 'demo',
      name: 'Mariage — Camille & Hugo',
      clientName: 'Camille & Hugo',
      passwordHash: hashPassword('demo123'),
      mode: 'demo',
      folderId: null,
      folderName: 'Photos de démonstration (stockées localement)',
      createdAt: Date.now(),
      expiry: null,
      syncedAt: Date.now(),
      files,
      downloadsEnabled: true,
      watermark: { enabled: true, text: 'MEWS STUDIO' },
      albums: { enabled: true },
      clients: [],
      selections: [],
    });
    saveGalleries(all);
  }

  // Mise à niveau idempotente des données existantes
  let changed = false;
  const demoG = all.find((g) => g.slug === 'demo');
  if (demoG) {
    if (demoG.downloadsEnabled === undefined) { demoG.downloadsEnabled = true; changed = true; }
    if (!demoG.watermark) { demoG.watermark = { enabled: true, text: 'MEWS STUDIO' }; changed = true; }
    if (!demoG.albums) { demoG.albums = { enabled: true }; changed = true; }
    if (!demoG.clients) {
      demoG.clients = [{
        id: 'client-demo-camille',
        name: 'Camille',
        pinHash: hashPassword('camille'),
        createdAt: Date.now() - 10 * 24 * 3600 * 1000,
        lastSeenAt: Date.now() - 2 * 24 * 3600 * 1000,
        albums: {
          checked: { '200': true, '150': true, '100': false },
          photos: {
            '200': ['01-couple.jpg', '04-ceremonie.jpg', '05-danse.jpg', '07-table.jpg'],
            '150': ['02-preparation.jpg', '03-alliances.jpg'],
            '100': [],
          },
        },
        selections: [{
          id: randomToken(8),
          date: Date.now() - 2 * 24 * 3600 * 1000,
          albums: [
            { typeId: '200', photoIds: ['01-couple.jpg', '04-ceremonie.jpg', '05-danse.jpg', '07-table.jpg'] },
            { typeId: '150', photoIds: ['02-preparation.jpg', '03-alliances.jpg'] },
            { typeId: '100', photoIds: [] },
          ],
        }],
      }];
      changed = true;
    }
    if (!demoG.selections) {
      demoG.selections = [{
        id: randomToken(8),
        date: Date.now() - 2 * 24 * 3600 * 1000,
        name: 'Camille (exemple)',
        albums: [
          { typeId: '200', photoIds: ['01-couple.jpg', '04-ceremonie.jpg', '05-danse.jpg', '07-table.jpg'] },
          { typeId: '150', photoIds: ['02-preparation.jpg', '03-alliances.jpg'] },
          { typeId: '100', photoIds: ['08-portrait.jpg'] },
        ],
      }];
      changed = true;
    }
    if (changed) saveGalleries(all);
  }
}

module.exports = { seed, ALBUM_TYPES };

