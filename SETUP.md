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

## Tri automatique sur Google Drive (dossiers déjà triés)

Quand un client envoie sa sélection d'albums, le serveur peut **préparer automatiquement les dossiers triés** sur votre Drive :

```
Sélections
└── Sélection — Mariage Léa & Tom
    ├── Album 200 photos   ← copies des 200 sélectionnées
    ├── Album 150 photos
    └── Album 100 photos
```

- Les **originaux ne bougent pas** (la galerie reste intacte) : chaque photo choisie est **copiée** (ou reliée par **raccourci** — réglable) dans le bon sous-dossier.
- Quand le client **renvoie** une sélection modifiée, le dossier est **mis à jour** (ajouts + retraits automatiques).
- Nettoyage automatique possible après N jours (réglable, 0 = illimité).
- Un e-mail de confirmation avec le lien du dossier vous est envoyé (si les notifications SMTP sont actives).

### Prérequis : connexion OAuth de votre compte Google

Le robot (compte de service) sait **lire** les dossiers mais pas **écrire** (pas de quota). Le tri est donc effectué avec **votre compte Google personnel** :

1. Console Google Cloud (même projet que le compte de service) → **APIs & Services → Identifiants → Créer des identifiants → ID client OAuth**, type **Application Web**, URI de redirection : `https://mews-galleries.onrender.com/oauth2callback` (ou `BASE_URL` + `/oauth2callback`).
2. Écran de consentement : **Externe**, ajoutez votre e-mail comme **utilisateur test**. Scopes : `.../auth/drive` (les autres scopes de l'application sont facultatifs pour le tri).
3. Ajoutez `GOOGLE_CLIENT_ID` et `GOOGLE_CLIENT_SECRET` aux variables d'environnement (Render → Environment) puis redéployez.
4. Dans l'admin : **Réglages → Tri automatique → « Se connecter avec Google »** → autorisez une fois.
5. Choisissez le mode (copies réelles ou raccourcis — ou « désactivé »), le dossier racine et le délai de nettoyage, puis enregistrez.

⚠️ Application en statut « Test » : Google fait expirer l'autorisation après **7 jours** — il suffit de recliquer « Se connecter avec Google » (le badge de l'admin l'indique). Le jeton de renouvellement est inclus dans la sauvegarde GitHub (restauré automatiquement après un redéploiement).

## Notifications e-mail

Quand un client envoie une sélection d'albums, le serveur peut vous notifier automatiquement par e-mail.

**⚠️ Important (Render) : le plan gratuit de Render bloque la sortie SMTP (ports 25, 465 et 587) depuis septembre 2025.** Sur un service Render gratuit, utilisez le mode **Gmail** (API HTTPS, depuis votre compte Google) ou **Resend** (API HTTPS, depuis un domaine vérifié) ci-dessous. Le mode SMTP ne fonctionne que sur Render payant ou en local.

L'ordre de priorité des modes : **Resend** (si une clé est renseignée) → **Gmail** (si coché et compte connecté) → **SMTP**.

### Mode 1 — Gmail API (recommandé sur Render gratuit, gratuit)

Envoie **depuis une adresse Gmail de votre choix** (ex. `Mews Studio <vous@gmail.com>`) via l'API officielle Gmail : aucun port SMTP, aucun domaine à vérifier, 500 e-mails/jour.

**Le compte d'envoi est une connexion Google dédiée, indépendante du compte Drive** : on peut faire trier les albums 200/150/100 sur le Drive d'un compte (ex. le compte photo) et faire partir les e-mails d'un autre compte (ex. un Gmail pro).

1. Dans l'espace photographe : **Réglages → Notifications e-mail** → bouton **« Se connecter avec Google (envoi d'e-mails) »** → choisissez le compte qui signera les e-mails → autorisez (seule permission demandée : *envoyer vos e-mails*).
   - Premier passage : si l'application n'est pas encore « publiée/vérifiée » par Google, ajoutez ce compte comme *utilisateur de test* (console Google → Google Auth Platform → Audience → Test users). Le jeton d'une app non vérifiée expire au bout de 7 jours : un bandeau le rappelle, il suffit de re-cliquer.
   - **Sauvegarde du jeton** : pour survivre aux redéploiements Render, copiez le jeton de renouvellement affiché dans l'admin (bouton œil / API `GET /api/admin/mail/status`) dans la variable d'env `GOOGLE_MAIL_REFRESH_TOKEN` du service.
2. Dans l'espace photographe : **Réglages → Notifications e-mail**.
3. Cochez **« M'envoyer un e-mail à chaque sélection reçue »**.
4. Cochez **« Envoyer via Google (API Gmail) »**.
5. **Expéditeur** : `Mews Studio <vous@gmail.com>` (l'adresse doit être le compte d'envoi connecté ; le nom d'affichage est libre).
6. **Destinataire** : votre adresse (vide = votre adresse de réception des sélections).
7. Cliquez **Enregistrer**, puis **Envoyer un e-mail de test** pour vérifier.

### Mode 2 — Resend (recommandé si vous avez un domaine, gratuit)

1. Créez un compte gratuit sur <https://resend.com> (jusqu'à 3 000 e-mails/mois).
2. Ajoutez votre domaine (ex. `mewstudio.com`) : Resend vous donne 3 enregistrements DNS à ajouter chez votre registrar (1 CNAME `resend` + 2 TXT). Vérification en quelques minutes.
3. Dans Resend : **API Keys → Create API Key** (clé `re_…`).
4. Dans l'espace photographe : **Réglages → Notifications e-mail**.
5. Cochez **« M'envoyer un e-mail à chaque sélection reçue »**.
6. **Clé API Resend** : collez votre clé `re_…`.
7. **Expéditeur** : une adresse de votre domaine vérifié, ex. `Mews Studio <galeries@mewstudio.com>` (le nom d'affichage est libre).
8. **Destinataire** : votre adresse (vide = votre adresse de réception des sélections).
9. Cliquez **Enregistrer**, puis **Envoyer un e-mail de test** pour vérifier.

Le bloc « SMTP classique » est automatiquement ignoré tant qu'une clé Resend est active.

### Mode 3 — SMTP classique (Render payant ou local uniquement)

1. Dans l'espace photographe : **Réglages → Notifications e-mail**, laissez le champ « Clé API Resend » vide.
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

La configuration est stockée côté serveur (`data/config.json`) ; la clé Resend et le mot de passe ne sont jamais renvoyés au navigateur. Le statut du dernier envoi (réussi/échec) et le mode actif (Resend/SMTP) sont affichés sous le formulaire.
