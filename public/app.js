/* Mews Studio Galleries — utilitaires partagés */
(function () {
  'use strict';

  /* --- Toasts ------------------------------------------------- */
  window.toast = function (msg, type) {
    let wrap = document.getElementById('toasts');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.id = 'toasts';
      document.body.appendChild(wrap);
    }
    const el = document.createElement('div');
    el.className = 'toast' + (type ? ' toast--' + type : '');
    el.textContent = msg;
    wrap.appendChild(el);
    setTimeout(() => {
      el.style.transition = 'opacity .4s';
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    }, 3400);
  };

  /* --- Requêtes API ------------------------------------------- */
  window.api = async function (url, opts) {
    opts = opts || {};
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.headers) init.headers = Object.assign(init.headers, opts.headers);
    if (opts.body !== undefined) {
      if (opts.body instanceof FormData) {
        init.body = opts.body; // multipart, ne pas poser Content-Type
      } else {
        init.headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(opts.body);
      }
    }
    let res;
    try {
      res = await fetch(url, init);
    } catch {
      throw new Error('Connexion au serveur impossible.');
    }
    let data = null;
    try { data = await res.json(); } catch { /* réponse sans JSON */ }
    if (!res.ok) {
      throw new Error((data && data.error) || ('Erreur serveur (' + res.status + ')'));
    }
    return data;
  };

  /* --- Copier dans le presse-papiers -------------------------- */
  window.copyText = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  };

  /* --- Navigation mobile + scroll ----------------------------- */
  document.addEventListener('DOMContentLoaded', function () {
    const nav = document.querySelector('.nav');
    const burger = document.querySelector('.nav-burger');
    const links = document.querySelector('.nav-links');
    if (burger && links) {
      burger.addEventListener('click', () => links.classList.toggle('open'));
      links.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => links.classList.remove('open')));
    }
    if (nav) {
      const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 30);
      onScroll();
      window.addEventListener('scroll', onScroll, { passive: true });
    }

    /* Révélation au scroll */
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) {
          e.target.classList.add('visible');
          io.unobserve(e.target);
        }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach((el) => io.observe(el));
  });

  /* --- Formatage ---------------------------------------------- */
  window.fmtDate = function (ts) {
    if (!ts) return '—';
    try {
      return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      return '—';
    }
  };
  window.fmtSize = function (n) {
    n = Number(n) || 0;
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' Ko';
    return (n / (1024 * 1024)).toFixed(1) + ' Mo';
  };
})();
