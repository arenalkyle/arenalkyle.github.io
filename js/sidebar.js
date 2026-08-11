// Populates <aside class="sidebar" id="sidebar"></aside>. Requires
// auth.js to already be loaded (uses window.Auth for the admin-only link).
(function () {
  var ICONS = {
    board: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v6c0 5 3.8 8.7 9 9 5.2-.3 9-4 9-9V7l-9-5z"></path></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><path d="M14 2v6h6"></path><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="16" y2="17"></line></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3 21 7l-4 4"></path><path d="M21 7H9a4 4 0 0 0-4 4"></path><path d="M7 21 3 17l4-4"></path><path d="M3 17h12a4 4 0 0 0 4-4"></path></svg>',
    posts: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="14" rx="2"></rect><line x1="7" y1="9" x2="17" y2="9"></line><line x1="7" y1="13" x2="13" y2="13"></line></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 18h16l1.4-8.5-4.9 3-3.5-6-3.5 6-4.9-3L4 18z"></path></svg>'
  };

  var LINKS = [
    { href: 'index.html', label: 'Rankings', icon: ICONS.board },
    { href: 'rankings-editor.html', label: 'Create/Edit Rankings', icon: ICONS.edit },
    { href: 'my-teams.html', label: 'My Teams', icon: ICONS.users },
    { href: 'trade-analyzer.html', label: 'Trade Analyzer', icon: ICONS.swap },
    { href: 'expert-reviews.html', label: 'Expert Reviews', icon: ICONS.star },
    { href: 'posts.html', label: 'Posts', icon: ICONS.posts },
    { href: 'subscriptions.html', label: 'Subscriptions', icon: ICONS.crown }
  ];

  function currentPage() {
    var p = window.location.pathname.split('/').pop();
    return p || 'index.html';
  }

  function render() {
    var el = document.getElementById('sidebar');
    if (!el) return;
    var page = currentPage();
    var html = '<div class="sidebar-brand">The Board</div>';
    html += '<div class="sidebar-section-label">Menu</div>';
    LINKS.forEach(function (link) {
      html += '<a class="sidebar-link' + (page === link.href ? ' active' : '') + '" href="' + link.href + '">' + link.icon + '<span>' + link.label + '</span></a>';
    });
    if (window.Auth && (window.Auth.can('view_admin_panel') || window.Auth.can('manage_expert_reviews'))) {
      html += '<div class="sidebar-section-label">Admin</div>';
      if (window.Auth.can('view_admin_panel')) {
        html += '<a class="sidebar-link' + (page === 'admin.html' ? ' active' : '') + '" href="admin.html">' + ICONS.admin + '<span>Admin Panel</span></a>';
      }
      if (window.Auth.can('manage_expert_reviews')) {
        html += '<a class="sidebar-link' + (page === 'expert-reviews-log.html' ? ' active' : '') + '" href="expert-reviews-log.html">' + ICONS.log + '<span>Review Log</span></a>';
      }
    }
    el.innerHTML = html;
  }

  render();
  window.addEventListener('auth:change', render);
})();
