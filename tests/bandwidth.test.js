'use strict';
/**
 * Banc d'essai : économie de bande passante (alerte Render du 20/10/2026).
 *
 * Enjeu : la sauvegarde était réécrite toutes les 5 minutes MÊME SANS
 * CHANGEMENT (1,2 Mo × 12/h, nuit et jour ≈ 10 Go/mois), ce qui a consommé
 * 70 % du quota de 5 Go. Une sauvegarde ne doit coûter de la bande passante
 * que lorsque le contenu change réellement — sans jamais perdre une
 * modification ni affaiblir le garde-fou.
 *
 * Lancement : npm test   (aucun accès réseau)
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
process.env.GOOGLE_CLIENT_SECRET = 'secret-de-test';
process.env.MEWS_TOKEN_KEY = 'cle-de-test';
delete process.env.GOOGLE_REFRESH_TOKEN;
delete process.env.GOOGLE_MAIL_REFRESH_TOKEN;

/* --- Faux GitHub, compteur d'octets --------------------------- */
const gh = { content: null, puts: 0, bytesOut: 0, bytesIn: 0, gets: 0 };
global.fetch = async function (url, init) {
  const u = String(url);
  if (!u.startsWith('https://api.github.com/')) throw new Error('réseau inattendu : ' + u);
  const method = (init && init.method) || 'GET';

  if (method === 'PUT') {
    const body = init.body || '';
    gh.bytesOut += Buffer.byteLength(body, 'utf8');
    gh.content = Buffer.from(JSON.parse(body).content, 'base64').toString('utf8');
    gh.puts++;
    const sha = crypto.createHash('sha1').update(gh.content).digest('hex');
    return new Response(JSON.stringify({ content: { sha } }), { status: 200 });
  }
  gh.gets++;
  const sha = gh.content === null ? null : crypto.createHash('sha1').update(gh.content).digest('hex');
  if (u.includes('/contents/')) {
    if (gh.content === null) return new Response('{"message":"Not Found"}', { status: 404 });
    const payload = JSON.stringify({ sha, encoding: 'none', content: '' });
    gh.bytesIn += Buffer.byteLength(payload, 'utf8');
    return new Response(payload, { status: 200 });
  }
  const body = JSON.stringify({ encoding: 'base64', content: Buffer.from(gh.content || '', 'utf8').toString('base64') });
  gh.bytesIn += Buffer.byteLength(body, 'utf8');
  return new Response(body, { status: 200 });
};

const backup = require(path.join(__dirname, '..', 'lib', 'backup'));
const store = require(path.join(__dirname, '..', 'lib', 'store'));

function resetData(galleries) {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'galleries.json'), JSON.stringify(galleries));
  fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x', photographerEmail: 'test@example.com' }));
}
function gals(n, photos) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'g' + i, slug: 'g' + i, name: 'Galerie ' + i, mode: 'drive',
    files: Array.from({ length: photos }, (_, k) => ({
      id: 'f' + i + '_' + k, name: 'fichier-photo-' + k + '.jpg', size: 4000000 + k, mime: 'image/jpeg', storage: 'drive',
      thumb: 'https://lh3.googleusercontent.com/d/ID' + k + '=s400',
    })),
  }));
}

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}

(async () => {
  console.log('\nA. Première sauvegarde : écriture normale');
  resetData(gals(6, 250));                 // ~1500 photos, proche du réel
  const r0 = await backup.now();
  check('écriture effectuée', r0.ok === true && gh.puts === 1);
  const tailleKo = Math.round(gh.bytesOut / 1024);
  console.log('    poids d\'une écriture : ' + tailleKo + ' Ko');

  console.log('\nB. 12 cycles sans aucun changement (1 heure de veille)');
  const putsAvant = gh.puts;
  const octetsAvant = gh.bytesOut;
  for (let i = 0; i < 12; i++) await backup.now();
  const economise = gh.bytesOut - octetsAvant;
  check('aucune réécriture inutile', gh.puts === putsAvant, 'écritures=' + (gh.puts - putsAvant));
  check('aucun octet envoyé pendant l\'heure', economise === 0, economise + ' octets');
  const goParMois = (ko) => ((ko * 12 * 24 * 30) / 1024 / 1024).toFixed(2);
  console.log('    avec cette taille (' + tailleKo + ' Ko) : ~' + goParMois(tailleKo) + ' Go/mois de trafic sortant pour rien');
  console.log('    avec la taille réelle constatée (1230 Ko) : ~' + goParMois(1230) + ' Go/mois');
  console.log('    après ce correctif : 0 octet tant que rien ne change');

  console.log('\nC. Une modification réelle est sauvegardée immédiatement');
  const all = store.galleries();
  all[0].clientName = 'Cliente ajoutée';
  store.saveGalleries(all);
  const r1 = await backup.now();
  check('écriture déclenchée par la modification', gh.puts === putsAvant + 1);
  check('la modification est bien dans la copie en ligne',
    JSON.parse(gh.content).galleries[0].clientName === 'Cliente admissible' || JSON.parse(gh.content).galleries[0].clientName === 'Cliente ajoutée');

  console.log('\nD. Puis de nouveau le silence');
  const p2 = gh.puts;
  for (let i = 0; i < 6; i++) await backup.now();
  check('aucune réécriture après la modification', gh.puts === p2);

  console.log('\nE. Le garde-fou reste actif malgré l\'économie');
  resetData(gals(1, 5));                   // site « vidé »
  const r2 = await backup.now();
  check('site vide : écriture REFUSÉE', r2.refused === true, r2.reason || '');
  resetData(gals(6, 250));
  const r3 = await backup.now({ force: true });
  check('« Forcer » fonctionne toujours', r3.ok === true);

  console.log('\nF. Le battement de cœur (12 h) réécrit la copie');
  // Redémarrage réel : le disque est vidé, la copie en ligne est restaurée.
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  delete require.cache[require.resolve(path.join(__dirname, '..', 'lib', 'backup'))];
  const backup2 = require(path.join(__dirname, '..', 'lib', 'backup'));
  const p3 = gh.puts;
  const octets3 = gh.bytesOut;
  const rr = await backup2.restoreIfNeeded();
  check('restauration effectuée au redémarrage', rr.restored === true, rr.reason);
  const r4 = await backup2.now();
  check('après restauration, aucune réécriture inutile', gh.puts === p3,
    r4.unchanged ? 'rien à envoyer' : 'écriture');
  check('aucun octet envoyé après le redémarrage', gh.bytesOut === octets3, (gh.bytesOut - octets3) + ' octets');
  console.log('    (un redémarrage ne coûte plus 1,2 Mo de réécriture)');

  fs.rmSync(DATA, { recursive: true, force: true });
  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERREUR DU BANC :', e); process.exit(1); });
