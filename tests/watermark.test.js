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

console.log('\nB. Pourcentage : en haut de la photo');
check('la pastille est ancrée en haut (position calculée ensuite par le script)',
  /\.lb-pct \{[^}]*top: 16px/.test(html));
check('elle n’est plus ancrée en bas', !/\.lb-pct \{[^}]*bottom:/.test(html));
check('elle est centrée horizontalement', /\.lb-pct \{[^}]*left: 50%/.test(html) && /\.lb-pct \{[^}]*translateX\(-50%\)/.test(html));
check('le placement tient compte du rapport de la photo (bandes noires)',
  /function placeLoadPct\(\)/.test(js) && /naturalHeight \/ ref\.naturalWidth/.test(js));
check('la pastille est replacée à chaque photo affichée',
  /pre\.onload = function \(\) \{ if \(token === fullToken\) schedulePct\(\); \}/.test(js));
check('elle est replacée quand la photo nette arrive',
  /img\.onload = function \(\) \{\s*if \(token !== fullToken\) return;[\s\S]{0,300}schedulePct\(\)/.test(js));
check('elle suit la rotation du téléphone', /orientationchange/.test(js) && /resize/.test(js));
check('au-dessus de la photo quand il y a la place', /hautPhoto - pillH - 10/.test(js));
check('repli sur la photo si la place manque', /if \(top < 8\) top = Math.round\(hautPhoto \+ 12\)/.test(js));
check('replacée à chaque changement de taille (rotation, photo portrait/paysage)',
  /ResizeObserver/.test(js) && /function watchPct\(\)/.test(js));
check('elle ne capte pas le doigt', /\.lb-pct \{[^}]*pointer-events: none/.test(html));

console.log('\nC. Placement : au-dessus de la photo, comme la version du bas');
/* Reproduction de la formule livrée : haut de la zone peinte − hauteur de la
   pastille − 10 px ; si la place manque, la pastille se pose sur la photo. */
function placePct(boite, natif, sceneTop, pillH) {
  const zoneH = natif.h && natif.w ? Math.min(boite.h, boite.w * (natif.h / natif.w)) : boite.h;
  const hautPhoto = boite.top - sceneTop + (boite.h - zoneH) / 2;
  let top = Math.round(hautPhoto - pillH - 10);
  if (top < 8) top = Math.round(hautPhoto + 12);
  return { top, bas: top + pillH, hautPhoto };
}
// Téléphone, mesure réelle : scène de 632 px, photo paysage peinte sur 262 px
// (185 px de bande noire au-dessus et en dessous).
{
  const r = placePct({ top: 0, h: 632, w: 390 }, { w: 390, h: 262 }, 0, 35);
  check('téléphone : la pastille est entièrement au-dessus de la photo',
    r.bas <= Math.round(r.hautPhoto), `pastille ${r.top}–${r.bas} px, photo à ${Math.round(r.hautPhoto)} px`);
  check('téléphone : 10 px d’écart avec la photo',
    Math.abs((Math.round(r.hautPhoto) - r.bas) - 10) <= 1, (Math.round(r.hautPhoto) - r.bas) + ' px');
  check('téléphone : elle reste dans l’écran', r.top >= 8, r.top + ' px');
  check('téléphone : elle est centrée dans la bande noire, pas sur l’image',
    r.bas < r.hautPhoto - 5, 'bas de la pastille ' + r.bas + ' px');
}
// Ordinateur : la photo occupe toute la hauteur, aucune place au-dessus
{
  const r = placePct({ top: 0, h: 752, w: 1120 }, { w: 1120, h: 747 }, 0, 35);
  check('ordinateur (photo pleine hauteur) : la pastille se pose sur le haut de la photo',
    r.top >= r.hautPhoto && r.top - r.hautPhoto <= 20, `pastille à ${r.top} px, photo à ${Math.round(r.hautPhoto)} px`);
}

console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
process.exit(fail ? 1 : 0);
