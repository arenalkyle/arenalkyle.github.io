// Shared player-row rendering helpers used by both the Rankings page
// (index.html) and the Create/Edit Rankings page (rankings-editor.html),
// so the two can never visually drift apart: tiering, number formatting,
// and ESPN headshot/team-logo resolution all live here once.
(function () {
  var TIERS = [
    { key: 'S', max: 3,   color: 'var(--tier-s)' },
    { key: 'A', max: 6,   color: 'var(--tier-a)' },
    { key: 'B', max: 12,  color: 'var(--tier-b)' },
    { key: 'C', max: 22,  color: 'var(--tier-c)' },
    { key: 'D', max: 32,  color: 'var(--tier-d)' },
    { key: 'E', max: 42,  color: 'var(--tier-e)' },
    { key: 'F', max: 52,  color: 'var(--tier-f)' },
    { key: 'G', max: 82,  color: 'var(--tier-g)' },
    { key: 'H', max: Infinity, color: 'var(--tier-h)' }
  ];

  function tierFor(value) {
    if (value === null || value === undefined || isNaN(value)) return null;
    for (var i = 0; i < TIERS.length; i++) {
      if (value <= TIERS[i].max) return TIERS[i];
    }
    return TIERS[TIERS.length - 1];
  }

  function posLabel(pos) {
    return pos === 'DST' ? 'D/ST' : pos;
  }

  function fmt(v, decimals) {
    if (v === null || v === undefined) return null;
    var d = decimals === undefined ? 2 : decimals;
    return (Math.round(v * Math.pow(10, d)) / Math.pow(10, d)).toFixed(d);
  }

  // Points columns: up to 2 decimals, but trim a trailing hundredths-place
  // zero down to 1 decimal (339.30 -> 339.3, 339.33 stays, 202.0 stays 202.0)
  function fmtPoints(v) {
    if (v === null || v === undefined) return '—';
    var s = (Math.round(v * 100) / 100).toFixed(2);
    if (s.charAt(s.length - 1) === '0') s = s.slice(0, -1);
    return s;
  }

  function normalizeName(str) {
    if (!str) return '';
    var s = str.toLowerCase();
    s = s.replace(/[*+]/g, '');
    s = s.replace(/\./g, '');
    s = s.replace(/'/g, '');
    s = s.replace(/\s+/g, ' ').trim();
    s = s.replace(/\s+(jr|sr|ii|iii|iv|v)$/, '');
    return s;
  }

  // ---------------- ESPN headshot resolution ----------------
  var espn = { index: null, promise: null };
  var ESPN_PAGE_COUNT = 21;

  function loadEspnIndex() {
    if (espn.promise) return espn.promise;
    var urls = [];
    for (var i = 1; i <= ESPN_PAGE_COUNT; i++) {
      urls.push('https://sports.core.api.espn.com/v3/sports/football/nfl/athletes?limit=1000&page=' + i);
    }
    espn.promise = Promise.all(urls.map(function (u) {
      return fetch(u).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
    })).then(function (pages) {
      var index = new Map();
      pages.forEach(function (page) {
        if (!page || !page.items) return;
        page.items.forEach(function (item) {
          if (!item.fullName || !item.id) return;
          var key = normalizeName(item.fullName);
          if (!key) return;
          var existing = index.get(key);
          // prefer active players when a name collides
          if (!existing || (item.active && !existing._active)) {
            index.set(key, item.id);
            if (item.active) index.set(key + '__active', true);
          }
        });
      });
      espn.index = index;
      return index;
    });
    return espn.promise;
  }
  // kick off in the background so it's likely ready by the time rows scroll into view
  loadEspnIndex();

  function headshotUrlForId(id) {
    return 'https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/' + id + '.png&w=350&h=254';
  }

  function teamLogoUrl(team) {
    return 'https://a.espncdn.com/i/teamlogos/nfl/500/' + team.toLowerCase() + '.png';
  }

  function initials(name) {
    var parts = String(name || '').replace(/[^a-zA-Z' -]/g, '').split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function showFallback(wrapEl) {
    var img = wrapEl.querySelector('img');
    if (img) img.classList.add('hidden');
    if (!wrapEl.querySelector('.avatar-fallback')) {
      var fb = document.createElement('div');
      fb.className = 'avatar-fallback';
      fb.textContent = initials(wrapEl.getAttribute('data-name'));
      wrapEl.appendChild(fb);
    }
  }

  function resolvePhoto(wrapEl) {
    var name = wrapEl.getAttribute('data-name');
    loadEspnIndex().then(function (index) {
      var id = index.get(normalizeName(name));
      var img = wrapEl.querySelector('img');
      if (!id) {
        showFallback(wrapEl);
        return;
      }
      img.onerror = function () { showFallback(wrapEl); };
      img.onload = function () { img.classList.remove('hidden'); };
      img.src = headshotUrlForId(id);
    }).catch(function () { showFallback(wrapEl); });
  }

  // One IntersectionObserver instance per page (pass it into buildAvatarWrap).
  function createPhotoObserver() {
    var observer = ('IntersectionObserver' in window) ? new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        resolvePhoto(entry.target);
      });
    }, { rootMargin: '250px 0px' }) : null;
    return observer;
  }

  // Builds the `.avatar-wrap` element for a player (team logo for D/ST,
  // lazily-resolved ESPN headshot for everyone else) and kicks off loading.
  function buildAvatarWrap(p, observer) {
    var wrap = document.createElement('div');
    wrap.className = 'avatar-wrap' + (p.isTeamLogo ? ' logo' : '');
    wrap.setAttribute('data-name', p.name);
    var img = document.createElement('img');
    img.alt = '';
    img.loading = 'lazy';
    wrap.appendChild(img);

    if (p.isTeamLogo) {
      img.onerror = function () { showFallback(wrap); };
      img.src = teamLogoUrl(p.team);
    } else if (observer) {
      observer.observe(wrap);
    } else {
      resolvePhoto(wrap);
    }
    return wrap;
  }

  window.PlayerRender = {
    TIERS: TIERS,
    tierFor: tierFor,
    posLabel: posLabel,
    fmt: fmt,
    fmtPoints: fmtPoints,
    normalizeName: normalizeName,
    loadEspnIndex: loadEspnIndex,
    headshotUrlForId: headshotUrlForId,
    teamLogoUrl: teamLogoUrl,
    initials: initials,
    showFallback: showFallback,
    resolvePhoto: resolvePhoto,
    createPhotoObserver: createPhotoObserver,
    buildAvatarWrap: buildAvatarWrap
  };
})();
