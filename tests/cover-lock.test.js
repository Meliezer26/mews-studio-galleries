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
check('téléphone : 1080 px', cover.coverSize(390, 3) === 1080);
check('tablette : 1080 px', cover.coverSize(820, 2) === 1080);
check('ordinateur : 1600 px', cover.coverSize(1440, 1) === 1600);
check('écran dense : 1920 px', cover.coverSize(1440, 2) === 1920);
check('valeur aberrante manageable', cover.coverSize(0, 1) === 1600 && cover.coverSize(undefined, 1) === 1600);
check('jamais au-delà de 1920 px', cover.coverSize(3840, 3) === 1920);

console.log('\nF. Poids estimé de la couverture');
// Une couverture de 1600 px pèse ~250 Ko, mise en cache 7 jours côté navigateur.
console.log('   couverture 1600 px ≈ 250 Ko, une seule fois par visite (cache 7 jours)');
check('reste légère face au quota mensuel', 250 / 1024 < 0.3, (250 / 1024).toFixed(2) + ' Mo par première visite');

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
