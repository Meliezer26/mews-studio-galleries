'use strict';
/**
 * Banc d'essai : compteur de chargement en pourcentage (visionneuse).
 *
 * Enjeu : pendant le passage de la vignette à la photo, le client doit voir
 * « 42 % » plutôt qu'une roue qui tourne. Le pourcentage affiché doit être le
 * vrai rapport octets reçus / taille annoncée par le serveur (en-tête
 * Content-Length), la photo déjà vue doit revenir sans réseau, et un
 * téléchargement abandonné (glissement rapide) ne doit jamais écraser la
 * photo affichée.
 *
 * Ce banc exécute le code RÉELLEMENT livré (extrait de public/gallery.js)
 * dans un faux navigateur, pas une copie.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const js = fs.readFileSync(path.join(root, 'public', 'gallery.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'gallery.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

/* --- Extraction du bloc livré au navigateur ------------------------- */
const start = js.indexOf('var FULL_MAX = 8;');
const endMark = '  /* Met la grande photo dans la visionneuse (ou la reprend du cache). */';
const end = js.indexOf(endMark);
if (start < 0 || end < 0) {
  console.error('✗ ÉCHEC : mécanique de chargement introuvable dans public/gallery.js');
  process.exit(1);
}
const chargeurSrc = js.slice(start, js.indexOf('\n  /* --- Glissement au doigt', start) > -1
  ? js.indexOf('\n  /* --- Glissement au doigt', start)
  : js.length);

/** Faux navigateur : éléments HTML minimalistes + fetch piloté par le test. */
function makeEnv(opts = {}) {
  const els = {};
  function el(id) {
    if (!els[id]) {
      els[id] = {
        id, textContent: '', src: '',
        style: { width: '', backgroundImage: '' },
        classes: new Set(),
        classList: {
          add: function () { [].forEach.call(arguments, (c) => els[id].classes.add(c)); },
          remove: function () { [].forEach.call(arguments, (c) => els[id].classes.delete(c)); },
          contains: function (c) { return els[id].classes.has(c); },
        },
      };
    }
    return els[id];
  }
  el('lb'); el('lb-img'); el('lb-pct'); el('lb-loadbar');
  const calls = { pct: [], urls: [], revoques: [] };
  const sandbox = {
    Math, Date, Object, Promise, Error, Number, String, JSON, Set, Array, console,
    Blob,
    $: el,
    document: { getElementById: el, querySelector: () => null },
    URL: {
      createObjectURL: (blob) => { const u = 'blob:mews/' + (calls.urls.length + 1); calls.urls.push(u); return u; },
      revokeObjectURL: (u) => calls.revoques.push(u),
    },
    fetch: opts.fetch || (() => Promise.reject(new Error('pas de réseau dans ce test'))),
    setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(chargeurSrc, sandbox);
  return { sandbox, els, el, calls };
}

/** Fausse réponse HTTP : taille annoncée + morceaux à servir. */
function fakeResponse(chunks, total, ok = true, status = 200) {
  let i = 0;
  return {
    ok, status,
    headers: { get: (h) => (h.toLowerCase() === 'content-length' ? String(total) : h.toLowerCase() === 'content-type' ? 'image/jpeg' : null) },
    body: {
      getReader: () => ({
        read: () => Promise.resolve(i < chunks.length ? { done: false, value: chunks[i++] } : { done: true }),
      }),
    },
    blob: () => Promise.resolve(new Blob(chunks, { type: 'image/jpeg' })),
  };
}

function tick(ms = 0) { return new Promise((r) => setTimeout(r, ms)); }

(async function run() {
  console.log('A. Le pourcentage suit les octets réellement reçus');
  {
    const env = makeEnv({ fetch: () => Promise.resolve(fakeResponse([new Uint8Array(250), new Uint8Array(250), new Uint8Array(500)], 1000)) });
    const pcts = [];
    await env.sandbox.fetchImageWithProgress('/img', (p) => { pcts.push(p); env.sandbox.setLoadPct(p); }, env.sandbox.fullToken)
      .then((blob) => { env.sandbox.blob = blob; });
    check('25 % → 50 % → 100 %', JSON.stringify(pcts) === '[25,50,100]', pcts.join(' / '));
    check('la pastille affiche « 100 % »', env.el('lb-pct').textContent === '100 %');
    check('la barre a la même largeur que le pourcentage', env.el('lb-loadbar').style.width === '100%');
    check('l’image complète est reconstituée', env.sandbox.blob && env.sandbox.blob.size === 1000, (env.sandbox.blob || {}).size + ' octets');
  }

  console.log('\nB. Serveur sans taille annoncée : mode « Chargement… »');
  {
    const env = makeEnv({ fetch: () => Promise.resolve(fakeResponse([new Uint8Array(10)], 0)) });
    const pcts = [];
    await env.sandbox.fetchImageWithProgress('/img', (p) => pcts.push(p), env.sandbox.fullToken);
    check('aucun pourcentage inventé', pcts.length === 1 && pcts[0] === null, 'valeur : ' + pcts[0]);
    check('le mode indéterminé est activé', env.el('lb').classes.has('lb-indet'));
    env.sandbox.setLoadPct(null);
    check('la pastille affiche « Chargement… »', env.el('lb-pct').textContent === 'Chargement…');
  }

  console.log('\nC. Photo introuvable : on retombe sur le navigateur');
  {
    const env = makeEnv({ fetch: () => Promise.resolve({ ok: false, status: 404, headers: { get: () => null } }) });
    let erreur = null;
    await env.sandbox.fetchImageWithProgress('/img', () => {}, env.sandbox.fullToken).catch((e) => { erreur = e; });
    check('une erreur est signalée (pas de pourcentage bloqué)', erreur && /404/.test(erreur.message), erreur && erreur.message);
  }

  console.log('\nD. Grande photo : une seule requête, puis mémoire');
  {
    let appels = 0;
    const env = makeEnv({ fetch: () => { appels++; return Promise.resolve(fakeResponse([new Uint8Array(400), new Uint8Array(600)], 1000)); } });
    const img = env.el('lb-img');
    env.sandbox.loadFullPhoto(img, '/photo?size=1200');
    await tick(20);
    check('la photo est posée dans la visionneuse', /^blob:mews\//.test(img.src), img.src);
    const avant = img.src;
    env.sandbox.loadFullPhoto(img, '/photo?size=1200');   // retour sur la même photo
    await tick(20);
    check('retour sur la même photo : aucun réseau', appels === 1, appels + ' requête(s)');
    check('la même image est réutilisée', img.src === avant);
    // Le compteur s'efface quand la photo nette est réellement affichée
    // (img.onload dans updateLightbox), pas avant : on simule ce moment.
    env.sandbox.clearLoadPct();
    check('le compteur est effacé quand la photo nette s’affiche',
      env.el('lb-pct').textContent === '' && env.el('lb-loadbar').style.width === '0%');
    check('c’est bien le chargement de l’image qui efface le compteur',
      /img\.onload = function \(\) \{[^}]*clearLoadPct\(\)/.test(js));
  }

  console.log('\nE. Glissement rapide : un chargement abandonné n’écrase rien');
  {
    const env = makeEnv({ fetch: () => Promise.resolve(fakeResponse([new Uint8Array(100), new Uint8Array(900)], 1000)) });
    const img = env.el('lb-img');
    env.sandbox.loadFullPhoto(img, '/photo-1');
    env.sandbox.fullToken += 1;                 // l'utilisateur a déjà glissé vers une autre photo
    await tick(30);
    check('la photo quittée ne s’affiche pas par-dessus', img.src === '', img.src || '(vide)');
  }

  console.log('\nF. Mémoire bornée');
  {
    const env = makeEnv({ fetch: () => Promise.resolve(fakeResponse([new Uint8Array(10)], 10)) });
    const img = env.el('lb-img');
    for (let i = 0; i < 12; i++) {
      env.sandbox.loadFullPhoto(img, '/photo-' + i);
      await tick(5);
    }
    const restants = env.sandbox.FULL_ORDER.length;
    check('jamais plus de 8 grandes photos en mémoire', restants <= 8, restants + ' en mémoire');
    check('les images sorties de la mémoire sont libérées', env.calls.revoques.length >= 3, env.calls.revoques.length + ' libérée(s)');
  }

  console.log('\nG. Présence à l’écran');
  check('la pastille existe dans la page', /id="lb-pct"/.test(html));
  check('la pastille se cache par défaut', /\.lb-pct \{[^}]*display: none/.test(html));
  check('elle redevient visible quand elle a un contenu', /\.lb-pct\.on \{ display: block; \}/.test(html));
  check('la barre démarre à zéro (plus d’animation perpétuelle par défaut)',
    /\.lb-loadbar \{[^}]*width: 0;/.test(html) && /#lb\.lb-indet \.lb-loadbar \{ animation/.test(html));
  check('la pastille est au-dessus de la photo, sans bloquer le doigt', /\.lb-pct \{[^}]*pointer-events: none/.test(html));

  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})();
