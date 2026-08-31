# Connecter Mews Studio Galleries à votre Google Drive

> ✅ **Déjà installé en production** (31/08/2026) : compte de service
> `mews-235@mews-studio-galleries.iam.gserviceaccount.com`, dossiers
> partagés « 3 Mews Galleries » (avec « test 1 » et « test 2 »),
> sauvegarde automatique sur le dépôt GitHub privé
> `Meliezer26/mews-studio-backup`. Ce document sert de référence.

Deux options — **recommandée : le compte de service** (une seule fois,
aucune re-connexion, connexion automatique) ; alternative : OAuth
classique (bouton « Se connecter avec Google », à re-cliquer environ
une fois par semaine pour une application non vérifiée par Google).

---

## Option A (recommandée) — Compte de service

Le compte de service est un « robot Google » créé dans votre projet
Google Cloud. L'application se connecte automatiquement avec sa clé,
**sans écran de consentement et sans expiration**. Vous partagez vos
dossiers de photos avec lui : c'est exactement comme les partager avec
une personne.

### A1. Créer un projet Google Cloud

1. Ouvrez https://console.cloud.google.com/ et connectez-vous avec votre compte Google (celui qui possède le Drive de photos).
2. En haut à gauche, dans le sélecteur de projet → **Nouveau projet**.
3. Nommez-le `Mews Studio Galleries`, cliquez **Créer** puis sélectionnez-le.

### A2. Activer l'API Google Drive

1. Menu **APIs & services → Bibliothèque**.
2. Recherchez **Google Drive API** → ouvrez-la → **Activer**.

### A3. Créer le compte de service et sa clé

1. Menu **APIs & services → Identifiants → + Créer des identifiants → Compte de service**.
2. Nom : `mews-studio` (l'adresse e-mail se génère toute seule : `mews-studio@<projet>.iam.gserviceaccount.com` — **notez-la**, elle servira à l'étape A4).
3. Validez (aucun rôle à ajouter : les droits viennent du partage Drive).
4. Dans la liste, cliquez le compte de service → onglet **Clés → Ajouter une clé → Créer une clé → JSON**.
5. Un fichier `.json` se télécharge (il contient la clé privée). Ouvrez-le avec le Bloc-notes et copiez **tout son contenu**.

### A4. Configurer l'application

1. Sur Render (ou votre hébergeur) : variable d'environnement
   `GOOGLE_SERVICE_ACCOUNT_JSON` = **le contenu complet du fichier JSON**
   (collé sur une seule ligne).
   *(En local : collez-le dans le fichier `.env`.)*
2. Redémarrez l'application (Render redéploie automatiquement).

### A5. Partager vos dossiers de photos avec le robot

1. Sur https://drive.google.com, cliquez droit sur le dossier racine de vos photos → **Partager**.
2. Dans « Ajouter des personnes et des groupes », collez l'adresse e-mail du compte de service (`mews-studio@…gserviceaccount.com`) → rôle **Éditeur** → **Envoyer**.
3. Faites de même pour chaque dossier de photos (ou partagez un dossier parent unique qui les contient tous — le partage se propage aux sous-dossiers).

✅ Terminé : l'espace photographe affiche « Google Drive connecté » avec
l'adresse du compte de service, vos dossiers apparaissent, les
téléchargements clients passent par des liens Google directs et la
sauvegarde automatique fonctionne.

> 🔒 **Sécurité** : la clé JSON donne accès UNIQUEMENT aux dossiers que
> vous partagez avec le robot. Gardez la clé privée secrète (c'est une
> variable d'environnement, jamais dans le code ni sur GitHub).
> **Important** : ne partagez pas de dossiers sensibles (papiers,
> factures…) avec le robot.

---

## Option B (alternative) — OAuth classique

> ⚠️ Application non vérifiée par Google (usage personnel) : le jeton de
> renouvellement expire au bout de **7 jours**. L'espace photographe
> affiche alors un bandeau « reconnecter Google Drive » — 30 secondes à
> refaire chaque semaine. Si cela vous dérange, utilisez l'option A.

## B1. Créer un projet Google Cloud

1. Ouvrez https://console.cloud.google.com/ et connectez-vous avec votre compte Google (celui qui possède le Drive de photos).
2. En haut à gauche, dans le sélecteur de projet → **Nouveau projet**.
3. Nommez-le `Mews Studio Galleries`, cliquez **Créer** puis sélectionnez-le.

## B2. Activer l'API Google Drive

1. Menu **APIs & services → Bibliothèque**.
2. Recherchez **Google Drive API** → ouvrez-la → **Activer**.

## B3. Créer l'identifiant OAuth

1. Menu **APIs & services → Écran de consentement OAuth** :
   - Choisissez **Externe**, remplissez le nom de l'application (`Mews Studio Galleries`), votre e-mail de contact, puis validez.
   - Onglet **Niveaux d'accès** (audience) : ajoutez votre propre adresse e-mail comme utilisateur de test, puis cliquez **Enregistrer**. *(Pas besoin de demander la validation Google : vous êtes le seul utilisateur.)*
2. Menu **APIs & services → Identifiants → + Créer des identifiants → ID client OAuth** :
   - Type d'application : **Application Web**
   - **URI de redirection autorisés** : `http://localhost:3000/oauth2callback` (ou `https://votre-domaine.fr/oauth2callback` en production)
   - Créez, puis notez **l'ID client** et le **code secret du client**.

## B4. Renseigner le fichier `.env`

```bash
cp .env.example .env
```

Puis éditez `.env` :

```
BASE_URL=http://localhost:3000
GOOGLE_CLIENT_ID=xxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxxxx
```

## B5. Connecter le compte depuis l'application

1. Relancez le serveur : `npm start`.
2. Ouvrez http://localhost:3000/admin et connectez-vous.
3. Onglet **Google Drive → Se connecter avec Google**.
4. Google affiche l'écran « **Google n'a pas validé cette application** » (normal pour un usage personnel) : cliquez **Paramètres avancés → Continuer vers Mews Studio Galleries**.
5. Autorisez l'accès (cochez la case pour rester connecté — l'application garde le jeton de renouvellement).
6. De retour dans l'application, vos dossiers Drive apparaissent.
7. Ouvrez « 💾 Sauvegarde automatique sur Drive » dans l'onglet Google Drive et copiez la **clé de secours** dans la variable `GOOGLE_REFRESH_TOKEN` de votre hébergeur (restauration automatique après un redéploiement).

## 6. Créer une galerie liée à un dossier Drive

1. **Galeries → Nouvelle galerie**.
2. Source des photos : **Dossier Google Drive**, choisissez le dossier.
3. Renseignez le nom, le mot de passe client, la date d'expiration éventuelle → **Créer**.
4. Le lien est copié : envoyez-le à votre client avec le mot de passe.

La galerie se resynchronise automatiquement toutes les 5 minutes (ou via le bouton **Sync** / **Synchroniser avec Drive**).

## Notes

- **Accès demandés** :
  - *Compte de service* : le robot accède uniquement aux dossiers que vous lui partagez (en « Éditeur »). Aucun accès au reste de votre Drive. ⚠️ Limite Google : un compte de service ne peut **pas écrire** de fichiers dans les dossiers (pas de quota de stockage) — l'ajout de photos se fait donc **directement sur drive.google.com**, puis « Synchroniser avec Drive » dans l'espace photographe. La sauvegarde des données, elle, part sur GitHub (voir plus bas).
  - *OAuth* : `drive.readonly` (lire), `drive.file` (déposer dans les dossiers choisis) et `drive` (accès complet, utilisé uniquement pour poser puis révoquer les **liens de téléchargement temporaires** — voir ci-dessous).
- **Téléchargements directs (bande passante gratuite)** : quand un client télécharge une photo, l'application crée un lien public temporaire valable **1 heure** (permission « toute personne disposant du lien », révoquée automatiquement ensuite) et le client reçoit le fichier **directement depuis les serveurs de Google**. Le serveur d'hébergement ne transmet jamais les fichiers lourds : des dossiers de 8–15 Go ne consomment pas sa bande passante.
- **Déconnexion** (OAuth uniquement) : bouton **Déconnecter** dans l'onglet Google Drive, ou révoquez l'accès depuis https://myaccount.google.com/permissions. *(Compte de service : supprimez la clé dans la console Google et/ou retirez le partage des dossiers.)*
- **Production** : voir **[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)** — mise en ligne pas-à-pas sur Render (gratuit, HTTPS). En résumé : remplacez `BASE_URL` par votre domaine, ajoutez l'URI de redirection correspondant dans la console Google.
- **Sauvegarde automatique** : les données (galeries, réglages, comptes clients) sont copiées à chaque modification, toutes les 5 minutes et à chaque démarrage :
  - **GitHub (recommandé, utilisé en production)** : dépôt privé dédié + variables `GITHUB_BACKUP_TOKEN` (jeton avec permission Contents: Read and write) et `GITHUB_BACKUP_REPO` (« propriétaire/dépôt »). Fonctionne dans tous les modes, y compris compte de service.
  - **Google Drive** (OAuth uniquement) : fichier `mews-studio-data.json` dans un dossier partagé ; la variable `GOOGLE_REFRESH_TOKEN` permet la restauration automatique après une perte du disque.
  - La restauration est automatique au démarrage si le disque de l'hébergeur a été réinitialisé.
- **Photo Drive ≠ photo locale** : quand une galerie est liée à un dossier Drive, ce sont bien les fichiers de ce dossier qui sont affichés. Quand vous importez via l'interface, les photos sont déposées dans ce même dossier Drive.
- **Formats sans aperçu (RAW…)** : pas de vignette affichée (cartouche « Aperçu non disponible ») pour éviter de transfuser des fichiers énormes — le client utilise le bouton Télécharger (lien Google direct).
- ⚠️ **Ne laissez pas la clé JSON du compte de service dans un dossier partagé** avec le robot (elle serait téléchargeable) : gardez-la uniquement dans les variables d'environnement de l'hébergeur.

## Notifications e-mail (SMTP)

Quand un client envoie une sélection d'albums, le serveur peut vous notifier automatiquement par e-mail.

1. Dans l'espace photographe : **Réglages → Notifications e-mail (SMTP)**.
2. Cochez **« M'envoyer un e-mail à chaque sélection reçue »**.
3. Renseignez votre serveur SMTP :

| Fournisseur | Hôte | Port | Notes |
|---|---|---|---|
| Gmail | `smtp.gmail.com` | 587 | Utilisez un **mot de passe d'application** (https://myaccount.google.com/apppasswords) |
| Brevo / Sendinblue | `smtp-relay.brevo.com` | 587 | Utilisez vos identifiants SMTP Brevo |
| Mailjet | `in-v3.mailjet.com` | 587 | Utilisez votre clé API comme mot de passe |
| OVH / Ionos | `ssl0.ovh.net` / `smtp.ionos.fr` | 587 | Identifiants de votre boîte |

4. **Expéditeur** : une adresse autorisée par votre fournisseur (ex. `Mews Studio <galeries@votre-domaine.fr>`).
5. **Destinataire** : votre adresse (vide = votre adresse de réception des sélections).
6. Cliquez **Enregistrer**, puis **Envoyer un e-mail de test** pour vérifier.

La configuration est stockée côté serveur (`data/config.json`) ; le mot de passe n'est jamais renvoyé au navigateur. Le statut du dernier envoi (réussi/échec) est affiché sous le formulaire.
