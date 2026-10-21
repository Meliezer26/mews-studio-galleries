'use strict';
/**
 * Banc d'essai : taille des images demandée selon l'écran.
 *
 * Enjeu (alerte bande passante Render du 20/10/2026) : les vignettes sont
 * relayées par le serveur, seul poste consommateur de bande passante.
 * Mesures réelles sur la galerie Serero (885 photos) :
 *   400 px = 47 Ko | 600 = 85 Ko | 1200 = 204 Ko | 1600 = 322 Ko.
 * Servir 1600 px à un téléphone n'apporte rien de visible et coûte 58 % de
 * plus qu'un 1200 px. Ce test vérifie la règle réellement embarquée dans
 * public/gallery.js (pas une copie).
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'gallery.js'), 'utf8');

// Extrait les fonctions telles qu'elles sont livrées aux navigateurs.
const m = /function displaySize\(kind\) \{[\s\S]*?\n  \}/.exec(src);
const mReseau = /function reseauLent\(\) \{[\s\S]*?\n  \}/.exec(src);
if (!m || !mReseau) {
  console.error('✗ ÉCHEC : displaySize() / reseauLent() introuvable(s) dans public/gallery.js');
  process.exit(1);
}
const fnSource = m[0];
const reseauSource = mReseau[0];

/** Évalue la fonction avec un écran donné (largeur CSS, densité de pixels)
 *  et, si on le précise, un débit réseau (navigator.connection). */
function sizeFor(kind, width, dpr, reseau) {
  const sandbox = {
    window: { innerWidth: width, devicePixelRatio: dpr },
    navigator: reseau ? { connection: reseau } : {},
    Math, RegExp,
  };
  vm.createContext(sandbox);
  vm.runInContext(reseauSource, sandbox);
  const fn = vm.runInContext('(' + fnSource + ')', sandbox);
  return fn(kind);
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

console.log('\nA. Téléphone (le cas dominant : galerie vue sur mobile)');
check('photo en grand : 1080 px', sizeFor('full', 390, 3) === 1080, sizeFor('full', 390, 3) + ' px');
check('grille : 400 px', sizeFor('grid', 390, 3) === 400, sizeFor('grid', 390, 3) + ' px');
check('petit téléphone : 1080 px en grand', sizeFor('full', 320, 2) === 1080);
check('grand téléphone : 1080 px en grand', sizeFor('full', 430, 3) === 1080);

console.log('\nA2. Réseau lent : on demande plus petit pour que ça arrive vite');
const lent = { effectiveType: '3g' };
check('photo en grand sur 3G : 900 px', sizeFor('full', 390, 3, lent) === 900, sizeFor('full', 390, 3, lent) + ' px');
check('grille sur 3G : 320 px', sizeFor('grid', 390, 3, lent) === 320, sizeFor('grid', 390, 3, lent) + ' px');
check('économiseur de données respecté', sizeFor('grid', 390, 3, { saveData: true, effectiveType: '4g' }) === 320);
check('4G : tailles normales', sizeFor('grid', 390, 3, { effectiveType: '4g' }) === 400 &&
  sizeFor('full', 390, 3, { effectiveType: '4g' }) === 1080);
check('sans information réseau, on garde la qualité', sizeFor('grid', 390, 3, null) === 400);

console.log('\nB. Tablette');
check('photo en grand : 1080 px', sizeFor('full', 820, 2) === 1080);

console.log('\nC. Ordinateur : qualité conservée');
check('photo en grand : 1600 px', sizeFor('full', 1440, 1) === 1600, sizeFor('full', 1440, 1) + ' px');
check('écran Retina : 1600 px', sizeFor('full', 1440, 2) === 1600);
check('grille standard : 400 px', sizeFor('grid', 1440, 1) === 400, sizeFor('grid', 1440, 1) + ' px');
check('grille Retina : 600 px', sizeFor('grid', 1440, 2) === 600);

console.log('\nD. Aucune taille fixe oubliée dans le fichier livré');
const fixes = (src.match(/\?size=1600|\?size=600/g) || []);
check('plus aucune taille codée en dur', fixes.length === 0, fixes.length + ' occurrence(s)');
check('displaySize utilisé pour la grille', /displaySize\('grid'\)/.test(src));
const usagesFull = (src.match(/displaySize\('full'\)/g) || []).length;
check('displaySize utilisé pour les 3 vues en grand', usagesFull === 3, usagesFull + ' usage(s)');

console.log('\nE. Gain estimé sur une galerie de 885 photos');
const ko = (px) => ({ 320: 41, 400: 60, 600: 113, 900: 180, 1080: 230, 1600: 322 })[px];
const grilleMobile = ko(sizeFor('grid', 390, 3)) * 885;
const grandMobile = ko(sizeFor('full', 390, 3)) * 885;
const avantMobile = ko(1600) * 885;
console.log('   une visite complète sur téléphone (grille seule) : ' + (grilleMobile / 1024).toFixed(0) + ' Mo');
console.log('   avant ce correctif, si chaque photo était ouverte en grand : ' + (avantMobile / 1024).toFixed(0) + ' Mo');
console.log('   après ce correctif, dans le même cas : ' + (grandMobile / 1024).toFixed(0) + ' Mo');
check('économie d\'au moins 25 % sur les vues en grand', grandMobile <= avantMobile * 0.75,
  Math.round((1 - grandMobile / avantMobile) * 100) + ' %');

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
