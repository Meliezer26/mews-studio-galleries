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
check('un plafond de requêtes simultanées existe', /var PM_CONCURRENCE = \d+;/.test(admin));
check('les images sont montées dans un fragment', /createDocumentFragment\(\)/.test(admin));
check('la suite se charge au défilement', /reste < 400/.test(admin));
check('le bouton « Afficher la suite » reste disponible', /pm-more/.test(admin) && /pm-more/.test(html));

console.log('\nB. Aucune image demandée d’un coup');
check('l’adresse est posée en data-src, pas en src',
  /img\.dataset\.src = [^\n]+;\n/.test(admin) && !/img\.src = locale/.test(admin));
check('le chargement passe par chargerVignettes()', /function chargerVignettes\(/.test(admin));
check('une image n’est demandée que si son tour arrive',
  /while \(enCours < PM_CONCURRENCE && prochain < fileList\.length\)/.test(admin));

console.log('\nC. Vignettes plus légères');
check('l’admin demande des vignettes de 150 px', /thumb\?size=150/.test(admin));
check('il ne reste plus de demande à 240 px', !/thumb\?size=240/.test(admin));

console.log('\nD. Mémoire maîtrisée');
check('les images hors écran sont libérées', /function libererHorsEcran\(/.test(admin));
check('le défilement est écouté sans bloquer (passive)', /\{ passive: true \}/.test(admin));

console.log('\nE. Fermeture propre');
check('fermer la fenêtre arrête le remplissage', /__pmFermer/.test(admin));
check('la fermeture est branchée dans closeModal()',
  /if \(id === 'm-photos'/.test(admin));

console.log('\nF. Zone de défilement présente dans la page');
check('la grille est dans .pm-scroll', /class="pm-scroll" id="pm-scroll"/.test(html));
check('la barre de progression existe', /id="pm-progress-bar"/.test(html));

console.log('\nG. Les vignettes ne passent plus toutes par le serveur');
check('l’adresse Google signée est utilisée quand elle existe',
  /img\.dataset\.src = f\.t \?/.test(admin));
check('la taille demandée à Google est ramenée à 150 px',
  /=s150\$1/.test(admin));
check('un repli vers le serveur est prévu', /dataset\.secours/.test(admin));
check('le repli n’est tenté qu’une fois', /if \(el\.dataset\.secours && el\.src !== el\.dataset\.secours\)/.test(admin));
check('le serveur transmet le champ `t` à l’admin',
  /t: f\.storage === 'drive' \? \(f\.thumb \|\| null\) : null/.test(
    require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));
check('les champs inutiles de Drive sont retirés',
  /function sanitizeFilesForAdmin/.test(require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8')));

console.log('\nH. Mémoire de l’instance protégée');
const srv = require('fs').readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
check('le cache de vignettes est plafonné à 64 Mo', /MEDIA_CACHE_MAX_BYTES = 64 \* 1024 \* 1024/.test(srv));
check('un seul aperçu de couverture à la fois par galerie',
  /coverPreviewLocks/.test(srv) && /while \(coverPreviewLocks\.has/.test(srv));

console.log('\nI. L’instance ne meurt plus en silence');
check('un seuil mémoire est défini', /const SEUIL_MEMOIRE_OCTETS = \d+ \* 1024 \* 1024/.test(srv));
check('les caches sont vidés avant la limite', /MEDIA_CACHE\.clear\(\)/.test(srv));
check('la veille mémoire tourne périodiquement', /setInterval\(veillerSurLaMemoire/.test(srv));
check('la veille n’empêche pas l’arrêt du processus', /veilleMemoire\.unref/.test(srv));

console.log('\nRésultat : ' + ok + ' réussites, ' + ko + ' échec(s)');
process.exit(ko ? 1 : 0);
