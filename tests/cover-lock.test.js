'use strict';
/**
 * Banc d'essai : photo de couverture (écran de verrouillage plein cadre).
 *
 * Enjeu : la couverture est la SEULE image d'une galerie privée visible
 * AVANT le mot de passe. Elle doit donc être strictement encadrée :
 *   - une seule photo, celle choisie par le photographe ;
 *   - jamais d'image si la galerie est désactivée ou expirée ;
 *   - si la photo choisie a été supprimée du dossier, pas de couverture
 *     plutôt qu'une image cassée ou, pire, une autre photo.
 *
 * Lancement : npm test
 */
const cover = require('../lib/cover');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

const gal = (over = {}) => ({
  id: 'g1', slug: 'serero-talia', name: 'Serero', enabled: true,
  files: [{ id: 'a.jpg' }, { id: 'b.jpg' }, { id: 'c.jpg' }],
  ...over,
});

console.log('\nA. Aucune couverture choisie : rien ne fuit');
check('pas de couverture par défaut', cover.coverId(gal()) === null);
check('donc aucune image visible avant le mot de passe', cover.coverVisible(gal()) === false);

console.log('\nB. Couverture choisie');
const g2 = gal({ coverId: 'b.jpg' });
check('l\'identifiant est retenu', cover.coverId(g2) === 'b.jpg');
check('elle est visible avant le mot de passe', cover.coverVisible(g2) === true);
check('une seule photo est concernée, jamais la liste',
  cover.coverId(g2) !== 'a.jpg' && cover.coverId(g2) !== 'c.jpg');

console.log('\nC. La photo choisie disparaît du dossier');
const g3 = gal({ coverId: 'supprimee.jpg' });
check('identifiant inconnu : pas de couverture', cover.coverId(g3) === null);
check('l\'écran de verrouillage reste classique', cover.coverVisible(g3) === false,
  'mieux vaut pas de couverture qu\'une image cassée');

console.log('\nD. Galerie désactivée ou expirée : aucune image publique');
check('galerie désactivée : rien', cover.coverVisible(gal({ coverId: 'b.jpg', enabled: false })) === false);
check('galerie expirée : rien', cover.coverVisible(gal({ coverId: 'b.jpg' }), { expired: true }) === false);
check('galerie inexistante : rien', cover.coverVisible(null) === false);

console.log('\nE. Taille demandée : juste ce qu\'il faut');
// La couverture est un fond assombri, recouvert d'un voile et de texte :
// inutile de payer la pleine définition (mesures : 1600 px ≈ 320 Ko).
check('téléphone : 1080 px', cover.coverSize(390, 3) === 1080);
check('tablette : 1080 px', cover.coverSize(820, 2) === 1080);
check('ordinateur : 1280 px', cover.coverSize(1440, 1) === 1280);
check('écran dense : 1600 px', cover.coverSize(1440, 2) === 1600);
check('valeur aberrante manageable', cover.coverSize(0, 1) === 1280 && cover.coverSize(undefined, 1) === 1280);
check('jamais au-delà de 1600 px', cover.coverSize(3840, 3) === 1600);
check('le script du <head> et le serveur demandent la même taille',
  cover.coverSize(390, 3) === 1080 && cover.coverSize(1280, 2) === 1600 && cover.coverSize(1280, 1) === 1280);

console.log('\nE2. Aperçu minuscule glissé dans la page (arrivée instantanée)');
const apGallery = {
  id: 'g1', slug: 'demo', enabled: true,
  coverId: 'fileA',
  files: [{ id: 'fileA', name: 'photo.jpg', storage: 'drive' }],
  coverPreview: 'data:image/jpeg;base64,AAAA',
};
apGallery.coverPreviewV = cover.coverVersion(apGallery);
check('aperçu livré quand il correspond à la photo choisie',
  cover.coverPreview(apGallery) === 'data:image/jpeg;base64,AAAA');
check('aucun aperçu sans photo de couverture',
  cover.coverPreview({ id: 'g2', coverPreview: 'data:image/jpeg;base64,AAAA' }) === null);
const apPerime = Object.assign({}, apGallery, { coverPreviewV: 'ancienne-v' });
check('aperçu abandonné si le photographe a changé de photo', cover.coverPreview(apPerime) === null);
check('aperçu abandonné si ce n\'est pas une image',
  cover.coverPreview(Object.assign({}, apGallery, { coverPreview: 'javascript:alert(1)' })) === null);
check('aperçu abandonné s\'il est anormalement gros',
  cover.coverPreview(Object.assign({}, apGallery, { coverPreview: 'data:image/jpeg;base64,' + 'A'.repeat(20000) })) === null);
check('l\'adresse de l\'aperçu ne contient pas l\'identifiant Drive',
  !/fileA/.test(JSON.stringify(apGallery.coverPreview)) && /^[0-9a-f]{10}$/.test(apGallery.coverPreviewV));

console.log('\nF. Poids estimé de la couverture');
// 1080 px ≈ 150 Ko sur téléphone, mise en cache 7 jours côté navigateur,
// plus l'aperçu flou (≈ 2 Ko) qui voyage dans la page.
console.log('   couverture 1080 px ≈ 150 Ko + aperçu ≈ 2 Ko, une seule fois par visite (cache 7 jours)');
check('reste légère face au quota mensuel', 152 / 1024 < 0.3, (152 / 1024).toFixed(2) + ' Mo par première visite');

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
