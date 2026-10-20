'use strict';
/**
 * Banc d'essai : garde-fou anti-écrasement de la sauvegarde.
 *
 * Enjeu : ne JAMAIS écraser une sauvegarde saine par un site vide.
 * Voir lib/backup.js (assessAgainstRemote) et l'incident du 20/10/2026
 * (lecture GitHub impossible au-delà de 1 Mo, restauration muette).
 *
 * Lancement : npm test   (aucun accès réseau : GitHub est simulé)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mews-test-'));
process.env.MEWS_DATA_DIR = DATA;
process.env.GITHUB_BACKUP_TOKEN = 'faux-jeton-de-test';
process.env.GITHUB_BACKUP_REPO = 'test/repo';
process.env.GOOGLE_CLIENT_ID = 'client-de-test';
process.env.GOOGLE_CLIENT_SECRET = 'secret-de-test';
// Aucune connexion Google : l'alerte e-mail échouera en silence, sans réseau.
delete process.env.GOOGLE_REFRESH_TOKEN;
delete process.env.GOOGLE_MAIL_REFRESH_TOKEN;

const REPO = 'Meliezer26/mews-studio-backup';

/* --- Faux GitHub (aucun appel réel) --------------------------- */
const gh = { state: 'ok', content: null, puts: 0, lastPut: null };
// GitHub change l'empreinte dès que le contenu change : le simulateur doit
// faire de même, sinon le cache de lecture masque les modifications.
const crypto = require('crypto');
function contentSha() {
  return gh.content === null ? null : crypto.createHash('sha1').update(gh.content).digest('hex');
}

global.fetch = async function (url, init) {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) throw new Error('appel réseau inattendu : ' + u);
  const method = (init && init.method) || 'GET';

  if (method === 'PUT') {
    if (gh.state === '500') return new Response('boom', { status: 500 });
    gh.content = Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8');
    gh.puts++;
    gh.lastPut = gh.content;
    return new Response(JSON.stringify({ content: { sha: contentSha() } }), { status: 200 });
  }
  if (gh.state === '404') return new Response('{"message":"Not Found"}', { status: 404 });
  if (gh.state === '500' || gh.state === 'read500') return new Response('{"message":"Server Error"}', { status: 500 });
  if (u.includes('/contents/')) {
    if (gh.content === null) return new Response('{"message":"Not Found"}', { status: 404 });
    // Comme GitHub au-delà de 1 Mo : 200 avec un contenu vide.
    if (gh.state === 'empty' || gh.state === 'corrupt' || Buffer.byteLength(gh.content, 'utf8') > 1024 * 1024) {
      return new Response(JSON.stringify({ sha: contentSha(), encoding: 'none', content: '' }), { status: 200 });
    }
    return new Response(JSON.stringify({
      sha: contentSha(), encoding: 'base64', content: Buffer.from(gh.content, 'utf8').toString('base64'),
    }), { status: 200 });
  }
  if (u.includes('/git/blobs/')) {
    if (gh.state === 'corrupt') return new Response(JSON.stringify({ encoding: 'base64', content: 'cGFzIGR1IGpzb24=' }), { status: 200 });
    if (gh.state === 'empty') return new Response(JSON.stringify({ encoding: 'none', content: '' }), { status: 200 });
    return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(gh.content || '', 'utf8').toString('base64') }), { status: 200 });
  }
  throw new Error('route non gérée : ' + u);
};

const backup = require(path.join(__dirname, '..', 'lib', 'backup'));

/* --- Utilitaires ---------------------------------------------- */
function resetData(galleries) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify(galleries));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x', photographerEmail: 'test@example.com' }));
}
function gals(n, photosEach) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'g' + i, slug: 'g' + i, name: 'Galerie ' + i, mode: 'drive',
    files: Array.from({ length: photosEach }, (_, k) => ({ id: 'f' + i + '_' + k, name: 'f' + k + '.jpg' })),
  }));
}
const demoGallery = () => [{ id: 'demo', slug: 'demo', name: 'Démo', mode: 'demo', files: [{ id: 'a' }, { id: 'b' }] }];
const payloadOf = (galleries, previous) => JSON.stringify({
  version: 4, savedAt: new Date().toISOString(), config: { adminPasswordHash: 'x' }, galleries, previous: previous || null, mailToken: null,
});

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  console.log('\nA. Redémarrage sans restauration (le scénario catastrophe)');
  resetData([]);
  const healthy = payloadOf(gals(6, 100));
  gh.content = healthy;
  gh.state = '500';                                   // la lecture échoue au démarrage
  const r0 = await backup.restoreIfNeeded();
  check('la restauration échoue', r0.restored === false, r0.reason);
  check('les données locales sont marquées non fiables', backup.localTrusted() === false);
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify(demoGallery())); // demo.seed()
  gh.state = 'ok';
  const before = gh.puts;
  const r1 = await backup.now();
  check('la sauvegarde est REFUSÉE', r1.ok === false && r1.refused === true, r1.reason);
  check('aucune écriture envoyée', gh.puts === before, 'PUT=' + gh.puts);
  check('la sauvegarde en ligne est intacte', gh.content === healthy);
  check('le refus est mémorisé pour l\'admin', !!backup.lastRefusal());
  const r2 = await backup.now({ force: true });
  check('« Forcer » passe outre', r2.ok === true && gh.puts === before + 1);
  check('après forçage, les données redeviennent fiables', backup.localTrusted() === true);

  console.log('\nB. Écriture normale');
  resetData(gals(6, 100));
  gh.content = payloadOf(gals(6, 100));
  const rB = await backup.now();
  check('sauvegarde autorisée', rB.ok === true);
  const wB = JSON.parse(gh.lastPut);
  check('l\'état précédent est mémorisé', wB.previous && wB.previous.galleries === 6);
  check('format version 4', wB.version === 4);

  console.log('\nC. Sauvegarde distante illisible (bug du 20/10/2026)');
  resetData(gals(6, 100));
  gh.content = payloadOf(gals(6, 100));
  gh.puts = 0;
  gh.state = 'empty';
  const rC = await backup.now();
  check('contenu vide : écriture refusée', rC.ok === false && rC.refused === true, rC.reason);
  check('aucune écriture', gh.puts === 0);
  gh.state = 'corrupt';
  const rC2 = await backup.now();
  check('JSON cassé : écriture refusée', rC2.ok === false && rC2.refused === true);
  gh.state = 'read500';
  // Nouveau comportement (incident du 20/10) : une panne réseau/HTTP passagère
  // n'est PAS une sauvegarde corrompue. Si l'état local est cohérent avec la
  // dernière lecture réussie, on sauvegarde quand même.
  const rC3 = await backup.now();
  check('GitHub en panne : écriture autorisée (état local cohérent)', rC3.ok === true, rC3.reason || 'ok');
  resetData(gals(1, 5));                       // mais si le site a fondu...
  gh.state = 'ok';
  gh.content = payloadOf(gals(6, 100));
  gh.state = 'read500';
  const rC3b = await backup.now();
  check('GitHub en panne + site vide : écriture REFUSÉE', rC3b.refused === true, rC3b.reason);
  gh.state = 'ok';
  gh.state = '404';
  const rC4 = await backup.now();
  check('dépôt vide (404) : première sauvegarde autorisée', rC4.ok === true);

  console.log('\nD. Nombre de galeries');
  gh.state = 'ok';
  resetData(gals(5, 100));
  gh.content = payloadOf(gals(6, 100));
  check('6 → 5 : autorisé (suppression normale)', (await backup.now()).ok === true);
  resetData(gals(3, 100));
  gh.content = payloadOf(gals(6, 100));
  check('6 → 3 : REFUSÉ (chute > 40 %)', (await backup.now()).refused === true);
  resetData(gals(1, 5));
  gh.content = payloadOf(gals(6, 100));
  check('6 → 1 : REFUSÉ', (await backup.now()).refused === true);
  resetData(gals(2, 100));
  gh.content = payloadOf(gals(2, 100));
  check('2 → 2 : autorisé', (await backup.now()).ok === true);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
