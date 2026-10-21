'use strict';
/**
 * Banc d'essai : filigrane et pastille de chargement dans la visionneuse.
 *
 * Deux demandes du 21/10/2026 :
 *   1. le pourcentage de chargement doit être posé EN HAUT DE LA PHOTO
 *      (pas dans la bande noire de la visionneuse) ;
 *   2. sur téléphone, le filigrane doit être DEUX FOIS plus grand qu'avant.
 *
 * Ce banc lit les fichiers réellement livrés (public/styles.css,
 * public/gallery.js, public/gallery.html) et vérifie les règles de calcul.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const css = fs.readFileSync(path.join(root, 'public', 'styles.css'), 'utf8');
const js = fs.readFileSync(path.join(root, 'public', 'gallery.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'gallery.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

/* --- Petite analyse de CSS : trouve une déclaration dans un bloc ---------- */
function bloc(selecteur) {
  const i = css.indexOf(selecteur + ' {');
  if (i < 0) return null;
  const j = css.indexOf('}', i);
  return css.slice(i + selecteur.length, j);
}
function valeur(sel, prop) {
  const b = bloc(sel);
  if (!b) return null;
  const m = new RegExp(prop + '\\s*:\\s*([^;]+);').exec(b);
  return m ? m[1].trim() : null;
}
/* Déclarations du bloc @media (max-width: 720px) qui concerne le filigrane
   (il peut y avoir plusieurs blocs de ce type dans la feuille de styles). */
const tel = (() => {
  const marque = '@media (max-width: 720px)';
  let i = css.indexOf(marque);
  while (i > -1) {
    const fin = css.indexOf('\n}', i);
    const corps = css.slice(i, fin);
    if (corps.indexOf('#lb-wm span') > -1) return corps;
    i = css.indexOf(marque, i + 1);
  }
  return '';
})();
const blocTel = (sel) => {
  const i = tel.indexOf(sel + ' {');
  if (i < 0) return null;
  return tel.slice(i + sel.length, tel.indexOf('}', i));
};
const valeurTel = (sel, prop) => {
  const b = blocTel(sel);
  if (!b) return null;
  const m = new RegExp(prop + '\\s*:\\s*([^;]+);').exec(b);
  return m ? m[1].trim() : null;
};
const nombre = (s) => parseFloat(String(s));
const cqw = (s) => /cqw$/.test(String(s).trim()) ? nombre(s) : NaN;

console.log('A. Filigrane : deux fois plus grand sur téléphone');
const grilleBureau = cqw(valeur('.g-item .wm span', 'font-size'));
const grilleTel = cqw(valeurTel('.g-item .wm span', 'font-size'));
const lbBureau = cqw(valeur('#lb-wm span', 'font-size'));
const lbTel = cqw(valeurTel('#lb-wm span', 'font-size'));
check('vignettes : 2 cqw sur ordinateur (inchangé)', grilleBureau === 2, grilleBureau + ' cqw');
check('vignettes : 4 cqw sur téléphone', grilleTel === 4, grilleTel + ' cqw');
check('vignettes : exactement le double', grilleTel === grilleBureau * 2);
check('visionneuse : 1,2 cqw sur ordinateur (inchangé)', lbBureau === 1.2, lbBureau + ' cqw');
check('visionneuse : 2,4 cqw sur téléphone', lbTel === 2.4, lbTel + ' cqw');
check('visionneuse : exactement le double', Math.abs(lbTel - lbBureau * 2) < 1e-9);
check('l’écartement des lignes du filigrane est resserré sur téléphone',
  /\.wm \{ gap: 0?\.85em; \}/.test(tel), valeurTel('.wm', 'gap') || 'absent');
check('le filigrane reste au centre de la photo',
  /\.wm \{[^}]*top: 50%/.test(css) && /\.wm \{[^}]*transform: translate\(-50%, -50%\)/.test(css));

console.log('\nB. Pourcentage : dans la barre du haut, au-dessus de la photo');
check('la pastille est dans la barre du haut de la visionneuse',
  /<div class="lb-top">[\s\S]{0,400}id="lb-pct"/.test(html));
check('elle n’est plus posée sur la photo',
  !/<div class="lb-loadbar" id="lb-loadbar"><\/div>\s*<div class="lb-pct"/.test(html));
check('elle suit le numéro de la photo', /<span class="lb-count" id="lb-count"><\/span>\s*<span class="lb-pct"/.test(html));
check('elle se cache par défaut', /\.lb-pct \{[^}]*display: none/.test(html));
check('elle redevient visible quand elle a un contenu', /\.lb-pct\.on \{ display: inline-block; \}/.test(html));
check('aucun positionnement sur la photo n’est plus calculé',
  !/function placeLoadPct/.test(js) && !/schedulePct/.test(js));
check('elle ne capte aucun clic ni geste', /\.lb-pct \{[^}]*pointer-events: none/.test(html));
check('la barre fine de progression reste sur la photo, pilotée par le pourcentage',
  /\.lb-loadbar \{[^}]*width: 0;/.test(html) && /#lb\.lb-indet \.lb-loadbar \{ animation/.test(html));

console.log('\nC. Aucune place retirée à la photo');
check('la scène garde toute la hauteur (aucune bande réservée)',
  /padding: 0 60px 20px;/.test(html) && !/padding: 3[0-9]px 60px/.test(html));
check('sur téléphone non plus', /padding: 0 14px 14px;/.test(html));

console.log('\nD. Texte d’accueil : police lisible, nom du studio jamais coupé');
/* Le style de la couverture est dans gallery.html (bloc <style>), pas dans
   styles.css : on y cherche les déclarations de la même façon. */
const valeurHtml = (sel, prop) => {
  const i = html.indexOf(sel + ' {');
  if (i < 0) return null;
  const corps = html.slice(i + sel.length, html.indexOf('}', i));
  const m = new RegExp(prop + '\\s*:\\s*([^;]+);').exec(corps);
  return m ? m[1].trim() : null;
};
const tailleAccueil = parseFloat(valeurHtml('.lock-cover-welcome', 'font-size'));
check('police nettement agrandie (au moins 1 rem)', tailleAccueil >= 1, tailleAccueil + ' rem');
check('taille demandée : 1,06 rem', tailleAccueil === 1.06, tailleAccueil + ' rem');
check('largeur qui évite le mot orphelin en fin de texte',
  valeurHtml('.lock-cover-welcome', 'max-width') === '34ch', valeurHtml('.lock-cover-welcome', 'max-width'));
check('nom insécable dans le texte de la couverture',
  /communiqué par Mew's&nbsp;Studio\./.test(html));
check('nom insécable aussi dans la carte classique',
  (html.match(/Mew's&nbsp;Studio\./g) || []).length >= 2);
check('le texte réécrit par le script garde le nom insécable',
  /Mew\\'s\\u00A0Studio\./.test(js), 'gallery.js');
check('les deux textes d’accueil gardent leur formulation exacte',
  /Bienvenue dans votre espace privé\. Veuillez entrer le mot de passe communiqué par Mew/.test(html));

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
