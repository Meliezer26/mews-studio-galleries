# Mews Studio Galleries

**Galeries photos privées pour photographes, connectées à Google Drive.**

Vous déposez vos photos dans un dossier Google Drive → vous créez la galerie en un clic → vos clients reçoivent un lien privé protégé par mot de passe, avec favoris, visionneuse plein écran et téléchargement HD.

Vos photos **restent dans votre Drive** : le site les lit en direct, sans les dupliquer.

## Fonctionnement

```
┌──────────────┐   OAuth Google   ┌───────────────┐
│ Google Drive │ ◄──────────────► │ Mews Studio   │
│ vos dossiers │    lecture +     │ Galleries     │ ──► lien privé + mot de passe
└──────────────┘    vignettes     └───────────────┘     pour vos clients
```

- **Mode démo (par défaut)** : fonctionne immédiatement, photos stockées localement. Galerie d'exemple : `/g/demo` (mot de passe `demo123`).
- **Mode réel** : deux options — **compte de service Google** (recommandé : clé JSON dans `GOOGLE_SERVICE_ACCOUNT_JSON`, connexion automatique sans expiration, vous partagez vos dossiers avec le robot en « Éditeur ») ou **OAuth classique** (bouton « Se connecter avec Google », voir `SETUP.md`). Les galeries se lient à un dossier Drive (synchronisation automatique toutes les 5 minutes, upload direct possible).
- **Téléchargements sans bande passante hébergeur** : quand un client télécharge une photo, l'application crée un lien public temporaire (1 heure, révoqué automatiquement) et le fichier part **directement de Google au client**. L'affichage, lui, utilise des vignettes légères. Résultat : même avec des dossiers de 8 à 15 Go, le plan gratuit d'un hébergeur (5 Go/mois de bande passante) suffit largement — 0 €/mois. (Sans accès d'édition Drive, repli automatique sur le proxy serveur.)
- **Sauvegarde automatique** : galeries, réglages et comptes clients copiés à chaque modification, toutes les 5 minutes et au démarrage — vers un **dépôt GitHub privé** (`GITHUB_BACKUP_TOKEN` + `GITHUB_BACKUP_REPO`) ou, en mode OAuth, vers Google Drive (`mews-studio-data.json`). Restauration automatique si le disque de l'hébergeur est réinitialisé (clé de secours `GOOGLE_REFRESH_TOKEN` en OAuth).

## Fonctionnalités client

- **Galeries privées** : lien + mot de passe par galerie, expiration automatique.
- **Téléchargements contrôlés par le photographe** : un **interrupteur global** (Réglages → « Autoriser le téléchargement de toutes les photos ») coupe ou rétablit le téléchargement sur toutes les galeries d'un seul clic ; un réglage par galerie permet ensuite d'affiner ; le serveur bloque réellement l'accès aux fichiers quand c'est coupé. La liste des galeries propose un filtre (toutes / téléchargement actif / sans téléchargement) et un bandeau avertit quand l'interrupteur global est coupé.
- **Favoris** : cœurs, filtre, visionneuse plein écran, sélection multiple et téléchargement HD.
- **Watermark** : filigrane configurable par galerie (texte libre), affiché au centre gauche de chaque photo dans la mosaïque et la visionneuse. Les téléchargements restent propres.
- **Sélection d'albums** : le client coche les albums qu'il commande (200 / 150 / 100 photos — capacités maximales, plusieurs albums possibles), les remplit photo par photo avec compteurs et barres de progression.
- **Comptes clients** : en début de session, le client s'identifie (prénom + code personnel) ; la première visite crée son profil automatiquement. Ses albums en cours sont **sauvegardés en continu côté serveur** et retrouvés depuis n'importe quel appareil. Son **historique** liste ses sélections envoyées : il peut les reconsulter, les **recharger dans ses albums** (pour repartir d'une sélection passée) ou les **renvoyer par e-mail**.
- **Récapitulatif des clients (espace photographe)** : vue « Clients » avec, par galerie, chaque profil (nom, dernière activité, nombre de sélections, avancement des albums en cours), plus un badge du nombre de clients sur chaque carte de galerie.
- **Notifications e-mail automatiques (SMTP)** : quand un client envoie une sélection, le serveur notifie le photographe par e-mail (détail album par album). Configuration dans Réglages (hôte SMTP, identifiants, expéditeur, destinataire) avec bouton « Envoyer un e-mail de test » et suivi du dernier envoi. Fonctionne avec Gmail (mot de passe d'application), Brevo, Mailjet, etc.
- **Envoi par e-mail (côté client)** : « Envoyer ma sélection » ouvre l'application mail du client avec un récap pré-rempli (album par album : numéros + noms de fichiers) à destination de l'adresse configurée par le photographe. La sélection est aussi enregistrée dans l'historique du client et consultable dans l'espace photographe (modale Photos → « Sélections d'albums envoyées »).

## Démarrage rapide

```bash
npm install
npm start
# → http://localhost:3000
```

- **Site vitrine** : http://localhost:3000
- **Espace photographe** : http://localhost:3000/admin — mot de passe par défaut `admin123` (changez-le !)
- **Galerie de démonstration** : http://localhost:3000/g/demo — mot de passe `demo123`

## Configuration

Copiez `.env.example` vers `.env` :

| Variable | Rôle |
|---|---|
| `PORT` | Port du serveur (défaut `3000`) |
| `BASE_URL` | URL publique du site (nécessaire pour OAuth) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Identifiants OAuth Google |
| `GOOGLE_REDIRECT_URI` | Optionnel, défaut `BASE_URL/oauth2callback` |
| `ADMIN_PASSWORD` | Mot de passe admin initial (sinon `admin123`) |

→ **Procédure complète pour Google Drive : voir [SETUP.md](SETUP.md).**

## Structure

```
server.js            — serveur Express (API + proxys Drive)
lib/
  store.js           — stockage JSON (galeries, config, jetons)
  drive.js           — API Google Drive (OAuth, listes, vignettes, upload)
  mailer.js          — notifications e-mail (SMTP)
  security.js        — mots de passe (scrypt), jetons HMAC, rate limiting
  demo.js            — données de démonstration
public/
  index.html         — site vitrine
  gallery.html/.js   — galerie client (verrou, favoris, visionneuse, albums, compte client)
  admin.html/.js     — espace photographe (galeries, clients, Drive, réglages)
  styles.css         — design system
  demo-photos/       — photos de démonstration (générées)
public/portal-page.html — page portail « Accéder à ma galerie » (à coller dans Showit)
data/                — données locales (créé au démarrage)
```

## Intégration à votre site existant (Showit)

Ajouter un onglet « Galeries clients » sur votre site Showit : voir
**[INTEGRATION-SHOWIT.md](INTEGRATION-SHOWIT.md)** (lien de menu, page iframe avec
`EMBED_MODE=1`, ou page portail prête à coller).

## Mise en ligne (hébergement)

Mise en production pas-à-pas sur un hébergeur gratuit (adresse fixe,
HTTPS, sauvegarde automatique des données sur Google Drive) : voir
**[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)**.

## Sécurité

- Mots de passe hashés (scrypt), jamais stockés en clair.
- Session admin et déverrouillage de galerie par jetons HMAC signés.
- Limiteur de tentatives sur la connexion admin et le déverrouillage des galeries.
- Accès aux photos **uniquement** via le serveur : les fichiers Drive ne sont jamais exposés directement à Google.
- Jetons OAuth stockés côté serveur uniquement (jamais envoyés au navigateur).

## Limites actuelles & pistes d'évolution

- Galeries : lire un dossier Drive, expiration, mot de passe, favoris, téléchargements, watermark, sélection d'albums avec envoi de la liste par e-mail au photographe.
- Pistes : envoi d'e-mails automatiques côté serveur (SMTP) en complément du mailto, boutique de tirages, pages d'albums personnalisées, nom de domaine personnalisé.
