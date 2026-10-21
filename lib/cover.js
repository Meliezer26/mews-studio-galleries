'use strict';
const crypto = require('crypto');
/**
 * Couverture de galerie (écran de verrouillage plein cadre).
 *
 * Le photographe choisit UNE photo par galerie dans l'admin. Cette photo
 * devient l'écran d'accueil de la galerie privée : elle est visible AVANT
 * le mot de passe — c'est le principe même de la couverture, et c'est un
 * choix explicite du photographe.
 *
 * Règle de sûreté : seule CETTE photo est exposée. Tant qu'aucune
 * couverture n'est choisie, l'écran de verrouillage reste la carte
 * habituelle (logo, texte, champ) : rien ne fuit.
 */

/**
 * Identifiant de la photo de couverture d'une galerie, ou null.
 * Retourne null si la photo a disparu du dossier : mieux vaut pas de
 * couverture qu'une image cassée sur la page d'accueil.
 */
function coverId(gallery) {
  if (!gallery || !gallery.coverId) return null;
  const files = gallery.files || [];
  const found = files.find((f) => f && f.id === gallery.coverId);
  return found ? found.id : null;
}

/** La couverture peut-elle être montrée à un visiteur non identifié ? */
function coverVisible(gallery, opts = {}) {
  if (!gallery) return false;
  if (gallery.enabled === false) return false;
  if (opts.expired) return false;
  return coverId(gallery) !== null;
}

/**
 * Taille d'image demandée pour la couverture.
 * L'écran est en plein cadre : 1920 sur ordinateur, 1080 sur téléphone.
 * Ces deux valeurs suffisent — au-delà, on paie des octets invisibles.
 */
function coverSize(widthPx, dpr = 1) {
  const w = Number(widthPx) || 1280;
  // La couverture est un fond assombri, avec un voile et du texte par-dessus :
  // inutile de payer la pleine résolution. Mesures sur une galerie réelle :
  // 1600 px ≈ 320 Ko, 1280 ≈ 200 Ko, 1080 ≈ 150 Ko, 160 px ≈ 8 Ko.
  if (w < 900) return 1080;
  return dpr >= 2 ? 1600 : 1280;
}

/**
 * Version courte de la couverture, pour l'adresse de l'image.
 * Elle change dès que le photographe choisit une autre photo : le cache du
 * navigateur peut donc être gardé 7 jours sans jamais montrer l'ancienne.
 * (Empreinte tronquée : l'identifiant Drive n'apparaît pas dans l'adresse.)
 */
function coverVersion(gallery) {
  const id = coverId(gallery);
  if (!id) return null;
  return crypto.createHash('sha256').update(String(gallery.id) + ':' + id).digest('hex').slice(0, 10);
}

/**
 * Base d'adresse de la couverture (sans la taille).
 * Injectée dans le HTML par le serveur : le navigateur peut ainsi commencer
 * à télécharger l'image AVANT d'avoir chargé le moindre script.
 */
function coverBase(gallery) {
  const v = coverVersion(gallery);
  if (!v) return null;
  return '/api/g/' + encodeURIComponent(gallery.slug) + '/cover?v=' + v;
}

/**
 * Aperçu minuscule (quelques centaines d'octets, base64) stocké avec la
 * galerie au moment du choix de la couverture.
 *
 * Il voyage DANS le HTML de la page : le fond flou apparaît donc en même
 * temps que la page elle-même, sans une seule requête réseau. C'est ce qui
 * rend l'arrivée « instantanée » sur un téléphone en 3G.
 *
 * On vérifie la version : si le photographe change de photo, l'ancien aperçu
 * n'est pas réutilisé (il ne correspond plus à la couverture affichée).
 */
function coverPreview(gallery) {
  if (!gallery || !gallery.coverPreview) return null;
  const v = coverVersion(gallery);
  if (!v || gallery.coverPreviewV !== v) return null;
  const p = String(gallery.coverPreview);
  if (!/^data:image\//.test(p) || p.length > 12000) return null;
  return p;
}

/** Adresse complète, pour une taille donnée. */
function coverUrl(gallery, size) {
  const b = coverBase(gallery);
  return b ? b + '&size=' + size : null;
}

module.exports = { coverId, coverVisible, coverSize, coverVersion, coverBase, coverUrl, coverPreview };
