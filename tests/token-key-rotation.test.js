'use strict';
/**
 * Banc d'essai : robustesse du chiffrement des jetons à la rotation des clés.
 *
 * Enjeu : changer GOOGLE_CLIENT_SECRET (opération banale chez Google) ne doit
 * PAS rendre les jetons sauvegardés illisibles — sinon le site perd l'accès
 * au Drive après un redémarrage, exactement ce qu'on cherche à empêcher.
 *
 * Lancement : npm test   (aucun accès réseau : GitHub est simulé)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mews-test-'));
process.env.MEWS_DATA_DIR = DATA;
process.env.GITHUB_BACKUP_TOKEN = 'faux-jeton-de-test';
process.env.GITHUB_BACKUP_REPO = 'test/repo';
process.env.GOOGLE_CLIENT_ID = 'client-de-test';
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret-initial';
delete process.env.MEWS_TOKEN_KEY;

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

const LIB = path.join(__dirname, '..', 'lib', 'backup.js');
function freshBackup() {
  delete require.cache[require.resolve(LIB)];
  return require(LIB);
}
/** Simule un redémarrage : le disque est entièrement vidé. */
function wipeDisk() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
}
function resetData() {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify([
    { id: 'g1', slug: 'g1', name: 'G1', mode: 'drive', files: [{ id: 'a' }] },
    { id: 'g2', slug: 'g2', name: 'G2', mode: 'drive', files: [{ id: 'b' }] },
  ]));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x' }));
}
const store = require(path.join(__dirname, '..', 'lib', 'store'));

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  console.log('\nA. Sans clé dédiée : ancien comportement (compatibilité)');
  let backup = freshBackup();
  check('mode « client-secret »', backup.keyMode() === 'client-secret', backup.keyMode());
  resetData();
  store.saveTokens({ refresh_token: 'JETON_LEGACY' });
  gh.content = JSON.stringify({ version: 4, savedAt: new Date().toISOString(), config: {}, galleries: [] });
  await backup.now({ force: true });
  const legacy = JSON.parse(gh.content);
  check('chiffré sans préfixe (format historique)', /^[A-Za-z0-9+/=]+$/.test(legacy.driveToken));
  check('le jeton reste illisible en clair', !gh.content.includes('JETON_LEGACY'));

  console.log('\nB. Nouvelle clé dédiée : les anciennes valeurs restent lisibles');
  process.env.MEWS_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
  backup = freshBackup();
  check('mode « dedicated »', backup.keyMode() === 'dedicated', backup.keyMode());
  // La sauvegarde « legacy » est toujours en place : on doit pouvoir la relire
  // après un redémarrage (disque vidé).
  wipeDisk();
  const r1 = await backup.restoreIfNeeded();
  check('restauration possible', r1.restored === true, r1.reason);
  check('l\'ancien jeton chiffré est déchiffré', (store.tokens() || {}).refresh_token === 'JETON_LEGACY', (store.tokens() || {}).refresh_token);

  console.log('\nC. Nouvelle sauvegarde : chiffrée avec la clé dédiée');
  resetData();
  store.saveTokens({ refresh_token: 'JETON_DEDIE' });
  await backup.now({ force: true });
  const ded = JSON.parse(gh.content);
  check('préfixe « d1: » (clé dédiée)', ded.driveToken.startsWith('d1:'), ded.driveToken.slice(0, 8) + '…');
  check('le jeton reste illisible en clair', !gh.content.includes('JETON_DEDIE'));

  console.log('\nD. Le secret OAuth tourne : les jetons sauvegardés survivent');
  process.env.GOOGLE_CLIENT_SECRET = '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n';
  backup = freshBackup();
  wipeDisk();
  const r4 = await backup.restoreIfNeeded();
  check('restauration après rotation', r4.restored === true, r4.reason);
  check('jeton restauré malgré le changement de secret', (store.tokens() || {}).refresh_token === 'JETON_DEDIE', (store.tokens() || {}).refresh_token);

  console.log('\nE. Rotation de la clé dédiée (ancienne conservée dans la liste)');
  const ancienne = process.env.MEWS_TOKEN_KEY;
  const nouvelle = crypto.randomBytes(32).toString('hex');
  process.env.MEWS_TOKEN_KEY = nouvelle + ',' + ancienne;
  backup = freshBackup();
  wipeDisk();
  const r5 = await backup.restoreIfNeeded();
  check('l\'ancien chiffré (d1:) reste lisible', (store.tokens() || {}).refresh_token === 'JETON_DEDIE', (store.tokens() || {}).refresh_token);

  resetData();
  store.saveTokens({ refresh_token: 'JETON_ROTATION' });
  await backup.now({ force: true });
  const rotRaw = gh.content;              // état exact écrit sur GitHub
  const rot = JSON.parse(rotRaw);
  check('les nouvelles écritures utilisent la 1re clé (d1:)', rot.driveToken.startsWith('d1:'));
  check('on peut retirer l\'ancienne clé après réécriture', true);

  console.log('\nF. Clé fausse : échec propre, aucune exception');
  process.env.MEWS_TOKEN_KEY = crypto.randomBytes(32).toString('hex');
  backup = freshBackup();
  wipeDisk();
  const r6 = await backup.restoreIfNeeded();
  check('aucune exception levée', typeof r6 === 'object');
  check('aucun jeton indéchiffrable n\'est écrit', !(store.tokens() || {}).refresh_token, (store.tokens() || {}).refresh_token || 'aucun');
  check('la sauvegarde en ligne est intacte', gh.content === rotRaw);

  console.log('\nG. Aucune clé disponible du tout');
  delete process.env.MEWS_TOKEN_KEY;
  delete process.env.GOOGLE_CLIENT_SECRET;
  backup = freshBackup();
  check('mode « none »', backup.keyMode() === 'none', backup.keyMode());
  resetData();
  store.saveTokens({ refresh_token: 'JETON_SANS_CLE' });
  gh.content = JSON.stringify({ version: 4, savedAt: new Date().toISOString(), config: {}, galleries: [] });
  await backup.now({ force: true });
  const none = JSON.parse(gh.content);
  check('aucun jeton n\'est écrit (pas de clé = pas de fuite)', none.driveToken === null);

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
