'use strict';
/**
 * Notifications e-mail — Resend (API, recommandé) ou SMTP (nodemailer, repli).
 * Configuration stockée dans data/config.json (section `notifications`),
 * modifiable depuis l'espace photographe (Réglages).
 *
 * Mode Resend : si `apiKey` est renseigné, l'envoi passe par l'API HTTPS de
 * Resend (aucun port SMTP — indispensable sur Render, dont le plan gratuit
 * bloque les ports SMTP 25/465/587 depuis septembre 2025).
 * Mode SMTP : sinon, envoi classique via nodemailer (serveur payant ou local).
 */
const nodemailer = require('nodemailer');
const { config } = require('./store');
const drive = require('./drive');

function smtp() {
  return config().notifications || {};
}

/**
 * Mode d'envoi effectif, par ordre de priorité :
 *  'resend' — clé API Resend enregistrée
 *  'gmail'  — mode « mon compte Google » actif ET compte d'ENVOI connecté
 *             (connexion dédiée, indépendante du compte Drive)
 *  'smtp'   — repli classique (bloqué sur Render gratuit)
 */
function provider() {
  const n = smtp();
  if (n.apiKey) return 'resend';
  if (n.gmailMode && drive.isMailConnected()) return 'gmail';
  return 'smtp';
}

function isConfigured() {
  const n = smtp();
  if (!n.enabled || !n.from) return false;
  if (n.apiKey) return true;
  if (n.gmailMode) return drive.isMailConnected();
  return !!n.host;
}

/** « Mews Studio <a@b.c> » -> « Mews Studio » (nom d'affichage pour Gmail). */
function fromDisplayName(from) {
  const m = /(?:^([^<>]+))</.exec(String(from || ''));
  return m ? m[1].trim() : '';
}

/** « Mews Studio <a@b.c> » -> « a@b.c » (adresse d'expédition). */
function fromAddress(from) {
  const m = /<([^<>]+)>/.exec(String(from || ''));
  return m ? m[1].trim() : '';
}

/** MIME multipart/alternative (texte + HTML) pour l'API Gmail. */
function buildMime(mailOptions, fromName, accountEmail) {
  const boundary = 'mews' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const subject = String(mailOptions.subject || '');
  const subjectEnc = /[^\x20-\x7e]/.test(subject)
    ? '=?UTF-8?B?' + Buffer.from(subject, 'utf8').toString('base64') + '?='
    : subject;
  const lines = [
    'From: ' + (fromName ? fromName + ' <' + accountEmail + '>' : accountEmail),
    'To: ' + [].concat(mailOptions.to).join(', '),
    'Subject: ' + subjectEnc,
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
    '',
  ];
  if (mailOptions.cc) lines.splice(2, 0, 'Cc: ' + [].concat(mailOptions.cc).join(', '));
  if (mailOptions.text) {
    lines.push(
      '--' + boundary,
      'Content-Type: text/plain; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(mailOptions.text), 'utf8').toString('base64'),
      '',
    );
  }
  if (mailOptions.html) {
    lines.push(
      '--' + boundary,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(String(mailOptions.html), 'utf8').toString('base64'),
      '',
    );
  }
  lines.push('--' + boundary + '--');
  return lines.join('\r\n');
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
  if (info.clientEmail) lines.push('E-mail : ' + info.clientEmail);
  lines.push('');
  rows.forEach((a) => {
    lines.push('▸ ' + a.label + ' — ' + a.photoIds.length + ' photo(s)');
    if (a.cover) lines.push('   🖼 Couverture : n°' + (a.cover.index != null ? a.cover.index : '?') + ' — ' + a.cover.name);
    a.photos.forEach((p) => lines.push('   · n°' + (p.index != null ? p.index : '?') + ' — ' + p.name));
    lines.push('');
  });
  if (info.options && info.options.length) {
    lines.push('Options de la galerie : ' + info.options.map((o) => o.label + ' (\u00d7 ' + o.qty + ')').join(' \u00b7 '));
  }
  lines.push('Total : ' + total + ' photo(s)');
  lines.push('Galerie : ' + info.galleryUrl);
  lines.push('');
  lines.push('Envoyé par Mews Studio Galleries.');

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Nouvelle sélection d\u2019albums</h2>
  <p style="margin:0 0 ${info.clientEmail ? '6px' : '18px'}"><b>${escapeHtml(info.clientName || 'Un client')}</b> a envoyé une sélection pour la galerie
  « <b>${escapeHtml(info.galleryName)}</b> ».</p>
  ${info.clientEmail ? `<p style="margin:0 0 18px;font-size:14px;color:#555">E-mail : <a href="mailto:${escapeHtml(info.clientEmail)}">${escapeHtml(info.clientEmail)}</a></p>` : ''}
  ${rows.map((r) => `
    <h3 style="margin:16px 0 6px;font-size:15px">${escapeHtml(r.label)} — ${r.count} photo(s)</h3>
    ${r.cover ? `<p style="color:#b57f2a;font-size:13px;margin:0 0 6px">🖼 Couverture choisie : n°${r.cover.index != null ? r.cover.index : '?'} — ${escapeHtml(r.cover.name)}</p>` : ''}
    <p style="color:#555;font-size:13px;margin:0">${r.photos.map((p) => 'n°' + (p.index != null ? p.index : '?') + ' — ' + escapeHtml(p.name)).join('<br>')}</p>`).join('')}
  ${(info.options && info.options.length) ? `<p style="margin:14px 0 0;padding:10px 12px;background:#faf6ee;border:1px solid #e8dcc0;border-radius:8px;font-size:13px;color:#555">📦 <b>Options de la galerie :</b> ${info.options.map((o) => escapeHtml(o.label) + ' (\u00d7 ' + o.qty + ')').join(' \u00b7 ')}</p>` : ''}
  <p style="margin-top:22px"><b>Total : ${total} photo(s)</b><br>
  Lien : <a href="${escapeHtml(info.galleryUrl)}">${escapeHtml(info.galleryUrl)}</a></p>
  <p style="color:#999;font-size:12px;margin-top:30px">Envoyé par Mews Studio Galleries.</p>
  </body></html>`;

  return { text: lines.join('\n'), html };
}

/** Envoi via l'API Resend (HTTPS — ne dépend d'aucun port SMTP). */
async function sendViaResend(mailOptions) {
  const n = smtp();
  let res;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + n.apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: mailOptions.from,
        to: [].concat(mailOptions.to),
        cc: mailOptions.cc ? [].concat(mailOptions.cc) : undefined,
        subject: mailOptions.subject,
        html: mailOptions.html,
        text: mailOptions.text,
      }),
    });
  } catch (e) {
    throw new Error('Resend : connexion impossible — ' + e.message);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && (data.message || data.name)) || ('HTTP ' + res.status);
    throw new Error('Resend : ' + msg);
  }
  return data;
}

/** Envoi depuis le compte d'envoi Google (API Gmail, HTTPS). */
async function sendViaGmail(mailOptions) {
  const n = smtp();
  if (!drive.isMailConnected()) throw new Error('Gmail : le compte d\'envoi n\'est pas connecté — cliquez sur « Se connecter avec Google (envoi d\'e-mails) » dans la section Notifications e-mail.');
  let acc = null;
  try { acc = await drive.mailAccount(); } catch { /* profil illisible (scope gmail.send seul) */ }
  // L'appel de profil exige un scope plus large que gmail.send : en secours,
  // l'adresse est celle du champ Expéditeur (elle doit être le compte connecté,
  // sinon l'API Gmail refuse l'envoi avec une erreur explicite).
  const accountEmail = (acc && acc.emailAddress) || fromAddress(n.from);
  if (!accountEmail) throw new Error('Gmail : compte d\'envoi non connecté et aucune adresse dans le champ Expéditeur — renseignez « Nom <adresse@gmail.com> » dans Expéditeur.');
  const mime = buildMime(mailOptions, fromDisplayName(n.from), accountEmail);
  const raw = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await drive.mailApi('/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    const msg = (data && data.error && data.error.message) || ('HTTP ' + res.status);
    if (res.status === 403) {
      throw new Error('Gmail : permission « envoyer des e-mails » refusée — reconnectez le compte d\'envoi via « Se connecter avec Google (envoi d\'e-mails) » et autorisez.');
    }
    if (res.status === 429 || res.status === 503) {
      throw new Error('Gmail : quota ou indisponibilité temporaire (' + msg + ') — réessayez dans quelques minutes.');
    }
    throw new Error('Gmail : ' + msg);
  }
  return { ok: true };
}

async function sendMail(mailOptions) {
  const p = provider();
  if (p === 'resend') return sendViaResend(mailOptions);
  if (p === 'gmail') return sendViaGmail(mailOptions);
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

/** Contenu du récapitulatif de sélection envoyé AU CLIENT. */
function buildClientConfirmationContent(info) {
  const rows = (info.albums || []).filter((a) => a.count > 0);
  const total = rows.reduce((n, a) => n + a.count, 0);
  const firstName = info.clientName ? String(info.clientName).split(/\s+/)[0] : '';

  const lines = [];
  lines.push('Bonjour' + (firstName ? ' ' + firstName : '') + ',');
  lines.push('');
  lines.push('Merci ! Votre sélection pour la galerie « ' + info.galleryName + ' » a bien été envoyée à Mews Studio.');
  lines.push('');
  rows.forEach((a) => {
    lines.push('▸ ' + a.label + ' — ' + a.count + ' photo(s)');
    if (a.cover) lines.push('   🖼 Couverture : n°' + (a.cover.index != null ? a.cover.index : '?') + ' — ' + a.cover.name);
    (a.photos || []).forEach((p) => lines.push('   n°' + (p.index != null ? p.index : '?') + ' — ' + p.name));
  });
  lines.push('');
  lines.push('Total : ' + total + ' photo(s)');
  lines.push('');
  lines.push('Envoyé par Mews Studio Galleries.');

  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Votre sélection d\u2019albums ✓</h2>
  <p style="margin:0 0 18px">Bonjour <b>${escapeHtml(firstName || info.clientName || '')}</b>, merci ! Votre sélection pour la galerie
  « <b>${escapeHtml(info.galleryName)}</b> » a bien été envoyée à Mews Studio.</p>
  ${rows.map((r) => `
    <h3 style="margin:16px 0 4px;font-size:15px">${escapeHtml(r.label)} — ${r.count} photo(s)</h3>
    ${r.cover ? `<p style="color:#b57f2a;font-size:13px;margin:0">🖼 Couverture : n°${r.cover.index != null ? r.cover.index : '?'} — ${escapeHtml(r.cover.name)}</p>` : ''}
    ${r.photos && r.photos.length ? `<p style="color:#555;font-size:13px;margin:0">${r.photos.map((p) => 'n°' + (p.index != null ? p.index : '?') + ' — ' + escapeHtml(p.name)).join('<br>')}</p>` : ''}`).join('')}
  <p style="margin-top:22px"><b>Total : ${total} photo(s)</b></p>
  <p style="color:#999;font-size:12px;margin-top:30px">Envoyé par Mews Studio Galleries.</p>
  </body></html>`;

  return { text: lines.join('\n'), html };
}

/** Récapitulatif de sélection envoyé au client (sa propre e-mail). */
async function sendClientSelectionConfirmation(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!info.clientEmail) throw new Error('Aucune adresse e-mail pour le client.');
  const { text, html } = buildClientConfirmationContent(info);
  await sendMail({
    from: smtp().from,
    to: info.clientEmail,
    subject: 'Votre sélection — ' + info.galleryName + ' (Mews Studio)',
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
  rows.forEach((s) => lines.push('▸ ' + s.label + ' — ' + s.count + ' photo(s)' + (s.coverFolderId ? '  [cover pic/]' : '')));
  lines.push('');
  lines.push('Total : ' + info.total + ' photo(s) — mode : ' + modeLabel + '.');
  lines.push('');
  lines.push('Envoyé par Mews Studio Galleries.');
  const html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#222;line-height:1.55;max-width:640px">
  <h2 style="margin:0 0 6px;font-size:20px">Dossier Drive trié prêt</h2>
  <p style="margin:0 0 18px">La sélection de la galerie « <b>${escapeHtml(info.galleryName)}</b> » a été triée automatiquement sur votre Drive.</p>
  <p style="margin:0 0 14px"><a href="${escapeHtml(info.folderUrl)}">Ouvrir le dossier « ${escapeHtml(info.folderName)} »</a></p>
  ${rows.map((r) => `<p style="margin:4px 0;color:#555">▸ ${escapeHtml(r.label)} — ${r.count} photo(s)${r.coverFolderId ? ' · <span style="color:#b57f2a">🖼 cover pic/</span>' : ''}</p>`).join('')}
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
  const n = smtp();
  if (n.gmailMode && !drive.isMailConnected()) {
    throw new Error('Gmail : le compte d\'envoi n\'est pas connecté — cliquez sur « Se connecter avec Google (envoi d\'e-mails) » dans cette section.');
  }
  if (!isConfigured()) throw new Error('Notifications non configurées (expéditeur + clé Resend ou hôte SMTP requis).');
  if (!recipient()) throw new Error('Aucun destinataire défini.');
  const p = provider();
  const via = p === 'resend' ? 'Resend' : p === 'gmail' ? 'Gmail' : 'SMTP';
  await sendMail({
    from: smtp().from,
    to: recipient(),
    subject: 'Test — Mews Studio Galleries',
    text: 'Ceci est un e-mail de test envoyé depuis Mews Studio Galleries.\nSi vous le recevez, la configuration (' + via + ') fonctionne ✓',
    html: '<p>Ceci est un e-mail de test envoyé depuis <b>Mews Studio Galleries</b>.</p><p>Si vous le recevez, la configuration (<b>' + via + '</b>) fonctionne ✓</p>',
  });
}

/** Contenu de l'e-mail « accès galerie » envoyé à un client. */
function buildClientAccessContent(info) {
  const gUrl = info.galleryUrl || '';
  const galleryName = info.galleryName || '';
  const mdpText = info.galleryPassword
    ? 'Mot de passe de la galerie : ' + info.galleryPassword
    : 'Le mot de passe de la galerie vous a déjà été communiqué.';

  const lines = [];
  lines.push('Bonjour,');
  lines.push('');
  lines.push('Nous sommes heureux de vous communiquer vos codes d\'accès aux photos de votre évènement.');
  lines.push('Une vidéo tutorielle est disponible dans votre espace afin de vous guider lors de la sélection de vos photos.');
  lines.push('');
  lines.push('Pour accéder à votre galerie privée, veuillez cliquer sur le lien ci-dessous.');
  lines.push(gUrl);
  lines.push('');
  lines.push(mdpText);
  lines.push('');
  lines.push('Bonne visite sur votre espace dédié');
  lines.push('');
  lines.push('Merci');
  lines.push('L\'équipe Mews Studio');
  lines.push('www.mewstudio.com');
  const subject = 'Vos photos Mews Studio « ' + galleryName + ' »';

  // Bouton « MEWS » d'après le logo : fond blanc, double filet noir, mot MEWS
  // (tableau — compatibilité Gmail/Outlook/Apple Mail).
  const btn = `
  <table role="presentation" align="center" cellpadding="0" cellspacing="0" style="margin:0 auto 22px"><tr><td
    style="background:#ffffff;border-top:5px solid #000000;border-bottom:5px solid #000000;padding:18px 46px;">
    <a href="${escapeHtml(gUrl)}" target="_blank" style="display:inline-block;color:#000000;text-decoration:none;font-family:Helvetica,Arial,sans-serif;font-weight:700;font-size:24px;letter-spacing:7px;text-transform:uppercase;">MEWS</a>
  </td></tr></table>`;

  // Fond blanc imposé sur <html>, <body> ET la colonne principale :
  // sur mobile (Gmail/Apple Mail, surtout en mode sombre), l'app affiche
  // sinon SA couleur de fond autour du message, et la zone blanche du
  // bouton « MEWS » ne matchait plus. Tout en #ffffff = cohérent partout.
  const html = `<!doctype html><html lang="fr" style="background-color:#ffffff"><body style="margin:0;padding:0;background-color:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#222222;line-height:1.6">
  <div style="background-color:#ffffff;max-width:600px;margin:0 auto;padding:28px 22px">
  <p style="margin:0 0 14px;font-size:15px">Bonjour,</p>
  <p style="margin:0 0 14px;font-size:15px">Nous sommes heureux de vous communiquer vos codes d'accès aux photos de votre évènement.</p>
  <p style="margin:0 0 14px;font-size:15px">Une vidéo tutorielle est disponible dans votre espace afin de vous guider lors de la sélection de vos photos.</p>
  <p style="margin:0 0 18px;font-size:15px">Pour accéder à votre galerie privée, veuillez cliquer sur le lien ci-dessous.</p>
  ${btn}
  <p style="margin:0 0 26px;font-size:15px;text-align:center">
  ${info.galleryPassword
    ? `<b>Mot de passe de la galerie :</b> ${escapeHtml(info.galleryPassword)}`
    : 'Le mot de passe de la galerie vous a déjà été communiqué.'}
  </p>
  <p style="margin:0 0 26px;font-size:15px">Bonne visite sur votre espace dédié</p>
  <p style="margin:0;font-size:15px">Merci<br>L'équipe Mews Studio<br>
  <a href="https://www.mewstudio.com" style="color:#222222">www.mewstudio.com</a></p>
  </div>
  </body></html>`;

  return { subject, text: lines.join('\n'), html };
}

/** Envoie l'e-mail d'accès au client (destinataire = adresse du client). */
async function sendClientAccessEmail(info) {
  if (!isConfigured()) throw new Error('Notifications non configurées.');
  if (!info.clientEmail) throw new Error('Adresse e-mail du client manquante.');
  const { subject, text, html } = buildClientAccessContent(info);
  // Copie systématique au photographe (adresse de notification configurée),
  // sauf si le destinataire EST le photographe (test à soi-même).
  const ccAddr = recipient();
  const cc = ccAddr && ccAddr.toLowerCase() !== String(info.clientEmail).trim().toLowerCase() ? ccAddr : undefined;
  await sendMail({
    from: smtp().from,
    to: info.clientEmail,
    cc,
    subject,
    text,
    html,
  });
}

/** Rappel Google Agenda : e-mail avec bouton « Ajouter à l'agenda » (un clic, pas d'import .ics). */
async function sendReminder(info) {
  const to = [].concat(info.to || []).map(String).filter(Boolean);
  if (!to.length) throw new Error('Aucun destinataire défini.');
  const dates = info.startLocal + '/' + info.endLocal;
  const ctz = info.ctz || 'Europe/Paris';
  const url =
    'https://calendar.google.com/calendar/render?action=TEMPLATE' +
    '&text=' + encodeURIComponent(info.title) +
    '&dates=' + encodeURIComponent(dates) +
    '&ctz=' + encodeURIComponent(ctz) +
    '&details=' + encodeURIComponent(info.details || '');
  const text =
    'Rappel — Mews Studio\n\n' +
    info.title + '\n\n' +
    (info.details ? info.details + '\n\n' : '') +
    "Ajouter à Google Agenda (un clic) :\n" +
    url;
  const btn =
    '<a href="' + url + '" style="display:inline-block;background:#1a73e8;color:#ffffff;text-decoration:none;padding:12px 26px;border-radius:6px;font-weight:600;font-size:15px;">➕ Ajouter à Google Agenda</a>';
  const html =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#202124;">' +
    '<h2 style="margin:0 0 12px;font-size:20px;">📅 Rappel agenda — Mews Studio</h2>' +
    '<p style="font-size:15px;line-height:1.5;margin:0 0 16px;">' + escapeHtml(info.title) + '</p>' +
    (info.details
      ? '<div style="background:#f1f3f4;border-radius:8px;padding:14px 16px;font-size:14px;line-height:1.6;margin-bottom:18px;white-space:pre-wrap;color:#3c4043;">' + escapeHtml(info.details) + '</div>'
      : '') +
    '<p style="font-size:14px;color:#5f6368;margin:0 0 6px;">Cliquez sur le bouton, vérifiez que votre compte Google Agenda est bien le bon, puis « Ajouter ».</p>' +
    '<p style="margin:16px 0;">' + btn + '</p>' +
    '<p style="font-size:12px;color:#9aa0a6;margin:24px 0 0;">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur :\n' + url + '</p>' +
    '</div>';
  await sendMail({ from: smtp().from, to, subject: '📅 ' + info.title, text, html });
}

module.exports = { provider, isConfigured, recipient, sendSelectionNotification, sendClientSelectionConfirmation, sendDriveFolderNotification, sendDriveAuthWarning, sendTest, sendClientAccessEmail, sendReminder, buildClientAccessContent, buildContent, buildClientConfirmationContent };
