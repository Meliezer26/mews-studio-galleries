'use strict';
/**
 * Banc d'essai : l'admin ne doit pas saturer le serveur.
 *
 * Incident du 18/11/2026 : en choisissant une photo de couverture, le
 * photographe recevait une erreur 429. Cause : la fenêtre Photos demande une
 * vignette PAR PHOTO, et chaque route relançait un listing complet du dossier
 * Drive (945 à 1 188 entrées). Des dizaines de listings simultanés sur un
 * serveur gratuit à 0,1 vCPU → requêtes en échec.
 *
 * Règles vérifiées ici :
 *  - un seul listing Drive à la fois par galerie (verrou) ;
 *  - une vignette n'en déclenche jamais un (sauf lien manquant) ;
 *  - rouvrir la fenêtre Photos ne relance pas de listing.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Un seul listing Drive à la fois');
check('un verrou par galerie existe', /const syncEnCours = new Map\(\)/.test(src));
check('le deuxième appelant attend le listing en cours',
  /const deja = syncEnCours\.get\(g\.id\);/.test(src) && /await deja;/.test(src));
check('le verrou est libéré même en cas d’erreur', /\.finally\(\(\) => syncEnCours\.delete\(g\.id\)\)/.test(src));
check('le listage lui-même est isolé dans listerDrive()', /async function listerDrive\(g\)/.test(src));

console.log('\nB. Une vignette ne relance pas un listing');
const blocThumb = (src.match(/app\.get\('\/api\/admin\/galleries\/:id\/photo\/:fid\/thumb'[\s\S]{0,900}/) || [''])[0];
check('la route vignette admin ne synchronise plus systématiquement',
  !/await syncGallery\(g\);/.test(blocThumb));
check('elle ne synchronise que si le lien de vignette manque',
  /if \(rec && rec\.storage === 'drive' && !rec\.thumb\)/.test(blocThumb));

console.log('\nC. La fenêtre Photos ne relance pas de listing');
check('l’admin demande la fiche avec frais=1', /galleries\/' \+ id \+ '\?frais=1'/.test(admin));
check('le serveur respecte frais=1', /req\.query\.frais === '1'/.test(src));

console.log('\nD. Le choix de couverture reste possible');
check('la route de couverture existe toujours et n’est pas limitée',
  /app\.post\('\/api\/admin\/galleries\/:id\/cover', requireAdmin/.test(src));
check('aucun limiteur de débit sur les routes d’écriture admin',
  !/app\.(post|put|patch)\('\/api\/admin[^']*',\s*requireAdmin,\s*[a-zA-Z]*[Ll]imiter/.test(src));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
