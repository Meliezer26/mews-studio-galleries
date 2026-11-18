'use strict';
/**
 * Banc d'essai : ne plus jamais rester enfermé dehors de l'admin.
 *
 * Incident du 18/11/2026 : le mot de passe admin en production ne fonctionnait
 * plus. La sauvegarde GitHub contenait un mot de passe plus récent que celui
 * qu'on croyait utiliser (il est prioritaire sur la variable ADMIN_PASSWORD),
 * et la réparation au démarrage ne s'appliquait qu'à une config SANS mot de
 * passe. Résultat : impossible d'entrer, donc impossible de le changer depuis
 * l'interface.
 *
 * Règle vérifiée ici : une clé de secours dédiée (ADMIN_RECOVERY_PASSWORD) est
 * acceptée en plus du mot de passe courant, sans jamais le remplacer.
 */
const fs = require('fs');
const path = require('path');
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. La clé de secours existe');
check('une variable dédiée est lue', /ADMIN_RECOVERY_PASSWORD/.test(srv));
check('elle est chargée au démarrage', /cfgRecoveryHash = sec\.hashPassword\(process\.env\.ADMIN_RECOVERY_PASSWORD\)/.test(srv));

console.log('\nB. Elle ouvre la porte, sans rien casser');
check('la connexion accepte la clé de secours', /cfgRecoveryHash && sec\.verifyPassword/.test(srv));
check('le mot de passe courant reste accepté', /sec\.verifyPassword\(motDePasse, cfg\.adminPasswordHash\)/.test(srv));
check('aucune clé de secours définie = comportement normal', /cfgRecoveryHash &&/.test(srv));

console.log('\nC. Le mot de passe existant n’est jamais remplacé');
/* On isole UNIQUEMENT le bloc de la clé de secours (jusqu'à la relecture de la
   configuration) : la réparation existante, plus bas, a le droit d'écrire. */
const bloc = (srv.match(/if \(process\.env\.ADMIN_RECOVERY_PASSWORD\)[\s\S]*?const cfgH = store\.config\(\)/) || [''])[0];
check('la clé de secours n’écrit pas dans la configuration',
  !/adminPasswordHash\s*=/.test(bloc), 'elle doit être conservée en mémoire seulement');
check('la configuration n’est pas sauvegardée à cause d’elle', !/saveConfig/.test(bloc));

console.log('\nD. Le changement depuis l’interface reste possible');
check('la route de changement de mot de passe existe', /api\/admin\/password/.test(srv));
check('elle vérifie l’ancien mot de passe', /verifyPassword\(req\.body\.current/.test(srv));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
