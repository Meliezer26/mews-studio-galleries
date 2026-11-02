'use strict';
/**
 * Banc d'essai : versions de sécurité.
 *
 * Enjeu (avis Render du 26/10/2026, avis eMudhra/Node.js) : un serveur Node
 * qui appelle des API en HTTPS doit tourner sur une version corrigée, sinon
 * un certificat compromis peut être accepté sans que HTTPS protège quoi que
 * ce soit. Et les bibliothèques fautives doivent être au-dessus du correctif.
 *
 * Ce banc ne fait AUCUN appel réseau (npm audit en dépendrait) : il vérifie
 * les versions minimales gravées dans package.json et le verrou de versions.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package-lock.json'), 'utf8'));
const installe = (nom) => {
  const p = lock.packages['node_modules/' + nom];
  return p ? p.version : null;
};
const cmp = (a, b) => {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((x[i] || 0) > (y[i] || 0)) return 1;
    if ((x[i] || 0) < (y[i] || 0)) return -1;
  }
  return 0;
};

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Node.js');
check('la version de Node est plancherée à un correctif (>= 22.23.4)',
  />=22\.23\.4/.test(pkg.engines && pkg.engines.node || ''), pkg.engines && pkg.engines.node);
const plancher = ((pkg.engines && pkg.engines.node) || '').replace(/^>=/, '').trim();
/* Render installe la version la plus récente qui satisfait ce plancher : il
   faut donc que le plancher soit AU MOINS un correctif publié de l'avis. */
check('le plancher est un correctif publié (22.23.4 / 24.22.1 / 26.12.1 ou plus)',
  ['22.23.4', '24.22.1', '26.12.1'].includes(plancher) || cmp(plancher, '26.12.1') >= 0,
  plancher);

console.log('\nB. Bibliothèques');
check('nodemailer au-dessus du correctif (10.1.3)', cmp(installe('nodemailer'), '10.1.3') > 0, installe('nodemailer'));
check('proxy-addr corrigé (falsification d’adresse IP, critique)', cmp(installe('proxy-addr'), '2.0.7') > 0, installe('proxy-addr'));
check('body-parser corrigé (déni de service)', cmp(installe('body-parser'), '1.20.8') > 0, installe('body-parser'));
check('qs corrigé', cmp(installe('qs'), '6.16.0') > 0, installe('qs'));
check('multer à jour', cmp(installe('multer'), '1.4.5-lts.2') >= 0, installe('multer'));

console.log('\nC. Ce que nous n’utilisons pas');
check('aucun PHP dans le projet (avis PHP2Shell sans objet)',
  !fs.existsSync(path.join(__dirname, '..', 'composer.json')) &&
  !fs.existsSync(path.join(__dirname, '..', 'Dockerfile')));
check('aucune décompression Brotli de données reçues (faille Node)',
  !/brotliDecompress|createBrotliDecompress/.test(
    fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
