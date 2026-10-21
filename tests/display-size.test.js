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

// Extrait la fonction telle qu'elle est livrée aux navigateurs.
const m = /function displaySize\(kind\) \{[\s\S]*?\n  \}/.exec(src);
if (!m) {
  console.error('✗ ÉCHEC : displaySize() introuvable dans public/gallery.js');
  process.exit(1);
}
const fnSource = m[0];

/** Évalue la fonction avec un écran donné (largeur CSS, densité de pixels). */
function sizeFor(kind, width, dpr) {
  const sandbox = { window: { innerWidth: width, devicePixelRatio: dpr }, Math };
  vm.createContext(sandbox);
  const fn = vm.runInContext('(' + fnSource + ')', sandbox);
  return fn(kind);
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

console.log('\nA. Téléphone (le cas dominant : galerie vue sur mobile)');
check('photo en grand : 1200 px', sizeFor('full', 390, 3) === 1200, sizeFor('full', 390, 3) + ' px');
check('grille : 400 px', sizeFor('grid', 390, 3) === 400, sizeFor('grid', 390, 3) + ' px');
check('petit téléphone : 1200 px en grand', sizeFor('full', 320, 2) === 1200);
check('grand téléphone : 1200 px en grand', sizeFor('full', 430, 3) === 1200);

console.log('\nB. Tablette');
check('photo en grand : 1200 px', sizeFor('full', 820, 2) === 1200);

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
const ko = (px) => ({ 400: 47, 600: 85, 1200: 204, 1600: 322 })[px];
const grilleMobile = ko(sizeFor('grid', 390, 3)) * 885;
const grandMobile = ko(sizeFor('full', 390, 3)) * 885;
const avantMobile = ko(1600) * 885;
console.log('   une visite complète sur téléphone (grille seule) : ' + (grilleMobile / 1024).toFixed(0) + ' Mo');
console.log('   avant ce correctif, si chaque photo était ouverte en grand : ' + (avantMobile / 1024).toFixed(0) + ' Mo');
console.log('   après ce correctif, dans le même cas : ' + (grandMobile / 1024).toFixed(0) + ' Mo');
check('économie d\'au moins 35 % sur les vues en grand', grandMobile <= avantMobile * 0.65,
  Math.round((1 - grandMobile / avantMobile) * 100) + ' %');

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
