'use strict';
/* ------------------------------------------------------------------
 * Bilan de santé hebdomadaire — Mews Studio Galleries
 *
 * Chaque LUNDI à 08:00 (heure de Paris), le serveur vérifie lui-même :
 *   - le site (page d'accueil, point de vie, certificat HTTPS),
 *   - Google Drive (compte de service + Drive de tri) et chaque galerie,
 *   - Gmail (jeton accepté par Google),
 *   - la sauvegarde GitHub (fraîcheur, contenu),
 * puis envoie le rapport au photographe par e-mail.
 *
 * Les AUTRES jours, le même contrôle tourne en silence à 08:00 et
 * n'envoie un e-mail QUE si quelque chose est en panne (alerte).
 * ------------------------------------------------------------------ */
const tls = require('tls');
const store = require('./store');
const drive = require('./drive');
const backup = require('./backup');
const mailer = require('./mailer');

const SITE_HOST = process.env.CANONICAL_HOST || 'galeries.mewstudio.com';
const HOUR_PARIS = 8;            // heure d'exécution
const WEEKLY_DAY = 1;            // 1 = lundi

let lastReport = null;
let running = false;

/* --- Utilitaires -------------------------------------------------- */
function parisParts(d = new Date()) {
  const f = new Intl.DateTimeFormat('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'short', hour: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const p = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const dayIdx = { 'dim.': 0, 'lun.': 1, 'mar.': 2, 'mer.': 3, 'jeu.': 4, 'ven.': 5, 'sam.': 6 }[p.weekday];
  return { day: dayIdx, hour: parseInt(p.hour, 10) % 24, date: p.year + '-' + p.month + '-' + p.day };
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(label + ' : délai dépassé (' + ms / 1000 + ' s)')), ms)),
  ]);
}

function certExpiry(host) {
  return new Promise((resolve, reject) => {
    const s = tls.connect({ host, port: 443, servername: host, timeout: 8000 }, () => {
      const c = s.getPeerCertificate();
      s.end();
      resolve(c && c.valid_to ? new Date(c.valid_to) : null);
    });
    s.on('error', reject);
    s.on('timeout', () => { s.destroy(); reject(new Error('timeout TLS')); });
  });
}

/* --- Les contrôles --------------------------------------------------
 * Chaque contrôle renvoie { ok: bool, detail: '…' } (jamais d'exception). */
async function check(label, fn) {
  const t0 = Date.now();
  try {
    const r = await withTimeout(fn(), 20000, label);
    return { label, ok: r.ok !== false, detail: r.detail || '', ms: Date.now() - t0 };
  } catch (e) {
    return { label, ok: false, detail: String(e.message || e).slice(0, 160), ms: Date.now() - t0 };
  }
}

async function runChecks() {
  const checks = [];

  // 1. Site public
  checks.push(await check('Site — page d\'accueil', async () => {
    const res = await fetch('https://' + SITE_HOST + '/', { redirect: 'manual' });
    return { ok: res.status === 200, detail: 'HTTP ' + res.status };
  }));
  checks.push(await check('Site — point de vie (keepalive)', async () => {
    const res = await fetch('https://' + SITE_HOST + '/healthz');
    return { ok: res.status === 200, detail: 'HTTP ' + res.status };
  }));
  checks.push(await check('Site — certificat HTTPS', async () => {
    const exp = await certExpiry(SITE_HOST);
    if (!exp) return { ok: false, detail: 'certificat illisible' };
    const days = Math.round((exp - Date.now()) / 86400000);
    return { ok: days > 7, detail: 'expire dans ' + days + ' j (' + exp.toLocaleDateString('fr-FR') + ')' };
  }));

  // 2. Google Drive (compte principal) + galeries
  const galleries = store.galleries() || [];
  checks.push(await check('Google Drive — compte principal', async () => {
    if (!drive.isConfigured()) return { ok: false, detail: 'non configuré' };
    const g = galleries.find((x) => x.folderId);
    if (!g) return { ok: true, detail: 'connecté (aucune galerie Drive à tester)' };
    const meta = await drive.folderMeta(g.folderId);
    return { ok: !!meta.id, detail: 'dossier « ' + (meta.name || g.folderId) + ' » lisible' };
  }));
  for (const g of galleries) {
    if (!g.folderId) continue;
    checks.push(await check('Galerie — ' + (g.name || g.slug), async () => {
      const files = await drive.listImages(g.folderId);
      const n = Array.isArray(files) ? files.length : 0;
      const known = (g.files || []).length;
      const ok = n > 0 && (known === 0 || n >= known);
      return { ok, detail: n + ' photo' + (n > 1 ? 's' : '') + ' sur le Drive' + (known && n !== known ? ' (' + known + ' connues côté site)' : '') };
    }));
  }
  checks.push(await check('Google Drive — compte de tri (albums)', async () => {
    const t = store.tokens();
    if (!(t && t.refresh_token)) return { ok: false, detail: 'non connecté' };
    const res = await drive.userApi('/drive/v3/about?fields=user(emailAddress)');
    if (!res.ok) return { ok: false, detail: 'HTTP ' + res.status };
    const d = await res.json();
    return { ok: true, detail: 'connecté : ' + ((d.user && d.user.emailAddress) || '?') };
  }));

  // 3. Gmail
  checks.push(await check('Gmail — compte d\'envoi', async () => {
    if (!drive.isMailConnected()) return { ok: false, detail: 'non connecté' };
    const tok = await drive.mailAccessToken();
    const tm = store.tokensMail() || {};
    if (!tok) {
      const e = tm.lastRefreshError;
      return { ok: false, detail: 'jeton refusé par Google' + (e ? ' (' + (e.error || e.status) + (e.description ? ' — ' + e.description : '') + ')' : '') + ' → Reconnecter dans l\'admin' };
    }
    return { ok: true, detail: (tm.email || 'compte') + ' accepté par Google' + (tm.connectedAt ? ' (connecté le ' + new Date(tm.connectedAt).toLocaleDateString('fr-FR') + ')' : '') };
  }));

  // 4. Sauvegarde
  checks.push(await check('Sauvegarde — dernière écriture', async () => {
    const at = backup.lastBackupAt();
    if (!at) return { ok: false, detail: 'aucune sauvegarde depuis le démarrage' };
    const min = Math.round((Date.now() - new Date(at)) / 60000);
    return { ok: min <= 20, detail: 'il y a ' + min + ' min (' + (backup.lastBackupStore() || backup.backupStore() || '?') + ')' };
  }));
  checks.push(await check('Sauvegarde — contenu GitHub', async () => {
    if (!backup.githubConfigured()) return { ok: false, detail: 'GitHub non configuré' };
    const data = await backup.githubGet();
    if (!data) return { ok: false, detail: 'fichier de sauvegarde absent' };
    const n = Array.isArray(data.galleries) ? data.galleries.length : 0;
    const age = data.savedAt ? Math.round((Date.now() - new Date(data.savedAt)) / 60000) : null;
    return {
      ok: n >= galleries.length && !!data.mailToken && (age === null || age <= 30),
      detail: n + ' galerie' + (n > 1 ? 's' : '') + ', jeton Gmail ' + (data.mailToken ? 'présent' : 'ABSENT') + (age !== null ? ', datée d\'il y a ' + age + ' min' : ''),
    };
  }));

  const failed = checks.filter((c) => !c.ok);
  return {
    at: new Date().toISOString(),
    ok: failed.length === 0,
    checks,
    failedCount: failed.length,
    galleriesCount: galleries.length,
    photosCount: galleries.reduce((s, g) => s + ((g.files || []).length), 0),
  };
}

/* --- E-mail ---------------------------------------------------------- */
function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

function buildMail(report, weekly) {
  const dateFr = new Date(report.at).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const title = report.ok
    ? (weekly ? 'Bilan du lundi — tout fonctionne ✓' : 'Tout est rentré dans l\'ordre ✓')
    : 'ALERTE — ' + report.failedCount + ' problème' + (report.failedCount > 1 ? 's' : '') + ' détecté' + (report.failedCount > 1 ? 's' : '');
  const subject = (report.ok ? '✓ ' : '⚠ ') + 'Mews Studio Galleries — ' + title;

  const lines = report.checks.map((c) => (c.ok ? '  ✓ ' : '  ✗ ') + c.label + (c.detail ? ' — ' + c.detail : ''));
  const text = [
    title, '', 'Contrôle automatique du ' + dateFr + ' (08:00, Paris).', '',
    ...lines, '',
    report.galleriesCount + ' galerie(s), ' + report.photosCount + ' photos au total.',
    '',
    report.ok ? 'Rien à faire.' : 'Que faire : ouvrez l\'admin (https://' + SITE_HOST + '/admin). Pour Gmail → section e-mails → « Reconnecter avec Google ». Pour le reste, transmettez ce message à votre assistant.',
    '', '— Mews Studio Galleries, contrôle hebdomadaire',
  ].join('\n');

  const rows = report.checks.map((c) =>
    '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee;white-space:nowrap;color:' + (c.ok ? '#1a7f37' : '#d1242f') + ';font-weight:600">' + (c.ok ? '✓ OK' : '✗ PANNE') + '</td>' +
    '<td style="padding:6px 10px;border-bottom:1px solid #eee"><b>' + esc(c.label) + '</b>' + (c.detail ? '<br><span style="color:#555">' + esc(c.detail) + '</span>' : '') + '</td></tr>').join('');
  const html =
    '<div style="font-family:Inter,Arial,sans-serif;max-width:640px;margin:0 auto;color:#111">' +
    '<h2 style="margin:0 0 4px;color:' + (report.ok ? '#1a7f37' : '#d1242f') + '">' + esc(title) + '</h2>' +
    '<p style="margin:0 0 16px;color:#555">Contrôle automatique du ' + esc(dateFr) + ' (08:00, Paris).</p>' +
    '<table style="border-collapse:collapse;width:100%;font-size:14px">' + rows + '</table>' +
    '<p style="margin:16px 0 0;color:#555">' + report.galleriesCount + ' galerie(s), ' + report.photosCount + ' photos au total.</p>' +
    (report.ok
      ? '<p style="margin:12px 0 0"><b>Rien à faire.</b></p>'
      : '<p style="margin:12px 0 0"><b>Que faire :</b> ouvrez <a href="https://' + SITE_HOST + '/admin">l\'admin</a>. Pour Gmail → section e-mails → « Reconnecter avec Google ». Pour le reste, transmettez ce message à votre assistant.</p>') +
    '<p style="margin:24px 0 0;font-size:12px;color:#999">— Mews Studio Galleries, contrôle hebdomadaire (chaque lundi ; les autres jours, un e-mail n\'est envoyé qu\'en cas de panne).</p>' +
    '</div>';
  return { subject, text, html };
}

async function sendReport(report, weekly) {
  const to = mailer.recipient();
  if (!to) throw new Error('aucun destinataire (adresse du photographe absente)');
  const cfg = store.config();
  const from = (cfg.notifications && cfg.notifications.from) || ('Mews Studio <' + to + '>');
  const m = buildMail(report, weekly);
  await mailer.sendMail({ from, to, subject: m.subject, text: m.text, html: m.html });
}

/* --- Orchestration ----------------------------------------------------- */
function state() {
  const cfg = store.config();
  return (cfg.healthcheck && typeof cfg.healthcheck === 'object') ? cfg.healthcheck : {};
}
function saveState(patch) {
  const cfg = store.config();
  cfg.healthcheck = { ...state(), ...patch };
  store.saveConfig(cfg);
}

/**
 * Lance un contrôle. mode = 'weekly' (rapport envoyé quoi qu'il arrive),
 * 'daily' (e-mail seulement si panne, ou si retour à la normale après une panne),
 * 'manual' (rapport envoyé si sendMail=true).
 */
async function run(mode = 'manual', { sendMail = true } = {}) {
  if (running) return lastReport;
  running = true;
  try {
    const report = await runChecks();
    report.mode = mode;
    const prev = state();
    let mailed = false;
    let shouldMail = false;
    if (mode === 'weekly') shouldMail = true;
    else if (mode === 'daily') shouldMail = !report.ok || prev.lastOk === false; // panne, ou retour à la normale
    else shouldMail = !!sendMail;
    if (shouldMail) {
      try {
        await sendReport(report, mode === 'weekly');
        mailed = true;
      } catch (e) {
        report.mailError = String(e.message || e).slice(0, 160);
        console.warn('[healthcheck] Envoi du rapport impossible :', report.mailError);
      }
    }
    report.mailed = mailed;
    lastReport = report;
    saveState({ lastRunAt: report.at, lastOk: report.ok, lastMode: mode, lastMailed: mailed, lastRunDate: parisParts().date });
    console.log('[healthcheck] ' + mode + ' : ' + (report.ok ? 'OK' : report.failedCount + ' panne(s)') + (mailed ? ' — rapport envoyé' : ''));
    return report;
  } finally {
    running = false;
  }
}

/** Planification : toutes les minutes, déclenche à 08:xx Paris une fois par jour. */
let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    try {
      const p = parisParts();
      if (p.hour !== HOUR_PARIS) return;
      if (state().lastRunDate === p.date) return; // déjà fait aujourd'hui (survit aux redémarrages via config/sauvegarde)
      run(p.day === WEEKLY_DAY ? 'weekly' : 'daily').catch((e) => console.warn('[healthcheck] Erreur :', e.message));
    } catch (e) { /* ne jamais faire tomber le serveur pour un contrôle */ }
  }, 60 * 1000);
  timer.unref && timer.unref();
}

function nextWeeklyRun() {
  // Prochain lundi 08:00 Paris (approximation lisible pour l'admin).
  const now = new Date();
  for (let i = 0; i < 8; i++) {
    const d = new Date(now.getTime() + i * 86400000);
    const p = parisParts(d);
    if (p.day === WEEKLY_DAY && (i > 0 || p.hour < HOUR_PARIS)) return p.date + ' 08:00';
  }
  return null;
}

module.exports = { run, start, lastReport: () => lastReport, state, nextWeeklyRun };
