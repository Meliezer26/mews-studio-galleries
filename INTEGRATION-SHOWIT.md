# Ajouter « Mews Studio Galleries » à mewstudio.com (Showit)

> ✅ **INTÉGRATION RÉALISÉE le 31/08/2026** (par l'assistant, avec vos accès).
> Détails en bas de ce fichier.

> **La marque est Mews Studio (avec un S)** ; le domaine reste **mewstudio.com**
> (sans S) et le sous-domaine des galeries : **galeries.mewstudio.com**.

Votre site actuel : **https://mewstudio.com** (construit sur Showit).
Dans votre menu, l'onglet **« prive »** pointe aujourd'hui vers Jooméo
(`https://www.joomeo.com/login.php?as=guest`). C'est exactement l'emplacement
à utiliser pour vos nouvelles galeries Mews Studio.

> **Prérequis** : le site de galeries doit être en ligne à une adresse fixe,
> idéalement un sous-domaine de votre domaine : **`https://galeries.mewstudio.com`**
> (voir « Hébergement et domaine » en bas). En attendant, vous pouvez utiliser
> l'adresse de l'aperçu pour tester.

---

## Étape 1 — Remplacer le lien « prive » (2 minutes, recommandé)

1. Ouvrez votre site dans l'éditeur **Showit** (app.showit.com → votre site).
2. Repérez le texte **« prive »** dans votre menu (même endroit que HOME,
   portfolio, vidéo, à propos, contact).
3. Sélectionnez-le → dans le panneau de droite, ouvrez l'onglet **Link**.
4. Remplacez le lien Jooméo par :
   - URL : `https://galeries.mewstudio.com` *(votre adresse de galeries)*
   - Cochez **« Open in new window/tab »**
5. (Facultatif) Renommez le texte en **« Galeries privées »** ou
   **« Espace clients »** — gardez la même police que les autres onglets.
6. Cliquez **Publish**.

✅ L'onglet ouvre désormais votre espace de galeries. Vos clients, eux,
continuent de recevoir leur lien direct par e-mail ou WhatsApp
(`https://galeries.mewstudio.com/g/...` + mot de passe) : l'onglet sert
d'entrée visible pour retrouver le service.

> 💡 Vous pouvez garder le lien Jooméo en plus si certains clients utilisent
> encore leurs anciennes galeries : ajoutez alors un **nouvel onglet**
> « Galeries privées » à côté de « prive », au lieu de le remplacer.

---

## Étape 2 (optionnelle) — Une page galerie intégrée dans votre site

Si vous préférez que les galeries s'affichent **dans une page de mewstudio.com**
sans quitter le site :

1. Dans Showit : **Pages → + New Page**, nommez-la « Galeries privées ».
2. Ajoutez un élément **Embed Code** pleine largeur, et collez :

```html
<iframe
  src="https://galeries.mewstudio.com"
  title="Galeries privées — Mews Studio"
  style="width:100%; height:820px; border:0; border-radius:12px;"
  allowfullscreen>
</iframe>
```

3. Reliez la page à votre menu (Étape 1, en pointant vers cette page interne).

### ⚠️ Réglage indispensable pour l'iframe

Pour que le déverrouillage des galeries fonctionne dans l'iframe (les
navigateurs bloquent les cookies « tiers »), ajoutez au fichier `.env` du
serveur de galeries :

```
EMBED_MODE=1
```

Le site doit alors être servi en **HTTPS** (automatique sur Render, Railway,
Fly.io…). Sans ce réglage, l'option A (lien qui ouvre un nouvel onglet)
fonctionne sans aucune configuration supplémentaire.

---

## Étape 3 (optionnelle) — Un encart « J'ai reçu un lien » sur votre site

Un petit encart où le client colle le lien reçu et rejoint sa galerie —
pratique sur la page d'accueil ou la page contact.

1. Ajoutez un bloc **Embed Code** dans Showit.
2. Collez :

```html
<div style="max-width:520px;margin:0 auto;padding:36px 24px;text-align:center;font-family:Georgia,serif;color:#222">
  <h2 style="font-size:26px;margin:0 0 8px">Accéder à ma galerie</h2>
  <p style="color:#777;margin:0 0 22px;font-size:15px">Collez le lien reçu de votre photographe, puis ouvrez votre galerie.</p>
  <input id="mewsLink" type="text" placeholder="https://galeries.mewstudio.com/g/…"
         style="width:100%;padding:13px 16px;border:1px solid #ccc;border-radius:10px;font-size:15px;margin-bottom:14px">
  <button onclick="var v=document.getElementById('mewsLink').value.trim();if(!v)return;location.href=/^https?:\/\//i.test(v)?v:'https://'+v;"
          style="background:#b57f2a;color:#fff;border:0;border-radius:999px;padding:13px 30px;font-size:15px;font-weight:600;cursor:pointer">
    Ouvrir ma galerie
  </button>
</div>
```

3. Publiez. Une page complète assortie au design Mews Studio existe aussi :
   `https://galeries.mewstudio.com/portal-page.html`.

---

## Hébergement et domaine

L'onglet doit pointer vers une adresse **fixe et publique** :

| Option | Comment |
|---|---|
| **Render (gratuit) — chemin recommandé** | Suivez **[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)** : déploiement en clics depuis GitHub, adresse fixe du type `https://mews-galleries.onrender.com`, HTTPS automatique, sauvegarde automatique des données sur Google Drive. |
| **Sous-domaine de mewstudio.com** (pour la suite) | Une fois sur Render : CNAME `galeries` → votre service Render, puis `BASE_URL=https://galeries.mewstudio.com`. Le rendu le plus professionnel. |
| **VPS** | `npm install && npm start` + nginx avec HTTPS (Let's Encrypt). |

Configuration de production (détails dans `SETUP.md`) :
- `BASE_URL=https://votre-adresse` (obligatoire pour Google OAuth)
- Identifiants Google OAuth pour brancher Google Drive (sinon le mode local fonctionne déjà)
- `GOOGLE_REFRESH_TOKEN` (clé de secours) pour la restauration automatique après un redéploiement
- `EMBED_MODE=1` uniquement si vous utilisez l'iframe (Étape 2)

## Adresses utiles

| Page | URL |
|---|---|
| Accueil vitrine | `https://galeries.mewstudio.com/` |
| **Page de connexion clients** | `https://galeries.mewstudio.com/connexion` (mot de passe de galerie → ouverture directe) |
| Galerie démo | `https://galeries.mewstudio.com/g/demo` (mdp `demo123`) |
| Espace photographe | `https://galeries.mewstudio.com/admin` (mdp `admin123` → à changer) |

**Libellés d'onglet possibles** : « Galeries privées », « Espace clients »,
« Accès photos » — cohérents avec votre menu actuel (home, portfolio, vidéo,
à propos, contact, prive).

---

## ✅ Bilan de l'intégration réalisée (31/08/2026)

Ce qui a été fait dans votre compte Showit et publié sur mewstudio.com :

| Élément | Avant | Après |
|---|---|---|
| Libellé du menu (section MINI MENU) | « prive » (sous « ESPACE ») | « **galeries privées** » (sous « ESPACE ») |
| Lien de « galeries privées » | https://www.joomeo.com/login.php?as=guest | **https://tongue-taxes-keyboards-among.trycloudflare.com/connexion** *(adresse publique temporaire du serveur de galeries — voir ci-dessous)* |
| Lien de « ESPACE » | *(pas cliquable / ancien lien)* | **même page de connexion** (ajouté le 31/08/2026 à votre demande) |
| Ouverture | nouvel onglet (target=_blank conservé) | nouvel onglet |

**Le client arrive directement sur la page de connexion** (`/connexion`) :
il tape le mot de passe de sa galerie et est redirigé automatiquement vers sa
galerie déverrouillée (plus de page d'accueil intermédiaire). Le back-end des
galeries reste sur sa propre adresse, séparée du site Showit.

> ℹ️ La première adresse temporaire (`payday-continuity-…trycloudflare.com`)
> est devenue injoignable (tunnel Cloudflare arrêté) ; elle a été remplacée
> par `tongue-taxes-keyboards-among.trycloudflare.com` le même jour, et les
> deux liens du menu ont été re-pointés vers `/connexion` puis republiés.

Vérifié en ligne sur mewstudio.com après publication : liens corrects (tous
deux vers `…/connexion`), texte correct, ouverture dans un nouvel onglet,
page de connexion et déverrouillage testés (mot de passe `demo123` → galerie
demo).

### ⚠️ À faire de votre côté

1. **Changez votre mot de passe Showit immédiatement** (celui que vous avez
   transmis) : compte Showit → Account Settings → Security.
2. **Adresse temporaire défunte** : le tunnel gratuit
   `…trycloudflare.com` est arrêté (l'environnement de prévisualisation a
   été réinitialisé). Les liens du menu pointent encore vers cette adresse
   morte : tant que le serveur n'est pas déployé, les liens renvoient une
   erreur. **Solution durable** : suivez
   **[DEPLOIEMENT-RENDER.md](DEPLOIEMENT-RENDER.md)** pour obtenir une
   adresse fixe, puis remplacez l'URL des deux liens (même manipulation
   que ci-dessous) par `<votre-adresse>/connexion` et republiez.

### Pour modifier le lien vous-même plus tard (2 minutes)

1. Compte Showit → « Edit My Website ».
2. Panneau de gauche, onglet **Page** → cliquez la section **MINI MENU**
   (ses calques s'affichent) → cliquez le calque « galeries privées ».
3. Panneau de droite → section **Click Actions** → champ URL : remplacez
   l'adresse → la sauvegarde est automatique.
4. Cliquez **Publish** → **Publish** → c'est en ligne.
