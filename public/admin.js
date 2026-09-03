/* Mews Studio Galleries — espace photographe */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var state = { galleries: [], currentGalleryId: null, filter: 'all', clientAccess: null };

  /* --- Session ---------------------------------------------- */
  function isLogged() {
    try { return document.cookie.split(';').some(function (c) { return c.trim().indexOf('mews_admin=') === 0; }); }
    catch { return false; }
  }

  /* --- Vue / navigation -------------------------------------- */
  function showShell(on) {
    $('login').classList.toggle('hidden', on);
    $('shell').classList.toggle('on', on);
  }
  function setView(name) {
    document.querySelectorAll('.a-nav button').forEach(function (b) {
      b.classList.toggle('active', b.dataset.view === name);
    });
    document.querySelectorAll('[data-view-pane]').forEach(function (p) {
      p.style.display = p.dataset.viewPane === name ? '' : 'none';
    });
    if (name === 'drive') loadDriveView();
    if (name === 'clients') loadClients();
    if (name === 'settings') {
      window.api('/api/admin/status')
        .then(function (s) {
          if (!$('set-email').value) $('set-email').value = s.photographerEmail || '';
          $('set-default-dl').checked = s.defaultDownloadsEnabled !== false;
          $('set-global-dl').checked = s.globalDownloadsEnabled !== false;
          fillNotifyForm(s.notifications || {});
          $('set-drive-mode').value = s.selectionDriveMode || 'off';
          $('set-drive-cleanup').value = s.selectionCleanupDays || '';
          refreshDriveUser();
          populateDriveRoots(s.selectionRootFolderId);
        })
        .catch(function () {});
    }
  }

  /* --- Tri Drive : connexion du compte Google utilisateur ------ */
  function refreshDriveUser() {
    window.api('/api/admin/drive-user/status')
      .then(function (s) {
        var state = $('drive-user-state');
        if (s.connected && s.email) {
          state.textContent = 'Connecté : ' + s.email + ' ✓';
          $('btn-drive-connect').classList.add('hidden');
          $('btn-drive-disconnect').classList.remove('hidden');
        } else if (s.configured) {
          state.textContent = 'Non connecté — cliquez sur « Se connecter avec Google ».';
          $('btn-drive-connect').classList.remove('hidden');
          $('btn-drive-disconnect').classList.add('hidden');
        } else {
          state.textContent = 'Identifiants Google OAuth non configurés (finalisation en attente).';
          $('btn-drive-connect').classList.add('hidden');
          $('btn-drive-disconnect').classList.add('hidden');
        }
        // Miroir dans l'onglet Drive (encadré « Tri automatique »)
        var miniState = $('drive-sort-mini-state');
        if (miniState) {
          if (s.connected && s.email) {
            miniState.innerHTML = '✓ Connecté (<b>' + escapeHtml(s.email) + '</b>) — chaque sélection envoyée par un client crée automatiquement le dossier trié sur votre Drive.';
            $('drive-sort-mini-connect').classList.add('hidden');
          } else if (s.configured) {
            miniState.innerHTML = '⚠️ Compte Google non connecté : les sélections ne sont pas triées automatiquement (elles arrivent toujours par e-mail).';
            $('drive-sort-mini-connect').classList.remove('hidden');
          } else {
            miniState.innerHTML = '⚠️ Identifiants OAuth absents (finalisation en attente — voir SETUP.md).';
            $('drive-sort-mini-connect').classList.add('hidden');
          }
        }
      })
      .catch(function () {
        $('drive-user-state').textContent = 'Statut indisponible.';
      });
  }

  function populateDriveRoots(selectedId) {
    window.api('/api/admin/drive-user/folders')
      .then(function (data) {
        var sel = $('set-drive-root');
        var current = selectedId || sel.value || '';
        sel.innerHTML = '<option value="">(auto) « Mews Studio — Sélections triées »</option>';
        data.folders.forEach(function (f) {
          var o = document.createElement('option');
          o.value = f.id;
          o.textContent = f.name;
          sel.appendChild(o);
        });
        sel.value = current;
      })
      .catch(function () { /* compte non connecté : la liste reste en (auto) */ });
  }

  /* --- Vue Clients -------------------------------------------- */
  function loadClients() {
    var wrap = $('clients-list');
    wrap.innerHTML = '<div class="spinner"></div>';
    window.api('/api/admin/clients')
      .then(function (data) {
        wrap.innerHTML = '';
        if (!data.galleries.length) {
          wrap.innerHTML = '<div class="empty"><b>Aucun client pour le moment</b><span>Activez la sélection d\u2019albums sur une galerie : vos clients pourront s\u2019identifier et apparaître ici.</span></div>';
          return;
        }
        data.galleries.forEach(function (g) {
          var card = document.createElement('div');
          card.className = 'client-gallery';
          var head = document.createElement('div');
          head.className = 'client-gallery-head';
          var h = document.createElement('h3');
          h.innerHTML = escapeHtml(g.name) + ' <span class="muted">(lien /g/' + escapeHtml(g.slug) + ')</span>';
          head.appendChild(h);
          var addBtn = document.createElement('button');
          addBtn.className = 'btn btn--gold btn--sm';
          addBtn.textContent = '+ Nouveau client';
          addBtn.type = 'button';
          addBtn.addEventListener('click', function () { openClientAccessModal(g.id, g.slug, g.name, null); });
          head.appendChild(addBtn);
          card.appendChild(head);
          if (!g.clients.length) {
            var p = document.createElement('p');
            p.className = 'small muted';
            p.textContent = 'Aucun client identifié sur cette galerie.';
            card.appendChild(p);
          }
          g.clients.forEach(function (c) {
            var row = document.createElement('div');
            row.className = 'client-row';
            var rhead = document.createElement('div');
            rhead.className = 'client-row-head';
            var b = document.createElement('b');
            b.textContent = c.name;
            var em = document.createElement('span');
            em.className = 'muted small';
            em.textContent = c.email ? ('✉ ' + c.email + ' · ') : '';
            var meta = document.createElement('span');
            meta.className = 'muted small';
            meta.textContent = em.textContent + c.selections + ' sélection(s) · dernière activité le ' + (c.lastSeenAt ? window.fmtDate(c.lastSeenAt) : '—');
            rhead.appendChild(b);
            rhead.appendChild(meta);
            var sendBtn = document.createElement('button');
            sendBtn.className = 'btn btn--ghost btn--sm';
            sendBtn.textContent = '📧 Envoyer l\u2019accès';
            sendBtn.type = 'button';
            sendBtn.addEventListener('click', function () { openClientAccessModal(g.id, g.slug, g.name, c); });
            rhead.appendChild(sendBtn);
            row.appendChild(rhead);
            var chips = document.createElement('div');
            chips.className = 'client-albums';
            ['200', '150', '100'].forEach(function (tid) {
              var photos = (c.albums.photos || {})[tid] || [];
              var checked = (c.albums.checked || {})[tid];
              if (!checked && !photos.length) return;
              var chip = document.createElement('span');
              chip.className = 'client-album';
              chip.textContent = 'Album ' + tid + ' : ' + photos.length + ' photo(s)' + (checked ? '' : ' (retiré)');
              chips.appendChild(chip);
            });
            if (!chips.children.length) {
              var none = document.createElement('span');
              none.className = 'client-album';
              none.textContent = 'Aucun album commencé';
              chips.appendChild(none);
            }
            row.appendChild(chips);
            card.appendChild(row);
          });
          wrap.appendChild(card);
        });
      })
      .catch(function (err) { wrap.innerHTML = '<div class="alert alert--err">' + escapeHtml(err.message) + '</div>'; });
  }

  /* --- Modale : créer un client / envoyer l'accès -------------- */
  function openClientAccessModal(galleryId, slug, galleryName, client) {
    state.clientAccess = { galleryId, clientId: client ? client.id : null };
    $('mca-title').textContent = client
      ? 'Envoyer l\u2019accès — ' + client.name + ' (' + galleryName + ')'
      : 'Nouveau client — ' + galleryName;
    $('mca-name').value = client ? client.name : '';
    $('mca-name').disabled = !!client;
    $('mca-email').value = client ? (client.email || '') : '';
    $('mca-gpw').value = '';
    $('btn-save-client-access').textContent = client ? 'Envoyer l\u2019accès' : 'Créer et envoyer l\u2019accès';
    openModal('m-client-access');
    setTimeout(function () { $(client ? 'mca-email' : 'mca-name').focus(); }, 60);
  }

  function clientAccessDone(data) {
    closeModal('m-client-access');
    loadClients();
    if (data.sent) {
      window.toast('E-mail d\u2019accès envoyé au client ✓', 'ok');
      return;
    }
    if (data.sendError) {
      window.toast('Compte créé, mais l\u2019envoi a échoué : ' + data.sendError, 'err');
    }
    if (data.mailto) {
      window.toast('SMTP non configuré : votre messagerie s\u2019ouvre avec l\u2019e-mail prêt à envoyer.', '');
      window.location.href = data.mailto;
    } else if (!data.sent && !data.sendError) {
      window.toast('Client enregistré. E-mail : renseignez une adresse pour l\u2019envoyer.', 'err');
    }
  }

  /* --- Réglages : notifications (Resend / SMTP) ---------------- */
  var notifyResendSet = false; // clé Resend enregistrée côté serveur ?

  function updateSmtpVisibility() {
    var block = $('smtp-block');
    if (!block) return;
    var resendActive = notifyResendSet || $('set-resend-key').value.trim() !== '';
    block.classList.toggle('block-off', resendActive);
  }

  function fillNotifyForm(n) {
    $('set-notify-enabled').checked = !!n.enabled;
    notifyResendSet = !!n.resendSet;
    $('set-resend-key').value = '';
    $('set-resend-key').placeholder = notifyResendSet ? '•••••••• (conservée — laissez vide)' : 're_…';
    $('set-smtp-host').value = n.host || '';
    $('set-smtp-port').value = n.port || 587;
    $('set-smtp-secure').checked = !!n.secure;
    $('set-smtp-user').value = n.user || '';
    $('set-smtp-pass').value = '';
    $('set-smtp-from').value = n.from || '';
    $('set-smtp-to').value = n.to || '';
    $('set-smtp-pass').placeholder = n.passSet ? '•••••••• (conservé — laissez vide)' : 'Mot de passe SMTP';
    updateSmtpVisibility();
    renderNotifyStatus(n);
  }

  function renderNotifyStatus(n) {
    var el = $('notify-status');
    var parts = [];
    if (n.configured) parts.push('Configuration complète ✓');
    else parts.push('Configuration incomplète (expéditeur + clé Resend ou hôte SMTP requis)');
    if (n.resendSet) parts.push('envoi via Resend (clé enregistrée)');
    else if (n.passSet && n.host) parts.push('envoi via SMTP (mot de passe enregistré)');
    if (n.lastNotify) {
      parts.push('dernier envoi : ' + (n.lastNotify.ok ? 'réussi' : 'échec') + ' le ' + window.fmtDate(n.lastNotify.date) + (n.lastNotify.error ? ' — ' + n.lastNotify.error : ''));
    }
    el.textContent = parts.join(' · ');
  }

  function collectNotify() {
    return {
      enabled: $('set-notify-enabled').checked,
      apiKey: $('set-resend-key').value.trim(),
      host: $('set-smtp-host').value.trim(),
      port: parseInt($('set-smtp-port').value, 10) || 587,
      secure: $('set-smtp-secure').checked,
      user: $('set-smtp-user').value.trim(),
      pass: $('set-smtp-pass').value,
      from: $('set-smtp-from').value.trim(),
      to: $('set-smtp-to').value.trim(),
    };
  }

  /* --- Modales ----------------------------------------------- */
  function openModal(id) { $(id).classList.remove('hidden'); }
  function closeModal(id) { $(id).classList.add('hidden'); }

  /* --- Galeries : liste -------------------------------------- */
  function loadGalleries() {
    window.api('/api/admin/galleries')
      .then(function (data) {
        state.galleries = data.galleries;
        renderGalleries();
        refreshBanners();
      })
      .catch(function (err) {
        if (err.message === 'non-autorisé') { showShell(false); return; }
        window.toast(err.message, 'err');
      });
  }

  function refreshBanners() {
    window.api('/api/admin/status')
      .then(function (s) {
        window._saMode = !!s.serviceAccount;
        $('drive-banner').classList.toggle('hidden', !s.demoMode);
        $('global-dl-banner').classList.toggle('hidden', s.globalDownloadsEnabled !== false);
      })
      .catch(function () {});
  }

  function renderGalleries() {
    var wrap = $('g-cards');
    wrap.innerHTML = '';

    var counts = {
      all: state.galleries.length,
      dl: state.galleries.filter(function (g) { return g.downloadsEnabled !== false; }).length,
      nodl: state.galleries.filter(function (g) { return g.downloadsEnabled === false; }).length,
    };
    $('fc-all').textContent = counts.all;
    $('fc-dl').textContent = counts.dl;
    $('fc-nodl').textContent = counts.nodl;
    document.querySelectorAll('#g-filter .fchip').forEach(function (b) {
      b.classList.toggle('active', b.dataset.filter === state.filter);
    });

    var list = state.galleries.filter(function (g) {
      if (state.filter === 'dl') return g.downloadsEnabled !== false;
      if (state.filter === 'nodl') return g.downloadsEnabled === false;
      return true;
    });

    var empty = $('no-galleries');
    empty.classList.toggle('hidden', list.length > 0);
    if (state.filter !== 'all') {
      empty.querySelector('b').textContent = 'Aucune galerie dans ce filtre';
      empty.querySelector('span').textContent = 'Essayez un autre filtre ou créez une galerie.';
    } else {
      empty.querySelector('b').textContent = 'Aucune galerie pour l\u2019instant';
      empty.querySelector('span').textContent = 'Cliquez sur « Nouvelle galerie » pour créer votre première livraison.';
    }
    list.forEach(function (g) { wrap.appendChild(galleryCard(g)); });
  }

  function galleryCard(g) {
    var card = document.createElement('div');
    card.className = 'g-card';

    var cover = document.createElement('div');
    cover.className = 'g-card-cover';
    if (g.cover) {
      var img = document.createElement('img');
      img.src = g.cover;
      img.alt = '';
      cover.appendChild(img);
    } else {
      var ph = document.createElement('div');
      ph.className = 'placeholder';
      ph.textContent = 'Aucune photo pour l\u2019instant';
      cover.appendChild(ph);
    }

    var body = document.createElement('div');
    body.className = 'g-card-body';

    var h3 = document.createElement('h3');
    h3.textContent = g.name;
    var client = document.createElement('div');
    client.className = 'client';
    client.textContent = (g.clientName ? g.clientName + ' · ' : '') + g.count + ' photo(s)';

    var link = document.createElement('div');
    link.className = 'g-link';
    link.title = window.location.origin + g.url;
    var span = document.createElement('span');
    span.textContent = window.location.origin + g.url;
    var copy = document.createElement('button');
    copy.className = 'btn btn--soft btn--sm';
    copy.textContent = 'Copier';
    copy.addEventListener('click', function () {
      window.copyText(window.location.origin + g.url).then(function (ok) {
        window.toast(ok ? 'Lien copié ✓' : 'Lien : ' + window.location.origin + g.url, ok ? 'ok' : 'err');
      });
    });
    link.appendChild(span);
    link.appendChild(copy);

    var meta = document.createElement('div');
    meta.className = 'g-card-meta';
    meta.appendChild(badge(g.mode === 'drive' ? 'Drive' : 'Stockage local', g.mode === 'drive' ? 'gold' : ''));
    if (g.downloadsEnabled === false) meta.appendChild(badge('Sans téléchargement', 'warn'));
    if (g.albumsEnabled) meta.appendChild(badge('👥 ' + (g.clientsCount || 0) + ' client(s)', 'ok'));
    if (g.expiry) {
      var expired = new Date(g.expiry).getTime() < Date.now();
      meta.appendChild(badge(expired ? 'Expirée' : 'Expire le ' + window.fmtDate(g.expiry), expired ? 'warn' : 'ok'));
    }

    var actions = document.createElement('div');
    actions.className = 'g-card-actions';
    actions.appendChild(actBtn('Ouvrir', 'ghost', function () { window.open(g.url, '_blank'); }));
    actions.appendChild(actBtn('Modifier', 'ghost', function () { openEditModal(g); }));
    actions.appendChild(actBtn('Photos', 'ghost', function () { openPhotosModal(g); }));
    if (g.mode === 'drive') {
      actions.appendChild(actBtn('Sync', 'ghost', function () { syncGallery(g, this); }));
    }
    actions.appendChild(actBtn('Supprimer', 'danger', function () { removeGallery(g); }));

    body.appendChild(h3);
    body.appendChild(client);
    body.appendChild(link);
    body.appendChild(meta);
    body.appendChild(actions);
    card.appendChild(cover);
    card.appendChild(body);
    return card;
  }

  function badge(text, kind) {
    var b = document.createElement('span');
    b.className = 'badge' + (kind ? ' badge--' + kind : '');
    b.textContent = text;
    return b;
  }
  function actBtn(text, kind, fn) {
    var b = document.createElement('button');
    b.className = 'btn btn--' + kind + ' btn--sm';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function removeGallery(g) {
    if (!window.confirm('Supprimer la galerie « ' + g.name + ' » ?\nLes photos de votre Drive ne sont jamais supprimées.')) return;
    window.api('/api/admin/galleries/' + g.id, { method: 'DELETE' })
      .then(function () { window.toast('Galerie supprimée'); loadGalleries(); })
      .catch(function (err) { window.toast(err.message, 'err'); });
  }

  function syncGallery(g, btn) {
    btn.disabled = true;
    window.api('/api/admin/galleries/' + g.id + '/sync', { method: 'POST' })
      .then(function (data) { window.toast('Galerie synchronisée — ' + data.count + ' photo(s)'); loadGalleries(); })
      .catch(function (err) { window.toast(err.message, 'err'); })
      .finally(function () { btn.disabled = false; });
  }

  /* --- Modale : nouvelle galerie ------------------------------ */
  function openNewGalleryModal() {
    $('ng-name').value = '';
    $('ng-client').value = '';
    $('ng-slug').value = '';
    $('ng-password').value = '';
    $('ng-expiry').value = '';
    $('ng-mode').value = 'drive';
    $('ng-dl').checked = true;
    $('ng-albums').checked = false;
    $('ng-wm').checked = false;
    $('ng-wm-text').value = 'Mews Studio';
    $('ng-wm-field').classList.add('hidden');
    refreshFolderSelect();
    openModal('m-new');
    setTimeout(function () { $('ng-name').focus(); }, 60);
    // La case « téléchargement » suit le réglage par défaut du photographe
    window.api('/api/admin/status')
      .then(function (s) {
        $('ng-dl').checked = s.defaultDownloadsEnabled !== false;
      })
      .catch(function () {});
  }

  /* --- Modale : modifier une galerie --------------------------- */
  function openEditModal(g) {
    state.editingGalleryId = g.id;
    state.editLoaded = false;
    $('eg-name').value = g.name;
    $('eg-client').value = g.clientName || '';
    $('eg-event').value = g.eventName || '';
    $('eg-password').value = '';
    $('eg-expiry').value = g.expiry ? new Date(g.expiry).toISOString().slice(0, 10) : '';
    window.api('/api/admin/galleries/' + g.id)
      .then(function (data) {
        var full = data.gallery;
        $('eg-dl').checked = full.downloadsEnabled !== false;
        $('eg-albums').checked = !!(full.albums && full.albums.enabled);
        $('eg-wm').checked = !!(full.watermark && full.watermark.enabled);
        $('eg-wm-text').value = (full.watermark && full.watermark.text) || 'Mews Studio';
        $('eg-wm-field').classList.toggle('hidden', !$('eg-wm').checked);
        if (full.mode === 'drive') {
          $('eg-folder-field').classList.remove('hidden');
          populateFolderSelect($('eg-folder'), full.folderId || null, function (hasFolders) {
            $('eg-folder-field').classList.toggle('hidden', !hasFolders);
          });
        } else {
          $('eg-folder-field').classList.add('hidden');
        }
        state.editLoaded = true;
      })
      .catch(function (err) { window.toast(err.message, 'err'); });
    openModal('m-edit');
    setTimeout(function () { $('eg-name').focus(); }, 60);
  }

  function populateFolderSelect(sel, selectedId, cb) {
    sel.innerHTML = '<option value="">Chargement des dossiers…</option>';
    window.api('/api/admin/drive-folders')
      .then(function (data) {
        sel.innerHTML = '';
        if (data.error || !data.folders.length) {
          var o = document.createElement('option');
          o.value = '';
          o.textContent = data.error || 'Aucun dossier trouvé dans ce Drive';
          sel.appendChild(o);
          if (cb) cb(false);
          return;
        }
        data.folders.forEach(function (f) {
          var o = document.createElement('option');
          o.value = f.id;
          o.textContent = f.name;
          if (selectedId && f.id === selectedId) o.selected = true;
          sel.appendChild(o);
        });
        if (cb) cb(true);
      })
      .catch(function () {
        sel.innerHTML = '';
        var o = document.createElement('option');
        o.value = '';
        o.textContent = 'Google Drive non connecté';
        sel.appendChild(o);
        if (cb) cb(false);
      });
  }

  function refreshFolderSelect() {
    populateFolderSelect($('ng-folder'), null, function (hasFolders) {
      $('ng-mode').value = hasFolders ? 'drive' : 'demo';
      $('ng-folder-field').classList.toggle('hidden', !hasFolders);
    });
  }

  /* --- Modale : photos ---------------------------------------- */
  function openPhotosModal(g) {
    state.currentGalleryId = g.id;
    $('pm-title').textContent = 'Photos — ' + g.name;
    $('pm-sub').textContent = g.mode === 'drive' ? 'Dossier Drive lié : ' + g.folderName : 'Stockage local';
    $('pm-sync').style.display = g.mode === 'drive' ? '' : 'none';
    // Mode compte de service : le robot ne peut pas déposer de fichiers.
    var saMode = !!window._saMode;
    $('pm-drop').classList.toggle('hidden', saMode);
    $('pm-sa-note').classList.toggle('hidden', !saMode);
    openModal('m-photos');
    loadPhotosGrid(g.id);
  }

  function loadPhotosGrid(id) {
    var grid = $('pm-grid');
    grid.innerHTML = '<div class="spinner" style="grid-column:1/-1"></div>';
    $('pm-sel').innerHTML = '';
    window.api('/api/admin/galleries/' + id)
      .then(function (data) {
        var g = data.gallery;
        $('pm-count').textContent = g.files.length + ' photo(s)';
        grid.innerHTML = '';
        if (!g.files.length) {
          var e = document.createElement('div');
          e.className = 'empty';
          e.style.gridColumn = '1 / -1';
          e.innerHTML = '<b>Aucune photo</b><span>Ajoutez des images ci-dessus' + (g.mode === 'drive' ? ', ou déposez-les directement dans le dossier Drive.' : '.') + '</span>';
          grid.appendChild(e);
        } else {
          g.files.forEach(function (f) {
            var item = document.createElement('div');
            item.className = 'pm-item';
            var img = document.createElement('img');
            img.src = '/api/admin/galleries/' + g.id + '/photo/' + encodeURIComponent(f.id) + '/thumb?size=240';
            img.loading = 'lazy';
            var del = document.createElement('button');
            del.className = 'pm-del';
            del.title = 'Retirer cette photo';
            del.textContent = '✕';
            del.addEventListener('click', function () { deletePhoto(g, f); });
            item.appendChild(img);
            item.appendChild(del);
            grid.appendChild(item);
          });
        }
        renderSelections(g);
      })
      .catch(function (err) { window.toast(err.message, 'err'); });
  }

  /* --- Sélections d'albums envoyées par les clients ------------- */
  function renderSelections(g) {
    var wrap = $('pm-sel');
    var showWrap = g.albums && g.albums.enabled;
    $('pm-sel-wrap').classList.toggle('hidden', !showWrap);
    if (!showWrap) return;

    var sels = g.selections || [];
    if (!sels.length) {
      wrap.innerHTML = '<p class="small muted">Aucune sélection reçue pour le moment. Les envois de vos clients apparaîtront ici.</p>';
      return;
    }
    var files = g.files || [];
    sels.slice(0, 8).forEach(function (sel) {
      var card = document.createElement('details');
      card.className = 'sel-card';

      var sum = document.createElement('summary');
      var title = document.createElement('span');
      title.textContent = 'Sélection du ' + window.fmtDate(sel.date) + (sel.name ? ' — ' + sel.name : '');
      var cnt = document.createElement('span');
      cnt.className = 'muted';
      cnt.textContent = sel.albums.reduce(function (n, a) { return n + a.photoIds.length; }, 0) + ' photo(s)';
      sum.appendChild(title);
      sum.appendChild(cnt);
      card.appendChild(sum);

      var albumsWrap = document.createElement('div');
      albumsWrap.className = 'sel-albums';
      (sel.albums || []).forEach(function (a) {
        var line = document.createElement('div');
        line.className = 'sel-album';
        var label = (a.typeId === '200' ? 'Album 200 photos' : a.typeId === '150' ? 'Album 150 photos' : 'Album 100 photos');
        var b = document.createElement('b');
        b.textContent = label + ' — ' + a.photoIds.length + ' photo(s)';
        line.appendChild(b);
        if (a.photoIds.length) {
          var chips = document.createElement('div');
          chips.className = 'sel-photos';
          a.photoIds.forEach(function (fid) {
            var idx = files.findIndex(function (f) { return f.id === fid; });
            var chip = document.createElement('span');
            chip.className = 'sel-photo';
            chip.textContent = 'n°' + (idx > -1 ? idx + 1 : '?') + ' · ' + (idx > -1 ? files[idx].name : fid);
            chips.appendChild(chip);
          });
          line.appendChild(chips);
        } else {
          var p = document.createElement('p');
          p.className = 'list';
          p.textContent = '(aucune photo)';
          line.appendChild(p);
        }
        albumsWrap.appendChild(line);
      });
      card.appendChild(albumsWrap);

      /* Ligne « dossier Drive trié » */
      var driveRow = document.createElement('div');
      driveRow.className = 'sel-drive';
      if (sel.driveFolderUrl) {
        var link = document.createElement('a');
        link.href = sel.driveFolderUrl;
        link.target = '_blank';
        link.rel = 'noopener';
        link.textContent = '📁 Dossier trié : ' + (sel.driveFolderName || sel.driveFolderUrl);
        driveRow.appendChild(link);
        if (sel.driveStatus === 'error') {
          var errNote = document.createElement('span');
          errNote.className = 'muted small';
          errNote.textContent = '⚠ ' + (sel.driveError || 'erreur');
          driveRow.appendChild(errNote);
        }
      } else {
        var st = document.createElement('span');
        st.className = 'muted small';
        st.textContent = sel.driveStatus === 'error'
          ? '⚠ Tri Drive en erreur : ' + (sel.driveError || '')
          : sel.driveStatus === 'pending'
            ? '⏳ Tri Drive en cours…'
            : 'Dossier Drive : non créé.';
        driveRow.appendChild(st);
        var btn = document.createElement('button');
        btn.className = 'btn btn--ghost btn--sm';
        btn.textContent = 'Créer le dossier Drive';
        btn.addEventListener('click', function () {
          btn.disabled = true;
          btn.textContent = 'Création…';
          window.api('/api/admin/galleries/' + g.id + '/selections/' + sel.id + '/drive-apply', { method: 'POST' })
            .then(function (d) {
              window.toast('Dossier trié créé ✓ ' + d.total + ' photo(s)', 'ok');
              sel.driveFolderUrl = d.folderUrl;
              sel.driveFolderName = d.folderName;
              sel.driveStatus = 'ok';
              renderSelections(g);
            })
            .catch(function (err) {
              window.toast(err.message, 'err');
              btn.disabled = false;
              btn.textContent = 'Créer le dossier Drive';
            });
        });
        driveRow.appendChild(btn);
      }
      card.appendChild(driveRow);

      wrap.appendChild(card);
    });
  }

  function deletePhoto(g, f) {
    if (!window.confirm('Retirer « ' + f.name + ' » de la galerie ?' + (g.mode === 'drive' ? '\nLe fichier sera déplacé dans la corbeille de votre Drive.' : ''))) return;
    window.api('/api/admin/galleries/' + g.id + '/photo/' + encodeURIComponent(f.id) + '/delete', { method: 'POST' })
      .then(function () { window.toast('Photo retirée'); loadPhotosGrid(g.id); loadGalleries(); })
      .catch(function (err) { window.toast(err.message, 'err'); });
  }

  function uploadPhotos(files) {
    var id = state.currentGalleryId;
    if (!id || !files.length) return;
    var fd = new FormData();
    for (var i = 0; i < files.length; i++) fd.append('photos', files[i]);
    $('pm-count').textContent = 'Envoi en cours…';
    window.api('/api/admin/galleries/' + id + '/upload', { method: 'POST', body: fd })
      .then(function (data) {
        var failed = data.results.filter(function (r) { return !r.ok; });
        window.toast(data.results.length - failed.length + ' photo(s) ajoutée(s)' + (failed.length ? ', ' + failed.length + ' échec(s)' : ''), failed.length ? 'err' : 'ok');
        if (failed.length) failed.slice(0, 3).forEach(function (r) { window.toast(r.name + ' : ' + r.error, 'err'); });
        loadPhotosGrid(id);
        loadGalleries();
      })
      .catch(function (err) { window.toast(err.message, 'err'); });
  }

  /* --- Vue Drive ---------------------------------------------- */
  function loadDriveView() {
    window.api('/api/admin/status')
      .then(function (s) {
        $('drive-unconfigured').classList.toggle('hidden', !s.demoMode);
        $('drive-disconnected').classList.toggle('hidden', s.demoMode || s.driveConnected);
        $('drive-connected').classList.toggle('hidden', !s.driveConnected);
        $('drive-banner').classList.toggle('hidden', !s.demoMode);
        if (s.driveConnected) {
          $('drive-account').textContent = s.driveEmail || s.driveName || 'compte Google';
          $('drive-backup-box').hidden = !(s.backupEnabled || s.serviceAccount);
          $('backup-last').textContent = s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString('fr-FR') : '—';
          $('backup-store').textContent = s.backupStore === 'github' ? 'dépôt GitHub privé' : (s.backupStore === 'drive' ? 'votre Google Drive' : '—');
          $('backup-key-row').hidden = !!s.serviceAccount;
          $('backup-sa-note').hidden = !s.serviceAccount;
          if (s.backupKey) $('backup-key').value = s.backupKey;
          if ($('btn-disconnect-drive')) $('btn-disconnect-drive').style.display = s.serviceAccount ? 'none' : '';
          loadFolders();
        }
        refreshDriveUser(); // encadré « Tri automatique » (compte Google du photographe)
      })
      .catch(function (err) { window.toast(err.message, 'err'); });
  }

  function loadFolders() {
    var box = $('drive-folders');
    box.innerHTML = '<div class="spinner"></div>';
    window.api('/api/admin/drive-folders')
      .then(function (data) {
        box.innerHTML = '';
        if (!data.folders.length) {
          box.innerHTML = '<div class="small muted">Aucun dossier dans ce Drive. Créez un dossier sur drive.google.com.</div>';
          return;
        }
        data.folders.forEach(function (f) {
          var row = document.createElement('div');
          row.className = 'folder-row';
          row.innerHTML = '<span style="color:var(--accent-2)">▸</span>' + escapeHtml(f.name);
          box.appendChild(row);
        });
      })
      .catch(function (err) { box.innerHTML = '<div class="alert alert--err">' + escapeHtml(err.message) + '</div>'; });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* --- Initialisation ----------------------------------------- */
  function init() {
    if (isLogged()) {
      showShell(true);
      loadGalleries();
    } else {
      showShell(false);
    }

    $('login-form').addEventListener('submit', function (e) {
      e.preventDefault();
      $('login-error').textContent = '';
      window.api('/api/admin/login', { method: 'POST', body: { password: $('login-pass').value } })
        .then(function () {
          $('login-pass').value = '';
          showShell(true);
          loadGalleries();
        })
        .catch(function (err) { $('login-error').textContent = err.message; });
    });

    $('btn-logout').addEventListener('click', function () {
      window.api('/api/admin/logout', { method: 'POST' }).finally(function () { showShell(false); });
    });

    document.querySelectorAll('.a-nav button').forEach(function (b) {
      b.addEventListener('click', function () { setView(b.dataset.view); });
    });

    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () { closeModal(b.dataset.close); });
    });
    document.querySelectorAll('.modal-backdrop').forEach(function (m) {
      m.addEventListener('click', function (e) { if (e.target === m) closeModal(m.id); });
    });

    /* Filtres de la liste des galeries */
    document.querySelectorAll('#g-filter .fchip').forEach(function (b) {
      b.addEventListener('click', function () {
        state.filter = b.dataset.filter;
        renderGalleries();
      });
    });

    /* Nouvelle galerie */
    $('btn-new-gallery').addEventListener('click', openNewGalleryModal);
    $('ng-mode').addEventListener('change', function () {
      var drive = this.value === 'drive';
      $('ng-folder-field').classList.toggle('hidden', !drive);
      if (drive && $('ng-folder').options.length === 0) refreshFolderSelect();
    });
    $('ng-name').addEventListener('input', function () {
      var slug = $('ng-slug');
      if (slug.dataset.touched === '1') return;
      slug.value = this.value.toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    });
    $('ng-slug').addEventListener('input', function () { this.dataset.touched = '1'; });

    $('ng-wm').addEventListener('change', function () {
      $('ng-wm-field').classList.toggle('hidden', !this.checked);
    });
    $('eg-wm').addEventListener('change', function () {
      $('eg-wm-field').classList.toggle('hidden', !this.checked);
    });

    $('btn-create-gallery').addEventListener('click', function () {
      var mode = $('ng-mode').value;
      var payload = {
        name: $('ng-name').value.trim(),
        clientName: $('ng-client').value.trim(),
        eventName: $('ng-event').value.trim(),
        slug: $('ng-slug').value.trim(),
        password: $('ng-password').value,
        mode: mode,
        folderId: mode === 'drive' ? $('ng-folder').value : '',
        folderName: mode === 'drive' ? $('ng-folder').selectedOptions[0].textContent : '',
        expiry: $('ng-expiry').value || null,
        downloadsEnabled: $('ng-dl').checked,
        watermarkEnabled: $('ng-wm').checked,
        watermarkText: $('ng-wm-text').value.trim() || 'Mews Studio',
        albumsEnabled: $('ng-albums').checked,
      };
      window.api('/api/admin/galleries', { method: 'POST', body: payload })
        .then(function (data) {
          closeModal('m-new');
          window.toast('Galerie créée ✓');
          loadGalleries();
          var url = window.location.origin + data.gallery.url;
          window.copyText(url).then(function (ok) {
            window.toast(ok ? 'Lien copié : ' + url : 'Lien : ' + url, ok ? 'ok' : '');
          });
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    /* Modifier une galerie */
    $('btn-save-gallery').addEventListener('click', function () {
      var id = state.editingGalleryId;
      if (!id) return;
      if (!state.editLoaded) {
        window.toast('Chargement des informations de la galerie…', 'err');
        return;
      }
      var payload = {
        name: $('eg-name').value.trim(),
        clientName: $('eg-client').value.trim(),
        eventName: $('eg-event').value.trim(),
        password: $('eg-password').value,
        expiry: $('eg-expiry').value || null,
        downloadsEnabled: $('eg-dl').checked,
        watermarkEnabled: $('eg-wm').checked,
        watermarkText: $('eg-wm-text').value.trim() || 'Mews Studio',
        albumsEnabled: $('eg-albums').checked,
      };
      if (!$('eg-folder-field').classList.contains('hidden')) {
        payload.folderId = $('eg-folder').value;
        payload.folderName = $('eg-folder').selectedOptions[0].textContent;
      }
      window.api('/api/admin/galleries/' + id + '/update', { method: 'POST', body: payload })
        .then(function () {
          closeModal('m-edit');
          window.toast('Galerie mise à jour ✓', 'ok');
          loadGalleries();
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    /* Photos */
    $('pm-drop').addEventListener('click', function () { $('pm-file').click(); });
    $('pm-file').addEventListener('change', function () { uploadPhotos(this.files); this.value = ''; });
    ['dragover', 'dragenter'].forEach(function (ev) {
      $('pm-drop').addEventListener(ev, function (e) { e.preventDefault(); $('pm-drop').classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      $('pm-drop').addEventListener(ev, function (e) { e.preventDefault(); $('pm-drop').classList.remove('over'); });
    });
    $('pm-drop').addEventListener('drop', function (e) {
      uploadPhotos(e.dataTransfer.files);
    });
    $('pm-sync').addEventListener('click', function () {
      var id = state.currentGalleryId;
      window.api('/api/admin/galleries/' + id + '/sync', { method: 'POST' })
        .then(function (data) {
          loadPhotosGrid(id);
          if (data.hint) window.toast(data.hint, 'err');
          else window.toast('Synchronisé — ' + data.count + ' photo(s)', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    /* Drive */
    $('btn-connect-drive').addEventListener('click', function () {
      window.api('/api/drive/connect')
        .then(function (data) { window.location.href = data.url; })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-refresh-folders').addEventListener('click', loadFolders);
    $('btn-backup-now').addEventListener('click', function () {
      window.api('/api/admin/backup-now', { method: 'POST' })
        .then(function (r) {
          if (r.ok) {
            window.toast('Sauvegarde réussie ✓ (' + (r.folder || 'Drive') + ')', 'ok');
            $('backup-last').textContent = new Date(r.at).toLocaleString('fr-FR');
          } else {
            window.toast('Sauvegarde impossible : ' + r.reason, 'err');
          }
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-copy-key').addEventListener('click', function () {
      window.copyText($('backup-key').value).then(function (ok) {
        window.toast(ok ? 'Clé copiée ✓' : 'Clé : ' + $('backup-key').value, ok ? 'ok' : 'err');
      });
    });
    $('btn-disconnect-drive').addEventListener('click', function () {
      if (!window.confirm('Déconnecter Google Drive ? Les galeries Drive ne seront plus accessibles tant que vous ne serez pas reconnecté.')) return;
      window.api('/api/admin/drive-disconnect', { method: 'POST' })
        .then(function () { window.toast('Drive déconnecté'); loadDriveView(); })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    /* Réglages */
    $('btn-save-defaults').addEventListener('click', function () {
      window.api('/api/admin/settings', {
        method: 'POST',
        body: {
          defaultDownloadsEnabled: $('set-default-dl').checked,
          globalDownloadsEnabled: $('set-global-dl').checked,
        },
      })
        .then(function (data) {
          $('set-default-dl').checked = data.defaultDownloadsEnabled !== false;
          $('set-global-dl').checked = data.globalDownloadsEnabled !== false;
          refreshBanners();
          window.toast('Réglages des téléchargements enregistrés ✓', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-save-notify').addEventListener('click', function () {
      window.api('/api/admin/settings', { method: 'POST', body: { notifications: collectNotify() } })
        .then(function (data) {
          fillNotifyForm(data.notifications || {});
          $('set-smtp-pass').value = '';
          $('set-resend-key').value = '';
          window.toast('Notifications enregistrées ✓', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('set-resend-key').addEventListener('input', updateSmtpVisibility);
    $('btn-test-email').addEventListener('click', function () {
      var btn = this;
      btn.disabled = true;
      window.api('/api/admin/test-email', { method: 'POST' })
        .then(function (data) {
          window.toast('E-mail de test envoyé à ' + data.to + ' ✓', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); })
        .finally(function () {
          btn.disabled = false;
          window.api('/api/admin/status').then(function (s) { renderNotifyStatus(s.notifications || {}); }).catch(function () {});
        });
    });
    $('btn-save-email').addEventListener('click', function () {
      window.api('/api/admin/settings', { method: 'POST', body: { photographerEmail: $('set-email').value.trim() } })
        .then(function (data) {
          $('set-email').value = data.photographerEmail;
          window.toast('Adresse e-mail enregistrée ✓', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-save-drive').addEventListener('click', function () {
      window.api('/api/admin/settings', {
        method: 'POST',
        body: {
          selectionDriveMode: $('set-drive-mode').value,
          selectionRootFolderId: $('set-drive-root').value || '',
          selectionCleanupDays: parseInt($('set-drive-cleanup').value || '0', 10) || 0,
        },
      })
        .then(function (data) {
          $('set-drive-mode').value = data.selectionDriveMode || 'off';
          window.toast('Réglages du tri Drive enregistrés ✓', 'ok');
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-save-client-access').addEventListener('click', function () {
      var st = state.clientAccess;
      if (!st) return;
      var isNew = !st.clientId;
      var name = $('mca-name').value.trim();
      var email = $('mca-email').value.trim();
      var gpw = $('mca-gpw').value.trim();
      if (isNew && name.length < 2) { window.toast('Entrez le nom du client.', 'err'); return; }
      if (!email) { window.toast('Adresse e-mail du client requise.', 'err'); return; }
      var btn = $('btn-save-client-access');
      btn.disabled = true;
      var url = isNew
        ? '/api/admin/galleries/' + st.galleryId + '/clients'
        : '/api/admin/galleries/' + st.galleryId + '/clients/' + st.clientId + '/send-access';
      var body = { name: name, email: email, galleryPassword: gpw };
      window.api(url, { method: 'POST', body: body })
        .then(function (data) { clientAccessDone(data); })
        .catch(function (err) { btn.disabled = false; window.toast(err.message, 'err'); });
    });
    $('btn-drive-connect').addEventListener('click', function () {
      window.api('/api/admin/drive-user/connect', { method: 'POST' })
        .then(function (data) { window.open(data.url, '_blank', 'noopener'); })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('drive-sort-mini-connect').addEventListener('click', function () {
      window.api('/api/admin/drive-user/connect', { method: 'POST' })
        .then(function (data) { window.open(data.url, '_blank', 'noopener'); })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });
    $('btn-drive-disconnect').addEventListener('click', function () {
      window.api('/api/admin/drive-user/disconnect', { method: 'POST' })
        .then(function () {
          window.toast('Compte Google déconnecté. Le tri automatique est en pause.', 'ok');
          refreshDriveUser();
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    /* Retour du consentement Google (redirection /admin#drive=…) */
    if (location.hash.indexOf('drive=ok') > -1) {
      history.replaceState(null, '', location.pathname + location.search);
      window.toast('Compte Google connecté ✓ Le tri automatique est prêt.', 'ok');
      refreshDriveUser();
    } else if (location.hash.indexOf('drive=err') > -1) {
      history.replaceState(null, '', location.pathname + location.search);
      var m = (location.hash.match(/m=([^&]*)/) || [])[1];
      window.toast('Connexion Google impossible : ' + (m ? decodeURIComponent(m) : 'réessayez.'), 'err');
    }
    $('btn-save-password').addEventListener('click', function () {
      window.api('/api/admin/password', { method: 'POST', body: { current: $('set-current').value, next: $('set-next').value } })
        .then(function () {
          window.toast('Mot de passe modifié ✓', 'ok');
          $('set-current').value = '';
          $('set-next').value = '';
        })
        .catch(function (err) { window.toast(err.message, 'err'); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop:not(.hidden)').forEach(function (m) { closeModal(m.id); });
      }
    });
  }

  init();
})();
