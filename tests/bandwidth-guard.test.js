'use strict';
/**
 * Banc d'essai : garde-fou de bande passante.
 *
 * Enjeu : le 21/10/2026 le site a été suspendu par Render (5,29 Go sur 5 Go)
 * sans prévenir à temps. Ce banc vérifie l'alerte précoce : elle doit partir
 * AVANT la limite, une seule fois par palier, et jamais deux fois le même
 * mois. Aucun accès réseau ni e-mail réel : tout est simulé.
 *
 * Lancement : npm test
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mews-bw-'));
process.env.MEWS_DATA_DIR = DATA;
// config.json porte la copie de secours de l'état (survit aux redémarrages).
fs.writeFileSync(path.join(DATA, 'config.json'), JSON.stringify({ adminPasswordHash: 'x' }));
process.env.RENDER_API_KEY = 'cle-de-test';
process.env.RENDER_SERVICE_ID = 'srv-de-test';

/* --- Faux Render et faux e-mail ------------------------------- */
const api = { mb: 0, state: 'ok' };
global.fetch = async function (url) {
  const u = String(url);
  if (!u.startsWith('https://api.render.com/v1/metrics/bandwidth-sources')) {
    throw new Error('appel réseau inattendu : ' + u);
  }
  if (api.state === '500') return new Response('boom', { status: 500 });
  // Deux blocs : le total ne doit pas être compté deux fois.
  return new Response(JSON.stringify([
    { labels: [{ field: 'trafficSource', value: 'total' }], values: [{ timestamp: 'x', value: api.mb }] },
    { labels: [{ field: 'trafficSource', value: 'nat' }], values: [{ timestamp: 'x', value: api.mb / 2 }] },
  ]), { status: 200 });
};

const sent = [];
const mailerPath = require.resolve('../lib/mailer');
require.cache[mailerPath] = {
  id: mailerPath,
  filename: mailerPath,
  loaded: true,
  exports: { sendAlert: async (subject, text) => { sent.push({ subject, text }); return { ok: true, via: 'gmail' }; } },
};

const bw = require('../lib/bandwidth-guard');

let pass = 0, fail = 0;
function check(name, cond, info) {
  if (cond) { pass++; console.log('  ✓ ' + name + (info ? ' — ' + info : '')); }
  else { fail++; console.log('  ✗ ÉCHEC : ' + name + (info ? ' — ' + info : '')); }
}
const GB = (n) => n * 1024;

(async () => {
  console.log('\nA. Sous le seuil : aucun bruit');
  fs.rmSync(path.join(DATA, 'bandwidth-alert.json'), { force: true });
  api.mb = GB(1);
  let r = await bw.run(new Date('2026-10-10T12:00:00Z'));
  check('1 Go consommé : pas d\'alerte', r.alerted === false && sent.length === 0);
  check('la métrique lue est le total, pas la somme des sources', Math.round(r.usageMb) === GB(1), r.usageMb + ' Mo');

  console.log('\nB. Franchissement de 3,5 Go : un seul e-mail');
  api.mb = GB(3.6);
  r = await bw.run(new Date('2026-10-15T12:00:00Z'));
  check('alerte envoyée', r.alerted === true && sent.length === 1);
  check('niveau « prévenir »', r.level === 'warn', r.level);
  check('l\'objet annonce le pourcentage', /72 %/.test(sent[0].subject), sent[0].subject);
  check('le corps donne le reste et les jours restants', /reste 1,40 Go/.test(sent[0].text) && /17 jour/.test(sent[0].text));
  api.mb = GB(3.8);
  r = await bw.run(new Date('2026-10-16T12:00:00Z'));
  check('pas de doublon au cycle suivant', r.alerted === false && sent.length === 1);

  console.log('\nC. Franchissement de 4,5 Go : dernier avertissement');
  api.mb = GB(4.6);
  r = await bw.run(new Date('2026-10-20T12:00:00Z'));
  check('second e-mail, niveau urgent', r.alerted === true && r.level === 'urgent' && sent.length === 2, sent[1] && sent[1].subject);
  check('le texte dit que le site sera suspendu', /C'EST LE DERNIER AVERTISSEMENT/.test(sent[1].text));
  api.mb = GB(4.9);
  r = await bw.run(new Date('2026-10-21T12:00:00Z'));
  check('pas de troisième e-mail', r.alerted === false && sent.length === 2);

  console.log('\nD. Mois suivant : la surveillance repart');
  api.mb = GB(0.4);
  r = await bw.run(new Date('2026-11-02T12:00:00Z'));
  check('nouveau mois sous le seuil : pas d\'alerte', r.alerted === false);
  check('le compteur du mois est remis à zéro', bw.state().level === null, JSON.stringify(bw.state()));
  api.mb = GB(3.7);
  r = await bw.run(new Date('2026-11-20T12:00:00Z'));
  check('nouvelle alerte au même palier le mois suivant', r.alerted === true && sent.length === 3);

  console.log('\nE. Robustesse');
  api.state = '500';
  r = await bw.run(new Date('2026-11-25T12:00:00Z'));
  check('API Render en panne : pas de plantage', r.ok === false && sent.length === 3);
  api.state = 'ok';
  delete process.env.RENDER_API_KEY;
  const noKey = await bw.fetchUsageMb(new Date());
  check('sans clé API : veille silencieuse', noKey === null);
  process.env.RENDER_API_KEY = 'cle-de-test';

  console.log('\nF. Le message reste lisible');
  const msg = bw.buildMessage(GB(4.2), { level: 'warn', daysLeft: 6, projected: GB(5.6) });
  check('dit que le site risque la suspension', /risque d'être suspendu/.test(msg));
  check('ne contient pas de jargon technique', !/API|JSON|token/i.test(msg));
  check('signé', /Mews Studio Galleries/.test(msg));


  console.log('\nG. Quota déjà dépassé (situation du 21/10/2026)');
  fs.rmSync(path.join(DATA, 'bandwidth-alert.json'), { force: true });
  api.mb = GB(5.29);
  const before = sent.length;
  r = await bw.run(new Date('2026-10-21T14:00:00Z'));
  check('un seul message, niveau « dépassé »', r.alerted === true && r.level === 'over' && sent.length === before + 1);
  const over = sent[sent.length - 1];
  check('l\'objet parle de dépassement, pas de suspension', /dépassé/.test(over.subject) && !/suspendu/.test(over.subject), over.subject);
  check('le montant est chiffré', /0,04 \$/.test(over.text), (over.text.match(/[0-9,]+ \$/) || [])[0]);
  check('et la facturation expliquée sans panique', /sans suspension/.test(over.text));
  r = await bw.run(new Date('2026-10-22T14:00:00Z'));
  check('pas de répétition le lendemain', r.alerted === false);
  // Un palier inférieur ne redéclenche rien ensuite.
  api.mb = GB(4.6);
  r = await bw.run(new Date('2026-10-23T14:00:00Z'));
  check('redescente sous 5 Go : pas de message « urgent »', r.alerted === false, r.level);


  console.log('\nH. Redémarrage du service : aucun e-mail en double');
  // Le disque de Render est effacé à chaque redémarrage : seul le fichier
  // local disparaît, la copie de secours (config.json sauvegardé) reste.
  api.mb = GB(3.9);
  fs.rmSync(path.join(DATA, 'bandwidth-alert.json'), { force: true });
  const n0 = sent.length;
  r = await bw.run(new Date('2026-12-10T12:00:00Z'));
  check('première alerte du mois', r.alerted === true && sent.length === n0 + 1);
  fs.rmSync(path.join(DATA, 'bandwidth-alert.json'), { force: true });   // redémarrage
  r = await bw.run(new Date('2026-12-10T18:00:00Z'));
  check('après redémarrage : pas de nouvel e-mail', r.alerted === false && sent.length === n0 + 1);
  check('l\'état relu vient de la sauvegarde', bw.state().month === '2026-12', JSON.stringify(bw.state()));

  console.log('\nRésultat : ' + pass + ' réussites, ' + fail + ' échec(s)');
  process.exit(fail ? 1 : 0);
})();
