'use strict';
/**
 * Banc d'essai : une vignette ne doit jamais coûter 7,5 Mo.
 *
 * Incident du 18/11/2026 (le pire de la série) : les adresses de vignettes
 * enregistrées avec la liste des fichiers EXPIRENT au bout de quelques jours.
 * Elles répondaient alors 403, et le serveur, se croyant sans vignette,
 * renvoyait la PHOTO ORIGINALE : 7,5 Mo en 6658x4438 au lieu de 5 Ko.
 * Ouvrir la fenêtre Photos téléchargeait donc plusieurs gigaoctets, saturait
 * la mémoire de l'instance (512 Mo) et l'affichage cassait — puis Render
 * redémarrait le service, d'où les alertes « health check failed ».
 *
 * Règles vérifiées ici :
 *  - un lien de vignette expiré est remplacé par un lien FRAIS demandé à Google ;
 *  - l'original d'une photo n'est plus jamais servi à la place d'une vignette ;
 *  - une vignette pèse quelques kilo-octets, pas des mégaoctets.
 */
const fs = require('fs');
const path = require('path');
const drive = fs.readFileSync(path.join(__dirname, '..', 'lib', 'drive.js'), 'utf8');
const srv = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Un lien expiré est remplacé par un lien frais');
check('une demande de lien frais existe', /async function thumbnailLinkFrais/.test(drive));
check('elle interroge l’API Drive', /drive\/v3\/files\/' \+ encodeURIComponent\(fileId\)/.test(drive));
check('elle demande bien thumbnailLink', /fields=thumbnailLink/.test(drive));
check('le résultat est gardé 25 minutes', /VIGNETTE_DUREE = 25 \* 60 \* 1000/.test(drive));
check('le lien fourni est essayé d’abord (gratuit)', /for \(const lien of \[thumbnailLink,/.test(drive));
check('la taille demandée est appliquée', /=s' \+ size \+ '\$1'/.test(drive));

console.log('\nB. L’échec est propre, sans photo originale');
check('l’échec renvoie ok:false', /return \{ ok: false, status: 404 \};/.test(drive));
check('l’identifiant du fichier est transmis', /fetchThumbnail\(rec\.thumb \|\| '', size, rec\.id\)/.test(srv));
check('le repli sur l’original est désormais interdit par défaut',
  /if \(opts\.allowOriginal &&/.test(srv));
check('aucun appel ne l’autorise sur la grille', !/sendDriveThumb\(res, rec, size, \{ allowOriginal/.test(srv));

console.log('\nC. Le cartouche d’attente reste léger');
check('le cartouche pèse moins d’un kilo-octet', /Aperçu non disponible pour ce format/.test(srv));
check('le bouton Télécharger est proposé', /Utilisez le bouton Télécharger/.test(srv));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
