'use strict';
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
  if (w < 900) return 1080;
  return dpr >= 2 ? 1920 : 1600;
}

module.exports = { coverId, coverVisible, coverSize };
