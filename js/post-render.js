// Shared Markdown + embed rendering for Posts: turns a post body
// (Markdown, written in posts.html's editor) into sanitized HTML with
// three extra things Markdown alone doesn't give us -- used by both
// the editor's live preview pane and the published post detail view,
// so they can never visually drift apart (same pattern as
// js/player-render.js for player rows).
//
//   1. A bare YouTube link on its own line becomes an inline embedded
//      player instead of a plain hyperlink.
//   2. {{player:Full Name}} becomes a compact player "card" (photo +
//      name + team/pos/PPG), looked up from window.__PLAYERS__
//      (js/players-data.js) and clickable into the full player detail
//      modal (js/player-detail.js) via hydrate() below.
//   3. Everything else -- bold/italic, headings, links, images (incl.
//      gifs, which are just images), lists, blockquotes -- is plain
//      Markdown via marked.js, then run through DOMPurify.
//
// Post bodies are only ever written by editor/admin accounts (RLS
// 'create_posts' in supabase/schema.sql), so this isn't defending
// against a hostile public author -- DOMPurify is here as cheap
// defense-in-depth against a stray pasted <script> making it into a
// rendered page, not a hard trust boundary.
(function () {
  var YOUTUBE_RE = /(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([\w-]{6,})/i;

  function youtubeEmbedUrl(url) {
    var m = String(url || '').match(YOUTUBE_RE);
    return m ? ('https://www.youtube.com/embed/' + m[1]) : null;
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function findPlayer(name) {
    var players = window.__PLAYERS__ || [];
    var norm = String(name || '').trim().toLowerCase();
    return players.find(function (p) { return p.name.toLowerCase() === norm; }) || null;
  }

  function buildPlayerCardHtml(name) {
    var p = findPlayer(name);
    if (!p) return '<div class="pc-card pc-missing">Player not found: ' + escapeHtml(name) + '</div>';
    var pos = p.pos === 'DST' ? 'D/ST' : p.pos;
    var posColor = window.PlayerRender ? window.PlayerRender.posColor(p.pos) : 'inherit';
    var ppg = p.ppg25 || 0;
    return '' +
      '<div class="pc-card" data-player-key="' + escapeHtml(window.playerKey(p)) + '">' +
        '<div class="pc-avatar-slot" data-player-name="' + escapeHtml(p.name) + '"></div>' +
        '<div class="pc-info">' +
          '<div class="pc-name">' + escapeHtml(p.name) + '</div>' +
          '<div class="pc-meta"><span style="color:' + posColor + ';font-weight:700">' + escapeHtml(pos) + '</span> &middot; ' + escapeHtml(p.team) + (ppg > 0 ? ' &middot; ' + ppg.toFixed(1) + ' PPG' : '') + '</div>' +
        '</div>' +
      '</div>';
  }

  function buildYoutubeEmbedHtml(url) {
    var embed = youtubeEmbedUrl(url);
    if (!embed) return '';
    return '<div class="post-inline-video"><iframe src="' + embed + '" allowfullscreen loading="lazy"></iframe></div>';
  }

  // Renders Markdown + the extras above into sanitized HTML.
  function render(bodyMarkdown) {
    var text = String(bodyMarkdown || '');
    var stashed = [];
    var nonce = 'pr' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    function stash(html) {
      var token = nonce + stashed.length + nonce;
      stashed.push(html);
      return token;
    }

    text = text.replace(/\{\{\s*player\s*:\s*([^}]+?)\s*\}\}/gi, function (_, name) {
      return stash(buildPlayerCardHtml(name));
    });

    text = text.split('\n').map(function (line) {
      var trimmed = line.trim();
      if (trimmed && !/\s/.test(trimmed) && youtubeEmbedUrl(trimmed)) {
        return stash(buildYoutubeEmbedHtml(trimmed));
      }
      return line;
    }).join('\n');

    var html;
    if (window.marked) {
      html = window.marked.parse(text, { breaks: true, gfm: true });
    } else {
      html = '<p>' + escapeHtml(text).replace(/\n\n+/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
    }

    if (window.DOMPurify) {
      html = window.DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
    }

    stashed.forEach(function (embedHtml, i) {
      var token = nonce + i + nonce;
      html = html.split('<p>' + token + '</p>').join(embedHtml);
      html = html.split(token).join(embedHtml);
    });

    return html;
  }

  // Wires up player cards inside a rendered container: draws each
  // avatar (needs js/player-render.js) and makes cards clickable into
  // the full player detail modal (needs js/player-detail.js). Safe to
  // call even if neither is loaded -- it just no-ops.
  function hydrate(container) {
    if (!container) return;
    var players = window.__PLAYERS__ || [];
    if (window.PlayerRender) {
      container.querySelectorAll('.pc-avatar-slot').forEach(function (slot) {
        if (slot.childElementCount) return;
        var name = slot.getAttribute('data-player-name');
        var p = players.find(function (x) { return x.name === name; });
        if (p) slot.appendChild(window.PlayerRender.buildAvatarWrap(p, null));
      });
    }
    if (window.PlayerDetail) {
      container.querySelectorAll('.pc-card[data-player-key]').forEach(function (card) {
        if (card.classList.contains('pc-missing') || card._pcWired) return;
        card._pcWired = true;
        card.style.cursor = 'pointer';
        card.addEventListener('click', function () {
          var key = card.getAttribute('data-player-key');
          var p = players.find(function (x) { return window.playerKey(x) === key; });
          if (p) window.PlayerDetail.open(p);
        });
      });
    }
  }

  window.PostRender = { render: render, hydrate: hydrate, youtubeEmbedUrl: youtubeEmbedUrl };
})();
