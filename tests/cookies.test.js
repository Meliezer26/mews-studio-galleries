'use strict';
/**
 * Banc d'essai : cookies et vie privée.
 *
 * Enjeu : le site ne doit poser AUCUN cookie avant que le client tape son mot
 * de passe, et les deux seuls cookies existants (galerie + admin) sont
 * strictement techniques. Ils doivent donc être marqués `Secure` (HTTPS
 * seulement), ce qui les met hors de portée d'une connexion en clair, et
 * restent exemptés de consentement : aucun bandeau n'est nécessaire.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
const pages = ['gallery.html', 'index.html', 'connexion.html', 'confidentialite.html']
  .map((f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8'))
  .join('\n');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Aucun traceur, aucun bandeau');
check('aucun script d’analyse ou de publicité dans les pages',
  !/googletagmanager|google-analytics|\bgtag\(|facebook\.(net|com)\/|hotjar|matomo|doubleclick/i.test(pages));
check('aucun bandeau de consentement (inutile : cookies exemptés)',
  !/cookie[-_ ]?consent|accepter (les|nos) cookies|consentement aux cookies/i.test(pages));
check('la page de confidentialité décrit bien ces cookies',
  /cookies de session strictement techniques/i.test(pages));

console.log('\nB. Les deux cookies seulement');
/* Le troisième « Set-Cookie » est la SUPPRESSION du cookie admin à la
   déconnexion (Max-Age=0) : ce n'est pas un cookie de plus. */
const pose = (src.match(/setHeader\('Set-Cookie'/g) || []).length;
const suppr = (src.match(/SESSION_COOKIE\}=; Path=\/; Max-Age=0/g) || []).length;
check('deux cookies posés, pas un de plus', pose - suppr === 2, (pose - suppr) + ' cookie(s)');
check('cookie de galerie : HttpOnly', /UNLOCK_COOKIE\}=[^`]*Path=\/; HttpOnly/.test(src));
check('cookie de galerie : Secure en HTTPS', /'Lax' \+ cookieSecure\(req\)/.test(src));
check('cookie admin : HttpOnly', /SESSION_COOKIE\}=\$\{token\}; Path=\/; HttpOnly/.test(src));
check('cookie admin : Secure en HTTPS', /SameSite=Lax\$\{cookieSecure\(req\)\}/.test(src));
check('Secure suit la connexion réelle (admin local en http:// préservé)',
  /function cookieSecure\(req\)/.test(src) && /x-forwarded-proto/.test(src) && /req\.secure/.test(src));
check('le mode intégré (iframe) reste SameSite=None; Secure', /EMBED_MODE === '1' \? 'None; Secure'/.test(src));

console.log('\nC. Durées');
check('galerie mémorisée 30 jours', /UNLOCK_MAX_AGE = 30 \* 24 \* 3600 \* 1000/.test(src));
check('admin mémorisé 7 jours', /SESSION_MAX_AGE = 7 \* 24 \* 3600 \* 1000/.test(src));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
