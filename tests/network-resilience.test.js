'use strict';
/**
 * Banc d'essai : robustesse aux coupures réseau (incident du 20/10/2026).
 *
 * Un redémarrage de l'hébergeur coupe les connexions en cours. Le fetch
 * échoue alors avec « terminated » alors que la sauvegarde distante est
 * parfaitement saine. Ce cas NE DOIT PAS :
 *   - bloquer les sauvegardes au-delà d'un cycle,
 *   - envoyer un e-mail alarmant,
 *   - et surtout jamais autoriser l'écrasement d'une sauvegarde plus riche.
 *
 * Lancement : npm test   (aucun accès réseau)
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
process.env.MEWS_TOKEN_KEY = 'cle-de-test-pour-le-chiffrement';
delete process.env.GOOGLE_REFRESH_TOKEN;
delete process.env.GOOGLE_MAIL_REFRESH_TOKEN;

const REPO = 'Meliezer26/mews-studio-backup';

/* --- Faux GitHub, avec coupures simulées ---------------------- */
const gh = { content: null, puts: 0, down: 0, reads: 0, blobReads: 0, mails: 0 };
const realFetch = global.fetch;
global.fetch = async function (url, init) {
  const u = String(url);
  const method = (init && init.method) || 'GET';

  if (u.startsWith('https://gmail.googleapis.com') || u.startsWith('https://oauth2.googleapis.com') || u.startsWith('https://www.googleapis.com')) {
    throw new Error('aucun réseau attendu vers Google dans ce banc');
  }
  if (!u.startsWith('https://api.github.com/')) throw new Error('appel réseau inattendu : ' + u);

  // Panne simulée : connexion coupée (comme un redémarrage en pleine lecture).
  if (gh.down > 0 && method === 'GET') {
    gh.down--;
    throw new TypeError('terminated');
  }

  if (method === 'PUT') {
    gh.content = Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8');
    gh.puts++;
    return new Response(JSON.stringify({ content: { sha: 'sha-' + gh.puts } }), { status: 200 });
  }
  gh.reads++;
  if (u.includes('/contents/')) {
    if (gh.content === null) return new Response('{"message":"Not Found"}', { status: 404 });
    return new Response(JSON.stringify({ sha: 'sha-' + gh.puts, encoding: 'base64', content: '' }), { status: 200 });
  }
  gh.blobReads++;
  return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(gh.content || '', 'utf8').toString('base64') }), { status: 200 });
};

const backup = require(path.join(__dirname, '..', 'lib', 'backup'));

function resetData(galleries) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify(galleries));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x', photographerEmail: 'test@example.com' }));
}
function gals(n, photos) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'g' + i, slug: 'g' + i, name: 'Galerie ' + i, mode: 'drive',
    files: Array.from({ length: photos }, (_, k) => ({ id: 'f' + i + '_' + k, name: 'f' + k + '.jpg' })),
  }));
}
const payloadOf = (galleries, previous) => JSON.stringify({
  version: 4, savedAt: new Date().toISOString(), config: { adminPasswordHash: 'x' }, galleries, previous: previous || null, mailToken: null,
});

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  console.log('\nA. Une coupure brève est absorbée par les réessais');
  resetData(gals(6, 100));
  gh.content = payloadOf(gals(6, 100));
  gh.puts = 0; gh.reads = 0; gh.blobReads = 0;
  await backup.restoreIfNeeded();
  const avant = gh.puts;
  gh.down = 1;                       // la toute première requête est coupée
  const r1 = await backup.now();
  check('la sauvegarde réussit quand même', r1.ok === true, r1.reason || 'ok');
  check('un nouvel enregistrement a bien eu lieu', gh.puts === avant + 1);

  console.log('\nB. Le fichier n\'est plus retéléchargé à chaque cycle');
  const blobsAvant = gh.blobReads;
  const r2 = await backup.now();
  check('deuxième sauvegarde réussie', r2.ok === true);
  check('aucun téléchargement du fichier de 1,2 Mo', gh.blobReads === blobsAvant, 'blobReads=' + gh.blobReads);

  console.log('\nC. Coupure longue : repli autorisé si l\'état local est cohérent');
  resetData(gals(6, 100));
  gh.content = payloadOf(gals(6, 100));
  await backup.now();                                    // lecture réussie → cache
  gh.puts = 0;
  gh.down = 10;                                          // plus de 3 réessais → échec
  const r3 = await backup.now();
  check('écriture autorisée malgré la panne réseau', r3.ok === true, r3.reason || '');
  check('un enregistrement a eu lieu', gh.puts === 1);
  const w3 = JSON.parse(gh.content);
  check('le contenu écrit est complet', w3.galleries.length === 6);

  console.log('\nD. Coupure longue + site vide : toujours refusé');
  resetData(gals(1, 5));                                 // site « vidé »
  gh.content = payloadOf(gals(6, 100));
  gh.down = 10;
  const r4 = await backup.now();
  check('écriture REFUSÉE', r4.ok === false && r4.refused === true, r4.reason);
  check('aucun écrasement', JSON.parse(gh.content).galleries.length === 6);

  console.log('\nE. Coupure longue sans lecture récente : refus (prudence)');
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'backup'))];
  const backup2 = require(path.join(__dirname, '..', 'lib', 'backup'));   // cache vidé
  resetData(gals(6, 100));
  gh.down = 10;
  const r5 = await backup2.now();
  check('écriture REFUSÉE faute de référence', r5.ok === false && r5.refused === true, r5.reason);

  console.log('\nF. L\'alerte ne part qu\'après 3 refus consécutifs');
  let mails = 0;
  global.fetch = (function (orig) {
    return async function (url, init) {
      if (String(url).startsWith('https://gmail.googleapis.com') || String(url).startsWith('https://oauth2.googleapis.com')) { mails++; return new Response('{}', { status: 200 }); }
      return orig(url, init);
    };
  })(global.fetch);
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'backup'))];
  const backup3 = require(path.join(__dirname, '..', 'lib', 'backup'));
  resetData(gals(1, 5));                                 // état fatal → refus systématique
  gh.content = payloadOf(gals(6, 100));
  gh.down = 0;
  const mailsAvant = mails;
  const a = await backup3.now();                         // 1er refus
  check('1er refus : aucune alerte', mails === mailsAvant, 'mails=' + (mails - mailsAvant));
  const b = await backup3.now();                         // 2e refus
  check('2e refus : aucune alerte', mails === mailsAvant, 'mails=' + (mails - mailsAvant));
  check('les deux refus sont bien enregistrés', a.refused === true && b.refused === true);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
