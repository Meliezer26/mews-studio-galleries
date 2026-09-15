'use strict';
/**
 * Catalogue unique des packages vendus (albums, posters, agrandissements).
 *
 * C'est LA source des descriptifs exacts affichés partout :
 *   - cartes de sélection côté client (ex : « Album 30×60 — 150 photos »),
 *   - e-mails photographe et client,
 *   - noms des sous-dossiers Drive,
 *   - récapitulatif admin.
 *
 * Un package ALBUM coché (type 'check') active une carte de sélection
 * côté client : la capacité est le nombre de photos du package (suffixe
 * -100/-150/-200 de l'id). Un package d'impression (type 'qty') crée une
 * carte dont la capacité est la quantité commandée (ex : 2 posters →
 * choisir 2 photos).
 *
 * Les ids « 200 »/« 150 »/« 100 » sont les anciens formats génériques
 * (galeries créées avant les packages) — conservés pour rétro-compatibilité.
 */
const PACKAGE_DEFS = [
  { id: 'album-30x80-200', type: 'check', label: 'Album 30\u00d780 \u2014 200 photos' },
  { id: 'album-maries-offert-25x50-100', type: 'check', label: 'Album Mariés offert \u2014 25\u00d750 \u2014 100 photos' },
  { id: 'album-parents1-25x50-100', type: 'check', label: 'Album Parents 1 \u2014 25\u00d750 \u2014 100 photos' },
  { id: 'album-parents2-100', type: 'check', label: 'Albums Parents 2 \u2014 25\u00d750 \u2014 100 photos' },
  { id: 'album-mairie-henn\u00e9-25x50-150', type: 'check', label: 'Album Mairie Henn\u00e9 \u2014 25\u00d750 \u2014 150 photos' },
  { id: 'album-mairie-henne-30x60-150', type: 'check', label: 'Album Mairie Henne \u2014 30\u00d760 \u2014 150 photos' },
  { id: 'album-30x60-150', type: 'check', label: 'Album 30\u00d760 \u2014 150 photos' },
  { id: 'album-25x50-100', type: 'check', label: 'Album 25\u00d750 \u2014 100 photos' },
  { id: 'posters-30x45', type: 'qty', label: 'Posters 30\u00d745' },
  { id: 'agrandissements-20x30', type: 'qty', label: 'Agrandissements 20\u00d730' },
];

const byId = {};
PACKAGE_DEFS.forEach((def) => { byId[def.id] = def; });

/** Anciens formats génériques (avant les packages) — mêmes libellés qu'avant. */
const LEGACY_ALBUM_LABELS = {
  '200': 'Album 200 photos',
  '150': 'Album 150 photos',
  '100': 'Album 100 photos',
};

/** Descriptif exact d'un package (ou d'un ancien type générique). */
function packageLabel(id) {
  const def = byId[id];
  if (def) return def.label;
  if (LEGACY_ALBUM_LABELS[id]) return LEGACY_ALBUM_LABELS[id];
  return 'Album ' + id;
}

/** Capacité d'un package album = nombre de photos (suffixe -100/-150/-200). */
function packageCapacity(id) {
  const m = String(id).match(/-(\d+)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return [100, 150, 200].includes(n) ? n : 0;
}

/** Normalise les packages envoyés par l'admin (coches + quantités). */
function sanitizePackages(input) {
  const src = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const out = {};
  for (const def of PACKAGE_DEFS) {
    if (def.type === 'check') {
      if (src[def.id]) out[def.id] = true;
    } else {
      const n = Math.max(0, Math.min(999, parseInt(src[def.id], 10) || 0));
      if (n > 0) out[def.id] = n;
    }
  }
  return out;
}

module.exports = { PACKAGE_DEFS, packageLabel, packageCapacity, sanitizePackages };
