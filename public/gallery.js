/* Mews Studio Galleries — vue client */
(function () {
  'use strict';

  var slug = window.location.pathname.split('/').filter(Boolean)[1] || '';
  // Un point + une barre de progression par carte. Ids « 200/150/100 » =
  // anciens formats génériques ; ids packages = descriptif exact du package.
  var ALBUM_COLORS = {
    '200': '#ffffff', '150': '#b8b8b8', '100': '#7d7d7d',
    'album-30x80-200': '#ffffff',
    'album-maries-offert-25x50-100': '#9a9a9a',
    'album-parents1-25x50-100': '#8a8a8a',
    'album-parents2-100': '#6a6a6a',
    'album-mairie-henn\u00e9-25x50-150': '#a8a8a8',
    'album-mairie-henne-30x60-150': '#c8c8c8',
    'album-30x60-150': '#b8b8b8',
    'album-25x50-100': '#7d7d7d',
    'posters-30x45': '#e8c66a',
    'agrandissements-20x30': '#d9a05b'
  };
  var ALBUM_PALETTE = ['#e0e0e0', '#c4c4c4', '#a8a8a8', '#8c8c8c', '#707070'];
  function albumColor(id, i) {
    return ALBUM_COLORS[id] || ALBUM_PALETTE[(i || 0) % ALBUM_PALETTE.length];
  }

  var state = {
    photos: [],
    selected: new Set(),
    selecting: false,
    lbIndex: -1,
    lbList: [],
    downloads: true,           // décidé par l'admin, galerie par galerie
    watermark: null,           // { text } ou null
    albums: null,              // { types, email } ou null
    albumMode: false,
    alb: { name: '', checked: {}, active: null, photos: {}, covers: {} }, // par typeId ; covers: { typeId: photoId }
    client: null,              // { token, name, history } — profil identifié
    sentInAlbums: [],          // photos déjà dans un album envoyé (tous clients) → ✦
    gallerySentByType: {},     // formats d'album déjà envoyés (tous clients) → verrou global
    saveTimer: null,
    sending: false,            // verrou anti double-envoi de sélection
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --- Persistance (localStorage par galerie) ---------------- */
  function loadAlbums() {
    try {
      var raw = localStorage.getItem('mews_albums_' + slug);
      var d = raw ? JSON.parse(raw) : null;
      if (d && d.photos) state.alb = { name: d.name || '', checked: d.checked || {}, active: null, photos: d.photos, covers: d.covers || {} };
    } catch {}
  }
  function saveAlbums() {
    saveAlbumsLocal();
    if (state.client) debounceServerSave();
  }

  function saveAlbumsLocal() {
    try {
      localStorage.setItem('mews_albums_' + slug, JSON.stringify({
        name: state.alb.name, checked: state.alb.checked, photos: state.alb.photos, covers: state.alb.covers,
      }));
    } catch {}
  }

  /* --- Profil client (identification + historique) ------------ */
  function loadClient() {
    try {
      var raw = localStorage.getItem('mews_client_' + slug);
      var d = raw ? JSON.parse(raw) : null;
      if (d && d.token && d.name) state.client = { token: d.token, name: d.name, email: d.email || '', history: [] };
    } catch { state.client = null; }
  }
  function saveClientToken() {
    try {
      localStorage.setItem('mews_client_' + slug, JSON.stringify({ token: state.client.token, name: state.client.name, email: state.client.email || '' }));
    } catch {}
  }
  function clearClient() {
    try { localStorage.removeItem('mews_client_' + slug); } catch {}
  }
  function clientHeaders() {
    return state.client ? { 'X-Client-Token': state.client.token } : {};
  }

  /* Sauvegarde serveur du travail en cours (anti-perte) */
  function debounceServerSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () {
      if (!state.client) return; // déconnecté entre-temps
      window.api('/api/g/' + slug + '/client/albums', {
        method: 'POST',
        headers: clientHeaders(),
        body: { checked: state.alb.checked, photos: state.alb.photos, covers: state.alb.covers },
      }).catch(function () { /* silencieux */ });
    }, 900);
  }

  /* --- Écrans ------------------------------------------------ */
  function show(panes) {
    var ids = Array.isArray(panes) ? panes : [panes];
    ['top', 'lock', 'dead', 'loading', 'grid', 'bar'].forEach(function (id) {
      var n = $(id);
      if (n) n.classList.add('hidden');
    });
    ids.forEach(function (id) { $(id).classList.remove('hidden'); });
  }

  function showLock(meta) {
    $('lock-name').textContent = meta.name;
    $('lock-sub').textContent = 'Bienvenue dans votre espace privé. Veuillez entrer votre mot de passe communiqué par Mew\'s Studio.';
    $('lock-contact').classList.add('hidden');
    show('lock');
    setTimeout(function () { $('lock-pass').focus(); }, 60);
  }

  /* Galerie désactivée ou introuvable : on reste sur l'écran de connexion
     avec un message de contact — jamais de renvoi vers la page d'accueil. */
  function showUnavailable(info) {
    var email = (info && info.contactEmail) || 'mewstudiofrance@gmail.com';
    $('lock-name').textContent = (info && info.disabled) ? 'Galerie indisponible' : 'Galerie introuvable';
    $('lock-sub').textContent = (info && info.disabled)
      ? 'Cette galerie est désactivée pour le moment.'
      : 'Ce lien ne correspond à aucune galerie active.';
    $('lock-contact').textContent = 'Si vous pensez que c\u2019est une erreur, ou si vous venez de recevoir un nouveau mot de passe, saisissez-le ci-dessous. ' +
      'Sinon, contactez Mews Studio à ' + email + ' pour rétablir votre accès.';
    $('lock-contact').classList.remove('hidden');
    $('lock-error').textContent = '';
    show('lock');
    setTimeout(function () { $('lock-pass').focus(); }, 60);
  }

  function showDead(title, text) {
    $('dead-title').textContent = title;
    $('dead-text').textContent = text;
    show('dead');
  }

  /* --- Watermark --------------------------------------------- */
  function watermarkSpans(count) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < (count || 3); i++) {
      var s = document.createElement('span');
      s.textContent = state.watermark.text;
      frag.appendChild(s);
    }
    return frag;
  }

  /* --- Rendu ------------------------------------------------- */
  function photoUrl(p, kind) {
    return '/api/g/' + slug + '/photo/' + encodeURIComponent(p.id) + '/' + kind;
  }

  function visiblePhotos() {
    return state.photos;
  }

  function albumById(typeId) {
    return (state.albums && state.albums.types || []).find(function (t) { return t.id === typeId; });
  }
  /* Un album de CE format a-t-il déjà été envoyé par CE client ? (⇒ verrouillé) */
  // Verrou PAR GALERIE : un format d'album déjà envoyé par quelqu'un est clos
  // pour tous (même avec une autre adresse e-mail). Carte grisée + badge.
  function sentMap() {
    return (state.client && state.client.sentByType) || state.gallerySentByType || {};
  }
  function typeIsSent(typeId) {
    return !!(sentMap()[typeId] && sentMap()[typeId].albumsSent > 0);
  }
  function albPhotos(typeId) { return state.alb.photos[typeId] || []; }
  function albTotal() {
    var n = 0;
    Object.keys(state.alb.photos).forEach(function (k) { n += state.alb.photos[k].length; });
    return n;
  }

  function tileAlbums(id) {
    return (state.albums ? state.albums.types : []).filter(function (t) {
      return albPhotos(t.id).indexOf(id) > -1;
    });
  }

  function renderIdentity() {
    var logged = !!state.client;
    $('ident-form').classList.toggle('hidden', logged);
    $('ident-logged').classList.toggle('hidden', !logged);
    if (logged) {
      $('cl-name-out').textContent = state.client.name;
      $('cl-hist-count').textContent = state.client.history.length;
      if (state.client.email && !$('cl-email').value) $('cl-email').value = state.client.email;
    } else if (state.alb.name && !$('cl-name').value) {
      $('cl-name').value = state.alb.name; // pré-rempli depuis la saisie antérieure
    }
  }

  function renderHistory() {
    var list = $('cl-history-list');
    list.innerHTML = '';
    var history = state.client ? state.client.history : [];
    if (!history.length) {
      list.innerHTML = '<p class="small muted">Aucune sélection envoyée pour le moment. Votre première sélection apparaîtra ici.</p>';
      return;
    }
    history.forEach(function (sel) {
      var wrap = document.createElement('div');
      wrap.className = 'hist-wrap sent';

      var item = document.createElement('details');
      item.className = 'hist-item';

      var sum = document.createElement('summary');
      var title = document.createElement('span');
      title.textContent = 'Sélection du ' + window.fmtDate(sel.date);
      var badge = document.createElement('span');
      badge.className = 'hist-sent-badge';
      badge.textContent = '✓ Déjà envoyé à Mews Studio';
      var cnt = document.createElement('span');
      cnt.className = 'muted';
      cnt.textContent = (sel.albums || []).reduce(function (n, a) { return n + (a.photoIds ? a.photoIds.length : 0); }, 0) + ' photo(s)';
      sum.appendChild(title);
      sum.appendChild(badge);
      sum.appendChild(cnt);
      item.appendChild(sum);

      var body = document.createElement('div');
      body.className = 'hist-albums';
      (sel.albums || []).forEach(function (a) {
        if (!a.photoIds || !a.photoIds.length) return;
        var t = albumById(a.typeId);
        var line = document.createElement('div');
        line.className = 'hist-album';
        line.textContent = (t ? t.label : a.typeId) + ' — ' + a.photoIds.length + ' photo(s)';
        body.appendChild(line);
        if (a.coverId) {
          var cp = state.photos.find(function (x) { return x.id === a.coverId; });
          var cov = document.createElement('div');
          cov.className = 'hist-cover';
          cov.textContent = '🖼 Couverture : n°' + (cp ? cp.index + 1 : '?') + ' · ' + (cp ? cp.name : a.coverId);
          body.appendChild(cov);
        }
      });
      item.appendChild(body);
      wrap.appendChild(item);

      // Un album envoyé est définitif pour toute la galerie (verrou par album).
      var note = document.createElement('p');
      note.className = 'hist-note';
      note.textContent = 'Ces albums sont définitifs pour toute la galerie.';
      wrap.appendChild(note);

      list.appendChild(wrap);
    });
  }

  /* --- Couverture d'album ------------------------------------- */
  // La couverture peut être une photo de la galerie, même EN DEHORS de la
  // sélection de l'album (choix libre du client).
  function buildCoverRow(typeId) {
    var row = document.createElement('div');
    row.className = 'alb-cover';
    var coverId = state.alb.covers[typeId];
    var cover = state.photos.find(function (p) { return p.id === coverId; }) || null;
    if (cover) {
      var img = document.createElement('img');
      img.className = 'alb-cover-img';
      img.src = photoUrl(cover, 'thumb');
      img.onload = function () {
        var w = row.querySelector('.alb-cover-warn');
        if (w) w.style.display = (img.naturalWidth < img.naturalHeight) ? '' : 'none';
      };
      var meta = document.createElement('span');
      meta.className = 'alb-cover-meta';
      meta.textContent = '🖼 n°' + (cover.index + 1) + ' · ' + cover.name;
      var warn = document.createElement('span');
      warn.className = 'alb-cover-warn';
      warn.style.display = 'none';
      warn.textContent = '⚠ verticale — la couverture doit être horizontale';
      var change = document.createElement('span');
      change.className = 'alb-cover-btn';
      change.setAttribute('role', 'button');
      change.textContent = 'Changer';
      change.addEventListener('click', function (e) { e.stopPropagation(); openCoverPicker(typeId); });
      var rm = document.createElement('span');
      rm.className = 'alb-cover-btn alb-cover-btn--rm';
      rm.setAttribute('role', 'button');
      rm.title = 'Retirer la couverture';
      rm.textContent = '✕';
      rm.addEventListener('click', function (e) {
        e.stopPropagation();
        delete state.alb.covers[typeId];
        saveAlbums();
        renderAlbumsPanel();
      });
      row.appendChild(img);
      row.appendChild(meta);
      row.appendChild(warn);
      row.appendChild(change);
      row.appendChild(rm);
    } else {
      var choose = document.createElement('span');
      // Couverture OBLIGATOIRE avant envoi : si l'album contient déjà des
      // photos, le bouton passe en rouge pour signaler ce qui manque.
      choose.className = 'alb-cover-btn alb-cover-btn--pick' + (albPhotos(typeId).length > 0 ? ' alb-cover-btn--required' : '');
      choose.setAttribute('role', 'button');
      choose.textContent = '🖼 Choisir la couverture';
      choose.addEventListener('click', function (e) { e.stopPropagation(); openCoverPicker(typeId); });
      row.appendChild(choose);
    }
    return row;
  }

  function openCoverPicker(typeId) {
    var t = albumById(typeId);
    if (!t) return;
    if (!state.photos.length) {
      window.toast('La galerie est vide.', 'err');
      return;
    }
    var grid = $('cov-grid');
    grid.innerHTML = '';
    $('cov-title').textContent = 'Couverture — ' + t.label;
    // Toutes les photos de la galerie sont proposées (pas seulement celles de l'album).
    state.photos.forEach(function (p) {
      var tile = document.createElement('div');
      tile.className = 'cov-tile' + (state.alb.covers[typeId] === p.id ? ' current' : '');
      var img = document.createElement('img');
      img.loading = 'lazy';
      // 600 px (au lieu de 400) : la couverture se choisit à l'œil,
      // l'image doit être lisible — surtout sur mobile.
      img.src = photoUrl(p, 'thumb') + '?size=600';
      var badge = document.createElement('span');
      badge.className = 'cov-orient';
      badge.textContent = '…';
      img.onload = function () {
        img.classList.add('loaded'); // retire le placeholder animé
        var portrait = img.naturalWidth < img.naturalHeight;
        badge.textContent = portrait ? 'Portrait' : 'Paysage ✓';
        badge.classList.toggle('portrait', portrait);
      };
      if (img.complete && img.naturalWidth) img.classList.add('loaded'); // déjà en cache
      var cap = document.createElement('span');
      cap.className = 'cov-cap';
      cap.textContent = 'n°' + (p.index + 1) + ' · ' + p.name;
      tile.appendChild(img);
      tile.appendChild(badge);
      tile.appendChild(cap);
      tile.addEventListener('click', function () { openCovZoom(typeId, p); });
      grid.appendChild(tile);
    });
    $('cov').classList.remove('hidden');
  }

  /* --- Zoom avant validation de la couverture --- */
  var covPending = null;
  function openCovZoom(typeId, p) {
    covPending = { typeId: typeId, photo: p };
    var img = $('cov-zoom-img');
    img.src = photoUrl(p, 'thumb') + '?size=1600'; // grande version pour juger la photo
    $('cov-zoom-cap').textContent = 'n°' + (p.index + 1) + ' · ' + p.name;
    var zo = $('cov-zoom-orient');
    zo.textContent = '…';
    zo.classList.remove('portrait');
    img.onload = function () {
      var portrait = img.naturalWidth < img.naturalHeight;
      zo.textContent = portrait ? 'Portrait' : 'Paysage ✓';
      zo.classList.toggle('portrait', portrait);
    };
    if (img.complete && img.naturalWidth) {
      var portrait = img.naturalWidth < img.naturalHeight;
      zo.textContent = portrait ? 'Portrait' : 'Paysage ✓';
      zo.classList.toggle('portrait', portrait);
    }
    $('cov-zoom').classList.remove('hidden');
  }
  function closeCovZoom() {
    $('cov-zoom').classList.add('hidden');
    covPending = null;
  }

  function closeCoverPicker() {
    closeCovZoom();
    $('cov').classList.add('hidden');
  }

  function renderAlbumsPanel() {
    var wrap = $('albums-cards');
    wrap.innerHTML = '';
    renderIdentity();
    renderHistory();
    // Légende du ✦ : visible seulement si des albums ont déjà été envoyés (par quelqu'un)
    if (state.sentInAlbums && state.sentInAlbums.length) {
      var legend = document.createElement('div');
      legend.className = 'alb-legend';
      legend.innerHTML = '<span class="alb-legend-star">✦</span> Déjà choisie pour un album — elle reste disponible, vous pouvez la choisir aussi pour le vôtre.';
      wrap.appendChild(legend);
    }
    var hint = document.createElement('div');
    hint.className = 'alb-cover-hint';
    hint.innerHTML = '🖼 <b>Couverture d\u2019album (obligatoire)</b> : choisissez pour chaque album photo une photo en format <b>horizontal (paysage)</b> avant l\u2019envoi.';
    wrap.appendChild(hint);
    state.albums.types.forEach(function (t, ti) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'alb-card';
      var checked = !!state.alb.checked[t.id];
      var active = state.alb.active === t.id;
      var photos = albPhotos(t.id);
      var locked = typeIsSent(t.id); // format déjà envoyé par quelqu'un → clos pour toute la galerie
      if (checked) card.classList.add('checked');
      if (active && !locked) card.classList.add('active');
      if (locked) card.classList.add('locked');

      var head = document.createElement('div');
      head.className = 'alb-card-head';
      head.innerHTML =
        '<span class="dot-c" style="background:' + albumColor(t.id, ti) + '"></span>' +
        '<b>' + t.label + '</b>' +
        (locked ? '<span class="alb-locked-badge">✓ Envoyé à Mews Studio</span>' : '<span class="alb-check">✓</span>');

      var count = document.createElement('div');
      count.className = 'alb-count';
      if (locked) {
        count.innerHTML = '<b>Album clos</b> — envoyé à Mews Studio';
      } else {
        count.innerHTML = '<b>' + photos.length + '</b> / ' + t.capacity + ' photo(s)' +
          (photos.length >= t.capacity ? ' — album complet ✓' : '');
      }

      var bar = document.createElement('div');
      bar.className = 'alb-bar';
      bar.innerHTML = locked
        ? '<i style="width:100%;background:#e5484d"></i>'
        : '<i style="width:' + Math.min(100, (photos.length / t.capacity) * 100) + '%;background:' + albumColor(t.id, ti) + '"></i>';

      card.appendChild(head);
      card.appendChild(count);
      card.appendChild(bar);
      if (checked && !locked && !t.print) card.appendChild(buildCoverRow(t.id, photos));
      var sentInfo = sentMap()[t.id];
      if (locked && sentInfo && sentInfo.lastDate) {
        var line = document.createElement('div');
        line.className = 'alb-sentline';
        line.textContent = sentInfo.count + ' photo(s) · envoyé le ' +
          new Date(sentInfo.lastDate).toLocaleDateString('fr-FR');
        card.appendChild(line);
      }

      card.addEventListener('click', function () {
        if (locked) {
          window.toast('L\u2019album « ' + t.label + ' » a déjà été envoyé à Mews Studio — cette carte est close.', 'err');
          return;
        }
        if (state.alb.checked[t.id]) {
          // Clic sur un album déjà coché → il devient l'album actif
          state.alb.active = t.id;
        } else {
          state.alb.checked[t.id] = true;
          state.alb.active = t.id;
        }
        saveAlbums();
        renderAlbumsPanel();
        render();
      });

      // La petite case sert à décocher / retirer l'album (inexistante si clos)
      var check = head.querySelector('.alb-check');
      if (check) check.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.alb.checked[t.id]) {
          delete state.alb.checked[t.id];
          state.alb.photos[t.id] = [];
          delete state.alb.covers[t.id];
          if (state.alb.active === t.id) {
            state.alb.active = Object.keys(state.alb.checked)[0] || null;
          }
          window.toast(t.label + ' retiré de la commande');
        } else {
          state.alb.checked[t.id] = true;
          state.alb.active = t.id;
        }
        saveAlbums();
        renderAlbumsPanel();
        render();
      });

      wrap.appendChild(card);
    });
    $('alb-total').textContent = albTotal();
  }

  function render() {
    var grid = $('grid');
    grid.innerHTML = '';
    grid.classList.toggle('selecting', state.selecting && !state.albumMode);
    grid.classList.toggle('albums-mode', state.albumMode);

    $('btn-select').classList.toggle('active', state.selecting && !state.albumMode);
    $('btn-albums').classList.toggle('active', state.albumMode);
    $('alb-total').textContent = albTotal();
    var showBar = state.selecting && !state.albumMode && state.selected.size > 0;
    $('bar').classList.toggle('visible', showBar);
    $('bar').classList.toggle('hidden', !showBar);
    $('bar-count').textContent = state.selected.size;

    if (state.albumMode && state.albums) renderAlbumsPanel();

    // Photos déjà dans un album envoyé (n'importe quel client) : simple ✦
    // informatif — jamais un blocage.
    var sentSet = null;
    if (state.albumMode && state.albums && state.sentInAlbums && state.sentInAlbums.length) {
      sentSet = {};
      state.sentInAlbums.forEach(function (id) { sentSet[id] = 1; });
    }

    var vis = visiblePhotos();
    if (!vis.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.gridColumn = '1 / -1';
      var b = document.createElement('b');
      b.textContent = 'Cette galerie est vide';
      var s = document.createElement('span');
      s.textContent = 'Votre photographe n\u2019a pas encore ajouté de photos.';
      empty.appendChild(b);
      empty.appendChild(document.createElement('br'));
      empty.appendChild(s);
      grid.appendChild(empty);
      return;
    }

    vis.forEach(function (p) {
      var tile = document.createElement('figure');
      tile.className = 'g-item' + (state.selected.has(p.id) ? ' selected' : '');
      tile.dataset.id = p.id;

      var img = document.createElement('img');
      img.src = photoUrl(p, 'thumb');
      img.loading = 'lazy';
      img.alt = p.name;
      tile.appendChild(img);

      /* Watermark (affichage seulement) */
      if (state.watermark) {
        var wm = document.createElement('div');
        wm.className = 'wm';
        wm.appendChild(watermarkSpans(1));
        tile.appendChild(wm);
      }

      var sel = document.createElement('div');
      sel.className = 'g-sel';
      sel.textContent = '✓';
      tile.appendChild(sel);

      var num = document.createElement('span');
      num.className = 'g-num';
      num.textContent = p.index + 1;
      tile.appendChild(num);

      /* Mode albums : bouton +/✓ et compteur décroissant de l'album actif */
      if (state.albumMode && state.albums) {
        var isSent = !!(sentSet && sentSet[p.id]);
        if (isSent) {
          // Petit ✦ doré : « déjà dans un album » — purement informatif,
          // sans effet de blocage (la photo reste sélectionnable).
          var sentTag = document.createElement('span');
          sentTag.className = 'alb-sent-star';
          sentTag.textContent = '✦';
          sentTag.title = 'Déjà choisie pour un album — vous pouvez la choisir aussi pour le vôtre.';
          tile.appendChild(sentTag);
        }
        var activeT = albumById(state.alb.active);
        if (!activeT || typeIsSent(activeT.id)) {
          // Album actif absent ou clos → le bouton + vise le premier album encore ouvert
          activeT = null;
          for (var j = 0; j < state.albums.types.length; j++) {
            if (!typeIsSent(state.albums.types[j].id)) { activeT = state.albums.types[j]; break; }
          }
        }
        if (activeT) {
          var inAlb = albPhotos(activeT.id).indexOf(p.id) > -1;
          if (inAlb) tile.classList.add('in-album');

          var addBtn = document.createElement('button');
          addBtn.type = 'button';
          addBtn.className = 'alb-add' + (inAlb ? ' in' : '');
          addBtn.textContent = inAlb ? '✓' : '＋';
          addBtn.title = inAlb ? 'Retirer de l\u2019album « ' + activeT.label + ' »' : 'Ajouter à l\u2019album « ' + activeT.label + ' »';
          addBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleInAlbum(p); });
          tile.appendChild(addBtn);

          var rest = activeT.capacity - albPhotos(activeT.id).length;
          var num = document.createElement('span');
          num.className = 'alb-badge-num' + (inAlb ? ' in' : '');
          num.textContent = rest;
          num.title = 'Album « ' + activeT.label + ' » : ' + rest + ' photo(s) restante(s)';
          tile.appendChild(num);
        }
      }

      var actions = document.createElement('div');
      actions.className = 'g-actions';

      if (state.downloads) {
        var dlBtn = document.createElement('button');
        dlBtn.className = 'g-ico';
        dlBtn.innerHTML = '⤓';
        dlBtn.title = 'Télécharger en HD';
        dlBtn.addEventListener('click', function (e) { e.stopPropagation(); triggerDownload(p); });
        actions.appendChild(dlBtn);
      }
      tile.appendChild(actions);

      tile.addEventListener('click', function () {
        if (state.selecting) {
          if (state.selected.has(p.id)) state.selected.delete(p.id); else state.selected.add(p.id);
          render();
        } else {
          openLightbox(vis, vis.indexOf(p));
        }
      });

      grid.appendChild(tile);
    });
  }

  /* --- Mode albums -------------------------------------------- */
  function toggleInAlbum(p) {
    // Identification obligatoire AVANT toute sélection (sinon la connexion
    // suivante écraserait le travail local)
    if (!state.client) {
      // Conduite professionnelle : refermer la lightbox, amener la carte
      // d'identification à l'écran, flash blanc discret, focus sur l'e-mail,
      // message court et neutre (pas de grosse bulle rouge au milieu de la photo).
      var lb = $('lb');
      if (lb && lb.classList.contains('open')) closeLightbox();
      var em = $('cl-email');
      var identBox = em && em.closest('.ident');
      if (identBox) {
        identBox.classList.remove('ident-flash');
        void identBox.offsetWidth;
        identBox.classList.add('ident-flash');
      }
      if (em) {
        em.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setTimeout(function () { em.focus({ preventScroll: true }); }, 420);
      }
      window.toast('Veuillez vous identifier (nom + e-mail) avant de choisir vos photos.');
      return;
    }
    var typeId = state.alb.active;
    if (!typeId || typeIsSent(typeId)) {
      // Album actif absent ou déjà envoyé : choisir le premier album encore disponible
      typeId = null;
      for (var i = 0; i < state.albums.types.length; i++) {
        if (!typeIsSent(state.albums.types[i].id)) { typeId = state.albums.types[i].id; break; }
      }
      if (!typeId) { window.toast('Tous vos albums ont déjà été envoyés à Mews Studio.', 'err'); return; }
      if (!state.alb.checked[typeId]) {
        state.alb.checked[typeId] = true;
        state.alb.active = typeId;
        var tAuto = albumById(typeId);
        window.toast('Album « ' + tAuto.label + ' » activé automatiquement — la photo y est ajoutée ✓', 'ok');
      } else {
        state.alb.active = typeId;
      }
    }
    if (typeIsSent(typeId)) {
      window.toast('L\u2019album « ' + (albumById(typeId) || {}).label + ' » a déjà été envoyé à Mews Studio.', 'err');
      return;
    }
    var list = state.alb.photos[typeId] || [];
    var idx = list.indexOf(p.id);
    var t = albumById(typeId);
    if (idx > -1) {
      list.splice(idx, 1);
      state.alb.photos[typeId] = list;
      // NB : la couverture peut être hors de la sélection de l'album → on ne
      // l'efface pas quand on retire une photo de l'album.
      saveAlbums();
      renderAlbumsPanel();
      render();
      return;
    }
    if (list.length >= t.capacity) {
      window.toast(t.label + ' est complet (' + t.capacity + ' photos).', 'err');
      return;
    }
    list.push(p.id);
    state.alb.photos[typeId] = list;
    // Rassure au moment exact où une photo « déjà dans un album » est ajoutée
    if (state.sentInAlbums && state.sentInAlbums.indexOf(p.id) > -1) {
      window.toast('✓ Ajoutée ! Elle figure aussi dans un autre album — c\u2019est tout à fait possible.', 'ok');
    }
    saveAlbums();
    renderAlbumsPanel();
    render();
  }

  function logoutClient() {
    state.client = null;
    clearClient();
    $('cl-history').classList.add('hidden');
    renderAlbumsPanel();
    window.toast('Vous êtes déconnecté·e. Votre travail reste enregistré sur cet appareil.', 'ok');
  }

  function identifyClient(e) {
    e.preventDefault();
    $('cl-error').textContent = '';
    var name = $('cl-name').value.trim();
    var email = $('cl-email').value.trim();
    if (name.length < 2) { $('cl-error').textContent = 'Entrez votre nom.'; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) { $('cl-error').textContent = 'Entrez une adresse e-mail valide — elle permet de retrouver vos sélections.'; return; }
    var btn = $('ident-form').querySelector('button');
    btn.disabled = true;
    window.api('/api/g/' + slug + '/client/auth', {
      method: 'POST',
      body: { name: name, email: email },
    })
      .then(function (data) {
        state.client = {
          token: data.token, name: data.client.name, email: data.client.email || '',
          eventNames: data.client.eventNames || '',
          history: data.client.selections,
          sentIds: data.client.sentIds || [],
          sentByType: data.client.sentByType || {},
        };
        saveClientToken();
        // Prénoms déjà saisis (autre appareil / session précédente) → pré-remplir.
        if (state.client.eventNames) $('confirm-names-input').value = state.client.eventNames;
        // FUSION (jamais d'écrasement) : la sélection locale éventuelle est
        // conservée et complétée par celle du serveur (autre appareil, etc.)
        var srvAlb = data.client.albums || {};
        var mergedPhotos = {};
        var mergedChecked = {};
        (state.albums ? state.albums.types : []).forEach(function (t) {
          var local = state.alb.photos[t.id] || [];
          var srv = (srvAlb.photos || {})[t.id] || [];
          mergedPhotos[t.id] = local.concat(srv.filter(function (id) { return local.indexOf(id) === -1; }));
          if (state.alb.checked[t.id] || (srvAlb.checked || {})[t.id]) mergedChecked[t.id] = true;
        });
        state.alb.checked = mergedChecked;
        state.alb.photos = mergedPhotos;
        state.alb.covers = Object.assign({}, srvAlb.covers || {}, state.alb.covers || {});
        if (!state.alb.name) state.alb.name = data.client.name;
        $('cl-name').value = '';
        saveAlbums();
        renderAlbumsPanel();
        render();
        window.toast('Bienvenue ' + data.client.name + ' ✓ Vos albums sont sauvegardés.', 'ok');
      })
      .catch(function (err) { $('cl-error').textContent = err.message; })
      .finally(function () { btn.disabled = false; });
  }

  function setAlbumMode(on) {
    state.albumMode = on;
    if (on) {
      if (state.selecting) { state.selecting = false; state.selected.clear(); }
      if (!state.alb.active || typeIsSent(state.alb.active)) {
        state.alb.active = Object.keys(state.alb.checked).filter(function (k) { return !typeIsSent(k); })[0] || null;
      }
    }
    $('albums-panel').classList.toggle('hidden', !state.albums);
    render();
  }

  /* --- Récapitulatif + envoi ---------------------------------- */
  function currentSelectionAlbums() {
    return (state.albums ? state.albums.types : []).map(function (t) {
      var on = !!state.alb.checked[t.id];
      return {
        typeId: t.id,
        photoIds: on ? albPhotos(t.id) : [],
        coverId: on ? (state.alb.covers[t.id] || null) : null,
      };
    });
  }

  function selectionTextFor(albumsArr, senderName) {
    var g = state.galleryMeta || {};
    var lines = [];
    lines.push('Nouvelle sélection de photos');
    lines.push('');
    lines.push('Galerie : ' + g.name);
    if (g.clientName) lines.push('Client : ' + g.clientName);
    lines.push('');
    (state.albums ? state.albums.types : []).forEach(function (t) {
      var entry = (albumsArr || []).find(function (a) { return a.typeId === t.id; });
      var list = entry ? entry.photoIds : [];
      if (!list.length) return;
      lines.push('▸ ' + t.label + ' — ' + list.length + ' photo(s)');
      if (entry && entry.coverId) {
        var cp = state.photos.find(function (x) { return x.id === entry.coverId; });
        lines.push('   🖼 Couverture : n°' + (cp ? cp.index + 1 : '?') + ' — ' + (cp ? cp.name : entry.coverId));
      }
      list.forEach(function (id) {
        var p = state.photos.find(function (x) { return x.id === id; });
        lines.push('   · n°' + (p ? p.index + 1 : '?') + ' — ' + (p ? p.name : id));
      });
      lines.push('');
    });
    lines.push('Envoyé depuis Mews Studio Galleries' + (senderName ? ' par ' + senderName : '') + '.');
    return lines.join('\n');
  }

  function selectionText() {
    return selectionTextFor(currentSelectionAlbums(), state.alb.name);
  }

  function buildMailtoFor(albumsArr, senderName) {
    var subject = 'Sélection de photos — ' + (state.galleryMeta ? state.galleryMeta.name : 'galerie');
    return 'mailto:' + (state.albums.email || '') +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(selectionTextFor(albumsArr, senderName));
  }

  function buildMailto() {
    return buildMailtoFor(currentSelectionAlbums(), state.alb.name);
  }

  function sendSelection() {
    if (!state.albums) return;
    if (!state.client) {
      setAlbumMode(true);
      render();
      var em = $('cl-email');
      if (em) setTimeout(function () { em.focus(); }, 150);
      window.toast('Pour envoyer, indiquez d\u2019abord votre nom et votre e-mail (une seule fois).', 'err');
      return;
    }
    var hasPhotos = state.albums.types.some(function (t) { return albPhotos(t.id).length > 0; });
    if (!hasPhotos) {
      window.toast('Ajoutez au moins une photo à un album avant d\u2019envoyer.', 'err');
      return;
    }
    var senderName = state.client ? state.client.name : (state.alb.name || '');
    state.alb.name = senderName;
    saveAlbumsLocal();
    openSendConfirm();
  }

  /* Confirmation avant envoi définitif */
  function openSendConfirm() {
    var albums = currentSelectionAlbums();
    var withPhotos = albums.filter(function (a) { return a.photoIds.length > 0; });
    var nAlbums = withPhotos.length;
    var total = withPhotos.reduce(function (n, a) { return n + a.photoIds.length; }, 0);
    $('confirm-what').textContent = nAlbums > 1 ? 'vos sélections' : 'votre sélection';
    $('confirm-summary').textContent = nAlbums + ' album' + (nAlbums > 1 ? 's' : '') + ' · ' + total + ' photo' + (total > 1 ? 's' : '') + ' en tout';
    // « Prénom(s) sur la première page » : requis seulement si la sélection
    // contient au moins un ALBUM PHOTO — une sélection posters /
    // agrandissements seule n'a pas de première page → champ masqué.
    var types = state.albums ? state.albums.types : [];
    var needsNames = withPhotos.some(function (a) {
      var t = types.find(function (x) { return x.id === a.typeId; });
      return t && !t.print;
    });
    state.confirmNeedsNames = !!needsNames;
    var namesBlock = $('confirm-names');
    if (namesBlock) namesBlock.classList.toggle('hidden', !needsNames);
    // Champ « Prénom(s) » : pré-rempli si le client l'avait déjà saisi (profil / session).
    var namesField = $('confirm-names-input');
    if (namesField) {
      namesField.classList.remove('names-err');
      if (needsNames && !namesField.value.trim() && state.client && state.client.eventNames) {
        namesField.value = state.client.eventNames;
      }
    }
    // Alertes « couverture manquante » (albums photo seulement)
    var noCover = withPhotos.filter(function (a) {
      var t = types.find(function (x) { return x.id === a.typeId; });
      return t && !t.print && !a.coverId;
    }).map(function (a) {
      var t = types.find(function (x) { return x.id === a.typeId; });
      return t.label;
    });
    var warn = $('confirm-cover-warn');
    if (warn) {
      warn.textContent = noCover.length
        ? '⚠ Couverture manquante : ' + noCover.join(' · ') + ' — choisissez une couverture avant de confirmer.'
        : '';
      warn.classList.toggle('hidden', !noCover.length);
    }
    var ok = $('confirm-send-ok');
    ok.disabled = false;
    ok.textContent = 'Je confirme';
    $('confirm-send-modal').classList.add('open');
  }

  function closeSendConfirm() {
    $('confirm-send-modal').classList.remove('open');
  }

  function confirmSendSelection() {
    if (state.sending) return;
    // Prénom(s) OBLIGATOIRE(S) — mais seulement si la sélection contient un
    // album photo (posters / agrandissements seuls → pas de première page).
    var namesField = $('confirm-names-input');
    if (state.confirmNeedsNames && namesField && !namesField.value.trim()) {
      namesField.classList.add('names-err');
      namesField.focus();
      window.toast('Veuillez écrire le(s) prénom(s) avant de confirmer l\u2019envoi.', 'err');
      return;
    }
    state.sending = true;
    var ok = $('confirm-send-ok');
    ok.disabled = true;
    ok.textContent = 'Envoi en cours…';
    closeSendConfirm();

    var senderName = state.client ? state.client.name : (state.alb.name || '');
    // Enregistrement (côté photographe + historique du client)
    var albums = currentSelectionAlbums();
    // Couverture OBLIGATOIRE pour chaque album photo (les impressions n'en ont pas)
    var types = state.albums ? state.albums.types : [];
    var noCoverLabels = [];
    albums.forEach(function (a) {
      if (!a.photoIds.length) return;
      var t = types.find(function (x) { return x.id === a.typeId; });
      if (t && !t.print && !a.coverId) noCoverLabels.push({ label: t.label, typeId: a.typeId });
    });
    if (noCoverLabels.length) {
      state.sending = false;
      ok.disabled = false;
      ok.textContent = 'Je confirme';
      window.toast(
        'Couverture obligatoire : « ' + noCoverLabels[0].label +
        (noCoverLabels.length > 1 ? ' » et ' + (noCoverLabels.length - 1) + ' autre(s) album(s)' : '') +
        ' n\u2019' + (noCoverLabels.length > 1 ? 'ont' : 'a') + ' pas encore de couverture. Choisissez une couverture avant l\u2019envoi.', 'err'
      );
      var first = noCoverLabels[0];
      state.alb.active = first.typeId;
      renderAlbumsPanel();
      var el = document.querySelector('.alb-card.active');
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    var sent = null;
    var sentClient = false;
    var req;
    // Prénoms envoyés uniquement s'ils étaient requis (pas de names.txt
    // pour une sélection posters / agrandissements seule).
    var evNames = state.confirmNeedsNames
      ? ($('confirm-names-input') ? $('confirm-names-input').value.trim() : '')
      : '';
    if (state.client) {
      req = window.api('/api/g/' + slug + '/client/selection', {
        method: 'POST',
        headers: clientHeaders(),
        body: { albums: albums, eventNames: evNames },
      }).then(function (res) {
        sent = res && res.emailSent;
        sentClient = !!(res && res.clientEmailSent);
        return window.api('/api/g/' + slug + '/client/me', { headers: clientHeaders() });
      }).then(function (data) {
        state.client.history = data.client.selections;
        state.client.sentIds = data.client.sentIds || [];
        state.client.sentByType = data.client.sentByType || {};
        state.client.eventNames = data.client.eventNames || state.client.eventNames || '';
        // L'album est clos : les photos envoyées quittent le panier,
        // le client peut ensuite démarrer un autre album (mêmes photos possibles).
        albums.forEach(function (a) {
          var list = state.alb.photos[a.typeId] || [];
          state.alb.photos[a.typeId] = list.filter(function (id) { return a.photoIds.indexOf(id) === -1; });
          a.photoIds.forEach(function (id) {
            if (state.sentInAlbums.indexOf(id) === -1) state.sentInAlbums.push(id);
          });
        });
        // L'album actif ne doit plus être un album clos
        if (typeIsSent(state.alb.active)) {
          state.alb.active = Object.keys(state.alb.checked).filter(function (k) { return !typeIsSent(k); })[0] || null;
        }
        saveAlbumsLocal();
        renderAlbumsPanel();
        render();
      });
    } else {
      req = window.api('/api/g/' + slug + '/selection', {
        method: 'POST',
        body: { name: senderName, albums: albums, eventNames: evNames },
      }).then(function (res) { sent = res && res.emailSent; });
    }

    req.then(function () {
      if (sent) {
        // L'e-mail est parti automatiquement du serveur : rien d'autre à faire.
        window.toast(sentClient
          ? 'Sélection envoyée au photographe — récapitulatif envoyé à votre e-mail ✓'
          : 'Sélection envoyée par e-mail au photographe ✓', 'ok');
        return;
      }
      openSendFallback();
    }).catch(function (err) {
      if (sent) {
        window.toast('Sélection envoyée par e-mail au photographe ✓', 'ok');
      } else if (err && /déjà été envoyées/.test(err.message)) {
        // Doublon refusé : pas de repli mailto (ça enverrait la même sélection).
        window.toast(err.message, 'err');
        if (state.albumMode) renderAlbumsPanel();
        render();
      } else {
        // L'enregistrement a échoué mais l'e-mail reste possible.
        openSendFallback();
      }
    }).then(function () {
      state.sending = false;
    });
  }

  function openSendFallback() {
    if (!state.albums.email) {
      window.toast('L\u2019adresse e-mail du photographe n\u2019est pas encore configurée.', 'err');
      return;
    }
    // Ouverture de l'application mail + fenêtre de secours
    state.mailtoUrl = buildMailto();
    $('send-email').textContent = state.albums.email;
    $('send-recap').value =
      'À : ' + state.albums.email + '\n' +
      'Objet : Sélection de photos — ' + (state.galleryMeta ? state.galleryMeta.name : 'galerie') + '\n\n' +
      selectionText();
    $('send-modal').classList.add('open');
    openMailApp();
  }

  function gmailComposeUrl() {
    var subject = 'Sélection de photos — ' + (state.galleryMeta ? state.galleryMeta.name : 'galerie');
    var body = selectionText();
    if (body.length > 1400) body = body.slice(0, 1400) + '\n…';
    return 'https://mail.google.com/mail/?view=cm&fs=1&to=' + encodeURIComponent(state.albums.email || '') +
      '&su=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  function openMailApp() {
    // Ouvre l'application mail par défaut (fiable sur PC comme sur mobile)
    var a = document.createElement('a');
    a.href = state.mailtoUrl;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.setTimeout(function () {
      try { window.location.href = state.mailtoUrl; } catch (e) { /* rien à faire */ }
    }, 400);
  }

  /* --- Visionneuse ------------------------------------------- */
  function openLightbox(list, index) {
    state.lbList = list;
    state.lbIndex = index;
    var lb = $('lb');
    lb.classList.add('open');
    document.body.style.overflow = 'hidden';
    updateLightbox();
  }
  function updateLightbox() {
    var p = state.lbList[state.lbIndex];
    if (!p) return;
    var lb = $('lb');
    $('lb-count').textContent = (state.lbIndex + 1) + ' / ' + state.lbList.length;
    $('lb-name').textContent = p.name;
    $('lb-dl').style.display = state.downloads ? '' : 'none';

    /* Affichage progressif : la vignette (déjà en cache via la grille)
       apparaît aussitôt, la grande version charge en arrière-plan et
       se fond par-dessus quand elle est prête. Les voisines sont
       préchargées pour que « suivante » soit quasi instantanée. */
    var img = $('lb-img');
    var pre = $('lb-pre');
    lb.classList.add('loading');
    lb.classList.remove('lb-ready');
    pre.src = photoUrl(p, 'thumb');
    img.onload = function () {
      lb.classList.remove('loading');
      lb.classList.add('lb-ready');
      preloadNeighbors();
    };
    img.onerror = function () { lb.classList.remove('loading'); };
    img.src = photoUrl(p, 'thumb') + '?size=1600';
    preloadNeighbors();

    /* Bouton album dans la visionneuse (mode albums) */
    var activeT = state.albumMode && state.albums
      ? (albumById(state.alb.active) || (state.albums.types[0] ? albumById(state.albums.types[0].id) : null))
      : null;
    $('lb-alb').style.display = activeT ? '' : 'none';
    if (activeT) {
      var inAlb = albPhotos(activeT.id).indexOf(p.id) > -1;
      var rest = activeT.capacity - albPhotos(activeT.id).length;
      var lbAlbText = inAlb
        ? '✓ Retirer de « ' + activeT.label + ' »'
        : '＋ Ajouter à « ' + activeT.label + ' » (' + rest + ' photo' + (rest > 1 ? 's' : '') + ' restante' + (rest > 1 ? 's' : '') + ')';
      $('lb-alb').textContent = lbAlbText;
      $('lb-alb').title = lbAlbText; // texte complet en infobulle si tronqué
      $('lb-alb').classList.toggle('btn--gold', !inAlb);
      $('lb-alb').classList.toggle('btn--ghost', inAlb);
    }
  }
  function closeLightbox() {
    var lb = $('lb');
    lb.classList.remove('open', 'lb-ready', 'loading');
    document.body.style.overflow = '';
    $('lb-img').src = '';
    $('lb-pre').src = '';
  }

  /* Préchargement discret des photos voisines (suivante + précédente) :
     le survol du client ne doit plus attendre le réseau. */
  function preloadNeighbors() {
    var n = state.lbList.length;
    if (!n || n < 2) return;
    var seen = {};
    [state.lbIndex + 1, state.lbIndex - 1].forEach(function (i) {
      var q = state.lbList[(i + n) % n];
      if (!q || seen[q.id]) return;
      seen[q.id] = 1;
      var im = new Image();
      im.src = photoUrl(q, 'thumb') + '?size=1600';
    });
  }
  function lbStep(dir) {
    var n = state.lbList.length;
    state.lbIndex = (state.lbIndex + dir + n) % n;
    updateLightbox();
  }

  /* --- Téléchargements --------------------------------------- */
  var downloading = false;
  function triggerDownload(p) {
    var a = document.createElement('a');
    a.href = photoUrl(p, 'download');
    a.download = p.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  function downloadMany(list, label) {
    if (downloading) return;
    if (!list.length) { window.toast('Aucune photo à télécharger.', 'err'); return; }
    downloading = true;
    window.toast('Téléchargement de ' + list.length + ' photo(s)…');
    list.forEach(function (p, i) {
      setTimeout(function () {
        triggerDownload(p);
        if (i === list.length - 1) {
          setTimeout(function () { downloading = false; }, 800);
          window.toast('Téléchargements lancés ✓', 'ok');
        }
      }, i * 700);
    });
  }

  /* --- Initialisation ---------------------------------------- */
  function init() {
    loadAlbums();
    loadClient();

    $('lock-form').addEventListener('submit', function (e) {
      e.preventDefault();
      $('lock-error').textContent = '';
      var btn = e.target.querySelector('button');
      btn.disabled = true;
      window.api('/api/g/' + slug + '/unlock', { method: 'POST', body: { password: $('lock-pass').value } })
        .then(function () { loadPhotos(); })
        .catch(function (err) {
          $('lock-error').textContent = err.message +
            (err.contactEmail ? ' Si vous avez reçu un nouveau mot de passe, saisissez-le ici. Sinon, contactez Mews Studio à ' + err.contactEmail + '.' : '');
        })
        .finally(function () { btn.disabled = false; });
    });

    $('btn-select').addEventListener('click', function () {
      if (state.albumMode) setAlbumMode(false);
      state.selecting = !state.selecting;
      if (!state.selecting) state.selected.clear();
      render();
    });
    $('btn-albums').addEventListener('click', function () {
      setAlbumMode(!state.albumMode);
    });
    $('btn-dl-all').addEventListener('click', function () {
      var vis = visiblePhotos();
      if (vis.length > 8 && !window.confirm('Télécharger les ' + vis.length + ' photos de la galerie ?')) return;
      downloadMany(vis);
    });
    $('btn-dl-sel').addEventListener('click', function () {
      var list = state.photos.filter(function (p) { return state.selected.has(p.id); });
      downloadMany(list);
      exitSelectMode();
    });
    $('btn-clear').addEventListener('click', function () {
      state.selected.clear();
      render();
    });
    $('btn-send-selection').addEventListener('click', sendSelection);

    /* Confirmation avant envoi définitif */
    $('confirm-send-ok').addEventListener('click', confirmSendSelection);
    $('confirm-send-cancel').addEventListener('click', closeSendConfirm);
    $('confirm-send-modal').addEventListener('click', function (e) {
      if (e.target === $('confirm-send-modal') && !state.sending) closeSendConfirm();
    });

    /* Fenêtre d'aide à l'envoi */
    $('send-retry').addEventListener('click', openMailApp);
    $('send-gmail').addEventListener('click', function () {
      try { window.open(gmailComposeUrl(), '_blank', 'noopener'); } catch (e) { /* rien à faire */ }
      window.toast('Gmail s\u2019ouvre dans un nouvel onglet — le message est pré-rempli.', 'ok');
    });
    $('send-copy').addEventListener('click', function () {
      window.copyText($('send-recap').value).then(function (ok) {
        window.toast(ok
          ? 'Récapitulatif copié ✓ Collez-le dans un e-mail adressé à ' + (state.albums ? state.albums.email : 'votre photographe') + '.'
          : 'Copie automatique impossible : sélectionnez le texte et copiez-le (Ctrl+C).', ok ? 'ok' : 'err');
      });
    });
    $('send-close').addEventListener('click', function () {
      $('send-modal').classList.remove('open');
    });

    /* Identification client */
    $('ident-form').addEventListener('submit', identifyClient);
    $('btn-cl-history').addEventListener('click', function () {
      $('cl-history').classList.toggle('hidden');
    });
    $('btn-cl-logout').addEventListener('click', logoutClient);

    $('lb-close').addEventListener('click', closeLightbox);
    $('lb-prev').addEventListener('click', function () { lbStep(-1); });
    $('lb-next').addEventListener('click', function () { lbStep(1); });
    $('lb').addEventListener('click', function (e) { if (e.target === $('lb') || e.target === $('lb-img')) closeLightbox(); });
    $('lb-dl').addEventListener('click', function () {
      var p = state.lbList[state.lbIndex];
      if (p) triggerDownload(p);
    });
    $('lb-alb').addEventListener('click', function () {
      var p = state.lbList[state.lbIndex];
      if (p) { toggleInAlbum(p); updateLightbox(); }
    });

    $('cov-close').addEventListener('click', closeCoverPicker);
    $('cov').addEventListener('click', function (e) { if (e.target === $('cov')) closeCoverPicker(); });
    $('cov-zoom-back').addEventListener('click', closeCovZoom);
    $('cov-zoom-retour').addEventListener('click', closeCovZoom);
    $('cov-zoom-validate').addEventListener('click', function () {
      var pd = covPending;
      if (!pd) return;
      state.alb.covers[pd.typeId] = pd.photo.id;
      saveAlbums();
      closeCoverPicker();
      renderAlbumsPanel();
      var tt = albumById(pd.typeId);
      window.toast('Couverture de « ' + (tt ? tt.label : '') + ' » choisie ✓', 'ok');
    });

    // Champ « Prénom(s) » (fenêtre de validation) : retire l'erreur à la saisie.
    var namesInput = $('confirm-names-input');
    if (namesInput) {
      namesInput.addEventListener('input', function () { this.classList.remove('names-err'); });
    }

    /* Boutons « haut / bas » (mobile) : « ↑ » remonte au début de
       l'écran (là où se trouve « Envoyer ma sélection » pour valider
       l'album), « ↓ » descend directement à la dernière photo des
       grosses galeries — sans tout redescendre à la main. */
    (function () {
      var wrap = $('jump-nav-m');
      var topBtn = $('btn-scroll-top');
      var endBtn = $('btn-scroll-end');
      if (!wrap || !topBtn || !endBtn) return;
      function update() {
        var albumView = !$('albums-panel').classList.contains('hidden');
        var lbOpen = $('lb').classList.contains('open');
        var y = window.scrollY;
        var max = document.documentElement.scrollHeight - window.innerHeight;
        var showTop = albumView && !lbOpen && y > 240;
        var showEnd = albumView && !lbOpen && (max - y) > 600;
        if (!showTop && !showEnd) { wrap.classList.remove('visible'); return; }
        wrap.classList.add('visible');
        topBtn.classList.toggle('hidden', !showTop);
        endBtn.classList.toggle('hidden', !showEnd);
      }
      window.addEventListener('scroll', update, { passive: true });
      window.addEventListener('resize', update);
      var lb = $('lb');
      if (lb && 'MutationObserver' in window) {
        new MutationObserver(update).observe(lb, { attributes: true, attributeFilter: ['class'] });
      }
      topBtn.addEventListener('click', function () {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      endBtn.addEventListener('click', function () {
        // Saut direct : un scroll « smooth » depuis le milieu d'une
        // grosse galerie prendrait plusieurs secondes.
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      });
      update();
    })();

    /* Navigation « début / fin » (PC) : dans les grosses galeries
       (1 000+ photos), sauter directement à la 1re photo ou à la
       dernière sans tout remonter / redescendre à la main.
       « ↑ » visible quand on est éloigné du début, « ↓ » quand on est
       éloigné de la fin ; masqués en revue plein écran. */
    (function () {
      var wrap = $('jump-nav');
      var topBtn = $('jump-top');
      var endBtn = $('jump-end');
      if (!wrap || !topBtn || !endBtn) return;
      var ticking = false;
      function isDesktop() { return window.matchMedia('(min-width: 721px)').matches; }
      function update() {
        ticking = false;
        var lbOpen = !($('lb') && $('lb').classList.contains('open')) ? false : true;
        if (!isDesktop() || lbOpen) { wrap.classList.remove('visible'); return; }
        var max = document.documentElement.scrollHeight - window.innerHeight;
        var y = window.scrollY;
        var showTop = y > 800;
        var showEnd = max - y > 800;
        if (!showTop && !showEnd) { wrap.classList.remove('visible'); return; }
        wrap.classList.add('visible');
        topBtn.classList.toggle('hidden', !showTop);
        endBtn.classList.toggle('hidden', !showEnd);
      }
      function onScroll() {
        if (!ticking) { ticking = true; window.requestAnimationFrame(update); }
      }
      window.addEventListener('scroll', onScroll, { passive: true });
      window.addEventListener('resize', onScroll);
      // Ouverture/fermeture de la revue plein écran → réévaluer
      var lb = $('lb');
      if (lb && 'MutationObserver' in window) {
        new MutationObserver(onScroll).observe(lb, { attributes: true, attributeFilter: ['class'] });
      }
      function jump(toEnd) {
        var target = toEnd ? document.documentElement.scrollHeight : 0;
        var dist = Math.abs(target - window.scrollY);
        // Lisse quand la distance est courte, saut direct sinon
        // (remonter 30 000 px en « smooth » prendrait plusieurs secondes).
        window.scrollTo({ top: target, behavior: dist < 2500 ? 'smooth' : 'auto' });
      }
      topBtn.addEventListener('click', function () { jump(false); });
      endBtn.addEventListener('click', function () { jump(true); });
      update();
    })();

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('confirm-send-modal').classList.contains('open') && !state.sending) {
        closeSendConfirm();
        return;
      }
      if (e.key === 'Escape' && $('send-modal').classList.contains('open')) {
        $('send-modal').classList.remove('open');
        return;
      }
      if (e.key === 'Escape' && !$('cov').classList.contains('hidden')) {
        if (!$('cov-zoom').classList.contains('hidden')) { closeCovZoom(); return; }
        closeCoverPicker();
        return;
      }
      if (!$('lb').classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
    });

    /* --- Protections anti-copie ------------------------------ */
    // Clic droit / toucher long : pas de menu « Enregistrer l'image »
    document.addEventListener('contextmenu', function (e) {
      var el = e.target;
      if (el && el.closest && (el.closest('input') || el.closest('textarea'))) return;
      e.preventDefault();
    });
    // Glisser-déposer d'une image vers le bureau
    document.addEventListener('dragstart', function (e) {
      if (e.target && e.target.tagName === 'IMG') e.preventDefault();
    });
    // Enregistrer la page (Ctrl/Cmd+S)
    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && String(e.key).toLowerCase() === 's') e.preventDefault();
    });
    // Mobile : rappel confidentialité quand on revient dans l'onglet
    // (les navigateurs mobiles ne permettent pas de bloquer une capture d'écran ;
    //  le filigrane centré reste la protection réelle)
    if ('ontouchstart' in window || navigator.maxTouchPoints > 0) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') { state.hiddenAt = Date.now(); return; }
        if (!state.hiddenAt) return;
        var away = Date.now() - state.hiddenAt;
        state.hiddenAt = null;
        if (away < 600) return;
        var warned = false;
        try { warned = sessionStorage.getItem('mews_shot_warn_' + slug) === '1'; } catch (err) {}
        if (warned) return;
        try { sessionStorage.setItem('mews_shot_warn_' + slug, '1'); } catch (err) {}
        window.toast('Galerie privée : merci de ne pas photographier ni capturer les images. Elles sont protégées par un filigrane.', 'err');
      });
    }

    // Info galerie
    window.api('/api/g/' + slug + '/info')
      .then(function (info) {
        if (!info.exists) return showUnavailable(info);
        if (info.expired) return showDead('Galerie fermée', 'Cette galerie a expiré et n\u2019est plus consultable. Contactez Mews Studio à ' + (info.contactEmail || 'mewstudiofrance@gmail.com') + ' pour plus d\u2019informations.');
        if (info.locked) return showLock(info.meta);
        loadPhotos();
      })
      .catch(function () { showDead('Impossible de charger la galerie', 'Le serveur ne répond pas. Réessayez dans quelques instants.'); });
  }

  function exitSelectMode() {
    state.selecting = false;
    state.selected.clear();
  }

  function loadPhotos() {
    show('loading');
    window.api('/api/g/' + slug + '/photos')
      .then(function (data) {
        state.photos = data.photos || [];
        state.galleryMeta = data.gallery || {};
        state.downloads = data.downloads !== false;
        state.watermark = data.watermark || null;
        state.albums = data.albums || null;
        // Photos déjà dans un album envoyé (tous clients) → ✦ informatif
        state.sentInAlbums = data.sentInAlbums || [];
        // Formats déjà envoyés (tous clients) → verrou global, visible aussi non identifié
        state.gallerySentByType = data.sentByType || {};
    state.albumMode = !!state.albums;
    $('albums-panel').classList.toggle('hidden', !state.albums);
        document.title = state.galleryMeta.name + ' — Mews Studio Galleries';
        $('g-name').textContent = state.galleryMeta.name;
        var sub = [];
        if (state.galleryMeta.clientName) sub.push(state.galleryMeta.clientName);
        sub.push(state.photos.length + ' photo' + (state.photos.length > 1 ? 's' : ''));
        if (state.galleryMeta.expiresAt) sub.push('Jusqu\u2019au ' + window.fmtDate(state.galleryMeta.expiresAt));
        $('g-sub').textContent = sub.join(' · ');

        // Options
        $('btn-albums').classList.toggle('hidden', !state.albums);
        $('btn-dl-all').classList.toggle('hidden', !state.downloads);
        $('btn-select').classList.toggle('hidden', !state.downloads);
        $('btn-dl-sel').classList.toggle('hidden', !state.downloads);
        if (!state.downloads && state.selecting) {
          state.selecting = false;
          state.selected.clear();
        }
        $('lb-wm').innerHTML = '';
        if (state.watermark) $('lb-wm').appendChild(watermarkSpans(1));
        $('lb-wm').style.display = state.watermark ? '' : 'none';

        show(['top', 'grid']);
        render();

        // Session client : recharger profil + historique si identifié
        if (state.client && state.client.token) {
          window.api('/api/g/' + slug + '/client/me', { headers: clientHeaders() })
            .then(function (data) {
              state.client.history = data.client.selections;
              state.client.sentIds = data.client.sentIds || [];
              state.client.sentByType = data.client.sentByType || {};
              state.client.eventNames = data.client.eventNames || '';
              var ni = $('confirm-names-input');
              if (ni && state.client.eventNames && !ni.value.trim()) ni.value = state.client.eventNames;
              state.alb.checked = data.client.albums.checked || {};
              state.alb.photos = data.client.albums.photos || {};
              saveAlbumsLocal();
              if (state.albumMode) renderAlbumsPanel();
              render();
            })
            .catch(function () {
              state.client = null;
              clearClient();
              if (state.albumMode) renderAlbumsPanel();
            });
        }

        // Invitation à s'identifier en début de session (une fois par session)
        if (state.albums && !state.client) {
          var prompted = false;
          try { prompted = sessionStorage.getItem('mews_ident_prompt_' + slug) === '1'; } catch {}
          if (!prompted) {
            try { sessionStorage.setItem('mews_ident_prompt_' + slug, '1'); } catch {}
            setAlbumMode(true);
          }
        }
      })
      .catch(function (err) {
        if (err.message === 'Verrouillé.' || err.message === 'Galerie expirée.' || err.message === 'Galerie introuvable.') {
          return window.api('/api/g/' + slug + '/info').then(function (info) {
            if (!info.exists) showUnavailable(info);
            else if (info.expired) showDead('Galerie fermée', 'Cette galerie a expiré et n\u2019est plus consultable. Contactez Mews Studio à ' + (info.contactEmail || 'mewstudiofrance@gmail.com') + '.');
            else if (info.locked) showLock(info.meta);
          });
        }
        showDead('Impossible de charger la galerie', err.message);
      });
  }

  init();
})();
