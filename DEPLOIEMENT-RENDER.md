# 🚀 Mettre « Mews Studio Galleries » en ligne — guide Render (gratuit)

> Objectif : une **adresse fixe et durable** pour vos galeries
> (ex. `https://mews-galleries.onrender.com`), avec HTTPS automatique.
> Plus de tunnel temporaire, plus de lien cassé sur mewstudio.com.
>
> **Tout se fait en clics, sans ligne de commande.** Comptez 30 à 45 minutes.

---

## Vue d'ensemble

| Étape | Quoi | Durée |
|---|---|---|
| 1 | Créer un compte GitHub et y déposer le dossier du projet | 10 min |
| 2 | Créer un compte Render et déployer depuis GitHub | 10 min |
| 3 | Renseigner les variables d'environnement | 5 min |
| 4 | Tester le site en ligne | 5 min |
| 5 | Connecter Google Drive (OAuth Google) | 10 min |
| 6 | Repointer les liens du menu Showit | 2 min |

⚠️ **Sécurité** : le dossier `data/` (mots de passe, jetons, comptes
clients) et le fichier `.env` sont exclus du dépôt Git grâce au fichier
`.gitignore` déjà inclus. **Ne les ajoutez jamais** à GitHub.

---

## Étape 1 — GitHub

1. Rendez-vous sur https://github.com → **Sign up** (compte gratuit).
2. En haut à droite **+** → **New repository**.
   - Nom : `mews-studio-galleries` (ou ce que vous voulez)
   - **Private** (recommandé — vos fichiers sont visibles sinon)
   - Ne cochez rien d'autre → **Create repository**.
3. Sur la page du dépôt, cliquez **« uploading an existing file »**.
4. Décompressez le fichier `mews-studio-github.zip` fourni, puis
   **glissez-déposez tout le contenu du dossier** dans la zone de dépôt
   (la liste des fichiers apparaît : `server.js`, `package.json`,
   `public/…`, `lib/…`).
5. Vérifiez que `node_modules/`, `data/` et `.env` **ne sont pas** dans la
   liste, puis **Commit changes**.

✅ Le code est sur GitHub.

---

## Étape 2 — Render (hébergeur gratuit)

1. Rendez-vous sur https://render.com → **Get Started** → inscrivez-vous
   avec le bouton **GitHub** (c'est le plus simple).
2. Tableau de bord → **New +** → **Web Service**.
3. Autorisez Render à accéder à votre dépôt, puis choisissez
   **mews-studio-galleries** → **Connect**.
4. Remplissez le formulaire :

   | Champ | Valeur |
   |---|---|
   | Name | `mews-galleries` (donne l'adresse `mews-galleries.onrender.com`) |
   | Region | Frankfurt (EU Central) — proche de la France |
   | Branch | `main` |
   | Runtime | Node (détecté automatiquement) |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |

5. Cliquez **Create Web Service** et attendez la fin du déploiement
   (2–3 minutes). Un lien `https://mews-galleries.onrender.com` apparaît
   en haut de la page.

✅ Le site est en ligne. Testez : la page d'accueil s'affiche,
`/connexion` fonctionne, la galerie démo `mews-galleries.onrender.com/g/demo`
s'ouvre avec le mot de passe `demo123`.

> 💤 **Service gratuit** : Render endort le service après ~15 minutes sans
> visite. La première visite suivante met **30 à 60 secondes** à répondre
> (le temps du réveil) — c'est normal, dites-le à vos clients.
> Pour un réveil instantané, l'offre payante démarre à ~7 $/mois.

### 📊 Bande passante : conçue pour de très gros dossiers (8–15 Go)

Le plan gratuit inclut **5 Go/mois**, puis 0,15 $/Go. Mais grâce à
l'architecture de l'application, **vos dossiers de 8 à 15 Go ne
consomment presque rien** :

| Action du client | Ce qui circule | Coût en bande passante |
|---|---|---|
| Feuilleter la galerie | vignettes (~50 Ko) | ~15–30 Mo par session |
| Regarder une photo en plein écran | aperçu 1600 px (~0,3 Mo) | ~0,3 Mo par photo |
| Regarder 300 photos en plein écran | aperçus 1600 px | ~100 Mo |
| **Télécharger les photos** | **directement Google → client** | **0 — c'est Google qui livre** |

- **L'affichage** passe par le serveur mais utilise des vignettes
  légères : même en feuilletant beaucoup, on reste très loin des 5 Go.
- **Le téléchargement** (le seul poste qui serait lourd, 8–15 Go par
  dossier) ne transite **plus du tout par le serveur** : à chaque
  téléchargement, l'application crée un lien direct temporaire vers
  Google (valable 1 h, révoqué automatiquement ensuite) et le client
  récupère la photo **depuis les serveurs de Google**.

Résultat : avec vos volumes (dossiers de 8 à 15 Go, quelques clients par
mois), **le plan gratuit suffit, 0 €/mois**, même en autorisant les
téléchargements. Le dépassement éventuel reste minime (0,15 $/Go, suivi
en temps réel dans l'onglet Metrics du dashboard Render).

> ℹ️ Pour poser ces liens temporaires, l'application a besoin d'un accès
> d'« éditeur » sur vos dossiers de photos. Deux façons : le **compte de
> service** (recommandé — Étape 5) ou l'OAuth classique. Dans les deux
> cas, l'accès sert uniquement à créer puis supprimer ces liens
> temporaires valables 1 heure.

---

## Étape 3 — Variables d'environnement

Dans le tableau de bord Render : votre service → **Environment** →
**Environment Variables** → **Add Environment Variable**.

| Clé | Valeur | Obligatoire |
|---|---|---|
| `BASE_URL` | `https://mews-galleries.onrender.com` (votre URL réelle) | ✅ oui |
| `ADMIN_PASSWORD` | un mot de passe fort pour `/admin` (remplace `admin123`) | ✅ oui |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | le contenu du fichier JSON de la clé (Étape 5, option recommandée) | étape 5 |
| `GOOGLE_CLIENT_ID` | créé à l'étape 5 (option OAuth alternative) | non |
| `GOOGLE_CLIENT_SECRET` | créé à l'étape 5 (option OAuth alternative) | non |
| `GOOGLE_REFRESH_TOKEN` | clé de secours (option OAuth uniquement) | option OAuth |
| `EMBED_MODE` | laisser vide (0) — vous utilisez un lien, pas une iframe | non |

Après chaque ajout, Render redéploie automatiquement (~1 min).

---

## Étape 4 — Tester le site en ligne

1. `https://mews-galleries.onrender.com/` → page d'accueil.
2. `…/connexion` → page de connexion clients.
3. `…/g/demo` + mot de passe `demo123` → galerie démo.
4. `…/admin` + votre nouveau mot de passe → espace photographe.

---

## Étape 5 — Connecter Google Drive

Les photos restent dans **votre Google Drive** : il faut autoriser
l'application à y accéder. **Procédure complète dans `SETUP.md`** —
choisissez l'option A (compte de service) : c'est la plus simple à long
terme, aucune re-connexion n'est nécessaire.

### Option A (recommandée) — Compte de service, en résumé

1. https://console.cloud.google.com → créer un projet « Mews Studio ».
2. Activer l'API **Google Drive API**.
3. **Identifiants → + Créer des identifiants → Compte de service** →
   nom `mews-studio` (notez son adresse e-mail en `@…gserviceaccount.com`).
4. Ouvrir le compte de service → **Clés → Ajouter une clé → JSON** →
   un fichier `.json` se télécharge.
5. Sur Render : variable `GOOGLE_SERVICE_ACCOUNT_JSON` = **le contenu
   complet du fichier JSON** (collé tel quel).
6. Sur drive.google.com : cliquez droit sur votre dossier de photos →
   **Partager** → collez l'adresse e-mail du compte de service →
   rôle **Éditeur** → Envoyer.

✅ Terminé — l'espace photographe affiche « Google Drive connecté »,
la sauvegarde automatique et les téléchargements directs fonctionnent
sans aucune re-connexion.

### Option B (alternative) — OAuth classique

1. Console Google → **Écran de consentement OAuth** : type **Externe**,
   ajoutez votre adresse Gmail comme utilisateur de test.
2. **Identifiants → ID client OAuth → Application Web** :
   URI de redirection `https://mews-galleries.onrender.com/oauth2callback`.
3. Variables Render : `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET`.
4. Espace photographe → **Google Drive → Se connecter avec Google** →
   (écran « application non validée » : Paramètres avancés → Continuer).
5. Onglet Google Drive → « 💾 Sauvegarde automatique » → copiez la
   **clé de secours** dans la variable `GOOGLE_REFRESH_TOKEN` sur Render.

⚠️ En OAuth, Google fait expirer la connexion au bout de ~7 jours
(application personnelle non validée) : l'espace photographe vous
rappellera de re-cliquer « Se connecter avec Google » (30 secondes).
L'option A n'a pas cette contrainte.

---

## Étape 6 — Repointer les liens du menu Showit

Vos deux liens de menu (« ESPACE » et « galeries privées ») pointent vers
une ancienne adresse temporaire qui n'existe plus. Remplacez-les par :

```
https://mews-galleries.onrender.com/connexion
```

La marche à suivre exacte (2 minutes par lien) est dans
**`INTEGRATION-SHOWIT.md`**, section « Pour modifier le lien vous-même
plus tard ». Puis **Publish**.

---

## Étape 7 (plus tard, recommandé) — Votre propre adresse

`https://galeries.mewstudio.com` donne un rendu bien plus professionnel
que `…onrender.com`. Deux actions :

1. **Render** → votre service → **Settings** → **Custom Domains** →
   ajoutez `galeries.mewstudio.com`.
2. **Chez votre registraire** (là où est géré mewstudio.com), créez un
   enregistrement **CNAME** :

   | Type | Nom | Cible |
   |---|---|---|
   | CNAME | `galeries` | `mews-galleries.onrender.com` |

   (Sur certains registraires, le « nom » se note `galeries.mewstudio.com.`)

3. Mettez à jour `BASE_URL` dans les variables Render →
   `https://galeries.mewstudio.com` (redéploiement auto), puis les liens
   du menu Showit. Le certificat HTTPS est généré automatiquement.

---

## FAQ

**Le plan gratuit inclut-il assez de bande passante ?** Oui, même avec
des dossiers de 8 à 15 Go — voir l'encadré « Bande passante » de
l'étape 2 : l'affichage utilise des vignettes légères et les
téléchargements passent **directement de Google au client** (c'est
Google qui livre, pas votre serveur). Le plan gratuit (5 Go/mois)
suffit donc largement ; en cas de dépassement exceptionnel, 0,15 $/Go,
suivi en temps réel dans le dashboard.

**Le service gratuit suffira-t-il ?** Pour des galeries privées visitées
quelques fois par jour : oui. Le réveil après inactivité prend 30–60 s
une fois. Si cela gêne, passez au palier payant « Starter » (~7 $/mois,
réveil instantané) — la bande passante incluse reste de 5 Go/mois sur
le plan Hobby, le dépassement étant facturé 0,15 $/Go.

**Que se passe-t-il à chaque mise à jour du site ?** Render redéploie
depuis GitHub : le disque est remis à zéro, puis l'application restaure
automatiquement ses données depuis la sauvegarde Drive (étape 5).

**Où sont mes photos ?** Toujours dans votre Google Drive — l'application
ne stocke aucune photo sur l'hébergeur (en mode Drive). La galerie démo
locale ne sert que pour essayer.

**Et si Google Drive est déconnecté ?** L'application continue de
fonctionner avec les dernières données connues ; l'espace photographe
affiche un bandeau pour vous inviter à re-connecter.

---

## Alternative : Railway

Même principe que Render (déploiement depuis GitHub). Points de
différence : https://railway.app → **New Project** → **Deploy from GitHub
repo** → le service est détecté automatiquement (`npm start`).
Variables d'environnement dans l'onglet **Variables**. Offre gratuite
limitée dans le temps ; Render est souvent plus simple pour démarrer.
