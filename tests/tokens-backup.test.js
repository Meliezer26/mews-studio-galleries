'use strict';
/**
 * Banc d'essai : sauvegarde des jetons OAuth (Drive + envoi Gmail).
 *
 * Enjeu : après un redémarrage (disque effacé), le site doit repartir avec
 * le jeton le PLUS RÉCENT — celui d'une reconnexion faite dans l'admin —
 * et non avec l'ancien jeton d'une variable d'environnement devenue
 * obsolète. Les jetons ne doivent jamais apparaître en clair dans le dépôt.
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
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret-de-test';
process.env.GOOGLE_REFRESH_TOKEN = 'ANCIEN_JETON_ENV_OBSOLETE';
process.env.GOOGLE_MAIL_REFRESH_TOKEN = 'ANCIEN_JETON_MAIL_ENV';

const gh = { content: null };
global.fetch = async function (url, init) {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) throw new Error('appel réseau inattendu : ' + u);
  if ((init && init.method) === 'PUT') {
    gh.content = Buffer.from(JSON.parse(init.body).content, 'base64').toString('utf8');
    return new Response('{}', { status: 200 });
  }
  if (u.includes('/contents/')) return new Response(JSON.stringify({ sha: 's', encoding: 'none', content: '' }), { status: 200 });
  return new Response(JSON.stringify({ encoding: 'base64', content: Buffer.from(gh.content || '', 'utf8').toString('base64') }), { status: 200 });
};

const backup = require(path.join(__dirname, '..', 'lib', 'backup'));
const store = require(path.join(__dirname, '..', 'lib', 'store'));

function resetData() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify([
    { id: 'g1', slug: 'g1', name: 'G1', mode: 'drive', files: [{ id: 'a' }] },
    { id: 'g2', slug: 'g2', name: 'G2', mode: 'drive', files: [{ id: 'b' }] },
  ]));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x' }));
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  console.log('\nA. Les deux jetons partent dans la sauvegarde, chiffrés');
  resetData();
  store.saveTokens({ refresh_token: 'JETON_DRIVE_RECENT', access_token: 'a', expiry: Date.now() + 3600000, email: 'smelki@gmail.com' });
  store.saveTokensMail({ refresh_token: 'JETON_MAIL_RECENT', email: 'mewstudiofrance@gmail.com', connectedAt: '2026-09-22T06:26:27Z' });
  gh.content = JSON.stringify({ version: 3, savedAt: new Date().toISOString(), config: {}, galleries: [] });
  await backup.now({ force: true });
  const written = JSON.parse(gh.content);
  check('champ driveToken présent', !!written.driveToken);
  check('champ mailToken présent', !!written.mailToken);
  check('le jeton Drive n\'apparaît PAS en clair', !gh.content.includes('JETON_DRIVE_RECENT'));
  check('le jeton Gmail n\'apparaît PAS en clair', !gh.content.includes('JETON_MAIL_RECENT'));

  console.log('\nB. Redémarrage : la sauvegarde gagne sur les variables obsolètes');
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const r = await backup.restoreIfNeeded();
  check('restauration signalée', r.restored === true, r.reason);
  const td = store.tokens() || {};
  const tm = store.tokensMail() || {};
  check('jeton Drive restauré depuis la sauvegarde', td.refresh_token === 'JETON_DRIVE_RECENT', td.refresh_token);
  check('jeton Drive de l\'env ignoré', td.refresh_token !== 'ANCIEN_JETON_ENV_OBSOLETE');
  check('jeton Gmail restauré depuis la sauvegarde', tm.refresh_token === 'JETON_MAIL_RECENT', tm.refresh_token);
  check('jeton Gmail de l\'env ignoré', tm.refresh_token !== 'ANCIEN_JETON_MAIL_ENV');

  console.log('\nC. Rotation de GOOGLE_CLIENT_SECRET');
  const before = gh.content;
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-autre-secret-apres-rotation';
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'backup'))];
  const backup2 = require(path.join(__dirname, '..', 'lib', 'backup'));
  const r2 = await backup2.restoreIfNeeded();
  const td2 = store.tokens() || {};
  check('la restauration n\'échoue pas', r2.restored === true, r2.reason);
  check('aucun jeton indéchiffrable n\'est écrit', !td2.refresh_token);
  check('la sauvegarde reste intacte', gh.content === before);
  process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret-de-test';

  console.log('\nD. Aucun compte connecté : la sauvegarde reste valide');
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'backup'))];
  const backup3 = require(path.join(__dirname, '..', 'lib', 'backup'));
  resetData();
  await backup3.now({ force: true });
  const w3 = JSON.parse(gh.content);
  check('driveToken null (rien à protéger)', w3.driveToken === null);
  check('mailToken null (rien à protéger)', w3.mailToken === null);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
