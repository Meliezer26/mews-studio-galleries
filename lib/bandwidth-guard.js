'use strict';
/**
 * Garde-fou de bande passante.
 *
 * Enjeu : le plan gratuit Render inclut 5 Go de trafic sortant par mois.
 * Au-delà, sans moyen de paiement, Render SUSPEND le site jusqu'au 1er du
 * mois suivant. C'est arrivé le 21/10/2026 (5,29 Go) : quatre heures de
 * coupure avant que le photographe ne voie l'e-mail de Render.
 *
 * Ce module interroge l'API Render (métrique « bandwidth-sources ») et
 * prévient par e-mail bien avant la limite, avec le temps restant.
 * Il n'agit jamais sur le service : il informe, c'est tout.
 *
 * Variables d'environnement attendues :
 *   RENDER_API_KEY       clé API Render (lecture des métriques)
 *   RENDER_SERVICE_ID    identifiant du service (srv-…)
 * Sans elles, le module se met en veille sans bruit.
 */
const fs = require('fs');
const path = require('path');
const store = require('./store');

const MONTHLY_QUOTA_MB = 5 * 1024;   // 5 Go inclus dans le plan Hobby
const WARN_MB = 3.5 * 1024;          // 3,5 Go : prévenir (70 %)
const URGENT_MB = 4.5 * 1024;        // 4,5 Go : dernier avertissement (90 %)
const OVERAGE_PER_GB_USD = 0.15;     // tarif Render au-delà des 5 Go inclus
const CHECK_MS = 6 * 3600 * 1000;    // vérification toutes les 6 heures
const STATE_FILE = 'bandwidth-alert.json';

let timer = null;
let lastCheck = null;

function statePath() {
  return path.join(store.DATA_DIR, STATE_FILE);
}

/**
 * Mémorise le dernier palier annoncé, pour ne pas répéter l'e-mail.
 *
 * Le disque de Render est effacé à chaque redémarrage : le fichier local ne
 * suffit donc PAS. L'état est donc aussi rangé dans config.json, qui part
 * dans la sauvegarde GitHub et revient au démarrage. Un redémarrage ne
 * redéclenche alors aucun message. (Une alerte est rare, et l'écriture de
 * sauvegarde qu'elle provoque — 1,2 Mo — reste négligeable.)
 */
function loadState() {
  try {
    const local = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    if (local && local.month) return local;
  } catch { /* disque neuf : on lit la copie de secours */ }
  try {
    const saved = store.config().bandwidthAlert;
    if (saved && saved.month) return saved;
  } catch { /* configuration illisible : on repart de zéro */ }
  return {};
}

function saveState(next) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(next), 'utf8');
  } catch (e) {
    console.warn('[bande passante] état local non enregistré :', e.message);
  }
  try {
    const cfg = store.config();
    cfg.bandwidthAlert = next;
    store.saveConfig(cfg);
  } catch (e) {
    console.warn('[bande passante] état non conservé dans la sauvegarde :', e.message);
  }
}

/** Bornes du mois calendaire en cours (la remise à zéro suit ce découpage). */
function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return { start, end, key: start.toISOString().slice(0, 7) };
}

/** Lit la consommation sortante du mois, en Mo (null si indisponible). */
async function fetchUsageMb(now = new Date()) {
  const key = process.env.RENDER_API_KEY;
  const service = process.env.RENDER_SERVICE_ID;
  if (!key || !service) return null;
  const { start } = monthWindow(now);
  const url = 'https://api.render.com/v1/metrics/bandwidth-sources'
    + '?resource=' + encodeURIComponent(service)
    + '&startTime=' + encodeURIComponent(start.toISOString())
    + '&endTime=' + encodeURIComponent(now.toISOString())
    + '&resolutionSeconds=3600';
  const res = await fetch(url, { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) throw new Error('métriques Render indisponibles (' + res.status + ')');
  const blocks = await res.json();
  // Les blocs sont ventilés par source (« total », « nat », « http »…) :
  // on ne retient que le total, sinon on compterait deux fois.
  let total = null;
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const labels = b.labels || [];
    const src = labels.find((l) => l.field === 'trafficSource');
    if (!src || src.value !== 'total') continue;
    total = (b.values || []).reduce((s, v) => s + (Number(v.value) || 0), 0);
  }
  return total;
}

/**
 * Décide s'il faut écrire au photographe.
 * Fonction pure : testable sans réseau ni e-mail.
 */
function decide(usageMb, now = new Date(), previous = {}) {
  const { key: month, end } = monthWindow(now);
  if (usageMb === null || usageMb === undefined) {
    return { alert: false, reason: 'consommation indisponible' };
  }
  const level = usageMb >= MONTHLY_QUOTA_MB ? 'over'
    : usageMb >= URGENT_MB ? 'urgent'
      : usageMb >= WARN_MB ? 'warn' : null;
  const done = previous.month === month ? previous.level : null;
  if (!level) {
    // Nouveau mois sous le seuil : on remet le compteur à zéro.
    return { alert: false, level: null, month, reset: previous.month !== month };
  }
  // Un même palier n'est annoncé qu'une fois par mois ; le passage
  // « prévenir » → « urgent » déclenche bien un second message.
  // Un palier déjà franchi couvre les paliers inférieurs : pas de retour en
  // arrière, et jamais deux fois le même message dans le mois.
  const rank = { warn: 1, urgent: 2, over: 3 };
  if (done && rank[done] >= rank[level]) return { alert: false, level: done, month };
  const daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
  const dayOfMonth = now.getUTCDate();
  const projected = dayOfMonth > 0 ? (usageMb / dayOfMonth) * (dayOfMonth + daysLeft) : usageMb;
  return { alert: true, level, month, daysLeft, projected };
}

function go(n) {
  return (n / 1024).toFixed(2).replace('.', ',') + ' Go';
}

/** Texte de l'e-mail : court, factuel, sans jargon. */
function buildMessage(usageMb, d) {
  const left = Math.max(0, MONTHLY_QUOTA_MB - usageMb);
  const lines = [
    'Bonjour,',
    '',
    'Votre site a consommé ' + go(usageMb) + ' sur les 5 Go de trafic inclus ce mois-ci'
      + ' (' + Math.round((usageMb / MONTHLY_QUOTA_MB) * 100) + ' %).',
    'Il reste ' + go(left) + ' et ' + d.daysLeft + ' jour(s) avant la remise à zéro du 1er.',
    '',
  ];
  if (d.level === 'over') {
    const over = Math.max(0, usageMb - MONTHLY_QUOTA_MB);
    const cost = ((over / 1024) * OVERAGE_PER_GB_USD).toFixed(2).replace('.', ',');
    lines.push(
      'LE QUOTA EST DÉPASSÉ de ' + go(over) + '.',
      'Avec une carte enregistrée, ce dépassement est facturé ' + cost + ' $ environ',
      '(0,15 $ par Go au-delà des 5 Go) : quelques centimes, sans suspension.',
      'SANS carte, Render suspendrait le site jusqu\'au 1er du mois suivant.',
      '',
      'La remise à zéro du compteur a lieu le 1er : la consommation repart de zéro.',
    );
  } else if (d.level === 'urgent') {
    lines.push(
      'C\'EST LE DERNIER AVERTISSEMENT.',
      'Si le quota est épuisé, Render suspend le site jusqu\'au 1er du mois suivant',
      '(c\'est ce qui s\'est produit le 21 octobre).',
    );
  } else {
    lines.push(
      'Au rythme actuel, la consommation du mois devrait atteindre ' + go(d.projected) + '.',
      d.projected > MONTHLY_QUOTA_MB
        ? 'C\'est au-dessus du quota : le site risque d\'être suspendu avant la fin du mois.'
        : 'La marge est suffisante : aucune action n\'est nécessaire.',
    );
  }
  lines.push(
    '',
    'Pour agir : ouvrez l\'admin → Réglages (taille des images), ou demandez à',
    'votre assistant d\'alléger les vignettes.',
    '',
    'Ce message est automatique et n\'est envoyé qu\'une fois par palier.',
    '— Mews Studio Galleries',
  );
  return lines.join('\n');
}

/** Vérifie la consommation et alerte si nécessaire. */
async function run(now = new Date()) {
  let usageMb;
  try {
    usageMb = await fetchUsageMb(now);
  } catch (e) {
    console.warn('[bande passante]', e.message);
    return { ok: false, error: e.message };
  }
  const prev = loadState();
  const d = decide(usageMb, now, prev);
  lastCheck = { at: now.toISOString(), usageMb, decision: d };
  if (d.reset) saveState({ month: d.month, level: null });
  if (!d.alert) {
    if (d.level) saveState({ month: d.month, level: d.level, usageMb: Math.round(usageMb) });
    return { ok: true, alerted: false, usageMb, level: d.level || null };
  }
  const subject = d.level === 'over'
    ? 'Quota de trafic dépassé — ' + go(usageMb) + ' sur 5 Go (dépassement facturé)'
    : d.level === 'urgent'
    ? '⚠ Site bientôt suspendu — ' + go(usageMb) + ' de trafic sur 5 Go'
    : 'Bande passante à ' + Math.round((usageMb / MONTHLY_QUOTA_MB) * 100) + ' % — '
      + go(usageMb) + ' sur 5 Go';
  let sent = { ok: false, error: 'non envoyé' };
  try {
    const mailer = require('./mailer');
    sent = await mailer.sendAlert(subject, buildMessage(usageMb, d));
    console.log('[bande passante] alerte ' + d.level + ' ' + (sent.ok ? 'envoyée (' + sent.via + ')' : 'IMPOSSIBLE : ' + sent.error));
  } catch (e) {
    console.warn('[bande passante] alerte impossible :', e.message);
  }
  // L'état n'est enregistré que si l'e-mail est parti : sinon on réessaiera.
  if (sent.ok) saveState({ month: d.month, level: d.level, usageMb: Math.round(usageMb), at: now.toISOString() });
  return { ok: true, alerted: sent.ok, usageMb, level: d.level };
}

/** Démarre la surveillance périodique (sans jamais bloquer le démarrage). */
function start(intervalMs = CHECK_MS) {
  if (timer) return;
  setTimeout(() => { run().catch(() => {}); }, 3 * 60 * 1000).unref();
  timer = setInterval(() => { run().catch(() => {}); }, intervalMs);
  timer.unref && timer.unref();
}

module.exports = {
  run,
  start,
  decide,
  buildMessage,
  fetchUsageMb,
  monthWindow,
  state: loadState,
  lastCheck: () => lastCheck,
  QUOTA_MB: MONTHLY_QUOTA_MB,
  WARN_MB,
  URGENT_MB,
};
