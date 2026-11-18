'use strict';
/**
 * Banc d'essai : catalogue des albums proposés aux clients.
 *
 * Enjeu : le descriptif affiché au client (format, nombre de photos) doit être
 * EXACTEMENT celui de la source unique lib/packages.js. Une divergence entre
 * le catalogue et l'admin ferait vendre au client autre chose que ce qui est
 * prévu. Chaque album porte aussi son nombre de pages.
 *
 * Lancement : npm test
 */
const path = require('path');
const fs = require('fs');
const pk = require('../lib/packages');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

const albums = pk.PACKAGE_DEFS.filter((d) => d.type === 'check');
const parId = (id) => albums.find((a) => a.id === id);

console.log('\nA. Les neuf albums attendus');
const attendus = [
  ['album-30x80-200', 'Album 30×80 — 200 photos', 200, 40],
  ['album-maries-offert-25x50-100', 'Album Mariés offert — 25×50 — 100 photos', 100, 25],
  ['album-parents1-25x50-100', 'Album Parents 1 — 25×50 — 100 photos', 100, 25],
  ['album-parents2-100', 'Albums Parents 2 — 25×50 — 100 photos', 100, 25],
  ['album-mairie-henné-25x50-150', 'Album Mairie Henné — 25×50 — 150 photos', 150, 32],
  ['album-mairie-henne-30x60-150', 'Album Mairie Henne — 30×60 — 150 photos', 150, 32],
  ['album-30x60-150', 'Album 30×60 — 150 photos', 150, 32],
  ['album-25x50-100', 'Album 25×50 — 100 photos', 100, 25],
  ['album-25x50-80', 'Album 25×50 — 80 photos', 80, 20],
];
attendus.forEach(([id, label, photos, pages]) => {
  const d = parId(id);
  check(id + ' existe', !!d);
  if (!d) return;
  check('  libellé exact : ' + label, d.label === label, d.label);
  check('  capacité ' + photos + ' photos', pk.packageCapacity(id) === photos, pk.packageCapacity(id));
  check('  ' + pages + ' pages', pk.packagePages(id) === pages, pk.packagePages(id));
});
check('aucun album oublié ni en trop', albums.length === 9, albums.length + ' album(s)');

console.log('\nB. Cohérence du catalogue');
check('chaque libellé annonce le bon nombre de photos',
  albums.every((d) => {
    const m = d.label.match(/(\d+)\s+photos/);
    return m && Number(m[1]) === pk.packageCapacity(d.id);
  }));
check('chaque album a un nombre de pages sauf mention contraire',
  albums.every((d) => typeof d.pages === 'number' && d.pages > 0));
check('les posters et agrandissements n’ont pas de pages',
  pk.PACKAGE_DEFS.filter((d) => d.type === 'qty').every((d) => !d.pages));
check('aucun identifiant en double',
  new Set(pk.PACKAGE_DEFS.map((d) => d.id)).size === pk.PACKAGE_DEFS.length);

console.log('\nC. Une seule source de vérité');
const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('l’admin ne recopie plus la liste des albums à la main',
  !/Album 30x80 — 200 photos/.test(adminHtml));
check('l’admin construit ses cases depuis le catalogue',
  /data-pk-grid/.test(adminHtml) && /chargerCataloguePackages/.test(adminJs));
check('le catalogue est exposé par une route protégée',
  /app\.get\('\/api\/admin\/packages', requireAdmin/.test(server));
check('le nombre de pages accompagne le libellé dans l’admin',
  /def\.pages \+ ' pages'/.test(adminJs));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
