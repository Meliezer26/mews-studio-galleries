'use strict';
/**
 * Banc d'essai : limiteurs de tentatives (erreur 429).
 *
 * Incident du 21/10/2026 : le photographe s'est bloqué lui-même en se
 * connectant normalement. Deux causes corrigées ici :
 *   1. une tentative RÉUSSIE ne remettait pas le compteur à zéro ;
 *   2. le message ne disait pas combien de temps attendre.
 *
 * Lancement : npm test
 */
const sec = require('../lib/security');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

console.log('\nA. Le seuil bloque bien au-delà de la limite');
let l = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });
for (let i = 1; i <= 10; i++) {
  if (!l('1.2.3.4')) { check('les 10 premiers essais passent', false, 'bloqué au ' + i); break; }
}
check('les 10 premiers essais passent', true);
check('le 11e est refusé', l('1.2.3.4') === false);
check('une autre adresse reste libre', l('5.6.7.8') === true, 'pas de blocage collectif');

console.log('\nB. Une réussite remet le compteur à zéro (le correctif)');
l = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });
for (let i = 0; i < 9; i++) l('9.9.9.9');       // 9 essais, presque bloqué
check('après 9 essais, on peut encore essayer', l('9.9.9.9') === true);
l.reset('9.9.9.9');                              // connexion réussie
let ok = true;
for (let i = 0; i < 10; i++) if (!l('9.9.9.9')) ok = false;
check('après une réussite, 10 nouveaux essais passent', ok,
  'sans cela, l\'usage normal bloquait le photographe');

console.log('\nC. Usage normal répété : plus jamais de blocage');
l = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 10 });
ok = true;
for (let i = 0; i < 50; i++) { l('7.7.7.7'); l.reset('7.7.7.7'); }
check('50 connexions réussies d\'affilée : jamais bloqué', ok && l('7.7.7.7') === true);

console.log('\nD. Temps d\'attente annoncé');
l = sec.rateLimiter({ windowMs: 5 * 60 * 1000, max: 1 });
l('3.3.3.3'); l('3.3.3.3');                      // 2e essai : refusé
const s1 = l.retryAfter('3.3.3.3');
check('un temps restant est fourni', s1 > 0 && s1 <= 300, s1 + ' s');
check('proche des 5 minutes', s1 > 290, s1 + ' s');
check('adresse inconnue : zéro seconde', l.retryAfter('0.0.0.0') === 0);

console.log('\nE. Le message est compréhensible');
check('secondes', /Réessayez dans 42 secondes/.test(sec.tooManyMessage(42)), sec.tooManyMessage(42));
check('singulier', /1 seconde\b/.test(sec.tooManyMessage(1)), sec.tooManyMessage(1));
check('minutes', /Réessayez dans 3 minutes/.test(sec.tooManyMessage(150)), sec.tooManyMessage(150));
check('jamais « plus tard » sans chiffre', !/plus tard/.test(sec.tooManyMessage(90)));
check('valeur absente : pas de plantage', /seconde/.test(sec.tooManyMessage(0)), sec.tooManyMessage(0));

console.log('\nF. La fenêtre glisse après expiration');
l = sec.rateLimiter({ windowMs: 60, max: 1 });
l('4.4.4.4'); l('4.4.4.4');
check('bloqué tout de suite', l('4.4.4.4') === false);
const debut = Date.now();
while (Date.now() - debut < 70) { /* attente de 70 ms */ }
check('débloqué après la fenêtre', l('4.4.4.4') === true);

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
