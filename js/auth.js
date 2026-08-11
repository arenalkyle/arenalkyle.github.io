// Shared auth chrome: top-right login/account box + the login/signup
// modal. Injects its own markup so every page just needs:
//   <div id="authBox"></div>  in the topbar
// and to load supabase-client.js + this file after it.
//
// Public API: window.Auth = { ready, user, profile, permissions,
// can(key), openLogin(), openSignup(), logout() }. Fires a
// window 'auth:change' CustomEvent whenever sign-in state changes.
(function () {
  var GOOGLE_ICON = '<svg viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.9-2.26 5.36-4.78 7.02l7.73 6c4.51-4.18 7.09-10.36 7.09-17.49z"/><path fill="#FBBC05" d="M10.53 28.59A14.5 14.5 0 0 1 9.5 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.94 23.94 0 0 0 0 24c0 3.86.92 7.51 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.9-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.17 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.97 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';
  var BELL_ICON = '<svg viewBox="0 0 24 24"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

  var els = {};
  var state = { user: null, profile: null, permissions: new Set(), notifications: [], turnstileToken: null, turnstileWidgetId: null };
  var lockTimer = null;

  function injectMarkup() {
    var modal = document.createElement('div');
    modal.className = 'modal-backdrop';
    modal.id = 'authModal';
    modal.innerHTML =
      '<div class="modal-box" id="authModalBox">' +
        '<button class="modal-back" id="authBack" aria-label="Back">&#8592;</button>' +
        '<button class="modal-close" id="authClose" aria-label="Close">&times;</button>' +
        '<div id="authViewLogin">' +
          '<h2 class="modal-title">Log In</h2>' +
          '<div class="modal-field">' +
            '<label>Username</label>' +
            '<input type="text" id="loginIdentifier" autocomplete="username">' +
            '<div class="field-error" id="loginIdentifierError"></div>' +
          '</div>' +
          '<div class="modal-field">' +
            '<label>Password</label>' +
            '<input type="password" id="loginPassword" autocomplete="current-password">' +
            '<div class="field-error" id="loginPasswordError"></div>' +
          '</div>' +
          '<button class="modal-submit" id="loginSubmit">Sign In</button>' +
          '<div class="modal-divider">or</div>' +
          '<button class="google-btn" id="loginGoogle">' + GOOGLE_ICON + '<span>Sign in with Google</span></button>' +
          '<button class="modal-footer-link" id="gotoSignup">Create an account</button>' +
        '</div>' +
        '<div id="authViewSignup" style="display:none">' +
          '<h2 class="modal-title">Create Account</h2>' +
          '<div class="modal-field">' +
            '<label>Email</label>' +
            '<input type="email" id="signupEmail" autocomplete="email">' +
            '<div class="field-error" id="signupEmailError"></div>' +
          '</div>' +
          '<div class="modal-field">' +
            '<label>Username</label>' +
            '<input type="text" id="signupUsername" autocomplete="username">' +
            '<div class="field-error" id="signupUsernameError"></div>' +
          '</div>' +
          '<div class="modal-field">' +
            '<label>Password</label>' +
            '<input type="password" id="signupPassword" autocomplete="new-password">' +
            '<div class="field-error" id="signupPasswordError"></div>' +
          '</div>' +
          '<div class="modal-field">' +
            '<label>Re-type Password</label>' +
            '<input type="password" id="signupPassword2" autocomplete="new-password">' +
            '<div class="field-error" id="signupPassword2Error"></div>' +
          '</div>' +
          '<div class="captcha-row" id="turnstileContainer"></div>' +
          '<button class="modal-submit" id="signupSubmit" disabled>Create Account</button>' +
          '<div class="modal-msg" id="signupMsg"></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    els.modal = modal;
    els.box = document.getElementById('authModalBox');
    els.back = document.getElementById('authBack');
    els.close = document.getElementById('authClose');
    els.viewLogin = document.getElementById('authViewLogin');
    els.viewSignup = document.getElementById('authViewSignup');

    els.loginIdentifier = document.getElementById('loginIdentifier');
    els.loginIdentifierError = document.getElementById('loginIdentifierError');
    els.loginPassword = document.getElementById('loginPassword');
    els.loginPasswordError = document.getElementById('loginPasswordError');
    els.loginSubmit = document.getElementById('loginSubmit');
    els.loginGoogle = document.getElementById('loginGoogle');
    els.gotoSignup = document.getElementById('gotoSignup');

    els.signupEmail = document.getElementById('signupEmail');
    els.signupEmailError = document.getElementById('signupEmailError');
    els.signupUsername = document.getElementById('signupUsername');
    els.signupUsernameError = document.getElementById('signupUsernameError');
    els.signupPassword = document.getElementById('signupPassword');
    els.signupPasswordError = document.getElementById('signupPasswordError');
    els.signupPassword2 = document.getElementById('signupPassword2');
    els.signupPassword2Error = document.getElementById('signupPassword2Error');
    els.signupSubmit = document.getElementById('signupSubmit');
    els.signupMsg = document.getElementById('signupMsg');
    els.turnstileContainer = document.getElementById('turnstileContainer');
  }

  function clearErrors() {
    ['loginIdentifierError', 'loginPasswordError', 'signupEmailError', 'signupUsernameError',
      'signupPasswordError', 'signupPassword2Error'].forEach(function (id) {
      els[id].textContent = '';
      els[id].classList.remove('show');
    });
    els.signupMsg.textContent = '';
    if (lockTimer) { clearInterval(lockTimer); lockTimer = null; }
    els.loginSubmit.disabled = false;
    els.loginSubmit.textContent = 'Sign In';
  }

  function showError(id, msg) {
    els[id].textContent = msg;
    els[id].classList.add('show');
  }

  function showLoginView() {
    clearErrors();
    els.box.classList.remove('signup-view');
    els.viewLogin.style.display = '';
    els.viewSignup.style.display = 'none';
  }

  function showSignupView() {
    clearErrors();
    els.box.classList.add('signup-view');
    els.viewLogin.style.display = 'none';
    els.viewSignup.style.display = '';
    renderTurnstile();
  }

  function openModal() {
    els.modal.classList.add('open');
    showLoginView();
  }

  function closeModal() {
    els.modal.classList.remove('open');
    els.loginIdentifier.value = '';
    els.loginPassword.value = '';
  }

  function renderTurnstile() {
    if (!window.turnstile || !els.turnstileContainer) return;
    els.turnstileContainer.innerHTML = '';
    state.turnstileToken = null;
    els.signupSubmit.disabled = true;
    state.turnstileWidgetId = window.turnstile.render(els.turnstileContainer, {
      sitekey: window.APP_CONFIG.TURNSTILE_SITE_KEY,
      theme: 'dark',
      callback: function (token) { state.turnstileToken = token; els.signupSubmit.disabled = false; },
      'expired-callback': function () { state.turnstileToken = null; els.signupSubmit.disabled = true; },
      'error-callback': function () { state.turnstileToken = null; els.signupSubmit.disabled = true; }
    });
  }

  // ---------------- Login ----------------
  function startLockCountdown(seconds) {
    var remaining = seconds;
    els.loginSubmit.disabled = true;
    function tick() {
      if (remaining <= 0) {
        clearInterval(lockTimer);
        lockTimer = null;
        els.loginSubmit.disabled = false;
        els.loginSubmit.textContent = 'Sign In';
        showError('loginPasswordError', '');
        els.loginPasswordError.classList.remove('show');
        return;
      }
      var m = Math.floor(remaining / 60), s = remaining % 60;
      els.loginSubmit.textContent = 'Locked (' + m + ':' + (s < 10 ? '0' : '') + s + ')';
      remaining--;
    }
    tick();
    lockTimer = setInterval(tick, 1000);
  }

  function doLogin() {
    clearErrors();
    var identifier = els.loginIdentifier.value.trim();
    var password = els.loginPassword.value;
    if (!identifier) { showError('loginIdentifierError', "We couldn't find an account with that username or email."); return; }
    if (!password) { showError('loginPasswordError', 'Enter your password.'); return; }

    els.loginSubmit.disabled = true;
    els.loginSubmit.textContent = 'Signing in…';

    fetch(window.APP_CONFIG.LOGIN_FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: identifier, password: password })
    }).then(function (r) { return r.json().then(function (body) { return { status: r.status, body: body }; }); })
      .then(function (res) {
        if (res.status === 200) {
          return window.sb.auth.setSession({
            access_token: res.body.session.access_token,
            refresh_token: res.body.session.refresh_token
          }).then(function () { closeModal(); });
        }
        els.loginSubmit.disabled = false;
        els.loginSubmit.textContent = 'Sign In';
        if (res.status === 404) {
          showError('loginIdentifierError', "We couldn't find an account with that username or email.");
        } else if (res.status === 401) {
          showError('loginPasswordError', 'That password is incorrect.');
        } else if (res.status === 423) {
          showError('loginPasswordError', 'Too many attempts from this network. Try again in the time shown below.');
          startLockCountdown(res.body.retryAfterSeconds || 600);
        } else {
          showError('loginPasswordError', 'Something went wrong. Please try again.');
        }
      })
      .catch(function () {
        els.loginSubmit.disabled = false;
        els.loginSubmit.textContent = 'Sign In';
        showError('loginPasswordError', 'Something went wrong. Please try again.');
      });
  }

  function doGoogle() {
    window.sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: window.location.href } });
  }

  // ---------------- Sign up ----------------
  function doSignup() {
    clearErrors();
    var email = els.signupEmail.value.trim();
    var username = els.signupUsername.value.trim();
    var password = els.signupPassword.value;
    var password2 = els.signupPassword2.value;
    var ok = true;

    if (!email || email.indexOf('@') === -1) { showError('signupEmailError', 'Enter a valid email address.'); ok = false; }
    if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
      showError('signupUsernameError', '3-20 characters: letters, numbers, underscore only.');
      ok = false;
    }
    if (password.length < 8) { showError('signupPasswordError', 'Use at least 8 characters.'); ok = false; }
    if (password !== password2) { showError('signupPassword2Error', 'Passwords do not match.'); ok = false; }
    if (!state.turnstileToken) { els.signupMsg.textContent = 'Please complete the captcha.'; ok = false; }
    if (!ok) return;

    els.signupSubmit.disabled = true;
    els.signupSubmit.textContent = 'Creating…';

    window.sb.rpc('is_username_available', { check_username: username }).then(function (res) {
      if (res.error) throw res.error;
      if (!res.data) {
        showError('signupUsernameError', 'That username is already taken.');
        els.signupSubmit.disabled = false;
        els.signupSubmit.textContent = 'Create Account';
        return null;
      }
      return window.sb.auth.signUp({
        email: email,
        password: password,
        options: { data: { username: username }, captchaToken: state.turnstileToken }
      });
    }).then(function (signUpRes) {
      if (!signUpRes) return;
      els.signupSubmit.disabled = false;
      els.signupSubmit.textContent = 'Create Account';
      if (signUpRes.error) {
        var msg = signUpRes.error.message || 'Could not create account.';
        if (/registered|exists/i.test(msg)) showError('signupEmailError', 'An account with that email already exists.');
        else els.signupMsg.textContent = msg;
        if (window.turnstile && state.turnstileWidgetId != null) window.turnstile.reset(state.turnstileWidgetId);
        state.turnstileToken = null;
        return;
      }
      if (signUpRes.data.session) {
        closeModal();
      } else {
        els.signupMsg.textContent = 'Check your email to confirm your account, then log in.';
      }
    }).catch(function (err) {
      els.signupSubmit.disabled = false;
      els.signupSubmit.textContent = 'Create Account';
      els.signupMsg.textContent = (err && err.message) || 'Something went wrong. Please try again.';
    });
  }

  // ---------------- Top bar chrome ----------------
  function initials(name) {
    var parts = String(name || '').replace(/[^a-zA-Z0-9 ]/g, '').split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function fmtNotifTime(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  function renderNotifPanel(panel) {
    if (!state.notifications.length) {
      panel.innerHTML = '<div class="notif-panel-empty">No notifications yet.</div>';
      return;
    }
    panel.innerHTML = '';
    state.notifications.forEach(function (n) {
      var item = document.createElement('a');
      item.className = 'notif-item' + (n.read ? '' : ' unread');
      item.href = n.link || '#';
      item.innerHTML =
        '<div class="notif-item-title">' + n.title + '</div>' +
        (n.body ? '<div class="notif-item-body">' + n.body + '</div>' : '') +
        '<div class="notif-item-time">' + fmtNotifTime(n.created_at) + '</div>';
      item.addEventListener('click', function () {
        if (!n.read) window.Auth.markNotificationRead(n.id);
      });
      panel.appendChild(item);
    });
  }

  function renderAuthBox() {
    var containers = document.querySelectorAll('#authBox');
    containers.forEach(function (box) {
      if (!state.user) {
        box.innerHTML = '<button class="login-btn openLoginBtn">Login</button>';
        box.querySelector('.openLoginBtn').addEventListener('click', openModal);
        return;
      }
      var name = (state.profile && (state.profile.display_name || state.profile.username)) || state.user.email || 'Account';
      var avatarUrl = state.profile && state.profile.avatar_url;
      var role = state.profile && state.profile.role;
      var avatarHtml = avatarUrl
        ? '<img src="' + avatarUrl + '" alt="">'
        : '<span class="avatar-fallback">' + initials(name) + '</span>';
      var badgeHtml = (role && role !== 'user') ? '<span class="role-badge">' + role + '</span>' : '';
      var hasUnread = state.notifications.some(function (n) { return !n.read; });
      box.innerHTML =
        '<div class="auth-box">' +
          '<button class="notif-bell' + (hasUnread ? ' has-unread' : '') + '" aria-label="Notifications">' +
            BELL_ICON + '<span class="notif-bell-dot"></span>' +
          '</button>' +
          '<div class="notif-panel"></div>' +
          '<div class="account-chip" tabindex="0">' +
            '<span class="account-avatar">' + avatarHtml + '</span>' +
            '<span>' + name + '</span>' + badgeHtml +
          '</div>' +
          '<div class="account-menu">' +
            (state.permissions.has('view_admin_panel') ? '<button class="menuAdmin">Admin Panel</button>' : '') +
            '<button class="menuEditProfile">Edit Profile</button>' +
            '<button class="menuProfile">Create/Edit Rankings</button>' +
            '<button class="menuLogout">Log Out</button>' +
          '</div>' +
        '</div>';
      var chip = box.querySelector('.account-chip');
      var menu = box.querySelector('.account-menu');
      var bell = box.querySelector('.notif-bell');
      var notifPanel = box.querySelector('.notif-panel');
      renderNotifPanel(notifPanel);
      chip.addEventListener('click', function (e) { e.stopPropagation(); notifPanel.classList.remove('open'); menu.classList.toggle('open'); });
      bell.addEventListener('click', function (e) { e.stopPropagation(); menu.classList.remove('open'); notifPanel.classList.toggle('open'); });
      var adminBtn = box.querySelector('.menuAdmin');
      if (adminBtn) adminBtn.addEventListener('click', function () { window.location.href = 'admin.html'; });
      box.querySelector('.menuEditProfile').addEventListener('click', function () { window.location.href = 'profile.html'; });
      box.querySelector('.menuProfile').addEventListener('click', function () { window.location.href = 'rankings-editor.html'; });
      box.querySelector('.menuLogout').addEventListener('click', function () { window.Auth.logout(); });
    });
  }

  document.addEventListener('click', function () {
    document.querySelectorAll('.account-menu.open').forEach(function (m) { m.classList.remove('open'); });
    document.querySelectorAll('.notif-panel.open').forEach(function (m) { m.classList.remove('open'); });
  });

  // ---------------- Session / permissions ----------------
  function loadProfileAndPermissions(user) {
    if (!user) {
      state.profile = null;
      state.permissions = new Set();
      return Promise.resolve();
    }
    return window.sb.from('profiles').select('*').eq('id', user.id).single().then(function (res) {
      state.profile = res.data || null;
      if (!state.profile || !state.profile.role) { state.permissions = new Set(); return; }
      return window.sb.from('role_permissions').select('permission_key,allowed')
        .eq('role', state.profile.role).eq('allowed', true).then(function (permRes) {
          state.permissions = new Set((permRes.data || []).map(function (r) { return r.permission_key; }));
        });
    });
  }

  function loadNotifications(user) {
    if (!user) { state.notifications = []; return Promise.resolve(); }
    return window.sb.from('notifications').select('*').eq('user_id', user.id)
      .order('created_at', { ascending: false }).limit(20).then(function (res) {
        state.notifications = res.data || [];
      });
  }

  function refresh(user) {
    state.user = user || null;
    return Promise.all([loadProfileAndPermissions(state.user), loadNotifications(state.user)]).then(function () {
      renderAuthBox();
      window.dispatchEvent(new CustomEvent('auth:change', { detail: { user: state.user, profile: state.profile } }));
    });
  }

  injectMarkup();

  els.close.addEventListener('click', closeModal);
  els.modal.addEventListener('click', function (e) { if (e.target === els.modal) closeModal(); });
  els.back.addEventListener('click', showLoginView);
  els.gotoSignup.addEventListener('click', showSignupView);
  els.loginSubmit.addEventListener('click', doLogin);
  els.loginGoogle.addEventListener('click', doGoogle);
  els.signupSubmit.addEventListener('click', doSignup);
  els.loginPassword.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });
  els.loginIdentifier.addEventListener('keydown', function (e) { if (e.key === 'Enter') doLogin(); });

  var ready = window.sb.auth.getSession().then(function (res) {
    return refresh(res.data.session ? res.data.session.user : null);
  });

  window.sb.auth.onAuthStateChange(function (_event, session) {
    refresh(session ? session.user : null);
  });

  window.Auth = {
    ready: ready,
    can: function (key) { return state.permissions.has(key); },
    openLogin: openModal,
    openSignup: function () { openModal(); showSignupView(); },
    refreshProfile: function () { return refresh(state.user); },
    markNotificationRead: function (id) {
      var n = state.notifications.find(function (x) { return x.id === id; });
      if (n) n.read = true;
      renderAuthBox();
      return window.sb.from('notifications').update({ read: true }).eq('id', id);
    },
    logout: function () {
      return window.sb.auth.signOut();
    },
    get user() { return state.user; },
    get profile() { return state.profile; },
    get notifications() { return state.notifications.slice(); }
  };
})();
