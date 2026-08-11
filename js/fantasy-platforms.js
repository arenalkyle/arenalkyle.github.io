// Sleeper + ESPN league fetchers for my-teams.html, normalized to a
// common shape regardless of platform:
//   { leagueName, teams: [ { teamId, teamName, wins, losses, ties,
//                            roster: [ { name, team, pos } ] } ] }
// Sleeper's API is fully public/CORS-open, fetched directly here.
// ESPN always goes through the espn-proxy Edge Function -- see the
// comment at the top of supabase/functions/espn-proxy/index.ts for
// why (browsers won't let JS set the Cookie header private ESPN
// leagues need).
(function () {
  var SLEEPER_PLAYERS_CACHE_KEY = 'ff_sleeper_players_cache_v1';
  var SLEEPER_PLAYERS_CACHE_MS = 24 * 60 * 60 * 1000;

  // ESPN's fantasy API is unofficial/undocumented -- these numeric ID
  // maps are the commonly-used community-reverse-engineered values.
  // If a team or position ever shows up wrong, this table is the
  // first place to check.
  var ESPN_PRO_TEAM_ABBR = {
    0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN', 8: 'DET', 9: 'GB',
    10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA', 16: 'MIN', 17: 'NE', 18: 'NO',
    19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI', 23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB',
    28: 'WAS', 29: 'CAR', 30: 'JAX', 33: 'BAL', 34: 'HOU'
  };
  var ESPN_POSITION = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DST' };
  // lineupSlotId -> starting slot (community-reverse-engineered, same
  // caveat as the maps above). 20/21 are bench/IR -- not a starter.
  var ESPN_LINEUP_SLOT = { 0: 'QB', 2: 'RB', 4: 'WR', 6: 'TE', 23: 'FLEX', 16: 'DST', 17: 'K' };
  var SLEEPER_SLOT_LABELS = { QB: 'QB', RB: 'RB', WR: 'WR', TE: 'TE', FLEX: 'FLEX', DEF: 'DST', K: 'K' };

  // ---------------- Sleeper ----------------
  function getSleeperPlayers() {
    try {
      var raw = localStorage.getItem(SLEEPER_PLAYERS_CACHE_KEY);
      if (raw) {
        var cached = JSON.parse(raw);
        if (Date.now() - cached.fetchedAt < SLEEPER_PLAYERS_CACHE_MS) return Promise.resolve(cached.data);
      }
    } catch (e) {}
    return fetch('https://api.sleeper.app/v1/players/nfl').then(function (r) { return r.json(); }).then(function (data) {
      try { localStorage.setItem(SLEEPER_PLAYERS_CACHE_KEY, JSON.stringify({ fetchedAt: Date.now(), data: data })); } catch (e) {}
      return data;
    });
  }

  function sleeperPlayerInfo(playerDict, id) {
    var p = playerDict[id];
    if (p) return { name: p.full_name || ((p.first_name || '') + ' ' + (p.last_name || '')).trim(), team: p.team || 'FA', pos: p.position || '' };
    if (/^[A-Z]{2,4}$/.test(id)) return { name: id + ' D/ST', team: id, pos: 'DST' };
    return { name: id, team: 'FA', pos: '' };
  }

  function fetchSleeperLeague(leagueId) {
    var base = 'https://api.sleeper.app/v1/league/' + encodeURIComponent(leagueId);
    return Promise.all([
      fetch(base).then(function (r) { if (!r.ok) throw new Error('League not found.'); return r.json(); }),
      fetch(base + '/rosters').then(function (r) { return r.json(); }),
      fetch(base + '/users').then(function (r) { return r.json(); }),
      getSleeperPlayers()
    ]).then(function (results) {
      var league = results[0], rosters = results[1] || [], users = results[2] || [], playerDict = results[3] || {};
      var usersById = {};
      users.forEach(function (u) { usersById[u.user_id] = u; });
      // roster_positions lists the starting lineup slots in order (bench
      // slots are 'BN', taxi/IR similar) -- roster.starters is a same-length,
      // same-order array of player ids for the non-bench slots only.
      var startingSlots = (league.roster_positions || []).filter(function (s) { return s !== 'BN' && s !== 'IR' && s !== 'TAXI'; });

      var teams = rosters.map(function (r) {
        var u = usersById[r.owner_id];
        var teamName = (u && u.metadata && u.metadata.team_name) || (u && u.display_name) || ('Team ' + r.roster_id);
        var settings = r.settings || {};
        var slotByPlayerId = {};
        (r.starters || []).forEach(function (pid, idx) {
          var slot = startingSlots[idx];
          if (slot && slot !== '0') slotByPlayerId[pid] = SLEEPER_SLOT_LABELS[slot] || slot;
        });
        var roster = (r.players || []).map(function (pid) {
          var info = sleeperPlayerInfo(playerDict, pid);
          info.slot = slotByPlayerId[pid] || null;
          return info;
        });
        return {
          teamId: String(r.roster_id), teamName: teamName,
          wins: settings.wins || 0, losses: settings.losses || 0, ties: settings.ties || 0,
          roster: roster
        };
      });
      return { leagueName: league.name || 'Sleeper League', teams: teams };
    });
  }

  // ---------------- ESPN ----------------
  function fetchEspnLeague(leagueId, season, espnS2, swid) {
    if (!window.APP_CONFIG || !window.APP_CONFIG.ESPN_PROXY_URL) {
      return Promise.reject(new Error('ESPN proxy is not configured.'));
    }
    return fetch(window.APP_CONFIG.ESPN_PROXY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ leagueId: leagueId, season: season, espnS2: espnS2 || null, swid: swid || null })
    }).then(function (r) {
      return r.json().then(function (body) {
        if (!r.ok) {
          if (body.error === 'private_league') throw new Error('That league is private. Add your espn_s2 and SWID cookies below.');
          throw new Error('League not found. Double check the league ID and season.');
        }
        return body;
      });
    }).then(function (data) {
      var teams = (data.teams || []).map(function (t) {
        var teamName = ((t.location || '') + ' ' + (t.nickname || '')).trim() || ('Team ' + t.id);
        var record = (t.record && t.record.overall) || {};
        var roster = ((t.roster && t.roster.entries) || []).map(function (entry) {
          var pp = entry.playerPoolEntry && entry.playerPoolEntry.player;
          if (!pp) return null;
          return {
            name: pp.fullName,
            team: ESPN_PRO_TEAM_ABBR[pp.proTeamId] || 'FA',
            pos: ESPN_POSITION[pp.defaultPositionId] || '',
            slot: ESPN_LINEUP_SLOT[entry.lineupSlotId] || null
          };
        }).filter(Boolean);
        return {
          teamId: String(t.id), teamName: teamName,
          wins: record.wins || 0, losses: record.losses || 0, ties: record.ties || 0,
          roster: roster
        };
      });
      return { leagueName: (data.settings && data.settings.name) || 'ESPN League', teams: teams };
    });
  }

  window.FantasyPlatforms = {
    fetchSleeperLeague: fetchSleeperLeague,
    fetchEspnLeague: fetchEspnLeague
  };
})();
