/* ==========================================================================
   GrantGlide: ScholarQuest — single script (single-page app)
   Sections:
     1. Helpers
     2. ApiClient      (fetch wrapper: JWT + CSRF + errors)
     3. Auth           (session handling)
     4. Toast
     5. Shell          (sidebar / top bar / socket.io)
     6. Router         (hash-based: #/login, #/dashboard, #/scholarship/ID ...)
     7. Pages          (login, register, dashboard, scholarships, details,
                        profile, documents, applications, notifications)
     8. Boot
   ========================================================================== */

/* ---------- 1. Helpers ---------- */
const $ = (id) => document.getElementById(id);

/** Escape server-provided text before putting it into innerHTML. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
const inr = (n) => `₹${Number(n || 0).toLocaleString()}`;
const label = (s) => String(s ?? '').replace(/_/g, ' ');
const daysUntil = (date) => Math.ceil((new Date(date) - new Date()) / (1000 * 60 * 60 * 24));
const val = (id) => $(id).value;
const setVal = (id, v) => { $(id).value = v ?? ''; };

/* ---------- 2. ApiClient ---------- */
class ApiClient {
  /**
   * Where is the backend?
   *  - Page served by the Express backend itself (e.g. http://localhost:5000) -> same origin
   *  - Page opened with VS Code Live Server (e.g. :5500) or file:// -> backend on port 5000
   *  - Different backend port? In the browser console run:
   *      localStorage.setItem('gg_backend_url', 'http://localhost:YOUR_PORT')
   */
  static getBackendOrigin() {
    let override = window.GG_BACKEND_URL;
    try { override = override || localStorage.getItem('gg_backend_url'); } catch (e) {}
    if (override) return String(override).replace(/\/+$/, '');
    const { protocol, hostname, port } = window.location;
    if (protocol === 'file:') return 'http://localhost:5000';
    if (port === '' || port === '5000') return '';
    return `${protocol}//${hostname}:5000`;
  }

  static getBaseUrl() {
    return `${this.getBackendOrigin()}/api/v1`;
  }

  static getCsrfToken() {
    const match = document.cookie.match(new RegExp('(^| )XSRF-TOKEN=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : null;
  }

  static async request(endpoint, options = {}) {
    const url = `${this.getBaseUrl()}${endpoint}`;
    const token = localStorage.getItem('gg_token');

    const headers = { Accept: 'application/json', ...options.headers };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    const csrfToken = this.getCsrfToken();
    if (csrfToken) headers['X-CSRF-Token'] = csrfToken;

    // Do not set Content-Type for FormData (file upload) — the browser adds the boundary
    if (!(options.body instanceof FormData) && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    try {
      let response;
      try {
        response = await fetch(url, { ...options, headers, credentials: 'include' });
      } catch (networkError) {
        const origin = this.getBackendOrigin() || window.location.origin;
        throw new Error(`Cannot reach the backend server at ${origin}. Start it with "npm start" in the project folder, then refresh.`);
      }

      if (response.status === 204) return null;

      const raw = await response.text();
      let json = null;
      try { json = raw ? JSON.parse(raw) : null; } catch (parseError) { json = null; }

      if (!response.ok) {
        if (response.status === 401 && !endpoint.includes('/auth/login')) {
          // Token expired or invalid
          Auth.clearSession();
          if (!['#/login', '#/register'].includes(location.hash)) location.hash = '#/login';
        }
        const where = this.getBackendOrigin() || window.location.origin;
        throw new Error(
          (json && json.message) ||
          `The server at ${where} answered with HTTP ${response.status} and no usable message. ` +
          `Check that "npm start" is running in the project folder and look at its terminal for the error.`
        );
      }

      if (json === null) {
        const where = this.getBackendOrigin() || window.location.origin;
        throw new Error(`${where} did not return JSON. The page may be talking to the wrong server - make sure the backend (npm start) is running on port 5000.`);
      }
      return json;
    } catch (error) {
      console.error(`API Error on [${options.method || 'GET'} ${endpoint}]:`, error);
      throw error;
    }
  }

  /** Ask the backend if it is alive and its database is ready. */
  static async checkHealth() {
    const origin = this.getBackendOrigin();
    const where = origin || window.location.origin;
    let res;
    try {
      res = await fetch(`${origin}/health`, { credentials: 'include' });
    } catch (e) {
      return { ok: false, problem: `The backend server is not running (nothing is answering at ${where}).`, fix: 'Open a terminal in the project folder and run:  npm start   - then refresh this page.' };
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    if (!data || data.status !== 'healthy') {
      return { ok: false, problem: `Something is answering at ${where}, but it is not the GrantGlide backend.`, fix: 'Stop whatever uses that port, or start the backend with:  npm start' };
    }
    if (data.database !== 'ready') {
      return { ok: false, problem: 'The backend is running but the database is not ready: ' + (data.databaseMessage || 'tables are missing.'), fix: 'Stop the server and run:  npx prisma db push   then   npm run seed   then   npm start' };
    }
    if (data.demoUsers === false) {
      return { ok: false, problem: 'The database has no users yet, so the demo logins will not work.', fix: 'Run:  npm run seed   (or just restart with npm start - it seeds an empty database automatically).' };
    }
    return { ok: true };
  }

  /** Show a red banner in the given container when the backend or database has a problem. */
  static async showBackendStatus(containerId) {
    const el = $(containerId);
    if (!el) return;
    const result = await this.checkHealth();
    if (result.ok) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.innerHTML = `<strong>⚠ ${esc(result.problem)}</strong><br><code>${esc(result.fix)}</code>`;
  }

  /** Download an auth-protected file (a plain <a href> can't send the Bearer token). */
  static async download(endpoint, fallbackName = 'download') {
    const token = localStorage.getItem('gg_token');
    let response;
    try {
      response = await fetch(`${this.getBaseUrl()}${endpoint}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        credentials: 'include',
      });
    } catch (e) {
      throw new Error('Cannot reach the backend server. Start it with "npm start" and try again.');
    }
    if (!response.ok) {
      let message = 'Download failed';
      try { message = (await response.json()).message || message; } catch (e) {}
      throw new Error(message);
    }
    const disposition = response.headers.get('Content-Disposition') || '';
    const match = disposition.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i);
    const filename = match ? decodeURIComponent(match[1]) : fallbackName;
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  static get(endpoint, params = null) {
    let url = endpoint;
    if (params) {
      const query = new URLSearchParams(
        Object.entries(params).filter(([, v]) => v !== null && v !== undefined && v !== '')
      ).toString();
      if (query) url += `?${query}`;
    }
    return this.request(url, { method: 'GET' });
  }
  static post(endpoint, body = {}) {
    return this.request(endpoint, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body) });
  }
  static put(endpoint, body = {}) { return this.request(endpoint, { method: 'PUT', body: JSON.stringify(body) }); }
  static patch(endpoint, body = {}) { return this.request(endpoint, { method: 'PATCH', body: JSON.stringify(body) }); }
  static delete(endpoint) { return this.request(endpoint, { method: 'DELETE' }); }
}

/* ---------- 3. Auth ---------- */
const Auth = {
  getUser() {
    try { return JSON.parse(localStorage.getItem('gg_user')); } catch { return null; }
  },
  getToken() { return localStorage.getItem('gg_token'); },
  isAuthenticated() { return !!this.getToken(); },
  setSession(user, token) {
    localStorage.setItem('gg_user', JSON.stringify(user));
    localStorage.setItem('gg_token', token);
  },
  clearSession() {
    localStorage.removeItem('gg_user');
    localStorage.removeItem('gg_token');
  },
  async login(email, password) {
    const res = await ApiClient.post('/auth/login', { email, password });
    if (res && res.data) { this.setSession(res.data.user, res.data.token); return res.data; }
    throw new Error('Login failed');
  },
  async register(data) {
    const res = await ApiClient.post('/auth/register', data);
    if (res && res.data) { this.setSession(res.data.user, res.data.token); return res.data; }
    throw new Error('Registration failed');
  },
  async logout() {
    try { await ApiClient.post('/auth/logout'); } catch (e) { /* ignore network errors on logout */ }
    this.clearSession();
    Shell.disconnectSocket();
    location.hash = '#/login';
  },
};

/* ---------- 4. Toast ---------- */
const Toast = {
  show(message, type = 'info', duration = 3500) {
    const container = $('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;

    const text = document.createElement('span');
    text.textContent = message;
    const close = document.createElement('button');
    close.innerHTML = '&times;';
    close.addEventListener('click', () => toast.remove());
    toast.append(text, close);
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, duration);
  },
  success(msg) { this.show(msg, 'success'); },
  error(msg) { this.show(msg, 'error'); },
  info(msg) { this.show(msg, 'info'); },
};

/* ---------- 5. Shell (sidebar, top bar, real-time socket) ---------- */
const Shell = {
  socket: null,

  render(activeNav) {
    const user = Auth.getUser();
    const firstName = user?.profile?.firstName;
    $('topbar-title').textContent = activeNav.replace(/-/g, ' ');
    $('nav-avatar').textContent = user ? (firstName?.[0] || user.email[0]) : 'U';
    $('nav-username').textContent = user ? (firstName || user.email.split('@')[0]) : 'User';
    $('nav-role').textContent = user ? user.role : 'STUDENT';
    document.querySelectorAll('.sidebar-link').forEach((a) => {
      a.classList.toggle('active', a.dataset.nav === activeNav);
    });
    $('sidebar').classList.remove('open');
  },

  setUnread(count) {
    const badge = $('nav-unread-badge');
    badge.textContent = count;
    badge.style.display = count > 0 ? 'inline-flex' : 'none';
  },

  async refreshUnread() {
    if (!Auth.isAuthenticated()) return;
    try {
      const res = await ApiClient.get('/notifications');
      this.setUnread(res.data?.unreadCount || 0);
    } catch (e) { /* non-critical */ }
  },

  connectSocket() {
    if (this.socket || typeof io === 'undefined' || !Auth.isAuthenticated()) return;
    try {
      this.socket = io(ApiClient.getBackendOrigin() || undefined, { auth: { token: Auth.getToken() } });
      this.socket.on('notification', (data) => {
        Toast.info(`🔔 ${data.title}${data.message ? ': ' + data.message : ''}`);
        this.refreshUnread();
        if (Router.current === 'notifications') Pages.notifications.load();
      });
    } catch (e) {
      console.warn('Socket connection optional in offline environment');
    }
  },

  disconnectSocket() {
    if (this.socket) { this.socket.disconnect(); this.socket = null; }
  },
};

/* ---------- 6. Router (hash based) ---------- */
/**
 * Route table:  hash name -> { view id suffix, auth required?, sidebar highlight, title, loader }
 * #/scholarship/42 uses the "scholarship" route with param "42".
 */
const ROUTES = {
  '':              { view: 'landing',             auth: false, title: 'GrantGlide: ScholarQuest — Intelligent Scholarship Discovery & Matching' },
  login:           { view: 'login',               auth: false, title: 'Log In — GrantGlide: ScholarQuest', onEnter: () => Pages.login.enter() },
  register:        { view: 'register',            auth: false, title: 'Student Registration — GrantGlide: ScholarQuest', onEnter: () => Pages.register.enter() },
  dashboard:       { view: 'dashboard',           auth: true,  nav: 'dashboard',     title: 'Student Dashboard — GrantGlide', onEnter: () => Pages.dashboard.load() },
  scholarships:    { view: 'scholarships',        auth: true,  nav: 'scholarships',  title: 'Scholarship Discovery Engine — GrantGlide', onEnter: () => Pages.scholarships.load(1) },
  scholarship:     { view: 'scholarship-details', auth: true,  nav: 'scholarships',  title: 'Scholarship Details — GrantGlide', onEnter: (id) => Pages.details.load(id) },
  profile:         { view: 'profile',             auth: true,  nav: 'profile',       title: 'Student Profile — GrantGlide', onEnter: () => Pages.profile.load() },
  documents:       { view: 'documents',           auth: true,  nav: 'documents',     title: 'Document Vault & Expiry Tracker — GrantGlide', onEnter: () => Pages.documents.load() },
  applications:    { view: 'applications',        auth: true,  nav: 'applications',  title: 'Application Tracker & History — GrantGlide', onEnter: () => Pages.applications.load() },
  notifications:   { view: 'notifications',       auth: true,  nav: 'notifications', title: 'Notification Center — GrantGlide', onEnter: () => Pages.notifications.load() },
};

/** Convert server-generated links ("/documents.html", "/scholarship-details.html?id=3") to hash routes. */
function linkToHash(link) {
  const m = String(link || '').match(/^\/?([\w-]+)\.html(?:\?id=([^&]+))?/);
  if (!m) return '#/dashboard';
  const [, page, id] = m;
  if (page === 'scholarship-details') return id ? `#/scholarship/${encodeURIComponent(id)}` : '#/scholarships';
  if (page === 'index') return '#/';
  return `#/${page}`;
}

const Router = {
  current: null,

  parse() {
    const path = location.hash.replace(/^#\/?/, '').split('?')[0];
    const [name = '', param = null] = path.split('/').filter(Boolean);
    return { name, param: param ? decodeURIComponent(param) : null };
  },

  go() {
    const { name, param } = this.parse();
    const route = ROUTES[name];

    if (!route) { location.replace(Auth.isAuthenticated() ? '#/dashboard' : '#/'); return; }
    if (route.auth && !Auth.isAuthenticated()) { location.replace('#/login'); return; }
    if ((name === 'login' || name === 'register') && Auth.isAuthenticated()) { location.replace('#/dashboard'); return; }
    if (name === 'scholarship' && !param) { location.replace('#/scholarships'); return; }

    this.current = name;
    document.title = route.title;
    document.querySelectorAll('.view').forEach((v) => v.classList.remove('active'));
    $(`view-${route.view}`).classList.add('active');
    $('public-root').hidden = route.auth;
    $('app-shell').hidden = !route.auth;
    window.scrollTo(0, 0);

    if (route.auth) {
      Shell.render(route.nav);
      Shell.connectSocket();
      if (name !== 'notifications') Shell.refreshUnread();
    }
    if (route.onEnter) route.onEnter(param);
  },
};

/* ---------- 7. Pages ---------- */
const Pages = {};

/* ----- Login ----- */
Pages.login = {
  init() {
    const form = $('login-form');
    const btn = $('login-submit');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        btn.disabled = true;
        btn.textContent = 'Authenticating...';
        await Auth.login(val('login-email').trim(), val('login-password'));
        Toast.success('Login successful! Redirecting...');
        form.reset();
        setTimeout(() => { location.hash = '#/dashboard'; }, 600);
      } catch (err) {
        Toast.error(err.message || 'Login failed. Please check your credentials.');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sign In';
      }
    });

    $('demo-student-btn').addEventListener('click', () => {
      setVal('login-email', 'student@scholarquest.edu');
      setVal('login-password', 'Student@12345');
      form.requestSubmit();
    });
    $('demo-admin-btn').addEventListener('click', () => {
      setVal('login-email', 'admin@grantglide.org');
      setVal('login-password', 'Admin@12345');
      form.requestSubmit();
    });
  },
  enter() { ApiClient.showBackendStatus('login-backend-status'); },
};

/* ----- Register ----- */
Pages.register = {
  init() {
    const btn = $('register-submit');
    $('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        btn.disabled = true;
        btn.textContent = 'Creating Account...';
        await Auth.register({
          firstName: val('reg-firstName').trim(),
          lastName: val('reg-lastName').trim(),
          email: val('reg-email').trim(),
          phone: val('reg-phone').trim(),
          password: val('reg-password'),
          role: 'STUDENT',
        });
        Toast.success('Registration successful! Redirecting to your dashboard...');
        $('register-form').reset();
        setTimeout(() => { location.hash = '#/dashboard'; }, 600);
      } catch (err) {
        Toast.error(err.message || 'Registration failed');
      } finally {
        btn.disabled = false;
        btn.textContent = 'Create Free Account';
      }
    });
  },
  enter() { ApiClient.showBackendStatus('register-backend-status'); },
};

/* ----- Dashboard ----- */
Pages.dashboard = {
  chart: null,

  async load() {
    const user = Auth.getUser();
    if (user?.profile) $('welcome-heading').textContent = `Welcome back, ${user.profile.firstName}!`;

    try {
      // 1. Matching recommendations
      const matchRes = await ApiClient.get('/matching/recommendations');
      const matches = matchRes.data;
      $('stat-matches').textContent = matches.eligibleCount;
      const topMatches = matches.topMatches || [];
      const totalPot = topMatches.reduce((sum, item) => sum + (item.scholarship.awardAmount || 0), 0);
      $('stat-funding').textContent = inr(totalPot);
      this.renderRecommendations(topMatches);

      // 2. Document readiness
      const docRes = await ApiClient.get('/documents/readiness');
      $('stat-readiness').textContent = `${docRes.data.readinessPercentage}%`;
      this.renderReadiness(docRes.data.checklist || []);

      // 3. Applications count
      const appRes = await ApiClient.get('/applications/my');
      $('stat-applications').textContent = (appRes.data || []).length;

      // 4. Financial aid gap
      const finRes = await ApiClient.post('/intelligence/financial-aid-gap', {});
      this.renderFinancialAid(finRes.data);

      // 5. Upcoming deadlines
      const schedRes = await ApiClient.get('/scholarships', { limit: 4, sortBy: 'deadline', sortOrder: 'asc' });
      this.renderDeadlines(schedRes.data || []);
    } catch (err) {
      Toast.error('Failed to load dashboard data: ' + err.message);
    }
  },

  renderRecommendations(list) {
    const el = $('recommendations-container');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state">No matching scholarships found yet. Try completing your academic and family profile!</div>';
      return;
    }
    el.innerHTML = list.map((item) => `
      <div class="item-box row-between">
        <div>
          <div class="flex items-center gap-2" style="margin-bottom: 0.25rem;">
            <span class="badge badge-success">${esc(item.matchScore)}% MATCH</span>
            <span class="badge badge-primary">${esc(item.scholarship.category)}</span>
          </div>
          <h4 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.25rem;">${esc(item.scholarship.title)}</h4>
          <div class="text-secondary" style="font-size: 0.75rem;">
            Provider: ${esc(item.scholarship.provider)} &bull; Award: <strong>${inr(item.scholarship.awardAmount)}</strong> (${esc(item.scholarship.amountType)})
          </div>
          <div style="font-size: 0.75rem; color: #16a34a; margin-top: 0.25rem;">💡 ${esc(item.explanation)}</div>
        </div>
        <div><a href="#/scholarship/${encodeURIComponent(item.scholarship.id)}" class="btn btn-primary btn-sm">View &amp; Apply</a></div>
      </div>`).join('');
  },

  renderFinancialAid(data) {
    if (!data) return;
    $('fin-total-cost').textContent = inr(data.breakdown.totalAnnualExpense);
    $('fin-family-contrib').textContent = inr(data.fundingSources.estimatedFamilyContribution);
    $('fin-secured-aid').textContent = inr(data.fundingSources.securedFunding);
    $('fin-net-gap').textContent = inr(data.netFinancialGap);

    const badge = $('gap-severity-badge');
    badge.textContent = `${data.gapSeverity} GAP`;
    badge.className = `badge ${data.gapSeverity === 'HIGH' ? 'badge-danger' : 'badge-warning'}`;

    if (typeof Chart === 'undefined') return;
    if (this.chart) this.chart.destroy();
    this.chart = new Chart($('financialChart').getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Aid & Family', 'Net Gap'],
        datasets: [{ data: [data.fundingSources.totalCurrentAid, data.netFinancialGap], backgroundColor: ['#10b981', '#ef4444'], borderWidth: 2 }],
      },
      options: { responsive: true, plugins: { legend: { display: false } } },
    });
  },

  renderDeadlines(list) {
    const el = $('deadlines-container');
    if (!list.length) { el.innerHTML = '<div class="text-muted" style="font-size: 0.875rem;">No upcoming deadlines.</div>'; return; }
    el.innerHTML = list.map((s) => {
      const diff = daysUntil(s.deadline);
      const urgent = diff <= 7;
      return `
        <div class="deadline-item ${urgent ? 'urgent' : ''}">
          <a href="#/scholarship/${encodeURIComponent(s.id)}">${esc(s.title)}</a>
          <div class="when">${diff > 0 ? `${diff} days remaining (${new Date(s.deadline).toLocaleDateString()})` : 'Closes today!'}</div>
        </div>`;
    }).join('');
  },

  renderReadiness(checklist) {
    $('readiness-list').innerHTML = checklist.map((item) => `
      <div class="row-between" style="padding: 0.25rem 0;">
        <span class="text-secondary">${esc(label(item.documentType))}</span>
        <span style="font-weight: 600; color: ${item.isReady ? 'var(--success)' : 'var(--danger)'};">${item.isReady ? '✓ Ready' : '✗ Missing'}</span>
      </div>`).join('');
  },
};

/* ----- Scholarship list ----- */
Pages.scholarships = {
  timer: null,

  init() {
    const reload = () => this.load(1);
    ['category-filter', 'gender-filter', 'caste-filter', 'sort-select'].forEach((id) => $(id).addEventListener('change', reload));
    $('search-input').addEventListener('input', () => {
      clearTimeout(this.timer);
      this.timer = setTimeout(reload, 300); // debounce typing
    });
  },

  async load(page = 1) {
    const [sortBy, sortOrder] = val('sort-select').split(':');
    try {
      const res = await ApiClient.get('/scholarships', {
        page, limit: 6,
        search: val('search-input').trim(),
        category: val('category-filter'),
        gender: val('gender-filter'),
        caste: val('caste-filter'),
        sortBy, sortOrder,
      });
      this.render(res.data || []);
      this.renderPagination(res.meta);
      $('results-count').textContent = `Showing ${res.data?.length || 0} of ${res.meta?.totalItems || 0} available scholarships`;
    } catch (err) {
      Toast.error('Failed to load scholarships: ' + err.message);
    }
  },

  render(list) {
    const grid = $('scholarships-grid');
    if (!list.length) {
      grid.innerHTML = '<div class="card empty-state" style="padding: 3rem;">No scholarships found matching your criteria. Try loosening your search filters.</div>';
      return;
    }
    grid.innerHTML = list.map((s) => {
      const daysLeft = daysUntil(s.deadline);
      return `
        <div class="card flex flex-col justify-between">
          <div>
            <div class="row-between mb-1">
              <div class="flex items-center gap-2">
                <span class="badge badge-primary">${esc(s.category)}</span>
                <span class="badge ${daysLeft <= 7 ? 'badge-danger' : 'badge-warning'}">⏱️ ${daysLeft > 0 ? `${daysLeft} Days Left` : 'Deadline Today'}</span>
              </div>
              <div style="font-size: 1.25rem; font-weight: 700; color: var(--primary);">
                ${inr(s.awardAmount)} <span class="text-muted" style="font-size: 0.75rem; font-weight: 400;">/${esc(label(String(s.amountType).toLowerCase()))}</span>
              </div>
            </div>
            <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 0.375rem;">${esc(s.title)}</h3>
            <div class="text-secondary" style="font-size: 0.875rem; margin-bottom: 0.75rem;">Provider: <strong>${esc(s.provider)}</strong></div>
            <p class="text-secondary" style="font-size: 0.875rem; line-height: 1.5; margin-bottom: 1rem;">${esc(s.description)}</p>
            <div class="flex gap-4 text-muted" style="font-size: 0.75rem; border-top: 1px solid var(--border); padding-top: 0.75rem; flex-wrap: wrap;">
              <span>🎓 Min GPA: <strong>${s.minGpa ? `${esc(s.minGpa)} / 10` : 'None'}</strong></span>
              <span>💼 Max Income: <strong>${s.maxIncome ? inr(s.maxIncome) : 'No Limit'}</strong></span>
              <span>🚻 Gender: <strong>${esc(s.eligibleGender)}</strong></span>
              <span>🏛️ States: <strong>${esc(s.eligibleStates)}</strong></span>
            </div>
          </div>
          <div class="row-between" style="margin-top: 1.25rem; padding-top: 0.75rem; border-top: 1px dashed var(--border);">
            <span class="text-muted" style="font-size: 0.75rem;">Deadline: ${new Date(s.deadline).toLocaleDateString()}</span>
            <a href="#/scholarship/${encodeURIComponent(s.id)}" class="btn btn-primary btn-sm">Check Eligibility &amp; Details &rarr;</a>
          </div>
        </div>`;
    }).join('');
  },

  renderPagination(meta) {
    const el = $('pagination-container');
    if (!meta || meta.totalPages <= 1) { el.innerHTML = ''; return; }
    let html = '';
    if (meta.hasPrevPage) html += `<button class="btn btn-secondary btn-sm" data-page="${meta.currentPage - 1}">&larr; Previous</button>`;
    for (let i = 1; i <= meta.totalPages; i++) {
      html += `<button class="btn ${i === meta.currentPage ? 'btn-primary' : 'btn-secondary'} btn-sm" data-page="${i}">${i}</button>`;
    }
    if (meta.hasNextPage) html += `<button class="btn btn-secondary btn-sm" data-page="${meta.currentPage + 1}">Next &rarr;</button>`;
    el.innerHTML = html;
  },
};

/* ----- Scholarship details ----- */
Pages.details = {
  id: null,
  scholarship: null,

  init() {
    $('apply-btn').addEventListener('click', async () => {
      if (!confirm(`Are you sure you want to submit your application for ${this.scholarship?.title}?`)) return;
      const btn = $('apply-btn');
      try {
        btn.disabled = true;
        btn.textContent = 'Submitting Application...';
        const res = await ApiClient.post('/applications', {
          scholarshipId: this.id,
          notes: 'Submitted via ScholarQuest Intelligent Matching Portal',
        });
        Toast.success(`Application submitted! Reference ID: ${res.data.applicationNumber}`);
        setTimeout(() => { location.hash = '#/applications'; }, 1200);
      } catch (err) {
        Toast.error(err.message);
        btn.disabled = false;
        btn.textContent = '🚀 Submit Application Now';
      }
    });

    $('bookmark-btn').addEventListener('click', async () => {
      try {
        const res = await ApiClient.post('/applications/save-toggle', { scholarshipId: this.id });
        Toast.info(res.message);
      } catch (err) { Toast.error(err.message); }
    });
  },

  reset() {
    $('scholarship-title').textContent = 'Loading Scholarship Details...';
    ['scholarship-provider', 'scholarship-description', 'match-percent-display', 'match-explanation-display'].forEach((id) => { $(id).textContent = '--'; });
    $('award-amount-display').textContent = '₹--';
    $('badge-deadline').textContent = 'Loading Deadline';
    $('eligibility-status-badge').textContent = 'Evaluating...';
    $('eligibility-status-badge').className = 'badge badge-warning';
    $('scholarship-renewal').textContent = 'None specified';
    $('scholarship-url').href = '#';
    $('match-bar').style.width = '0%';
    $('passed-criteria-list').innerHTML = '';
    $('failed-criteria-list').innerHTML = '';
    $('required-docs-list').innerHTML = '';
    $('failed-criteria-section').hidden = true;
    $('conflict-card').hidden = true;
    const btn = $('apply-btn');
    btn.disabled = false;
    btn.textContent = '🚀 Submit Application Now';
  },

  async load(id) {
    this.id = id;
    this.reset();
    try {
      const res = await ApiClient.get(`/scholarships/${id}`);
      const s = this.scholarship = res.data;

      $('scholarship-title').textContent = s.title;
      $('scholarship-provider').textContent = s.provider;
      $('scholarship-description').textContent = s.description;
      $('badge-category').textContent = s.category;
      $('award-amount-display').textContent = inr(s.awardAmount);
      $('award-type-display').textContent = label(s.amountType);

      const daysLeft = daysUntil(s.deadline);
      const deadBadge = $('badge-deadline');
      deadBadge.textContent = daysLeft > 0 ? `⏱️ ${daysLeft} Days Remaining` : 'Deadline Today';
      deadBadge.className = `badge ${daysLeft <= 7 ? 'badge-danger' : 'badge-warning'}`;

      if (s.renewalConditions) $('scholarship-renewal').textContent = s.renewalConditions;
      if (s.officialUrl) $('scholarship-url').href = s.officialUrl;
      this.renderRequiredDocs(s.requiredDocuments || []);

      const evalRes = await ApiClient.get(`/matching/evaluate/${id}`);
      this.renderEligibility(evalRes.data);

      const confRes = await ApiClient.get(`/intelligence/check-conflicts/${id}`);
      this.renderConflicts(confRes.data);
    } catch (err) {
      Toast.error('Failed to load details: ' + err.message);
    }
  },

  renderRequiredDocs(docs) {
    const el = $('required-docs-list');
    if (!docs.length) { el.innerHTML = '<div class="text-muted" style="font-size: 0.875rem;">Standard documents required upon selection.</div>'; return; }
    el.innerHTML = docs.map((d) => `
      <div class="flex items-center gap-2" style="border-bottom: 1px solid var(--border); padding-bottom: 0.375rem;">
        <span style="color: var(--primary);">📄</span>
        <span style="font-weight: 500;">${esc(label(d.documentType))}</span>
        ${d.isMandatory ? '<span class="badge badge-danger" style="font-size: 9px; padding: 1px 4px;">Mandatory</span>' : ''}
      </div>`).join('');
  },

  renderEligibility(data) {
    const badge = $('eligibility-status-badge');
    badge.textContent = data.isEligible ? '100% ELIGIBLE' : 'REQUIREMENTS NOT MET';
    badge.className = `badge ${data.isEligible ? 'badge-success' : 'badge-danger'}`;

    $('match-percent-display').textContent = `${data.matchScore}%`;
    $('match-bar').style.width = `${data.matchScore}%`;
    $('match-explanation-display').textContent = data.explanation;

    $('passed-criteria-list').innerHTML = (data.passedCriteria || []).map((c) =>
      `<div class="criteria-pass"><strong>${esc(c.criterion)}:</strong> ${esc(c.detail)}</div>`).join('');

    const failed = data.failedCriteria || [];
    $('failed-criteria-section').hidden = failed.length === 0;
    $('failed-criteria-list').innerHTML = failed.map((f) => `
      <div class="criteria-fail">
        <div><strong>${esc(f.criterion)}:</strong> ${esc(f.reason)}</div>
        <div class="text-muted" style="font-size: 0.75rem; margin-top: 2px;">Required: <em>${esc(f.expected)}</em> | Your Profile: <em>${esc(f.actual)}</em></div>
      </div>`).join('');
  },

  renderConflicts(data) {
    const has = data.hasConflict && data.conflicts.length > 0;
    $('conflict-card').hidden = !has;
    if (!has) return;
    $('conflict-details-list').innerHTML = data.conflicts.map((c) => `
      <div style="background: #fef2f2; border-radius: var(--radius-md); padding: 0.75rem; border: 1px solid #fecaca;">
        <div class="row-between" style="margin-bottom: 0.25rem;">
          <strong>Conflict with: ${esc(c.conflictingWith)}</strong>
          <span class="badge badge-danger">${esc(c.severity)} SEVERITY</span>
        </div>
        <div style="font-size: 0.75rem; color: #991b1b;">${esc(c.description)}</div>
      </div>`).join('');
  },
};

/* ----- Profile ----- */
Pages.profile = {
  init() {
    // Tabs
    document.querySelectorAll('.tab-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
        btn.classList.add('active');
        $(`tab-${btn.dataset.tab}`).classList.add('active');
      });
    });

    $('personal-form').addEventListener('submit', (e) => this.save(e, '/students/profile/personal', 'Personal profile', () => ({
      firstName: val('pf-firstName').trim(),
      lastName: val('pf-lastName').trim(),
      phone: val('pf-phone').trim(),
      gender: val('pf-gender'),
      casteCategory: val('pf-casteCategory'),
      stateOfDomicile: val('pf-stateOfDomicile').trim(),
      isSpeciallyAbled: $('pf-isSpeciallyAbled').checked,
    })));

    $('academic-form').addEventListener('submit', (e) => this.save(e, '/students/profile/academic', 'Academic profile', () => ({
      currentEducationLevel: val('pf-educationLevel'),
      institutionName: val('pf-institutionName').trim(),
      courseName: val('pf-courseName').trim(),
      currentYear: parseInt(val('pf-currentYear'), 10),
      gpaOrPercentage: parseFloat(val('pf-gpa')),
      gradingSystem: val('pf-gradingSystem'),
      tenthPercentage: val('pf-tenthPercentage') ? parseFloat(val('pf-tenthPercentage')) : null,
      twelfthPercentage: val('pf-twelfthPercentage') ? parseFloat(val('pf-twelfthPercentage')) : null,
    })));

    $('family-form').addEventListener('submit', (e) => this.save(e, '/students/profile/family', 'Family financial profile', () => ({
      annualIncome: parseFloat(val('pf-annualIncome')),
      fatherOccupation: val('pf-fatherOccupation').trim(),
      motherOccupation: val('pf-motherOccupation').trim(),
      rationCardType: val('pf-rationCardType'),
      numberOfSiblings: parseInt(val('pf-numberOfSiblings') || '0', 10),
      isFirstGenerationLearner: $('pf-isFirstGenerationLearner').checked,
      singleParent: $('pf-singleParent').checked,
    })));
  },

  async save(e, endpoint, name, buildPayload) {
    e.preventDefault();
    try {
      await ApiClient.put(endpoint, buildPayload());
      Toast.success(`${name} saved successfully!`);
    } catch (err) { Toast.error(err.message); }
  },

  async load() {
    try {
      const p = (await ApiClient.get('/students/profile')).data;

      setVal('pf-firstName', p.firstName);
      setVal('pf-lastName', p.lastName);
      setVal('pf-phone', p.phone);
      setVal('pf-gender', p.gender);
      setVal('pf-casteCategory', p.casteCategory);
      setVal('pf-stateOfDomicile', p.stateOfDomicile);
      $('pf-isSpeciallyAbled').checked = !!p.isSpeciallyAbled;

      if (p.academicProfile) {
        const a = p.academicProfile;
        setVal('pf-educationLevel', a.currentEducationLevel || 'Undergraduate');
        setVal('pf-institutionName', a.institutionName);
        setVal('pf-courseName', a.courseName);
        setVal('pf-currentYear', a.currentYear || 1);
        setVal('pf-gpa', a.gpaOrPercentage);
        setVal('pf-gradingSystem', a.gradingSystem || 'CGPA_10');
        setVal('pf-tenthPercentage', a.tenthPercentage);
        setVal('pf-twelfthPercentage', a.twelfthPercentage);
      }
      if (p.familyProfile) {
        const f = p.familyProfile;
        setVal('pf-annualIncome', f.annualIncome);
        setVal('pf-fatherOccupation', f.fatherOccupation);
        setVal('pf-motherOccupation', f.motherOccupation);
        setVal('pf-rationCardType', f.rationCardType || 'None');
        setVal('pf-numberOfSiblings', f.numberOfSiblings || 0);
        $('pf-isFirstGenerationLearner').checked = !!f.isFirstGenerationLearner;
        $('pf-singleParent').checked = !!f.singleParent;
      }
    } catch (err) {
      Toast.error('Failed to load profile details: ' + err.message);
    }
  },
};

/* ----- Documents ----- */
Pages.documents = {
  init() {
    const modal = $('upload-modal');
    $('open-upload-modal').addEventListener('click', () => modal.classList.add('open'));
    $('close-modal-btn').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });

    $('upload-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const fileInput = $('doc-file');
      if (!fileInput.files || !fileInput.files.length) { Toast.error('Please select a file'); return; }

      const formData = new FormData();
      formData.append('file', fileInput.files[0]);
      formData.append('documentType', val('doc-type'));
      if (val('doc-issue')) formData.append('issueDate', val('doc-issue'));
      if (val('doc-expiry')) formData.append('expiryDate', val('doc-expiry'));

      const btn = $('upload-submit-btn');
      try {
        btn.disabled = true;
        btn.textContent = 'Uploading & Validating...';
        await ApiClient.post('/documents/upload', formData);
        Toast.success('Certificate uploaded to vault successfully!');
        modal.classList.remove('open');
        $('upload-form').reset();
        this.load();
      } catch (err) {
        Toast.error(err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Upload & Verify File';
      }
    });
  },

  async load() {
    try {
      const [docsRes, readRes] = await Promise.all([ApiClient.get('/documents'), ApiClient.get('/documents/readiness')]);
      this.renderTable(docsRes.data || []);
      this.renderReadiness(readRes.data);
    } catch (err) {
      Toast.error('Failed to load documents: ' + err.message);
    }
  },

  renderReadiness(data) {
    if (!data) return;
    $('readiness-percent').textContent = `${data.readinessPercentage}%`;
    $('readiness-pills').innerHTML = (data.checklist || []).map((item) => `
      <div class="row-between" style="border-bottom: 1px dashed var(--border); padding: 2px 0;">
        <span>${esc(label(item.documentType))}</span>
        <span style="font-weight: 600; color: ${item.isReady ? 'var(--success)' : 'var(--danger)'};">${item.isReady ? '✓ Uploaded' : '✗ Needed'}</span>
      </div>`).join('');
  },

  renderTable(docs) {
    const tbody = $('documents-tbody');
    if (!docs.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="empty-state" style="padding: 2.5rem;">No documents in your vault yet. Upload certificates to boost your readiness!</td></tr>';
      return;
    }
    tbody.innerHTML = docs.map((doc) => {
      let badge = 'badge-success', status = 'VALID';
      if (doc.expiryStatus === 'EXPIRED') { badge = 'badge-danger'; status = 'EXPIRED'; }
      else if (doc.expiryStatus === 'EXPIRING_SOON') { badge = 'badge-warning'; status = 'EXPIRING SOON'; }

      return `
        <tr>
          <td style="font-weight: 600;">${esc(label(doc.documentType))}</td>
          <td class="text-secondary">${esc(doc.originalName)}</td>
          <td class="text-muted">${Math.round(doc.fileSize / 1024)} KB</td>
          <td>${doc.expiryDate ? new Date(doc.expiryDate).toLocaleDateString() : 'Lifetime / No Expiry'}</td>
          <td><span class="badge ${badge}">${status}</span></td>
          <td style="text-align: right; white-space: nowrap;">
            <button class="btn btn-secondary btn-sm" data-action="download" data-id="${esc(doc.id)}" data-name="${esc(doc.originalName)}">⬇ Download</button>
            <button class="btn btn-danger btn-sm" data-action="delete" data-id="${esc(doc.id)}" style="margin-left: 6px;">🗑 Delete</button>
          </td>
        </tr>`;
    }).join('');
  },

  async download(id, name) {
    try { await ApiClient.download(`/documents/${id}/download`, name); }
    catch (err) { Toast.error(err.message); }
  },

  async remove(id) {
    if (!confirm('Are you sure you want to permanently delete this document from your vault?')) return;
    try {
      await ApiClient.delete(`/documents/${id}`);
      Toast.success('Document deleted successfully');
      this.load();
    } catch (err) { Toast.error(err.message); }
  },
};

/* ----- Applications ----- */
Pages.applications = {
  apps: [],

  init() {
    const modal = $('history-modal');
    $('close-history-modal').addEventListener('click', () => modal.classList.remove('open'));
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.remove('open'); });
  },

  async load() {
    try {
      const [appRes, savedRes] = await Promise.all([ApiClient.get('/applications/my'), ApiClient.get('/applications/saved')]);
      this.apps = appRes.data || [];
      this.renderApplications(this.apps);
      this.renderSaved(savedRes.data || []);
    } catch (err) {
      Toast.error('Failed to load applications: ' + err.message);
    }
  },

  renderApplications(list) {
    const el = $('applications-container');
    if (!list.length) {
      el.innerHTML = '<div class="empty-state" style="padding: 3rem;">You haven\'t submitted any applications yet. Explore matched scholarships on your dashboard!</div>';
      return;
    }
    el.innerHTML = list.map((app) => {
      let badge = 'badge-warning';
      if (app.status === 'APPROVED' || app.status === 'DISBURSED') badge = 'badge-success';
      if (app.status === 'REJECTED' || app.status === 'WITHDRAWN') badge = 'badge-danger';
      if (app.status === 'UNDER_REVIEW') badge = 'badge-primary';
      const amount = app.submittedAmount || app.scholarship?.awardAmount || 0;
      const canWithdraw = app.status !== 'WITHDRAWN' && app.status !== 'DISBURSED';

      return `
        <div class="item-box" style="padding: 1.25rem;">
          <div class="row-between mb-1">
            <div class="flex items-center gap-2">
              <span class="badge ${badge}">${esc(label(app.status))}</span>
              <span class="text-muted" style="font-size: 0.75rem; font-family: monospace;">REF: ${esc(app.applicationNumber)}</span>
            </div>
            <strong style="font-size: 1.125rem; color: var(--primary);">${inr(amount)}</strong>
          </div>
          <h4 style="font-size: 1.125rem; font-weight: 600; margin-bottom: 0.25rem;">${esc(app.scholarship?.title)}</h4>
          <div class="text-secondary" style="font-size: 0.875rem; margin-bottom: 0.75rem;">
            Provider: ${esc(app.scholarship?.provider)} &bull; Submitted on: ${new Date(app.appliedDate).toLocaleDateString()}
          </div>
          <div class="row-between" style="border-top: 1px dashed var(--border); padding-top: 0.75rem; margin-top: 0.5rem;">
            <button class="btn btn-secondary btn-sm" data-action="history" data-id="${esc(app.id)}">📜 View History Timeline (${app.history?.length || 1} logs)</button>
            ${canWithdraw ? `<button class="btn btn-secondary btn-sm" style="color: var(--danger); border-color: #fecaca;" data-action="withdraw" data-id="${esc(app.id)}">Withdraw Application</button>` : ''}
          </div>
        </div>`;
    }).join('');
  },

  renderSaved(list) {
    const el = $('saved-container');
    if (!list.length) { el.innerHTML = '<div class="text-muted" style="font-size: 0.875rem;">No saved scholarships.</div>'; return; }
    el.innerHTML = list.map((item) => `
      <div class="item-box">
        <h4 style="font-size: 0.95rem; font-weight: 600; margin-bottom: 0.25rem;">${esc(item.scholarship.title)}</h4>
        <div class="text-secondary" style="font-size: 0.75rem; margin-bottom: 0.75rem;">
          Award: <strong>${inr(item.scholarship.awardAmount)}</strong> &bull; Deadline: ${new Date(item.scholarship.deadline).toLocaleDateString()}
        </div>
        <div class="row-between">
          <a href="#/scholarship/${encodeURIComponent(item.scholarship.id)}" class="btn btn-primary btn-sm">View &amp; Apply &rarr;</a>
          <button class="btn btn-secondary btn-sm" style="font-size: 11px;" data-action="unsave" data-id="${esc(item.scholarship.id)}">Remove</button>
        </div>
      </div>`).join('');
  },

  viewHistory(appId) {
    const app = this.apps.find((a) => String(a.id) === String(appId));
    if (!app) return;
    $('timeline-container').innerHTML = (app.history || []).map((h) => `
      <div class="timeline-item">
        <div style="font-weight: 600; font-size: 0.875rem;">Status: ${esc(h.status)}</div>
        <div class="text-secondary" style="font-size: 0.75rem; margin: 2px 0;">${esc(h.remarks || 'No additional remarks')}</div>
        <div class="text-muted" style="font-size: 0.7rem;">Updated by: ${esc(h.changedBy)} on ${new Date(h.changedAt).toLocaleString()}</div>
      </div>`).join('');
    $('history-modal').classList.add('open');
  },

  async withdraw(appId) {
    const reason = prompt('Please provide a reason for withdrawing this application:');
    if (reason === null) return;
    try {
      await ApiClient.post(`/applications/${appId}/withdraw`, { reason });
      Toast.success('Application withdrawn successfully');
      this.load();
    } catch (err) { Toast.error(err.message); }
  },

  async unsave(scholarshipId) {
    try {
      await ApiClient.post('/applications/save-toggle', { scholarshipId });
      Toast.info('Bookmark removed');
      this.load();
    } catch (err) { Toast.error(err.message); }
  },
};

/* ----- Notifications ----- */
Pages.notifications = {
  init() {
    $('mark-all-read-btn').addEventListener('click', async () => {
      try {
        await ApiClient.patch('/notifications/mark-all-read');
        Toast.success('All notifications marked as read');
        this.load();
      } catch (err) { Toast.error(err.message); }
    });
  },

  async load() {
    try {
      const res = await ApiClient.get('/notifications');
      this.render(res.data?.notifications || []);
      Shell.setUnread(res.data?.unreadCount || 0);
    } catch (err) {
      Toast.error('Failed to load notifications: ' + err.message);
    }
  },

  render(list) {
    const el = $('notifications-list');
    if (!list.length) { el.innerHTML = '<div class="empty-state" style="padding: 3rem;">🎉 All caught up! No notifications right now.</div>'; return; }

    el.innerHTML = list.map((n) => {
      let icon = '🔔', badge = 'badge-primary';
      if (n.type === 'DEADLINE_REMINDER') { icon = '⏱️'; badge = 'badge-danger'; }
      else if (n.type === 'DOCUMENT_EXPIRY') { icon = '📄'; badge = 'badge-warning'; }
      else if (n.type === 'STATUS_UPDATE') { icon = '📝'; badge = 'badge-success'; }

      return `
        <div style="padding: 1rem; border-radius: var(--radius-md); border: 1px solid var(--border); background: ${n.isRead ? '#ffffff' : '#eff6ff'}; display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem;">
          <div class="flex items-start gap-3">
            <div style="font-size: 1.5rem; margin-top: 2px;">${icon}</div>
            <div>
              <div class="flex items-center gap-2" style="margin-bottom: 0.25rem;">
                <span class="badge ${badge}">${esc(label(n.type))}</span>
                ${!n.isRead ? '<span class="badge badge-primary" style="font-size: 9px; padding: 1px 5px;">NEW</span>' : ''}
              </div>
              <h4 style="font-size: 1rem; font-weight: 600; margin-bottom: 0.25rem;">${esc(n.title)}</h4>
              <p class="text-secondary" style="font-size: 0.875rem; line-height: 1.5; margin-bottom: 0.5rem;">${esc(n.message)}</p>
              <div class="text-muted" style="font-size: 0.75rem;">${new Date(n.createdAt).toLocaleString()}</div>
            </div>
          </div>
          <div class="flex flex-col gap-2 items-end">
            ${n.link ? `<a href="${linkToHash(n.link)}" class="btn btn-primary btn-sm" style="white-space: nowrap;">View &rarr;</a>` : ''}
            ${!n.isRead ? `<button class="btn btn-secondary btn-sm" style="font-size: 11px;" data-action="read" data-id="${esc(n.id)}">Mark Read</button>` : ''}
          </div>
        </div>`;
    }).join('');
  },

  async markRead(id) {
    try { await ApiClient.patch(`/notifications/${id}/read`); this.load(); }
    catch (err) { Toast.error(err.message); }
  },
};

/* ---------- 8. Boot ---------- */
/** One delegated click handler for buttons that are created dynamically. */
function bindDelegatedActions() {
  document.addEventListener('click', (e) => {
    const pageBtn = e.target.closest('#pagination-container [data-page]');
    if (pageBtn) { Pages.scholarships.load(parseInt(pageBtn.dataset.page, 10)); return; }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, name } = btn.dataset;
    switch (action) {
      case 'download': Pages.documents.download(id, name); break;
      case 'delete': Pages.documents.remove(id); break;
      case 'history': Pages.applications.viewHistory(id); break;
      case 'withdraw': Pages.applications.withdraw(id); break;
      case 'unsave': Pages.applications.unsave(id); break;
      case 'read': Pages.notifications.markRead(id); break;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // Bind every page's static listeners once
  Object.values(Pages).forEach((page) => page.init && page.init());
  bindDelegatedActions();

  $('logout-btn').addEventListener('click', () => Auth.logout());
  $('mobile-toggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  document.querySelectorAll('.sidebar-link').forEach((a) => a.addEventListener('click', () => $('sidebar').classList.remove('open')));

  window.addEventListener('hashchange', () => Router.go());
  Router.go();
});
