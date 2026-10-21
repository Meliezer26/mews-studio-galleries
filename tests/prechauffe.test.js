'use strict';
/* Banc : préchauffage mémoire des photos voisines (0 €, 0 stockage).
 * Objectif : le glissement d'une photo à l'autre ne reparte jamais de zéro.
 * Le principe doit rester SANS écriture disque et SANS coût pour le client. */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};
const bloc = (src.match(/\/\* --- Préchauffage mémoire[\s\S]*?\n\}\n/) || [''])[0];

console.log('\nA. Déclenchement');
check('le préchauffage part après une GRANDE photo seulement', /if \(size < 900\) return;/.test(bloc));
check('il est branché sur la route des photos', /res\.on\('finish', \(\) => prechauffer\(g, rec, size\)\);/.test(src));
check('il ne s’applique qu’aux photos du Drive', /rec\.storage !== 'drive'/.test(bloc));

console.log('\nB. Sobriété');
check('2 photos au maximum à la fois', /prechauffeEnCours\.size >= 2/.test(bloc));
check('plafond d’octets pré-chauffés (mémoire bornée)', /PRECHAUFFE_MAX = 100 \* 1024 \* 1024/.test(bloc));
check('jamais deux fois la même image', /if \(prechauffeAt\.has\(cle\)\) continue;/.test(bloc));
check('aucune écriture sur disque', !/writeFile|appendFile|createWriteStream/.test(bloc));
check('aucun appel à un stockage externe (Drive/GitHub)', !/upload|put|github/i.test(bloc));
check('une erreur de préchauffage ne remonte jamais', /catch\(\(\) => \{ \/\* pré-chauffage : jamais d'erreur visible \*\/ \}\)/.test(bloc));

console.log('\nC. Utilité');
check('la photo suivante est préparée', /\[1, -1, 2\]/.test(bloc));
check('la même taille que celle demandée est préparée', /thumbBytes\(c, size\)/.test(bloc));
check('le cache mémoire existant est réutilisé (pas un nouveau stockage)', /thumbBytes\(c, size\)/.test(bloc) && /mediaCachePut/.test(src));
check('les traces anciennes sont oubliées', /prechauffeAt\.size > 400/.test(bloc));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
