'use strict';
/**
 * Banc d'essai : une seule adresse par page publique.
 *
 * Enjeu (Search Console, 2/11/2026) : « Duplicate, Google chose different
 * canonical than user ». La même page répondait en 200 sur plusieurs adresses
 * (/connexion, /connexion/, /Connexion, /connexion.html,
 * /politique-de-confidentialite…). Chaque variante doit maintenant rediriger
 * en 301 vers l'adresse unique, et les adresses de service (API, galeries,
 * admin, point de vie) ne doivent JAMAIS être redirigées.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
/* On extrait la fonction du serveur et on l'exécute : on vérifie ce qu'elle
   fait, pas seulement qu'elle est écrite. */
const debut = src.indexOf('const PAGES_CANONIQUES = {');
const fin = src.indexOf('app.use((req, res, next) => {', debut);
const code = src.slice(debut, fin);
const fabrique = new Function(code + '; return { pageCanonique, PAGES_CANONIQUES };')();
const canonique = fabrique.pageCanonique;

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Variantes ramenées à une seule adresse');
[
  ['/connexion/', '/connexion'],
  ['/connexion.html', '/connexion'],
  ['/Connexion', '/connexion'],
  ['/CONNEXION.HTML', '/connexion'],
  ['/confidentialite/', '/confidentialite'],
  ['/confidentialite.html', '/confidentialite'],
  ['/politique-de-confidentialite', '/confidentialite'],
  ['/politique-de-confidentialite/', '/confidentialite'],
  ['/index.html', '/'],
  ['/index', '/'],
].forEach(([entree, attendu]) => {
  check(entree + ' → ' + attendu, canonique(entree) === attendu, canonique(entree));
});

console.log('\nB. Les adresses légitimes ne bougent pas');
check('/connexion reste /connexion (200, pas de redirection)',
  canonique('/connexion') === '/connexion' && canonique('/connexion') === '/connexion');
check('la racine reste la racine', canonique('/') === '/');
check('les galeries ne sont jamais touchées', canonique('/g/acoca-isaac') === null);
check('l’admin non plus', canonique('/admin') === null);
check('les API non plus', canonique('/api/g/demo/photos') === null);
check('le point de vie non plus (keepalive)', canonique('/healthz') === null);
check('le plan du site et robots.txt non plus',
  canonique('/sitemap.xml') === null && canonique('/robots.txt') === null);
check('une adresse inconnue n’est pas redirigée',
  canonique('/politique-de-confidentialites') === null);

console.log('\nC. Côté pages');
check('chaque page publique déclare sa canonique',
  ['index.html', 'connexion.html', 'confidentialite.html'].every((f) =>
    /rel="canonical"/.test(fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'))));
const sitemap = fs.readFileSync(path.join(__dirname, '..', 'public', 'sitemap.xml'), 'utf8');
check('le plan du site ne contient que des adresses canoniques',
  !/\.html|\/connexion\/|politique-de-confidentialite/.test(sitemap));
check('le plan du site porte une date de mise à jour récente',
  /<lastmod>2026-\d\d-\d\d<\/lastmod>/.test(sitemap) && /2026-11/.test(sitemap));

console.log('\nD. Découvrabilité (Search Console : « Découverte, actuellement non indexée »)');
const accueil = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
check('l’accueil mène à l’espace clients', /<a href="\/connexion"/.test(accueil));
check('et depuis le pied de page aussi', (accueil.match(/href="\/connexion"/g) || []).length >= 2,
  (accueil.match(/href="\/connexion"/g) || []).length + ' lien(s)');
check('l’accueil mène à la page de confidentialité', /href="\/confidentialite"/.test(accueil));
check('aucune adresse de galerie n’est liée comme page indexable (robots.txt la bloque)',
  /Disallow: \/g\//.test(fs.readFileSync(path.join(__dirname, '..', 'public', 'robots.txt'), 'utf8')));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
