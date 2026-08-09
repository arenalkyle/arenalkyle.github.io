// Populates <aside class="sidebar" id="sidebar"></aside>. Requires
// auth.js to already be loaded (uses window.Auth for the admin-only link).
(function () {
  var ICONS = {
    board: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>',
    edit: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>',
    admin: '<svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2 3 7v6c0 5 3.8 8.7 9 9 5.2-.3 9-4 9-9V7l-9-5z"></path></svg>'
  };

  var LINKS = [
    { href: 'index.html', label: 'Rankings', icon: ICONS.board },
    { href: 'rankings-editor.html', label: 'Create/Edit Rankings', icon: ICONS.edit }
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
    if (window.Auth && window.Auth.can('view_admin_panel')) {
      html += '<div class="sidebar-section-label">Admin</div>';
      html += '<a class="sidebar-link' + (page === 'admin.html' ? ' active' : '') + '" href="admin.html">' + ICONS.admin + '<span>Admin Panel</span></a>';
    }
    el.innerHTML = html;
  }

  render();
  window.addEventListener('auth:change', render);
})();
