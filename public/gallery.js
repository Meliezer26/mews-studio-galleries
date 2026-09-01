/* Mews Studio Galleries — vue client */
(function () {
  'use strict';

  var slug = window.location.pathname.split('/').filter(Boolean)[1] || '';
  var ALBUM_COLORS = { '200': '#d9a441', '150': '#8fbf7f', '100': '#7fa8bf' };

  var state = {
    photos: [],
    favs: new Set(),
    selected: new Set(),
    favOnly: false,
    selecting: false,
    lbIndex: -1,
    lbList: [],
    downloads: true,           // décidé par l'admin, galerie par galerie
    watermark: null,           // { text } ou null
    albums: null,              // { types, email } ou null
    albumMode: false,
    alb: { name: '', checked: {}, active: null, photos: {} }, // par typeId
    client: null,              // { token, name, history } — profil identifié
    saveTimer: null,
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --- Persistance (localStorage par galerie) ---------------- */
  function loadFavs() {
    try {
      var raw = localStorage.getItem('mews_favs_' + slug);
      state.favs = new Set(raw ? JSON.parse(raw) : []);
    } catch { state.favs = new Set(); }
  }
  function saveFavs() {
    try { localStorage.setItem('mews_favs_' + slug, JSON.stringify([...state.favs])); } catch {}
  }
  function toggleFav(id) {
    if (state.favs.has(id)) state.favs.delete(id); else state.favs.add(id);
    saveFavs();
    render();
  }

  function loadAlbums() {
    try {
      var raw = localStorage.getItem('mews_albums_' + slug);
      var d = raw ? JSON.parse(raw) : null;
      if (d && d.photos) state.alb = { name: d.name || '', checked: d.checked || {}, active: null, photos: d.photos };
    } catch {}
  }
  function saveAlbums() {
    saveAlbumsLocal();
    if (state.client) debounceServerSave();
  }

  function saveAlbumsLocal() {
    try {
      localStorage.setItem('mews_albums_' + slug, JSON.stringify({
        name: state.alb.name, checked: state.alb.checked, photos: state.alb.photos,
      }));
    } catch {}
  }

  /* --- Profil client (identification + historique) ------------ */
  function loadClient() {
    try {
      var raw = localStorage.getItem('mews_client_' + slug);
      var d = raw ? JSON.parse(raw) : null;
      if (d && d.token && d.name) state.client = { token: d.token, name: d.name, history: [] };
    } catch { state.client = null; }
  }
  function saveClientToken() {
    try {
      localStorage.setItem('mews_client_' + slug, JSON.stringify({ token: state.client.token, name: state.client.name }));
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
        body: { checked: state.alb.checked, photos: state.alb.photos },
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
    $('lock-sub').textContent = meta.clientName
      ? 'Bonjour ' + meta.clientName + ' ! Cette galerie privée vous est réservée. Entrez le mot de passe communiqué par votre photographe.'
      : 'Cette galerie est protégée. Entrez le mot de passe communiqué par votre photographe.';
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
    return state.favOnly ? state.photos.filter(function (p) { return state.favs.has(p.id); }) : state.photos;
  }

  function albumById(typeId) {
    return (state.albums && state.albums.types || []).find(function (t) { return t.id === typeId; });
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
      if (!$('alb-client-name').value) $('alb-client-name').value = state.client.name;
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
      wrap.className = 'hist-wrap';

      var item = document.createElement('details');
      item.className = 'hist-item';

      var sum = document.createElement('summary');
      var title = document.createElement('span');
      title.textContent = 'Sélection du ' + window.fmtDate(sel.date);
      var cnt = document.createElement('span');
      cnt.className = 'muted';
      cnt.textContent = (sel.albums || []).reduce(function (n, a) { return n + (a.photoIds ? a.photoIds.length : 0); }, 0) + ' photo(s)';
      sum.appendChild(title);
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
      });
      item.appendChild(body);
      wrap.appendChild(item);

      var actions = document.createElement('div');
      actions.className = 'hist-actions';
      var reload = document.createElement('button');
      reload.className = 'btn btn--soft btn--sm';
      reload.textContent = '↺ Recharger dans mes albums';
      reload.addEventListener('click', function () { reloadSelection(sel); });
      var resend = document.createElement('button');
      resend.className = 'btn btn--ghost btn--sm';
      resend.textContent = '✉ Renvoyer par e-mail';
      resend.addEventListener('click', function () { resendSelection(sel); });
      actions.appendChild(reload);
      actions.appendChild(resend);
      wrap.appendChild(actions);

      list.appendChild(wrap);
    });
  }

  function reloadSelection(sel) {
    var checked = {};
    var photos = {};
    (state.albums ? state.albums.types : []).forEach(function (t) { photos[t.id] = []; });
    (sel.albums || []).forEach(function (a) {
      checked[a.typeId] = true;
      photos[a.typeId] = (a.photoIds || []).slice();
    });
    state.alb.checked = checked;
    state.alb.photos = photos;
    state.alb.active = Object.keys(checked)[0] || null;
    saveAlbums();
    renderAlbumsPanel();
    render();
    window.toast('Sélection rechargée dans vos albums ✓', 'ok');
  }

  function resendSelection(sel) {
    if (!state.albums || !state.albums.email) {
      window.toast('L\u2019adresse e-mail du photographe n\u2019est pas encore configurée.', 'err');
      return;
    }
    var a = document.createElement('a');
    a.href = buildMailtoFor(sel.albums, state.client ? state.client.name : state.alb.name);
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.toast('Votre application mail s\u2019ouvre avec la sélection ✓', 'ok');
  }

  function renderAlbumsPanel() {
    var wrap = $('albums-cards');
    wrap.innerHTML = '';
    renderIdentity();
    renderHistory();
    state.albums.types.forEach(function (t) {
      var card = document.createElement('button');
      card.type = 'button';
      card.className = 'alb-card';
      var checked = !!state.alb.checked[t.id];
      var active = state.alb.active === t.id;
      var photos = albPhotos(t.id);
      if (checked) card.classList.add('checked');
      if (active) card.classList.add('active');

      var head = document.createElement('div');
      head.className = 'alb-card-head';
      head.innerHTML =
        '<span class="dot-c" style="background:' + ALBUM_COLORS[t.id] + '"></span>' +
        '<b>' + t.label + '</b>' +
        '<span class="alb-check">✓</span>';

      var count = document.createElement('div');
      count.className = 'alb-count';
      count.innerHTML = '<b>' + photos.length + '</b> / ' + t.capacity + ' photo(s)' +
        (photos.length >= t.capacity ? ' — album complet ✓' : '');

      var bar = document.createElement('div');
      bar.className = 'alb-bar';
      bar.innerHTML = '<i style="width:' + Math.min(100, (photos.length / t.capacity) * 100) + '%;background:' + ALBUM_COLORS[t.id] + '"></i>';

      card.appendChild(head);
      card.appendChild(count);
      card.appendChild(bar);

      card.addEventListener('click', function () {
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

      // La petite case sert à décocher / retirer l'album
      var check = head.querySelector('.alb-check');
      check.addEventListener('click', function (e) {
        e.stopPropagation();
        if (state.alb.checked[t.id]) {
          delete state.alb.checked[t.id];
          state.alb.photos[t.id] = [];
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

    $('fav-count').textContent = state.favs.size;
    $('btn-favs').classList.toggle('active', state.favOnly && !state.albumMode);
    $('btn-select').classList.toggle('active', state.selecting && !state.albumMode);
    $('btn-albums').classList.toggle('active', state.albumMode);
    $('alb-total').textContent = albTotal();
    var showBar = state.selecting && !state.albumMode && state.selected.size > 0;
    $('bar').classList.toggle('visible', showBar);
    $('bar').classList.toggle('hidden', !showBar);
    $('bar-count').textContent = state.selected.size;

    if (state.albumMode && state.albums) renderAlbumsPanel();

    var vis = visiblePhotos();
    if (!vis.length) {
      var empty = document.createElement('div');
      empty.className = 'empty';
      empty.style.gridColumn = '1 / -1';
      var b = document.createElement('b');
      b.textContent = state.favOnly ? 'Aucun favori pour le moment' : 'Cette galerie est vide';
      var s = document.createElement('span');
      s.textContent = state.favOnly
        ? 'Cliquez sur le cœur d\u2019une photo pour la retrouver ici.'
        : 'Votre photographe n\u2019a pas encore ajouté de photos.';
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
        var activeT = albumById(state.alb.active) || (state.albums.types[0] ? albumById(state.albums.types[0].id) : null);
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
          num.title = 'Album « ' + activeT.label + ' » : ' + rest + ' place(s) restante(s)';
          tile.appendChild(num);
        }
      }

      var actions = document.createElement('div');
      actions.className = 'g-actions';

      var favBtn = document.createElement('button');
      favBtn.className = 'g-ico' + (state.favs.has(p.id) ? ' faved' : '');
      favBtn.innerHTML = '♥';
      favBtn.title = state.favs.has(p.id) ? 'Retirer des favoris' : 'Ajouter aux favoris';
      favBtn.addEventListener('click', function (e) { e.stopPropagation(); toggleFav(p.id); });

      var dlBtn = document.createElement('button');
      dlBtn.className = 'g-ico';
      dlBtn.innerHTML = '⤓';
      dlBtn.title = 'Télécharger en HD';
      dlBtn.addEventListener('click', function (e) { e.stopPropagation(); triggerDownload(p); });

      actions.appendChild(favBtn);
      if (state.downloads) actions.appendChild(dlBtn);
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
    var typeId = state.alb.active;
    if (!typeId) {
      typeId = Object.keys(state.alb.checked)[0] || null;
      if (!typeId) {
        // Aucun album coché : on active automatiquement le premier
        var first = state.albums.types[0];
        if (!first) return;
        state.alb.checked[first.id] = true;
        state.alb.active = first.id;
        typeId = first.id;
        window.toast('Album « ' + first.label + ' » activé automatiquement — la photo y est ajoutée ✓', 'ok');
      } else {
        state.alb.active = typeId;
      }
    }
    var list = state.alb.photos[typeId] || [];
    var idx = list.indexOf(p.id);
    var t = albumById(typeId);
    if (idx > -1) {
      list.splice(idx, 1);
      state.alb.photos[typeId] = list;
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
    var btn = $('ident-form').querySelector('button');
    btn.disabled = true;
    window.api('/api/g/' + slug + '/client/auth', {
      method: 'POST',
      body: { name: $('cl-name').value.trim(), pin: $('cl-pin').value },
    })
      .then(function (data) {
        state.client = { token: data.token, name: data.client.name, history: data.client.selections };
        saveClientToken();
        state.alb.checked = data.client.albums.checked || {};
        state.alb.photos = data.client.albums.photos || {};
        if (!state.alb.name) state.alb.name = data.client.name;
        $('alb-client-name').value = state.alb.name;
        $('cl-name').value = '';
        $('cl-pin').value = '';
        saveAlbumsLocal();
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
      state.favOnly = false;
      if (!state.alb.active) state.alb.active = Object.keys(state.alb.checked)[0] || null;
    }
    $('albums-panel').classList.toggle('hidden', !on);
    render();
  }

  /* --- Récapitulatif + envoi ---------------------------------- */
  function currentSelectionAlbums() {
    return (state.albums ? state.albums.types : []).map(function (t) {
      return { typeId: t.id, photoIds: state.alb.checked[t.id] ? albPhotos(t.id) : [] };
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
    var hasPhotos = state.albums.types.some(function (t) { return albPhotos(t.id).length > 0; });
    if (!hasPhotos) {
      window.toast('Ajoutez au moins une photo à un album avant d\u2019envoyer.', 'err');
      return;
    }
    state.alb.name = $('alb-client-name').value.trim();
    saveAlbums();

    // Enregistrement (côté photographe + historique du client)
    var albums = currentSelectionAlbums();
    var req;
    if (state.client) {
      req = window.api('/api/g/' + slug + '/client/selection', {
        method: 'POST',
        headers: clientHeaders(),
        body: { albums: albums },
      }).then(function () {
        return window.api('/api/g/' + slug + '/client/me', { headers: clientHeaders() });
      }).then(function (data) {
        state.client.history = data.client.selections;
        renderAlbumsPanel();
      });
    } else {
      req = window.api('/api/g/' + slug + '/selection', {
        method: 'POST',
        body: { name: state.alb.name, albums: albums },
      });
    }
    req.catch(function () { /* l'e-mail reste utilisable même si l'enregistrement échoue */ });

    if (!state.albums.email) {
      window.toast('L\u2019adresse e-mail du photographe n\u2019est pas encore configurée. Utilisez « Copier le récap ».', 'err');
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

  function openMailApp() {
    try { window.location.href = state.mailtoUrl; } catch (e) { /* rien à faire */ }
  }

  function copySelection() {
    state.alb.name = $('alb-client-name').value.trim();
    saveAlbums();
    var text = 'À : ' + (state.albums.email || '(adresse du photographe)') + '\nObjet : Sélection de photos\n\n' + selectionText();
    window.copyText(text).then(function (ok) {
      window.toast(ok ? 'Récapitulatif copié ✓' : 'Impossible de copier automatiquement.', ok ? 'ok' : 'err');
    });
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
    $('lb-count').textContent = (state.lbIndex + 1) + ' / ' + state.lbList.length;
    $('lb-img').src = photoUrl(p, 'thumb') + '?size=1600';
    $('lb-name').textContent = p.name;
    $('lb-fav').textContent = state.favs.has(p.id) ? '♥ Retirer des favoris' : '♡ Ajouter aux favoris';
    $('lb-fav').classList.toggle('btn--danger', state.favs.has(p.id));
    $('lb-dl').style.display = state.downloads ? '' : 'none';

    /* Bouton album dans la visionneuse (mode albums) */
    var activeT = state.albumMode && state.albums
      ? (albumById(state.alb.active) || (state.albums.types[0] ? albumById(state.albums.types[0].id) : null))
      : null;
    $('lb-alb').style.display = activeT ? '' : 'none';
    if (activeT) {
      var inAlb = albPhotos(activeT.id).indexOf(p.id) > -1;
      var rest = activeT.capacity - albPhotos(activeT.id).length;
      $('lb-alb').textContent = inAlb
        ? '✓ Retirer de « ' + activeT.label + ' »'
        : '＋ Ajouter à « ' + activeT.label + ' » (' + rest + ' place' + (rest > 1 ? 's' : '') + ' restante' + (rest > 1 ? 's' : '') + ')';
      $('lb-alb').classList.toggle('btn--gold', !inAlb);
      $('lb-alb').classList.toggle('btn--ghost', inAlb);
    }
  }
  function closeLightbox() {
    $('lb').classList.remove('open');
    document.body.style.overflow = '';
    $('lb-img').src = '';
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
    loadFavs();
    loadAlbums();
    loadClient();

    $('lock-form').addEventListener('submit', function (e) {
      e.preventDefault();
      $('lock-error').textContent = '';
      var btn = e.target.querySelector('button');
      btn.disabled = true;
      window.api('/api/g/' + slug + '/unlock', { method: 'POST', body: { password: $('lock-pass').value } })
        .then(function () { loadPhotos(); })
        .catch(function (err) { $('lock-error').textContent = err.message; })
        .finally(function () { btn.disabled = false; });
    });

    $('btn-favs').addEventListener('click', function () {
      if (state.albumMode) setAlbumMode(false);
      state.favOnly = !state.favOnly;
      if (state.selecting) { state.selecting = false; state.selected.clear(); }
      render();
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
    $('btn-copy-selection').addEventListener('click', copySelection);

    /* Fenêtre d'aide à l'envoi */
    $('send-retry').addEventListener('click', openMailApp);
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
    $('lb-fav').addEventListener('click', function () {
      var p = state.lbList[state.lbIndex];
      if (p) { toggleFav(p.id); updateLightbox(); }
    });
    $('lb-dl').addEventListener('click', function () {
      var p = state.lbList[state.lbIndex];
      if (p) triggerDownload(p);
    });
    $('lb-alb').addEventListener('click', function () {
      var p = state.lbList[state.lbIndex];
      if (p) { toggleInAlbum(p); updateLightbox(); }
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && $('send-modal').classList.contains('open')) {
        $('send-modal').classList.remove('open');
        return;
      }
      if (!$('lb').classList.contains('open')) return;
      if (e.key === 'Escape') closeLightbox();
      if (e.key === 'ArrowLeft') lbStep(-1);
      if (e.key === 'ArrowRight') lbStep(1);
    });

    // Info galerie
    window.api('/api/g/' + slug + '/info')
      .then(function (info) {
        if (!info.exists) return showDead('Galerie introuvable', 'Ce lien ne correspond à aucune galerie. Vérifiez l\u2019adresse ou contactez votre photographe.');
        if (info.expired) return showDead('Galerie fermée', 'Cette galerie a expiré et n\u2019est plus consultable. Contactez votre photographe pour plus d\u2019informations.');
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
        if (!state.downloads && state.selecting) {
          state.selecting = false;
          state.selected.clear();
        }
        $('alb-client-name').value = state.alb.name || '';
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
        if (err.message === 'Verrouillé.' || err.message === 'Galerie expirée.') {
          return window.api('/api/g/' + slug + '/info').then(function (info) {
            if (info.expired) showDead('Galerie fermée', 'Cette galerie a expiré et n\u2019est plus consultable.');
            else if (info.locked) showLock(info.meta);
          });
        }
        showDead('Impossible de charger la galerie', err.message);
      });
  }

  init();
})();
