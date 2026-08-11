// Reusable multi-select player search widget (search box + dropdown
// matches + removable chips), backed by window.__PLAYERS__ /
// window.playerKey from js/players-data.js. Used by Expert Reviews'
// Trade Analysis and Start/Sit forms, and the Trade Analyzer,
// wherever the spec calls for "similar to the trade analyzer" player
// selection. Shows each player's photo and a position-colored pill
// (via js/player-render.js, if loaded) so results/chips are never
// just bare text.
(function () {
  var photoObserver = (window.PlayerRender && window.PlayerRender.createPhotoObserver) ? window.PlayerRender.createPhotoObserver() : null;

  function buildAvatar(p) {
    if (window.PlayerRender) return window.PlayerRender.buildAvatarWrap(p, photoObserver);
    var div = document.createElement('div');
    div.className = 'pp-avatar';
    return div;
  }

  function buildPosPill(pos) {
    var pill = document.createElement('span');
    pill.className = 'pp-pos-pill pos-' + pos;
    pill.textContent = pos === 'DST' ? 'D/ST' : pos;
    return pill;
  }

  function create(container, options) {
    options = options || {};
    var min = options.min || 0;
    var max = options.max || Infinity;
    var selected = (options.initial || []).slice();
    var onChange = options.onChange || function () {};
    var playersByKey = {};
    window.__PLAYERS__.forEach(function (p) { playersByKey[window.playerKey(p)] = p; });

    container.innerHTML =
      '<div class="player-picker">' +
        '<input class="player-picker-input" type="text" placeholder="Search a player&hellip;" autocomplete="off">' +
        '<div class="player-picker-results"></div>' +
        '<div class="player-picker-chips"></div>' +
      '</div>';

    var input = container.querySelector('.player-picker-input');
    var results = container.querySelector('.player-picker-results');
    var chips = container.querySelector('.player-picker-chips');

    function renderChips() {
      chips.innerHTML = '';
      selected.forEach(function (key) {
        var p = playersByKey[key];
        if (!p) return;
        var chip = document.createElement('span');
        chip.className = 'player-chip';
        var info = document.createElement('span');
        info.className = 'player-chip-info';
        info.appendChild(buildAvatar(p));
        info.appendChild(document.createTextNode(p.name + ' · ' + p.team));
        info.appendChild(buildPosPill(p.pos));
        if (window.PlayerDetail) {
          info.style.cursor = 'pointer';
          info.addEventListener('click', function () { window.PlayerDetail.open(p); });
        }
        chip.appendChild(info);
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'player-chip-remove';
        x.textContent = '×';
        x.addEventListener('click', function () {
          selected = selected.filter(function (k) { return k !== key; });
          renderChips();
          onChange(selected.slice());
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
    }

    function renderResults(query) {
      results.innerHTML = '';
      if (!query || selected.length >= max) { results.classList.remove('show'); return; }
      var q = query.toLowerCase();
      var matches = window.__PLAYERS__.filter(function (p) {
        return selected.indexOf(window.playerKey(p)) === -1 && p.name.toLowerCase().indexOf(q) !== -1;
      }).slice(0, 8);
      if (!matches.length) { results.classList.remove('show'); return; }
      matches.forEach(function (p) {
        var key = window.playerKey(p);
        var item = document.createElement('div');
        item.className = 'player-picker-item';
        item.appendChild(buildAvatar(p));
        var label = document.createElement('span');
        label.textContent = p.name + ' · ' + p.team;
        item.appendChild(label);
        item.appendChild(buildPosPill(p.pos));
        item.addEventListener('mousedown', function (e) {
          e.preventDefault();
          if (selected.length >= max) return;
          selected.push(key);
          input.value = '';
          results.innerHTML = '';
          results.classList.remove('show');
          renderChips();
          onChange(selected.slice());
        });
        results.appendChild(item);
      });
      results.classList.add('show');
    }

    input.addEventListener('input', function () { renderResults(input.value.trim()); });
    input.addEventListener('blur', function () { results.classList.remove('show'); });

    renderChips();

    return {
      getSelected: function () { return selected.slice(); },
      isValid: function () { return selected.length >= min && selected.length <= max; }
    };
  }

  window.PlayerPicker = { create: create };
})();
