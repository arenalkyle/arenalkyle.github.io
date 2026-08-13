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
  // "Current" season anchor -- matches the ppg26/posrank26/ovrank26
  // fields already used elsewhere in js/players-data.js as this app's
  // notion of the in-progress season. Bye-week and Matchup are only
  // ever shown against this season.
  var CURRENT_SEASON_YEAR = 2026;
  var MAX_SEASONS_BACK = 15;
  var WEEKS = 18;

  var espnIndexPromise = null;
  var gamelogCache = {};
  var defenseRankCache = {};
  var bioCache = {};
  var notesProfileCache = {};
  var els = null;
  var currentPlayer = null;
  var notesHistoryOpen = false;
  var notesLogLength = 0;

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

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

  // experience.years is ESPN's own count of pro seasons played
  // (inclusive of the current one) -- used to figure out how many
  // seasons back to pull gamelogs for, since there's no explicit
  // debut-year field on this endpoint.
  function fetchBio(espnId) {
    if (bioCache[espnId]) return bioCache[espnId];
    bioCache[espnId] = fetch('https://sports.core.api.espn.com/v3/sports/football/nfl/athletes/' + espnId)
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        return {
          age: (data && data.age) || null,
          experienceYears: (data && data.experience && data.experience.years) || null
        };
      })
      .catch(function () { return { age: null, experienceYears: null }; });
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
        '<div class="pd-notes-section" id="pdNotesSection" style="display:none">' +
          '<label class="pd-notes-label">Notes</label>' +
          '<div class="pd-notes-view" id="pdNotesView"></div>' +
          '<textarea class="pd-notes-edit" id="pdNotesEdit" style="display:none" rows="3"></textarea>' +
          '<button class="pd-notes-save" id="pdNotesSave" style="display:none">Save Notes</button>' +
          '<button class="pd-notes-history-toggle" id="pdNotesHistoryToggle" style="display:none"></button>' +
          '<div class="pd-notes-history" id="pdNotesHistory" style="display:none"></div>' +
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
      notesSection: document.getElementById('pdNotesSection'),
      notesView: document.getElementById('pdNotesView'),
      notesEdit: document.getElementById('pdNotesEdit'),
      notesSave: document.getElementById('pdNotesSave'),
      notesHistoryToggle: document.getElementById('pdNotesHistoryToggle'),
      notesHistory: document.getElementById('pdNotesHistory')
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
    els.notesHistoryToggle.addEventListener('click', function () {
      notesHistoryOpen = !notesHistoryOpen;
      els.notesHistory.style.display = notesHistoryOpen ? '' : 'none';
      els.notesHistoryToggle.textContent = (notesHistoryOpen ? 'Hide edit history' : 'View edit history') + ' (' + notesLogLength + ')';
    });
  }

  function close() { if (els) els.modal.classList.remove('open'); currentPlayer = null; }

  function canEditNotes() { return !!(window.Auth && window.Auth.can('edit_player_notes')); }

  function saveNotes() {
    if (!currentPlayer) return;
    var key = window.playerKey(currentPlayer);
    var text = els.notesEdit.value.trim();
    els.notesSave.disabled = true;
    window.sb.from('player_notes').upsert({ player_key: key, notes: text, updated_by: window.Auth.user.id, updated_at: new Date().toISOString() })
      .then(function (res) {
        els.notesSave.disabled = false;
        if (res.error) { alert('Could not save notes: ' + res.error.message); return; }
        loadNotes(key);
      });
  }

  function renderNotesView(text) {
    els.notesView.textContent = text || 'No notes yet.' + (canEditNotes() ? ' Click to add some.' : '');
    els.notesView.style.display = '';
    els.notesEdit.style.display = 'none';
    els.notesSave.style.display = 'none';
  }

  // Only shown to viewers at all once a note actually exists -- an
  // Editor/Admin still sees the (empty) section so they can add one.
  function renderNotesSection(text, log) {
    var show = !!text || canEditNotes();
    els.notesSection.style.display = show ? '' : 'none';
    if (!show) return;
    els.notesEdit.value = text;
    renderNotesView(text);
    renderNotesLog(log);
  }

  // player_notes_log is an append-only history written by a DB trigger
  // on every player_notes insert/update (see schema.sql) -- this just
  // renders it, collapsed behind a toggle so it doesn't dominate the
  // card for players with a long edit history.
  function renderNotesLog(log) {
    notesLogLength = log.length;
    if (log.length <= 1) {
      els.notesHistoryToggle.style.display = 'none';
      els.notesHistory.style.display = 'none';
      els.notesHistory.innerHTML = '';
      return;
    }
    var ids = Array.from(new Set(log.map(function (l) { return l.updated_by; }).filter(Boolean)));
    var missing = ids.filter(function (id) { return !notesProfileCache[id]; });
    var profilesPromise = missing.length
      ? window.sb.from('profiles').select('id,username,display_name').in('id', missing).then(function (res) {
          (res.data || []).forEach(function (p) { notesProfileCache[p.id] = p; });
        })
      : Promise.resolve();

    profilesPromise.then(function () {
      els.notesHistoryToggle.style.display = '';
      els.notesHistoryToggle.textContent = (notesHistoryOpen ? 'Hide edit history' : 'View edit history') + ' (' + log.length + ')';
      els.notesHistory.style.display = notesHistoryOpen ? '' : 'none';
      els.notesHistory.innerHTML = log.map(function (entry) {
        var profile = entry.updated_by ? notesProfileCache[entry.updated_by] : null;
        var who = profile ? (profile.display_name || profile.username) : 'Unknown';
        var when = new Date(entry.updated_at).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
        var body = entry.notes ? escapeHtml(entry.notes) : '<em>Cleared the note</em>';
        return '<div class="pd-notes-history-entry">' +
          '<div class="pd-notes-history-meta">' + escapeHtml(who) + ' &middot; ' + when + '</div>' +
          '<div class="pd-notes-history-text">' + body + '</div>' +
        '</div>';
      }).join('');
    });
  }

  function loadNotes(playerKey) {
    notesHistoryOpen = false;
    Promise.all([
      window.sb.from('player_notes').select('notes').eq('player_key', playerKey).maybeSingle(),
      window.sb.from('player_notes_log').select('notes,updated_by,updated_at').eq('player_key', playerKey).order('updated_at', { ascending: false })
    ]).then(function (results) {
      var text = (results[0].data && results[0].data.notes) || '';
      var log = results[1].data || [];
      renderNotesSection(text, log);
    });
  }

  // seasonRows: [{ year, log: {weeks, opponents}, ranks }], most recent
  // first. Bye/Matchup are only meaningful for CURRENT_SEASON_YEAR --
  // earlier seasons only ever show a played score or a plain dash for
  // an unplayed week (we don't track historical bye weeks).
  function renderTable(player, seasonRows) {
    var html = '<table class="pd-table"><thead><tr><th>Season</th>';
    for (var w = 1; w <= WEEKS; w++) html += '<th>' + w + '</th>';
    html += '<th>AVG</th><th>TOTAL</th></tr></thead><tbody>';

    seasonRows.forEach(function (row) {
      var data = row.log;
      var isCurrent = row.year === CURRENT_SEASON_YEAR;
      var total = 0, played = 0;
      html += '<tr><td class="pd-season-label">\'' + String(row.year % 100).padStart(2, '0') + '</td>';
      for (var w = 1; w <= WEEKS; w++) {
        var v = data.weeks[w];
        if (v === undefined) {
          var isBye = isCurrent && player.bye === w;
          html += isBye ? '<td class="pd-cell-bye">BYE</td>' : '<td class="pd-cell-empty">&mdash;</td>';
          continue;
        }
        total += v; played++;
        html += '<td>' + v.toFixed(1) + '</td>';
      }
      html += '<td class="pd-avg">' + (played ? (total / played).toFixed(1) : '—') + '</td>';
      html += '<td class="pd-total">' + total.toFixed(1) + '</td>';
      html += '</tr>';

      // Matchup difficulty is only meaningful for the current season --
      // showing it for a season that's already fully played is just
      // hindsight, not a decision-making signal.
      if (isCurrent) {
        html += '<tr class="pd-matchup-row"><td class="pd-season-label">Matchup (\'' + String(CURRENT_SEASON_YEAR % 100).padStart(2, '0') + ' only)</td>';
        for (var w2 = 1; w2 <= WEEKS; w2++) {
          var opp = data.opponents[w2];
          var rank = opp && row.ranks ? row.ranks[opp] : null;
          html += '<td>' + (rank ? MATCHUP_ICON[rank] : '') + '</td>';
        }
        html += '<td></td><td></td></tr>';
      }
    });

    html += '</tbody></table>';
    return html;
  }

  function renderMeta(player, age) {
    var posLabel = player.pos === 'DST' ? 'D/ST' : player.pos;
    var posColor = window.PlayerRender ? window.PlayerRender.posColor(player.pos) : 'inherit';
    var parts = ['<span class="pd-pos" style="color:' + posColor + '">' + escapeHtml(posLabel) + '</span>', escapeHtml(player.team)];
    if (age) parts.push(age + ' yrs');
    if (player.bye) parts.push('Bye ' + player.bye);
    els.meta.innerHTML = parts.filter(Boolean).join(' &middot; ');
  }

  // Quick "scorecard" tiles built entirely from the already-loaded
  // player object (window.__PLAYERS__) -- renders instantly on open(),
  // before the live ESPN weekly table (which needs a fetch) is ready.
  // Falls back gracefully: a stat with no real value (0/null, e.g. a
  // rookie with no 2025 games) is simply left out instead of showing 0.
  function renderStatCards(player) {
    if (player.isTeamLogo) { els.statCards.innerHTML = ''; return; }
    var fmtPoints = window.PlayerRender ? window.PlayerRender.fmtPoints : function (v) { return v == null ? '—' : String(v); };
    var cards = [];
    if (player.ppg25) cards.push({ label: 'PPG ’25', value: fmtPoints(player.ppg25) });
    if (player.points25) cards.push({ label: 'Total ’25', value: fmtPoints(player.points25) });
    if (player.posrank25) cards.push({ label: 'Pos Rank ’25', value: '#' + player.posrank25 });
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
      return fetchBio(espnId).then(function (bio) {
        if (currentPlayer === player) renderMeta(player, bio.age);

        // Pull every season the player has been in the league, not
        // just the current + previous one -- rookies with no career
        // history yet still fall back to showing the current season.
        // ESPN's experience.years occasionally undercounts (e.g. a
        // season where a player barely played can go un-accrued), so
        // fetch 2 extra seasons past what it reports as a buffer --
        // the empty-season filter below drops any of those that
        // genuinely come back with zero games, so this only ever adds
        // real seasons, never blank rows.
        var years = (bio.experienceYears && bio.experienceYears > 0) ? Math.min(bio.experienceYears + 2, MAX_SEASONS_BACK) : 1;
        var seasonYears = [];
        for (var i = 0; i < years; i++) seasonYears.push(CURRENT_SEASON_YEAR - i);
        if (seasonYears.indexOf(CURRENT_SEASON_YEAR) === -1) seasonYears.unshift(CURRENT_SEASON_YEAR);

        return Promise.all(
          seasonYears.map(function (y) { return fetchGamelog(espnId, y); }).concat(
            seasonYears.map(function (y) { return loadDefenseRanks(y); })
          )
        ).then(function (results) {
          if (currentPlayer !== player) return; // modal moved on to a different player
          var gamelogs = results.slice(0, seasonYears.length);
          var ranksList = results.slice(seasonYears.length);
          var seasonRows = seasonYears.map(function (y, idx) {
            return { year: y, log: gamelogs[idx], ranks: ranksList[idx] };
          }).filter(function (row, idx) {
            // Always keep the current season; drop older seasons with
            // literally no games found (pre-draft/no data at ESPN),
            // rather than rendering an all-dash row for them.
            return idx === 0 || Object.keys(row.log.weeks).length > 0;
          });
          els.tableWrap.innerHTML = renderTable(player, seasonRows);
        });
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
