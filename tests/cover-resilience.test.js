'use strict';
/**
 * Banc d'essai : couverture qui « reste floue » (incident levy-jammot, 21/10).
 *
 * Symptôme : la page s'affichait avec l'aperçu flou, et la photo nette
 * n'arrivait jamais. Cause : la vignette Drive renvoyait 404 (lien expiré) et
 * le script, qui gardait l'aperçu « par sécurité », laissait le client devant
 * une photo floue indéfiniment.
 *
 * Ce banc vérifie les trois protections mises en place :
 *   A. le navigateur essaie plusieurs tailles avant d'abandonner ;
 *   B. s'il n'y arrive pas, l'écran de verrouillage classique reprend la main ;
 *   C. côté serveur : un échec n'est jamais mis en cache, et les liens de
 *      vignette sont rafraîchis (une seule fois toutes les 2 minutes).
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'gallery.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

/* --- Extraction de la fonction livrée au navigateur -------------------- */
const m = /function coverFallbacks\(url\) \{[\s\S]*?\n  \}/.exec(js);
if (!m) {
  console.error('✗ ÉCHEC : coverFallbacks() introuvable dans public/gallery.js');
  process.exit(1);
}
const sandbox = { String, Array };
vm.createContext(sandbox);
const coverFallbacks = vm.runInContext('(' + m[0] + ')', sandbox);

console.log('A. Plusieurs tailles tentées avant d’abandonner');
{
  const base = '/api/g/levy-jammot/cover?v=ae23d7deb3&size=1080';
  const liste = coverFallbacks(base);
  check('la taille demandée est essayée en premier', liste[0] === base, liste[0]);
  check('des tailles de repli sont prévues', liste.length >= 3, liste.length + ' essais');
  check('chaque essai garde la version de la photo (cache sûr)',
    liste.every((u) => u.indexOf('v=ae23d7deb3') > -1));
  check('aucune adresse essayée deux fois', new Set(liste).size === liste.length);
  check('les replis changent bien la taille',
    liste.slice(1).map((u) => /size=(\d+)/.exec(u)[1]).join(',') === '1600,1200,640',
    liste.slice(1).map((u) => /size=(\d+)/.exec(u)[1]).join(' → '));
  const autre = coverFallbacks('/api/g/x/cover?size=1280');
  check('fonctionne aussi sans version dans l’adresse',
    autre.length === 4 && /size=640/.test(autre[3]), autre[3]);
  check('une adresse sans paramètre de taille reste intacte',
    coverFallbacks('/api/g/x/cover')[0] === '/api/g/x/cover');
}

console.log('\nB. À défaut, l’écran classique reprend la main');
check('une fonction dédiée rend la main au formulaire', /function couvertureIndisponible\(bg, card\)/.test(js));
check('elle retire l’aperçu flou', /couvertureIndisponible\(bg, card\) \{[\s\S]{0,400}bg\.classList\.remove\('apercu'\)/.test(js));
check('elle réaffiche la carte classique', /couvertureIndisponible\(bg, card\) \{[\s\S]{0,400}card\.classList\.remove\('hidden'\)/.test(js));
check('elle est appelée quand toutes les tailles ont échoué',
  /i < essais\.length\) \{ img\.src = essais\[i\]; return; \}[\s\S]{0,300}couvertureIndisponible/.test(js));
check('un filet de sécurité existe si rien n’arrive du tout', /12000/.test(js) && /couvertureIndisponible/.test(js));
check('l’ancien comportement fautif (aperçu gardé pour toujours) a disparu',
  !/l'aperçu suffit/.test(js));

console.log('\nC. Serveur : un échec n’est jamais mis en cache');
check('la route répond avec un cache « no-store » en cas d’échec',
  /const fail = \(\) => \{ res\.setHeader\('Cache-Control', 'no-store'\); res\.status\(404\)\.end\(\); \};/.test(server));
check('tous les cas d’échec passent par cette réponse', /if \(!g\) return fail\(\);/.test(server) && /if \(!t \|\| !t\.ok\) \{/.test(server));
check('le 404 de couverture est journalisé pour le diagnostic',
  /\[cover\] image indisponible/.test(server));
check('les liens de vignette sont rafraîchis puis l’image redemandée',
  /syncGallery\(g, true\)/.test(server) && /rec = fileRecord\(g, fid\);\s*\n\s*if \(rec && rec\.thumb\)/.test(server));
check('la synchronisation est limitée à une fois toutes les 2 minutes',
  /coverResyncAt/.test(server) && /120000/.test(server));
check('la lecture des vignettes est centralisée (un seul point d’appel pour la couverture)',
  /async function thumbBytes\(rec, size\)/.test(server) &&
  /async function sendDriveThumb[\s\S]{0,400}await thumbBytes\(rec, size\)/.test(server));

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
