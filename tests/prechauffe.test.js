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
check('les deux voisines sont préparées', /const cibles = \[1, -1\]/.test(bloc));
check('la même taille que celle demandée est préparée', /thumbBytes\(c, size\)/.test(bloc));
check('le cache mémoire existant est réutilisé (pas un nouveau stockage)', /thumbBytes\(c, size\)/.test(bloc) && /mediaCachePut/.test(src));
check('les traces anciennes sont oubliées', /prechauffeAt\.size > 400/.test(bloc));

/* --- B. Le VRAI code, exécuté sur des données simulées -----------------
 * On extrait la fonction du serveur et on l'exécute : on vérifie ce qu'elle
 * fait, pas seulement qu'elle est écrite. */
console.log('\nD. Comportement du vrai code (données simulées)');
const debut = src.indexOf('function prechauffer(');
const fin = src.indexOf("\napp.get('/api/g/:slug/photo/:fid/vignette'");
const code = src.slice(debut, fin);
const prechauffe = new Function('thumbBytes', 'prechauffeAt', 'prechauffeEnCours',
  'prechauffeBytes', 'PRECHAUFFE_MAX', code + '; return prechauffer;');

function scenario(nb, etat) {
  const appels = [];
  const thumbBytes = (rec, size) => {
    appels.push(rec.id + '@' + size);
    return Promise.resolve({ ok: true, buf: Buffer.alloc(1000) });
  };
  const at = new Map();
  const enCours = new Set();
  const prec = prechauffe(thumbBytes, at, enCours, 0, 100 * 1024 * 1024);
  const files = Array.from({ length: nb }, (_, i) => ({ id: 'p' + i, thumb: 't' + i, storage: 'drive' }));
  const g = { files };
  return { appels, lancer: (i, size, rec) => prec(g, rec || files[i], size) };
}

(async () => {
  let s = scenario(8);
  s.lancer(3, 1080);
  await new Promise((r) => setTimeout(r, 10));
  check('elle prépare bien les deux voisines (4 et 2)',
    s.appels.slice().sort().join(',') === 'p2@1080,p4@1080', s.appels.join(','));
  check('elle ne repart jamais sur la photo affichée', !s.appels.some((a) => a.startsWith('p3@')));

  s = scenario(8);
  s.lancer(0, 1080);
  await new Promise((r) => setTimeout(r, 10));
  check('la boucle est fermée (de la 1re à la 8e)', s.appels.slice().sort().join(',') === 'p1@1080,p7@1080', s.appels.join(','));

  s = scenario(8);
  s.lancer(3, 400);
  await new Promise((r) => setTimeout(r, 10));
  check('une vignette de grille ne déclenche RIEN (sobriété)', s.appels.length === 0, s.appels.join(','));

  s = scenario(8);
  s.lancer(3, 1080, { id: 'p3', thumb: 't3', storage: 'local' });
  await new Promise((r) => setTimeout(r, 10));
  check('une photo locale ne déclenche rien', s.appels.length === 0, s.appels.join(','));

  s = scenario(8);
  s.lancer(3, 1080);
  s.lancer(3, 1080);
  await new Promise((r) => setTimeout(r, 10));
  check('deux ouvertures rapprochées ne doublent pas les demandes',
    new Set(s.appels).size === s.appels.length, s.appels.join(','));

  console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
  process.exit(ko ? 1 : 0);
})();
