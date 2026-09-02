'use strict';
/**
 * Notifications e-mail (SMTP) — nodemailer.
 * Configuration stockée dans data/config.json (section `notifications`),
 * modifiable depuis l'espace photographe (Réglages).
 */
const nodemailer = require('nodemailer');
const { config } = require('./store');

function smtp() {
  return config().notifications || {};
}

function isConfigured() {
  const n = smtp();
  return !!(n.enabled && n.host && n.from);
}

function recipient() {
  const n = smtp();
  return n.to || config().photographerEmail || '';
}

function buildTransport() {
  const n = smtp();
  return nodemailer.createTransport({
    host: n.host,
    port: Number(n.port) || 587,
    secure: !!n.secure, // true = SSL direct (465), false = STARTTLS (587)
    auth: n.user ? { user: n.user, pass: n.pass || '' } : undefined,
  });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function buildContent(info) {
  const rows = info.albums.filter((a) => a.photoIds.length);
  const total = info.albums.reduce((n, a) => n + a.photoIds.length, 0);

  const lines = [];
  lines.push('Bonjour,');
  lines.push('');
  lines.push((info.clientName || 'Un client') + ' vient d\u2019envoyer une sélection de photos pour la galerie « ' + info.galleryName + ' ».');
  lines.push('');
  rows.forEach((a) => {
    lines.push('▸ ' + a.label + ' — ' + a.photoIds.length + ' photo(s)');
    a.photos.forEach((p) => lines.push('   · n°' + (p.index != null ? p.index : '?') + ' — ' + p.name));
    lines.push('');
  });
  lines.push('Total : ' + total + ' photo(s)');
  lines.push('Galerie : ' + info.galleryUrl);
  lines.push('');
  lines.push('Envoyé par Mews Studio Galleries.');

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Nouvelle sélection d\u2019albums</h2>
  <p style="margin:0 0 18px"><b>${escapeHtml(info.clientName || 'Un client')}</b> a envoyé une sélection pour la galerie
  « <b>${escapeHtml(info.galleryName)}</b> ».</p>
  ${rows.map((r) => `
    <h3 style="margin:16px 0 6px;font-size:15px">${escapeHtml(r.label)} — ${r.count} photo(s)</h3>
    <p style="color:#555;font-size:13px;margin:0">${r.photos.map((p) => 'n°' + (p.index != null ? p.index : '?') + ' — ' + escapeHtml(p.name)).join('<br>')}</p>`).join('')}
  <p style="margin-top:22px"><b>Total : ${total} photo(s)</b><br>
  Lien : <a href="${escapeHtml(info.galleryUrl)}">${escapeHtml(info.galleryUrl)}</a></p>
  <p style="color:#999;font-size:12px;margin-top:30px">Envoyé par Mews Studio Galleries.</p>
  </body></html>`;

  return { text: lines.join('\n'), html };
}

async function sendMail(mailOptions) {
  await buildTransport().sendMail(mailOptions);
}

/** Notification de nouvelle sélection au photographe. */
async function sendSelectionNotification(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!recipient()) throw new Error('Aucun destinataire défini.');
  const { text, html } = buildContent(info);
  await sendMail({
    from: smtp().from,
    to: recipient(),
    subject: 'Sélection d\u2019albums — ' + info.galleryName + (info.clientName ? ' (' + info.clientName + ')' : ''),
    text,
    html,
  });
}

/** E-mail « dossier Drive trié prêt ». */
async function sendDriveFolderNotification(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!recipient()) throw new Error('Aucun destinataire défini.');
  const rows = (info.subfolders || []).filter((s) => s.count > 0);
  const modeLabel = info.mode === 'shortcut' ? 'raccourcis (0 Go)' : 'copies réelles';
  const lines = [];
  lines.push('Bonjour,');
  lines.push('');
  lines.push('Le dossier Drive de la sélection « ' + info.galleryName + ' » est prêt :');
  lines.push(info.folderName);
  lines.push(info.folderUrl);
  lines.push('');
  rows.forEach((s) => lines.push('▸ ' + s.label + ' — ' + s.count + ' photo(s)'));
  lines.push('');
  lines.push('Total : ' + info.total + ' photo(s) — mode : ' + modeLabel + '.');
  lines.push('');
  lines.push('Envoyé par Mews Studio Galleries.');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Dossier Drive trié prêt</h2>
  <p style="margin:0 0 18px">La sélection de la galerie « <b>${escapeHtml(info.galleryName)}</b> » a été triée automatiquement sur votre Drive.</p>
  <p style="margin:0 0 14px"><a href="${escapeHtml(info.folderUrl)}">Ouvrir le dossier « ${escapeHtml(info.folderName)} »</a></p>
  ${rows.map((r) => `<p style="margin:4px 0;color:#555">▸ ${escapeHtml(r.label)} — ${r.count} photo(s)</p>`).join('')}
  <p style="margin-top:16px"><b>Total : ${info.total} photo(s)</b> · mode : ${modeLabel}</p>
  <p style="color:#999;font-size:12px;margin-top:30px">Envoyé par Mews Studio Galleries.</p>
  </body></html>`;
  await sendMail({
    from: smtp().from,
    to: recipient(),
    subject: 'Dossier Drive trié — ' + info.galleryName,
    text: lines.join('\n'),
    html,
  });
}

/** Alerte : la connexion Google du photographe a expiré (tri Drive en pause). */
async function sendDriveAuthWarning(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!recipient()) throw new Error('Aucun destinataire défini.');
  const lines = [];
  lines.push('Bonjour,');
  lines.push('');
  lines.push('⚠️ La connexion Google de Mews Studio Galleries a expiré : le tri');
  lines.push('automatique des sélections sur votre Drive est en pause.');
  lines.push('');
  lines.push('Les sélections de vos clients continuent d\u2019arriver par e-mail normalement.');
  lines.push('Pour réactiver le tri automatique (2 minutes) :');
  lines.push('  1. Ouvrez https://mews-galleries.onrender.com/admin');
  lines.push('  2. Onglet Réglages → section « Tri automatique » → « Se connecter avec Google »');
  lines.push('  3. Choisissez votre compte et acceptez l\u2019autorisation.');
  lines.push('');
  if (info && info.detail) { lines.push('Détail : ' + info.detail); lines.push(''); }
  lines.push('Envoyé par Mews Studio Galleries.');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">⚠️ Connexion Google expirée</h2>
  <p style="margin:0 0 16px">La connexion Google de <b>Mews Studio Galleries</b> a expiré : le tri automatique
  des sélections sur votre Drive est <b>en pause</b>. Les sélections de vos clients continuent d'arriver par e-mail normalement.</p>
  <p style="margin:0 0 16px">Pour réactiver le tri (2 minutes) :</p>
  <ol style="margin:0 0 16px;padding-left:20px">
    <li>Ouvrez <a href="https://mews-galleries.onrender.com/admin">mews-galleries.onrender.com/admin</a></li>
    <li>Onglet <b>Réglages</b> → section « Tri automatique » → « Se connecter avec Google »</li>
    <li>Choisissez votre compte et acceptez l'autorisation.</li>
  </ol>
  ${info && info.detail ? `<p style="color:#555;font-size:13px">Détail : ${escapeHtml(info.detail)}</p>` : ''}
  <p style="color:#999;font-size:12px;margin-top:30px">Envoyé par Mews Studio Galleries.</p>
  </body></html>`;
  await sendMail({
    from: smtp().from,
    to: recipient(),
    subject: '⚠️ Mews Studio Galleries — connexion Google à renouveler',
    text: lines.join('\n'),
    html,
  });
}

/** E-mail de test depuis les réglages. */
async function sendTest() {
  if (!isConfigured()) throw new Error('Notifications non configurées (hôte et expéditeur requis).');
  if (!recipient()) throw new Error('Aucun destinataire défini.');
  await sendMail({
    from: smtp().from,
    to: recipient(),
    subject: 'Test — Mews Studio Galleries',
    text: 'Ceci est un e-mail de test envoyé depuis Mews Studio Galleries.\nSi vous le recevez, la configuration SMTP fonctionne ✓',
    html: '<p>Ceci est un e-mail de test envoyé depuis <b>Mews Studio Galleries</b>.</p><p>Si vous le recevez, la configuration SMTP fonctionne ✓</p>',
  });
}

/** Contenu de l'e-mail « accès galerie » envoyé à un client. */
function buildClientAccessContent(info) {
  const gUrl = info.galleryUrl || '';
  const lines = [];
  lines.push('Bonjour ' + (info.clientName || '') + ',');
  lines.push('');
  lines.push('Votre galerie « ' + info.galleryName + ' » est prête.');
  lines.push('');
  lines.push('Accès : ' + gUrl);
  if (info.galleryPassword) {
    lines.push('Mot de passe de la galerie : ' + info.galleryPassword);
  } else {
    lines.push('Le mot de passe de la galerie vous a déjà été communiqué.');
  }
  if (info.pin) lines.push('Votre code personnel : ' + info.pin);
  lines.push('');
  lines.push('Comment faire :');
  lines.push('  1. Ouvrez le lien ci-dessus ;');
  lines.push('  2. Entrez le mot de passe de la galerie ;');
  lines.push('  3. Indiquez votre prénom et votre code personnel pour retrouver');
  lines.push('     votre sélection de photos à tout moment.');
  lines.push('');
  lines.push('Votre photographe — Mew\'s Studio');
  const subject = 'Votre galerie « ' + info.galleryName + ' » — Mew\'s Studio';

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.6;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Votre galerie est prête</h2>
  <p style="margin:0 0 18px">Bonjour ${escapeHtml(info.clientName || '')},<br>votre galerie « <b>${escapeHtml(info.galleryName)}</b> » est prête.</p>
  <div style="background:#f5f1e8;border:1px solid #e2d9c4;border-radius:10px;padding:16px 18px;margin-bottom:18px">
    <p style="margin:0 0 8px"><b>Accès :</b> <a href="${escapeHtml(gUrl)}">${escapeHtml(gUrl)}</a></p>
    ${info.galleryPassword
      ? `<p style="margin:0 0 8px"><b>Mot de passe de la galerie :</b> ${escapeHtml(info.galleryPassword)}</p>`
      : '<p style="margin:0 0 8px">Le mot de passe de la galerie vous a déjà été communiqué.</p>'}
    ${info.pin ? `<p style="margin:0"><b>Votre code personnel :</b> ${escapeHtml(info.pin)}</p>` : ''}
  </div>
  <p style="margin:0 0 16px">Comment faire :<br>1. Ouvrez le lien ci-dessus ;<br>2. Entrez le mot de passe de la galerie ;<br>3. Indiquez votre prénom et votre code personnel pour retrouver votre sélection à tout moment.</p>
  <p style="margin:0;color:#777">Votre photographe — Mew's Studio</p>
  </body></html>`;

  return { subject, text: lines.join('\n'), html };
}

/** Envoie l'e-mail d'accès au client (destinataire = adresse du client). */
async function sendClientAccessEmail(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!info.clientEmail) throw new Error('Adresse e-mail du client manquante.');
  const { subject, text, html } = buildClientAccessContent(info);
  await sendMail({
    from: smtp().from,
    to: info.clientEmail,
    subject,
    text,
    html,
  });
}

module.exports = { isConfigured, recipient, sendSelectionNotification, sendDriveFolderNotification, sendDriveAuthWarning, sendTest, sendClientAccessEmail, buildClientAccessContent };
