'use strict';
/**
 * Banc d'essai : défilement des photos au doigt (visionneuse, téléphone).
 *
 * Enjeu : sur un téléphone, les flèches ‹ › encombrent la photo. Le client
 * fait défiler en glissant le pouce, comme dans la galerie de son téléphone.
 * Ce test vérifie la règle RÉELLEMENT embarquée dans public/gallery.js
 * (lbSwipeDir), et que le câblage (doigt, pointage, flèches masquées) est
 * toujours en place — une régression silencieuse rendrait la visionneuse
 * inutilisable sur mobile.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'gallery.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'gallery.html'), 'utf8');

const m = /function lbSwipeDir\(dx, dt, w\) \{[\s\S]*?\n  \}/.exec(js);
if (!m) {
  console.error('✗ ÉCHEC : lbSwipeDir() introuvable dans public/gallery.js');
  process.exit(1);
}
const sandbox = { Math };
vm.createContext(sandbox);
const swipeDir = vm.runInContext('(' + m[0] + ')', sandbox);

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

console.log("A. Le geste change bien de photo");
check('doigt vers la gauche (390 px) : photo suivante', swipeDir(-120, 300, 390) === 1);
check('doigt vers la droite : photo précédente', swipeDir(120, 300, 390) === -1);
check('geste ample sur grand écran', swipeDir(-260, 600, 1440) === 1);

console.log('\nB. Un geste hésitant ne fait rien');
check('petit déplacement lent : on ne bouge pas', swipeDir(-30, 700, 390) === 0);
check('déplacement moyen mais lent sous le seuil', swipeDir(-55, 800, 390) === 0);
check('sur grand écran, 100 px ne suffisent pas', swipeDir(-100, 500, 1440) === 0);
check('geste vertical quasi nul : on ne bouge pas', swipeDir(3, 200, 390) === 0);

console.log('\nC. La « chiquenaude » compte aussi');
check('geste court mais rapide : photo suivante', swipeDir(-35, 120, 1440) === 1);
check('même geste mais lent : rien', swipeDir(-35, 500, 1440) === 0);

console.log('\nD. Câblage dans la page');
check('le doigt est écouté (pointerdown) sur la scène', /lbStage|\.lb-stage/.test(js) && /addEventListener\('pointerdown'/.test(js));
check('le mouvement et le relâchement sont écoutés', /addEventListener\('pointermove'/.test(js) && /addEventListener\('pointerup'/.test(js));
check('un geste vertical est laissé au navigateur', /axe === 'y'/.test(js));
check('le clic de fermeture est neutralisé après un glissement', /lbClicIgnore/.test(js));
check('la glissière est branchée au démarrage de la page', /initLightboxSwipe\(\);/.test(js));
check('les flèches sont masquées sur téléphone', /@media \(max-width: 720px\)[\s\S]{0,600}\.lb-nav \{ display: none; \}/.test(html));
check('les flèches restent sur ordinateur', !/\.lb-nav \{ display: none; \}/.test(html.split('@media (max-width: 720px)')[0]));
check("l'indication de glissement existe et s'efface après usage", /id="lb-hint"/.test(html) && /mews-swipe-vu/.test(js));
check('le glissement est animé (sortie puis entrée)', /lbGlisser/.test(js) && /lb-slide/.test(js) && /lb-slide/.test(html));
check('le pouce peut glisser sans bloquer le défilement', /touch-action: pan-y/.test(html));

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
