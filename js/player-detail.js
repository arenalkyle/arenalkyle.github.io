// Shared player detail modal: click any player (Rankings, Create/Edit
// Rankings, Trade Analyzer) to see an enlarged photo, bio, a real
// weekly PPR-points table pulled from ESPN's gamelog API, a
// simplified matchup-difficulty row, and an admin/editor-editable
// notes section (player_notes table). Injects its own modal markup
// once, lazily, the first time open() is called.
//
// Matchup difficulty is a simplification -- see the comment above
// loadDefenseRanks() below for why it's whole-defense-strength based
// rather than truly position-specific.
(function () {
  var SEASONS = ['26', '25'];
  var WEEKS = 18;

  var espnIndexPromise = null;
  var gamelogCache = {};
  var defenseRankCache = {};
  var els = null;
  var currentPlayer = null;

  function normName(s) { return window.PlayerRender ? window.PlayerRender.normalizeName(s) : String(s || '').toLowerCase(); }

  function resolveEspnId(name) {
    if (!window.PlayerRender) return Promise.resolve(null);
    if (!espnIndexPromise) espnIndexPromise = window.PlayerRender.loadEspnIndex();
    return espnIndexPromise.then(function (index) { return index.get(normName(name)) || null; });
  }

  function statVal(names, stats, field) {
    var idx = names.indexOf(field);
    if (idx === -1) return 0;
    var v = parseFloat(stats[idx]);
    return isNaN(v) ? 0 : v;
  }

  function computePoints(names, stats) {
    if (names.indexOf('totalKickingPoints') !== -1) {
      return statVal(names, stats, 'totalKickingPoints');
    }
    var pts = 0;
    pts += statVal(names, stats, 'passingYards') / 25;
    pts += statVal(names, stats, 'passingTouchdowns') * 4;
    pts -= statVal(names, stats, 'interceptions') * 2;
    pts += statVal(names, stats, 'rushingYards') / 10;
    pts += statVal(names, stats, 'rushingTouchdowns') * 6;
    pts += statVal(names, stats, 'receptions') * 1;
    pts += statVal(names, stats, 'receivingYards') / 10;
    pts += statVal(names, stats, 'receivingTouchdowns') * 6;
    pts -= statVal(names, stats, 'fumblesLost') * 2;
    return pts;
  }

  var bioCache = {};
  function fetchAge(espnId) {
    if (bioCache[espnId]) return bioCache[espnId];
    bioCache[espnId] = fetch('https://sports.core.api.espn.com/v3/sports/football/nfl/athletes/' + espnId)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { return (data && data.age) || null; })
      .catch(function () { return null; });
    return bioCache[espnId];
  }

  function fetchGamelog(espnId, seasonYear) {
    var key = espnId + ':' + seasonYear;
    if (gamelogCache[key]) return gamelogCache[key];
    gamelogCache[key] = fetch('https://site.web.api.espn.com/apis/common/v3/sports/football/nfl/athletes/' + espnId + '/gamelog?season=' + seasonYear)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        var weeks = {}, opponents = {};
        if (!data || !data.events) return { weeks: weeks, opponents: opponents };
        (data.seasonTypes || []).forEach(function (st) {
          (st.categories || []).forEach(function (cat) {
            (cat.events || []).forEach(function (ref) {
              var ev = data.events[ref.eventId];
              if (!ev) return;
              weeks[ev.week] = computePoints(data.names, ref.stats);
              if (ev.opponent) opponents[ev.week] = ev.opponent.abbreviation;
            });
          });
        });
        return { weeks: weeks, opponents: opponents };
      }).catch(function () { return { weeks: {}, opponents: {} }; });
    return gamelogCache[key];
  }

  // Simplification: ranks opponents by *overall* points allowed per
  // game (real ESPN standings data, one request covers all 32 teams)
  // rather than points allowed specifically to the player's position,
  // since there's no verified free source for the latter. "easy" =
  // allows the most points overall, "hard" = allows the fewest.
  function loadDefenseRanks(seasonYear) {
    if (defenseRankCache[seasonYear]) return defenseRankCache[seasonYear];
    defenseRankCache[seasonYear] = fetch('https://site.api.espn.com/apis/v2/sports/football/nfl/standings?season=' + seasonYear)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var entries = [];
        (function walk(node) {
          if (!node) return;
          if (node.entries) { entries = entries.concat(node.entries); return; }
          if (node.standings) { walk(node.standings); return; }
          if (node.children) node.children.forEach(walk);
        })(data);
        var teams = entries.map(function (e) {
          function stat(name) { var s = (e.stats || []).find(function (x) { return x.name === name; }); return s ? s.value : 0; }
          var gp = stat('wins') + stat('losses') + stat('ties');
          return { abbr: e.team.abbreviation, paPerGame: gp ? stat('pointsAgainst') / gp : 0 };
        });
        teams.sort(function (a, b) { return b.paPerGame - a.paPerGame; });
        var n = teams.length, rankByAbbr = {};
        teams.forEach(function (t, idx) {
          rankByAbbr[t.abbr] = idx < n / 3 ? 'easy' : (idx < (2 * n) / 3 ? 'average' : 'hard');
        });
        return rankByAbbr;
      }).catch(function () { return {}; });
    return defenseRankCache[seasonYear];
  }

  var MATCHUP_ICON = { easy: '<span class="pd-matchup pd-matchup-easy" title="Good matchup">&#10003;</span>', average: '<span class="pd-matchup pd-matchup-average" title="Average matchup">=</span>', hard: '<span class="pd-matchup pd-matchup-hard" title="Tough matchup">&#10003;</span>' };

  function injectMarkup() {
    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'playerDetailModal';
    modal.innerHTML =
      '<div class="modal-box player-detail-modal">' +
        '<button class="modal-close" id="pdClose" aria-label="Close">&times;</button>' +
        '<div class="pd-header">' +
          '<div class="pd-photo" id="pdPhoto"></div>' +
          '<div class="pd-bio">' +
            '<h2 class="pd-name"><span id="pdName"></span><span class="pd-tier-badge" id="pdTierBadge" style="display:none"></span></h2>' +
            '<div class="pd-meta" id="pdMeta"></div>' +
          '</div>' +
        '</div>' +
        '<div class="pd-stat-cards" id="pdStatCards"></div>' +
        '<label class="pd-section-label">Weekly Log</label>' +
        '<div class="pd-table-wrap" id="pdTableWrap"></div>' +
        '<div class="pd-notes-section">' +
          '<label class="pd-notes-label">Notes</label>' +
          '<div class="pd-notes-view" id="pdNotesView"></div>' +
          '<textarea class="pd-notes-edit" id="pdNotesEdit" style="display:none" rows="3"></textarea>' +
          '<button class="pd-notes-save" id="pdNotesSave" style="display:none">Save Notes</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    els = {
      modal: modal,
      close: document.getElementById('pdClose'),
      photo: document.getElementById('pdPhoto'),
      name: document.getElementById('pdName'),
      tierBadge: document.getElementById('pdTierBadge'),
      meta: document.getElementById('pdMeta'),
      statCards: document.getElementById('pdStatCards'),
      tableWrap: document.getElementById('pdTableWrap'),
      notesView: document.getElementById('pdNotesView'),
      notesEdit: document.getElementById('pdNotesEdit'),
      notesSave: document.getElementById('pdNotesSave')
    };
    els.close.addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    els.notesView.addEventListener('click', function () {
      if (!window.Auth || !window.Auth.can('edit_player_notes')) return;
      els.notesView.style.display = 'none';
      els.notesEdit.style.display = '';
      els.notesSave.style.display = '';
      els.notesEdit.focus();
    });
    els.notesSave.addEventListener('click', saveNotes);
  }

  function close() { if (els) els.modal.classList.remove('open'); currentPlayer = null; }

  function saveNotes() {
    if (!currentPlayer) return;
    var key = window.playerKey(currentPlayer);
    var text = els.notesEdit.value.trim();
    els.notesSave.disabled = true;
    window.sb.from('player_notes').upsert({ player_key: key, notes: text, updated_by: window.Auth.user.id, updated_at: new Date().toISOString() })
      .then(function (res) {
        els.notesSave.disabled = false;
        if (res.error) { alert('Could not save notes: ' + res.error.message); return; }
        renderNotesView(text);
      });
  }

  function renderNotesView(text) {
    els.notesView.textContent = text || 'No notes yet.' + ((window.Auth && window.Auth.can('edit_player_notes')) ? ' Click to add some.' : '');
    els.notesView.style.display = '';
    els.notesEdit.style.display = 'none';
    els.notesSave.style.display = 'none';
  }

  function loadNotes(playerKey) {
    window.sb.from('player_notes').select('notes').eq('player_key', playerKey).maybeSingle().then(function (res) {
      var text = (res.data && res.data.notes) || '';
      els.notesEdit.value = text;
      renderNotesView(text);
    });
  }

  function renderTable(espnId, weeksData25, weeksData26, ranks25, ranks26) {
    var html = '<table class="pd-table"><thead><tr><th>Season</th>';
    for (var w = 1; w <= WEEKS; w++) html += '<th>' + w + '</th>';
    html += '<th>AVG</th><th>TOTAL</th></tr></thead><tbody>';

    SEASONS.forEach(function (s) {
      var data = s === '26' ? weeksData26 : weeksData25;
      var ranks = s === '26' ? ranks26 : ranks25;
      if (!data) return;
      var total = 0, played = 0;
      html += '<tr><td class="pd-season-label">\'' + s + '</td>';
      for (var w = 1; w <= WEEKS; w++) {
        var v = data.weeks[w];
        if (v === undefined) { html += '<td class="pd-cell-empty">&mdash;</td>'; continue; }
        total += v; played++;
        html += '<td>' + v.toFixed(1) + '</td>';
      }
      html += '<td class="pd-avg">' + (played ? (total / played).toFixed(1) : '—') + '</td>';
      html += '<td class="pd-total">' + total.toFixed(1) + '</td>';
      html += '</tr>';

      // Matchup difficulty is only meaningful for the current season --
      // showing it for a season that's already fully played is just
      // hindsight, not a decision-making signal.
      if (s === SEASONS[0]) {
        html += '<tr class="pd-matchup-row"><td class="pd-season-label">Matchup</td>';
        for (var w2 = 1; w2 <= WEEKS; w2++) {
          var opp = data.opponents[w2];
          var rank = opp && ranks ? ranks[opp] : null;
          html += '<td>' + (rank ? MATCHUP_ICON[rank] : '') + '</td>';
        }
        html += '<td></td><td></td></tr>';
      }
    });

    html += '</tbody></table>';
    return html;
  }

  function renderMeta(player, age) {
    var parts = [player.pos === 'DST' ? 'D/ST' : player.pos, player.team];
    if (age) parts.push(age + ' yrs');
    if (player.bye) parts.push('Bye ' + player.bye);
    els.meta.textContent = parts.filter(Boolean).join(' · ');
  }

  // Quick "scorecard" tiles built entirely from the already-loaded
  // player object (window.__PLAYERS__) -- renders instantly on open(),
  // before the live ESPN weekly table (which needs a fetch) is ready.
  // Falls back gracefully: a stat with no real value (0/null, e.g. a
  // rookie with no 2025 games) is simply left out instead of showing 0.
  function renderStatCards(player) {
    if (player.isTeamLogo) { els.statCards.innerHTML = ''; return; }
    var posLabel = window.PlayerRender ? window.PlayerRender.posLabel(player.pos) : player.pos;
    var fmtPoints = window.PlayerRender ? window.PlayerRender.fmtPoints : function (v) { return v == null ? '—' : String(v); };
    var cards = [];
    if (player.ppg25) cards.push({ label: 'PPG ’25', value: fmtPoints(player.ppg25) });
    if (player.points25) cards.push({ label: 'Total ’25', value: fmtPoints(player.points25) });
    if (player.posrank25) cards.push({ label: 'Pos Rank ’25', value: posLabel + player.posrank25 });
    if (player.ovrank25) cards.push({ label: 'Ovr Rank ’25', value: '#' + player.ovrank25 });
    if (player.ppg26) cards.push({ label: 'PPG ’26', value: fmtPoints(player.ppg26) });
    if (!cards.length) { els.statCards.innerHTML = ''; return; }
    els.statCards.innerHTML = cards.map(function (c) {
      return '<div class="pd-stat-card"><div class="pd-stat-value">' + c.value + '</div><div class="pd-stat-label">' + c.label + '</div></div>';
    }).join('');
  }

  function renderTierBadge(player) {
    var rankSource = player.kyle || player.wesley;
    var tier = (rankSource && window.PlayerRender) ? window.PlayerRender.tierFor(rankSource) : null;
    if (!tier) { els.tierBadge.style.display = 'none'; return; }
    els.tierBadge.style.background = tier.color;
    els.tierBadge.textContent = tier.key;
    els.tierBadge.title = 'Tier ' + tier.key;
    els.tierBadge.style.display = '';
  }

  function loadStatsTable(player) {
    if (player.isTeamLogo) {
      els.tableWrap.innerHTML = '<p class="pd-unavailable">Weekly stats aren\'t available for team defenses yet.</p>';
      return;
    }
    els.tableWrap.innerHTML = '<p class="pd-unavailable">Loading weekly stats&hellip;</p>';
    resolveEspnId(player.name).then(function (espnId) {
      if (!espnId) { els.tableWrap.innerHTML = '<p class="pd-unavailable">Weekly stats not found for this player.</p>'; return; }
      fetchAge(espnId).then(function (age) { if (currentPlayer === player) renderMeta(player, age); });
      return Promise.all([
        fetchGamelog(espnId, 2026), fetchGamelog(espnId, 2025),
        loadDefenseRanks(2026), loadDefenseRanks(2025)
      ]).then(function (results) {
        if (currentPlayer !== player) return; // modal moved on to a different player
        els.tableWrap.innerHTML = renderTable(espnId, results[1], results[0], results[3], results[2]);
      });
    });
  }

  function open(player) {
    if (!els) injectMarkup();
    currentPlayer = player;
    els.name.textContent = player.name;
    renderTierBadge(player);
    renderMeta(player, null);
    renderStatCards(player);

    els.photo.innerHTML = '';
    if (window.PlayerRender) {
      var wrap = window.PlayerRender.buildAvatarWrap(player, null);
      els.photo.appendChild(wrap);
    }

    loadStatsTable(player);
    loadNotes(window.playerKey(player));

    els.modal.classList.add('open');
  }

  window.PlayerDetail = { open: open };
})();
