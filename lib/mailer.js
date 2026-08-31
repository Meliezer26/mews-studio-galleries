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

module.exports = { isConfigured, recipient, sendSelectionNotification, sendTest };
