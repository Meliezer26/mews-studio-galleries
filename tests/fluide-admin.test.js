'use strict';
/**
 * Banc d'essai : la fenêtre Photos doit rester fluide sur une grosse galerie.
 *
 * Incident du 18/11/2026 : sur 945 photos, « Photos » chargeait très lentement
 * puis l'affichage cassait vers la 30-40e photo. Cause : la grille créait 945
 * balises <img> d'un coup, donc 945 requêtes de vignettes en parallèle sur un
 * serveur gratuit à 0,1 vCPU. Les dernières requêtes expiraient.
 *
 * Règles vérifiées ici :
 *  - la grille se remplit par paquets, avec un plafond de requêtes simultanées ;
 *  - les vignettes sont demandées en 150 px (et non 240) pour l'admin ;
 *  - les images hors écran sont libérées ;
 *  - la fenêtre se ferme proprement (plus aucune requête après fermeture).
 */
const fs = require('fs');
const path = require('path');
const admin = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');

let ok = 0, ko = 0;
const check = (nom, cond, detail) => {
  if (cond) { ok++; console.log('  ✓ ' + nom); }
  else { ko++; console.log('  ✗ ÉCHEC : ' + nom + (detail ? ' — ' + detail : '')); }
};

console.log('\nA. Remplissage par paquets');
check('un paquet est défini (PM_PAQUET)', /var PM_PAQUET = \d+;/.test(admin));
check('la concurrence est plafonnée côté serveur', /Array\.from\(\{ length: Math\.min\(\d+/.test(
  fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
check('les images sont montées dans un fragment', /createDocumentFragment\(\)/.test(admin));
/* L'ancienne règle (défilement seul) laissait l'affichage bloqué à 52 photos en
   production. On vérifie désormais une règle qui ne dépend d'aucun événement. */
check('la suite se décide sur la position du dernier élément monté',
  /function verifierRemplissage/.test(admin) && /dernier\.getBoundingClientRect/.test(admin));
check('la vérification est répétée périodiquement', /setInterval\(verifierRemplissage, 900\)/.test(admin));
check('la répétition s’arrête à la fermeture', /arreterVeille\(\)/.test(admin));
check('le bouton « Afficher la suite » reste disponible', /pm-more/.test(admin) && /pm-more/.test(html));

console.log('\nB. Les vignettes arrivent par paquets, pas une par une');
const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('le serveur sert les vignettes par paquets', /app\.get\('\/api\/admin\/galleries\/:id\/thumbs'/.test(srvSrc));
check('le paquet est plafonné (60 au maximum)', /Math\.min\(Math\.max\(parseInt\(req\.query\.n \|\| '30'/.test(srvSrc));
check('le serveur interroge Google en parallèle', /Array\.from\(\{ length: Math\.min\(\d+/.test(srvSrc));
check('le navigateur demande le paquet en une fois', /galleries\/' \+ g\.id \+ '\/thumbs\?from=/.test(admin));
check('un repli image par image reste prévu', /dataset\.secours/.test(admin));

console.log('\nC. Vignettes légères');
check('l’admin demande des vignettes de 150 px', /size=150/.test(admin));
check('le serveur applique la taille demandée', /req\.query\.size \|\| '150'/.test(srvSrc));

console.log('\nD. Mémoire maîtrisée');
check('les images hors écran sont libérées', /function libererHorsEcran\(/.test(admin));
/* Incident du 18/11/2026 (soir) : après avoir fait défiler puis être remonté,
   les photos restaient vides — elles n'étaient jamais restituées. */
const blocLibere = (admin.match(/function libererHorsEcran\(\)[\s\S]*?\n  \}/) || [''])[0];
check('les images sont RESTITUÉES au retour à l’écran',
  /if \(!img\.getAttribute\('src'\) && img\.dataset\.src\)/.test(blocLibere));
check('l’adresse est conservée avant libération',
  /img\.dataset\.src = img\.getAttribute\('src'\)/.test(blocLibere));
check('le défilement est écouté sans bloquer (passive)', /\{ passive: true \}/.test(admin));

console.log('\nE. Fermeture propre');
check('fermer la fenêtre arrête le remplissage', /__pmFermer/.test(admin));
check('la fermeture est branchée dans closeModal()',
  /if \(id === 'm-photos'/.test(admin));

console.log('\nF. Zone de défilement présente dans la page');
check('la grille est dans .pm-scroll', /class="pm-scroll" id="pm-scroll"/.test(html));
check('la barre de progression existe', /id="pm-progress-bar"/.test(html));

console.log('\nG. Les vignettes ne sont plus demandées une par une au navigateur');
check('le champ `t` reste transmis (utile au diagnostic)', /t: f\.storage === 'drive'/.test(srvSrc));
check('les champs inutiles de Drive sont retirés', /function sanitizeFilesForAdmin/.test(srvSrc));
/* Tentative abandonnée le 18/11/2026 : faire charger les vignettes directement
   chez Google depuis la page admin. Google répond 403 (adresse signée exigeant
   un jeton que seul le serveur possède). Ne pas réessayer sans revérifier. */
check('aucune tentative de chargement direct chez Google dans la grille',
  !/img\.dataset\.src = f\.t/.test(admin), 'google refuse ces adresses (403)');

console.log('\nH. Mémoire de l’instance protégée');
const srv = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('le cache de vignettes est plafonné à 24 Mo', /MEDIA_CACHE_MAX_BYTES = 24 \* 1024 \* 1024/.test(srv));
check('un seul aperçu de couverture à la fois par galerie',
  /coverPreviewLocks/.test(srv) && /while \(coverPreviewLocks\.has/.test(srv));

console.log('\nI. L’instance ne meurt plus en silence');
check('un seuil mémoire est défini', /const SEUIL_MEMOIRE_OCTETS = \d+ \* 1024 \* 1024/.test(srv));
check('les caches sont vidés avant la limite', /MEDIA_CACHE\.clear\(\)/.test(srv));
check('la veille mémoire tourne périodiquement', /setInterval\(veillerSurLaMemoire/.test(srv));
check('la veille n’empêche pas l’arrêt du processus', /veilleMemoire\.unref/.test(srv));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
