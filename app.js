'use strict';
/* ============================================================
   ContractLens v2 — Frontend Application
   Backend-integrated · JWT Auth · Full AI pipeline
   ============================================================ */

const API_BASE = '/api';

// ═══════════════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════════════
const Auth = {
  getToken()  { return localStorage.getItem('cl_token'); },
  getUser()   { try { return JSON.parse(localStorage.getItem('cl_user') || 'null'); } catch { return null; } },
  setUser(u)  { localStorage.setItem('cl_user', JSON.stringify(u)); },
  logout() {
    localStorage.removeItem('cl_token');
    localStorage.removeItem('cl_user');
    window.location.href = '/login.html';
  },
  headers() {
    return { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.getToken()}` };
  },
  check() {
    if (!this.getToken()) { window.location.href = '/login.html'; return false; }
    return true;
  },
};

// ═══════════════════════════════════════════════════════════════
// BACKEND API CLIENT
// ═══════════════════════════════════════════════════════════════
const BackendAPI = {
  async req(method, path, body) {
    const opts = { method, headers: Auth.headers() };
    if (body) opts.body = JSON.stringify(body);
    const res  = await fetch(API_BASE + path, opts);
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { Auth.logout(); throw new Error('Session expired'); }
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  },

  getContracts()        { return this.req('GET',    '/contracts'); },
  getContract(id)       { return this.req('GET',    `/contracts/${id}`); },
  createContract(d)     { return this.req('POST',   '/contracts', d); },
  updateContract(id, d) { return this.req('PUT',    `/contracts/${id}`, d); },
  deleteContract(id)    { return this.req('DELETE', `/contracts/${id}`); },
  analyzeContract(id)   { return this.req('POST',   `/contracts/${id}/analyze`); },
  compareContracts(a,b) { return this.req('POST',   '/contracts/compare', { contractAId: a, contractBId: b }); },
  chat(id, messages)    { return this.req('POST',   `/contracts/${id}/chat`, { messages }); },
  getMe()               { return this.req('GET',    '/auth/me'); },
  saveSettings(d)       { return this.req('PUT',    '/auth/settings', d); },
  exportData()          { return this.req('GET',    '/export'); },
  importData(contracts) { return this.req('POST',   '/import', { contracts }); },

  async parseFile(file) {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(API_BASE + '/upload/parse', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${Auth.getToken()}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'File parsing failed');
    return data;
  },
};

// ═══════════════════════════════════════════════════════════════
// APP STATE (in-memory cache)
// ═══════════════════════════════════════════════════════════════
const State = {
  contracts:         [],
  currentContractId: null,
  currentView:       'dashboard',
  currentFilter:     'all',
  currentOFilter:    'all',
  currentOFilterStatus: 'all',
  currentTrackerFilter: 'all',
  currentAlertFilter: 'all',
  chatHistory:       [],
  uploadFile:        null,
  userSettings:      null,
};

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════
const Utils = {
  formatDate(d) {
    if (!d) return 'Not specified';
    try { return new Date(d + 'T00:00:00').toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }); }
    catch { return d; }
  },
  daysUntil(d) {
    if (!d) return null;
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((new Date(d + 'T00:00:00') - today) / 86400000);
  },
  daysBadge(d) {
    const days = this.daysUntil(d);
    if (days === null) return `<span class="days-badge days-unknown">No date</span>`;
    if (days < 0)  return `<span class="days-badge days-overdue">${Math.abs(days)}d overdue</span>`;
    if (days <= 14) return `<span class="days-badge days-soon">${days}d left</span>`;
    return `<span class="days-badge days-ok">${days}d</span>`;
  },
  urgencyClass(d) {
    const days = this.daysUntil(d);
    if (days === null) return 'ok';
    if (days < 0) return 'overdue';
    if (days <= 30) return 'due-soon';
    return 'ok';
  },
  dotClass(d, status) {
    if (status === 'complete') return 'complete';
    return this.urgencyClass(d);
  },
  contractStatus(c) {
    if (!c.analysis) return 'draft';
    const d = c.analysis.expirationDate;
    if (!d) return 'active';
    const days = this.daysUntil(d);
    if (days < 0) return 'expired';
    if (days <= 30) return 'expiring';
    return 'active';
  },
  contractStatusBadge(c) {
    const map = {
      active:   '<span class="badge badge-active">● Active</span>',
      expiring: '<span class="badge badge-expiring">⚠ Expiring</span>',
      expired:  '<span class="badge badge-expired">✕ Expired</span>',
      draft:    '<span class="badge badge-draft">○ Processing</span>',
    };
    return map[this.contractStatus(c)] || map.draft;
  },
  typeIcon(t) {
    const m = { vendor:'🤝', customer:'👔', employment:'👷', partnership:'🤜', nda:'🔒', saas:'💻', service:'⚙️', lease:'🏢', other:'📄' };
    return m[t] || '📄';
  },
  fileSize(b) {
    if (b < 1024) return b + ' B';
    if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
    return (b/1048576).toFixed(1) + ' MB';
  },
  esc(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  },
  alertSeverity(days) {
    const s = State.userSettings;
    const crit = s?.criticalThreshold || 14;
    const warn = s?.warningThreshold  || 45;
    if (days < 0 || days <= crit) return 'critical';
    if (days <= warn) return 'warning';
    return 'info';
  },
};

// ═══════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════
const Toast = {
  show(msg, type='info', ms=3500) {
    const icons = { success:'✅', error:'❌', warning:'⚠️', info:'ℹ️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span>${icons[type]||'ℹ️'}</span><span>${Utils.esc(msg)}</span>`;
    document.getElementById('toast-container').appendChild(el);
    setTimeout(() => {
      el.style.cssText = 'opacity:0;transform:translateX(20px);transition:all .3s ease';
      setTimeout(() => el.remove(), 300);
    }, ms);
  },
  success(m) { this.show(m, 'success'); },
  error(m)   { this.show(m, 'error', 5000); },
  warning(m) { this.show(m, 'warning'); },
  info(m)    { this.show(m, 'info'); },
};

// ═══════════════════════════════════════════════════════════════
// ANIMATED COUNTER
// ═══════════════════════════════════════════════════════════════
function animateCounter(el, target) {
  if (!el) return;
  el.classList.add('animating');
  const start = 0;
  const duration = 800;
  const startTime = performance.now();
  const step = (now) => {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3);
    el.textContent = Math.round(start + (target - start) * eased);
    if (progress < 1) requestAnimationFrame(step);
    else { el.textContent = target; el.classList.remove('animating'); }
  };
  requestAnimationFrame(step);
}

// ═══════════════════════════════════════════════════════════════
// ROUTER
// ═══════════════════════════════════════════════════════════════
const Router = {
  views: ['dashboard','library','detail','tracker','alerts','compare','settings'],
  titles: { dashboard:'Dashboard', library:'Contract Library', detail:'Contract Detail', tracker:'Obligation Tracker', alerts:'Alerts & Reminders', compare:'Compare Contracts', settings:'Settings' },

  navigate(view, contractId=null) {
    this.views.forEach(v => {
      document.getElementById(`page-${v}`)?.classList.remove('active');
      document.getElementById(`nav-${v}`)?.classList.remove('active');
    });

    document.getElementById(`page-${view}`)?.classList.add('active');
    document.getElementById(`nav-${view}`)?.classList.add('active');
    document.getElementById('topbar-title').textContent = this.titles[view] || view;
    State.currentView = view;

    switch(view) {
      case 'dashboard': Views.renderDashboard(); break;
      case 'library':   Views.renderLibrary(); break;
      case 'detail':
        if (contractId) { State.currentContractId = contractId; Views.renderDetail(contractId); }
        break;
      case 'tracker':  Views.renderTracker(); break;
      case 'alerts':   Views.renderAlerts(); break;
      case 'compare':  Views.renderCompare(); break;
      case 'settings': Views.renderSettings(); break;
    }
    this.updateAlertsBadge();
  },

  updateAlertsBadge() {
    const s = State.userSettings || {};
    const warnDays = s.warningThreshold || 45;
    let count = 0;
    State.contracts.forEach(c => {
      if (!c.analysis) return;
      if (c.analysis.expirationDate) {
        const d = Utils.daysUntil(c.analysis.expirationDate);
        if (d !== null && d <= warnDays) count++;
      }
      (c.analysis.obligations || []).forEach(ob => {
        if (ob.status === 'complete') return;
        if (ob.deadline && Utils.daysUntil(ob.deadline) <= warnDays) count++;
      });
    });
    const badge = document.getElementById('alerts-badge');
    if (badge) { badge.textContent = count; badge.classList.toggle('hidden', count === 0); }
  },
};

// ═══════════════════════════════════════════════════════════════
// VIEWS
// ═══════════════════════════════════════════════════════════════
const Views = {

  // ─── DASHBOARD ─────────────────────────────────────────────
  renderDashboard() {
    const contracts = State.contracts;
    const banner = document.getElementById('welcome-banner');
    if (banner) banner.classList.toggle('hidden', contracts.length > 0);

    let expiring30=0, overdue=0, flags=0;
    contracts.forEach(c => {
      if (!c.analysis) return;
      if (Utils.contractStatus(c) === 'expiring') expiring30++;
      (c.analysis.obligations||[]).forEach(ob => {
        if (ob.status !== 'complete' && ob.deadline && Utils.daysUntil(ob.deadline) < 0) overdue++;
      });
      flags += (c.analysis.flaggedClauses||[]).filter(f => f.risk==='High').length;
    });

    animateCounter(document.getElementById('stat-total'), contracts.length);
    animateCounter(document.getElementById('stat-expiring30'), expiring30);
    animateCounter(document.getElementById('stat-overdue'), overdue);
    animateCounter(document.getElementById('stat-flags'), flags);

    document.getElementById('stat-total-sub').textContent      = contracts.length === 1 ? '1 contract' : `${contracts.length} contracts`;
    document.getElementById('stat-expiring30-sub').textContent = expiring30 ? 'Require attention' : 'None imminent';
    document.getElementById('stat-overdue-sub').textContent    = overdue ? 'Action required!' : 'All clear ✓';
    document.getElementById('stat-flags-sub').textContent      = flags ? 'High-risk clauses' : 'No high-risk clauses';

    this.renderDashboardTimeline();
    this.renderDashboardAlerts();
  },

  renderDashboardTimeline() {
    const el = document.getElementById('dashboard-timeline');
    const items = [];
    State.contracts.forEach(c => {
      if (!c.analysis) return;
      if (c.analysis.expirationDate) items.push({ date: c.analysis.expirationDate, label: `${c.name} — Expiration`, sub: 'Contract ends', cId: c.id });
      (c.analysis.obligations||[]).slice(0,2).forEach(ob => {
        if (!ob.deadline || ob.status==='complete') return;
        items.push({ date: ob.deadline, label: ob.obligation.length>60?ob.obligation.slice(0,57)+'…':ob.obligation, sub: `${ob.party} — ${c.name}`, cId: c.id });
      });
    });
    items.sort((a,b) => !a.date?1:!b.date?-1:new Date(a.date)-new Date(b.date));
    const upcoming = items.filter(i => { const d=Utils.daysUntil(i.date); return d!==null&&d>=-7&&d<=90; }).slice(0,6);
    if (!upcoming.length) { el.innerHTML=`<div class="empty-state" style="padding:var(--sp-6)"><span style="font-size:28px;opacity:.4">📅</span><p>No upcoming deadlines in 90 days</p></div>`; return; }
    el.innerHTML = `<div class="timeline">${upcoming.map(item=>{
      const cls=Utils.urgencyClass(item.date);
      return `<div class="timeline-item" style="cursor:pointer" onclick="Router.navigate('detail','${item.cId}')">
        <div class="timeline-dot ${cls}"></div>
        <div class="timeline-date">${Utils.formatDate(item.date)}</div>
        <div class="timeline-content"><div class="timeline-title">${Utils.esc(item.label)}</div><div class="timeline-sub">${Utils.esc(item.sub)}</div></div>
      </div>`;
    }).join('')}</div>`;
  },

  renderDashboardAlerts() {
    const el = document.getElementById('dashboard-alerts');
    const alerts = this.buildAlerts(60).slice(0,4);
    if (!alerts.length) { el.innerHTML=`<div class="empty-state" style="padding:var(--sp-6)"><span style="font-size:28px;opacity:.4">🔔</span><p>No alerts for the next 60 days</p></div>`; return; }
    el.innerHTML = alerts.map(a=>`<div class="flex items-center gap-3 p-3 mb-2" style="background:var(--bg-raised);border:1px solid rgba(255,255,255,.06);border-radius:var(--r-md);cursor:pointer"
      onclick="Router.navigate('detail','${a.contractId}')">
      <span style="font-size:18px">${{renewal:'🔄',payment:'💳',termination:'❌',obligation:'✅'}[a.category]||'🔔'}</span>
      <div class="flex-1 min-w-0"><div class="fw-700 text-sm truncate">${Utils.esc(a.title)}</div><div class="text-xs text-muted">${Utils.esc(a.contractName)}</div></div>
      ${Utils.daysBadge(a.days>=0?new Date(Date.now()+a.days*86400000).toISOString().slice(0,10):null)}
    </div>`).join('');
  },

  buildAlerts(windowDays=365) {
    const alerts = [];
    State.contracts.forEach(c => {
      if (!c.analysis) return;
      if (c.analysis.expirationDate) {
        const days = Utils.daysUntil(c.analysis.expirationDate);
        if (days!==null && days<=windowDays) alerts.push({ type:'renewal', severity:Utils.alertSeverity(days), title:`${c.name} — Expiration`, desc:`Expires ${Utils.formatDate(c.analysis.expirationDate)}`, days, contractId:c.id, contractName:c.name, category:'renewal' });
      }
      (c.analysis.obligations||[]).forEach(ob => {
        if (ob.status==='complete'||!ob.deadline) return;
        const days = Utils.daysUntil(ob.deadline);
        if (days!==null && days<=windowDays) {
          const cat = ob.type?.toLowerCase().includes('pay')?'payment':ob.type?.toLowerCase().includes('term')?'termination':'obligation';
          alerts.push({ type:'obligation', severity:Utils.alertSeverity(days), title:ob.obligation.length>70?ob.obligation.slice(0,67)+'…':ob.obligation, desc:`${ob.party} — due ${Utils.formatDate(ob.deadline)}`, days, contractId:c.id, contractName:c.name, category:cat });
        }
      });
    });
    return alerts.sort((a,b) => a.days - b.days);
  },

  alertCardHTML(a) {
    const icon = {renewal:'🔄',payment:'💳',termination:'❌',obligation:'✅'}[a.category]||'🔔';
    const daysLabel = a.days<0?'Overdue':a.days===0?'Today':'Days left';
    return `<div class="alert-card alert-${a.severity}" onclick="Router.navigate('detail','${a.contractId}')">
      <div class="alert-icon ${a.severity}">${icon}</div>
      <div class="alert-content">
        <div class="alert-title">${Utils.esc(a.title)}</div>
        <div class="alert-desc">${Utils.esc(a.desc)}</div>
        <div class="alert-meta"><span>📂 ${Utils.esc(a.contractName)}</span><span class="badge badge-${a.severity==='critical'?'high':a.severity==='warning'?'medium':'info'}">${a.category}</span></div>
      </div>
      <div><div class="alert-days text-${a.severity==='critical'?'danger':a.severity==='warning'?'warning':'accent'}">${Math.abs(a.days)}</div><div class="alert-days-label">${daysLabel}</div></div>
    </div>`;
  },

  // ─── LIBRARY ─────────────────────────────────────────────────
  renderLibrary() {
    const search = document.getElementById('library-search')?.value.toLowerCase()||'';
    const sort   = document.getElementById('sort-select')?.value||'uploaded';
    let list = [...State.contracts];

    if (State.currentFilter !== 'all') list = list.filter(c => Utils.contractStatus(c) === State.currentFilter);
    if (search) list = list.filter(c => c.name.toLowerCase().includes(search) || (c.analysis?.parties||[]).some(p=>p.name.toLowerCase().includes(search)));
    if (sort==='expiration') list.sort((a,b) => (a.analysis?.expirationDate||'9999').localeCompare(b.analysis?.expirationDate||'9999'));
    else if (sort==='name') list.sort((a,b) => a.name.localeCompare(b.name));

    const sub = document.getElementById('library-subtitle');
    if (sub) sub.textContent = `${list.length} of ${State.contracts.length} contracts`;

    const grid = document.getElementById('contract-grid');
    if (!grid) return;

    if (!list.length) {
      grid.innerHTML = State.contracts.length === 0
        ? `<div class="empty-state" style="grid-column:1/-1;padding:var(--sp-12)"><span class="empty-icon">📂</span><h3>No contracts yet</h3><p>Upload your first contract to get started</p><button class="btn btn-primary mt-4" onclick="Upload.open()">📄 Upload Contract</button></div>`
        : `<div class="empty-state" style="grid-column:1/-1;padding:var(--sp-10)"><span class="empty-icon">🔍</span><h3>No matches</h3><p>Try adjusting your search or filters</p></div>`;
      return;
    }
    grid.innerHTML = list.map(c => this.contractCardHTML(c)).join('');
  },

  contractCardHTML(c) {
    const a = c.analysis;
    const flagCount = (a?.flaggedClauses||[]).length;
    const highFlags = (a?.flaggedClauses||[]).filter(f=>f.risk==='High').length;
    const obCount   = (a?.obligations||[]).length;
    const parties   = (a?.parties||[]).slice(0,3);

    return `<div class="contract-card" onclick="Router.navigate('detail','${c.id}')" id="cc-${c.id}">
      <div class="contract-card-header">
        <div class="contract-type-icon">${Utils.typeIcon(c.type)}</div>
        <div class="flex-1 min-w-0">
          <div class="contract-name truncate">${Utils.esc(c.name)}</div>
          <div class="mt-2">${Utils.contractStatusBadge(c)}</div>
        </div>
      </div>
      ${parties.length?`<div class="contract-parties">${parties.map(p=>`<span class="party-chip">${Utils.esc(p.name)}</span>`).join('')}</div>`:'<div class="text-xs text-muted">Analyzing…</div>'}
      <div class="contract-meta">
        ${a?.effectiveDate?`<div class="contract-meta-item">📅 ${Utils.formatDate(a.effectiveDate)}</div>`:''}
        ${a?.expirationDate?`<div class="contract-meta-item">⏰ ${Utils.formatDate(a.expirationDate)}</div>`:''}
        ${a?.keyFacts?.jurisdiction?`<div class="contract-meta-item">📍 ${Utils.esc(a.keyFacts.jurisdiction)}</div>`:''}
      </div>
      <div class="contract-card-footer">
        <div class="obligation-count">✅ ${obCount} obligation${obCount!==1?'s':''}</div>
        ${flagCount?`<div class="flag-count ${highFlags?'has-high':''}">🚩 ${flagCount}${highFlags?` (${highFlags} high)`:''}</div>`:'<div class="text-xs text-muted">No flags</div>'}
      </div>
      ${a?.expirationDate?`<div style="margin-top:var(--sp-2)">
        <div style="height:3px;background:rgba(255,255,255,.06);border-radius:99px;overflow:hidden">
          <div style="height:100%;background:${Utils.daysUntil(a.expirationDate)<0?'var(--danger)':Utils.daysUntil(a.expirationDate)<=30?'var(--warning)':'var(--emerald)'};border-radius:99px;width:${Math.min(100,Math.max(2,Utils.daysUntil(a.expirationDate)/(365)*100))}%;transition:width .5s"></div>
        </div></div>`:''}
    </div>`;
  },

  // ─── DETAIL ──────────────────────────────────────────────────
  renderDetail(id) {
    const c = State.contracts.find(x => x.id === id);
    if (!c) { Router.navigate('library'); return; }

    document.getElementById('topbar-title').textContent = c.name;
    document.getElementById('detail-title').textContent = c.name;
    const badges = document.getElementById('detail-badges');
    if (badges) badges.innerHTML = `${Utils.contractStatusBadge(c)}<span class="badge badge-info">${Utils.typeIcon(c.type)} ${c.type}</span>`;

    document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
    document.querySelector('.tab[data-tab="overview"]')?.classList.add('active');
    document.getElementById('tab-overview')?.classList.add('active');

    if (!c.analysis) {
      document.getElementById('detail-processing')?.classList.remove('hidden');
      document.getElementById('detail-content')?.classList.add('hidden');
    } else {
      document.getElementById('detail-processing')?.classList.add('hidden');
      document.getElementById('detail-content')?.classList.remove('hidden');
      this.populateDetail(c);
    }

    State.chatHistory = [];
    const chatMessages = document.getElementById('chat-messages');
    if (chatMessages) chatMessages.innerHTML = `<div class="chat-message assistant"><div class="chat-avatar">⚖️</div><div class="chat-bubble">Hello! I've analyzed <strong>${Utils.esc(c.name)}</strong> and ready to answer questions about parties, obligations, deadlines, clauses, or anything else.</div></div>`;
  },

  populateDetail(c) {
    const a = c.analysis;
    if (!a) return;

    // Info grid
    const ig = document.getElementById('contract-info-grid');
    if (ig) ig.innerHTML = [
      { label:'Effective Date',    value:Utils.formatDate(a.effectiveDate), hl:false },
      { label:'Expiration Date',   value:Utils.formatDate(a.expirationDate), hl:true },
      { label:'Contract Value',    value:a.keyFacts?.totalValue||'Not specified', hl:false },
      { label:'Governing Law',     value:a.keyFacts?.governingLaw||'Not specified', hl:false },
      { label:'Jurisdiction',      value:a.keyFacts?.jurisdiction||'Not specified', hl:false },
      { label:'Dispute Resolution',value:a.keyFacts?.disputeResolution||'Not specified', hl:false },
    ].map(x=>`<div class="info-item"><div class="info-item-label">${Utils.esc(x.label)}</div><div class="info-item-value ${x.hl?'highlight':''}">${Utils.esc(x.value)}</div></div>`).join('');

    // Parties
    const pl = document.getElementById('parties-list');
    if (pl) pl.innerHTML = (a.parties||[]).map(p=>`<div class="flex items-center gap-3 p-3 mb-2" style="background:var(--bg-raised);border-radius:var(--r-md);border:1px solid rgba(255,255,255,.05)">
      <div style="width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--violet));display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:800;flex-shrink:0">${p.name.charAt(0).toUpperCase()}</div>
      <div><div class="fw-700">${Utils.esc(p.name)}</div><div class="text-xs text-muted">${Utils.esc(p.role)}${p.description?' — '+Utils.esc(p.description):''}</div></div>
    </div>`).join('')||'<div class="text-sm text-muted">No parties identified</div>';

    // Payment terms
    const pay = document.getElementById('payment-terms-content');
    if (pay) {
      const pt = a.paymentTerms;
      pay.innerHTML = pt ? `${pt.summary?`<p>${Utils.esc(pt.summary)}</p>`:''}
        ${pt.amount?`<div class="flex gap-4 flex-wrap mt-3">
          <div class="info-item"><div class="info-item-label">Amount</div><div class="info-item-value highlight">${Utils.esc(pt.amount)}</div></div>
          <div class="info-item"><div class="info-item-label">Frequency</div><div class="info-item-value">${Utils.esc(pt.frequency||'—')}</div></div>
          ${pt.lateFee?`<div class="info-item"><div class="info-item-label">Late Fee</div><div class="info-item-value text-warning">${Utils.esc(pt.lateFee)}</div></div>`:''}
        </div>`:''}` : 'Not specified';
    }

    // Termination
    const term = document.getElementById('termination-content');
    if (term) {
      const conds = a.terminationConditions||[];
      term.innerHTML = conds.length ? conds.map(x=>`<div class="flex items-start gap-3 p-3 mb-2" style="background:var(--bg-raised);border-radius:var(--r-md);border-left:3px solid rgba(244,63,94,.4)">
        <span style="color:var(--rose);flex-shrink:0;margin-top:2px">❌</span>
        <div><div class="fw-600 text-sm">${Utils.esc(x.type||'Condition')}</div><div class="text-sm text-secondary mt-1">${Utils.esc(x.condition)}</div>${x.noticePeriod?`<div class="text-xs text-muted mt-1">Notice: ${Utils.esc(x.noticePeriod)}</div>`:''}</div>
      </div>`).join('') : '<div class="text-sm text-muted">Not specified</div>';
    }

    // Quick stats
    const qs = document.getElementById('quick-stats');
    if (qs) {
      const obs = a.obligations||[];
      const done = obs.filter(o=>o.status==='complete').length;
      const over = obs.filter(o=>o.status!=='complete'&&o.deadline&&Utils.daysUntil(o.deadline)<0).length;
      const highRisk = (a.flaggedClauses||[]).filter(f=>f.risk==='High').length;
      qs.innerHTML = [
        {l:'Obligations',v:obs.length,icon:'✅'},
        {l:'Completed',v:done,icon:'✔️'},
        {l:'Overdue',v:over,icon:'🚨',danger:over>0},
        {l:'High Risk',v:highRisk,icon:'🚩',danger:highRisk>0},
        {l:'IP Assignment',v:a.keyFacts?.ipAssignment?'Yes':'No',icon:'©️'},
        {l:'Exclusivity',v:a.keyFacts?.exclusivityClause?'Yes':'No',icon:'🔒'},
      ].map(s=>`<div class="settings-row" style="padding:6px 0"><div class="flex items-center gap-2 text-sm">${s.icon} ${Utils.esc(s.l)}</div><div class="fw-700 text-sm ${s.danger?'text-danger':''}">${s.v}</div></div>`).join('');
    }

    // Renewal
    const ren = document.getElementById('renewal-content');
    if (ren) ren.textContent = a.renewalTerms||'Not specified';

    // Source refs
    const refs = document.getElementById('source-refs');
    if (refs) refs.innerHTML = (a.sourceReferences||[]).slice(0,5).map(r=>`<div class="mb-3"><div class="text-xs fw-700 mb-1">${Utils.esc(r.insight)}</div><span class="source-ref">📎 ${Utils.esc((r.clause||'').slice(0,60))}…</span></div>`).join()||'<div class="text-xs text-muted">No references</div>';

    this.renderObligationsList(c, 'obligations-list', 'all', 'all');
    this.renderPartyFilters(c);
    this.renderFlaggedClauses(c);
    this.renderDetailTimeline(c);
    this.renderSummary(c);
  },

  renderPartyFilters(c) {
    const el = document.getElementById('party-filters');
    if (!el) return;
    const parties = [...new Set((c.analysis?.parties||[]).map(p=>p.name))];
    el.innerHTML = parties.map(p=>`<button class="filter-chip" data-ofilter="${Utils.esc(p)}">${Utils.esc(p)}</button>`).join('');
    el.querySelectorAll('.filter-chip').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-ofilter]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        State.currentOFilter = btn.dataset.ofilter;
        this.renderObligationsList(c,'obligations-list',State.currentOFilter,State.currentOFilterStatus);
      });
    });
  },

  renderObligationsList(c, containerId, partyF, statusF) {
    const el = document.getElementById(containerId);
    if (!el) return;
    let obs = c.analysis?.obligations||[];
    if (partyF && partyF!=='all') obs = obs.filter(o=>o.party===partyF);
    if (statusF === 'overdue')  obs = obs.filter(o=>o.status!=='complete'&&o.deadline&&Utils.daysUntil(o.deadline)<0);
    else if (statusF==='pending')  obs = obs.filter(o=>o.status==='pending');
    else if (statusF==='complete') obs = obs.filter(o=>o.status==='complete');

    obs = [...obs].sort((a,b) => {
      const dA=a.deadline?Utils.daysUntil(a.deadline):9999;
      const dB=b.deadline?Utils.daysUntil(b.deadline):9999;
      if (a.status==='complete' && b.status!=='complete') return 1;
      if (a.status!=='complete' && b.status==='complete') return -1;
      return dA - dB;
    });

    if (!obs.length) { el.innerHTML=`<div class="empty-state" style="padding:var(--sp-8)"><span class="empty-icon">✅</span><h3>No obligations</h3><p>No obligations match this filter</p></div>`; return; }

    el.innerHTML = obs.map(ob=>{
      const urg = Utils.urgencyClass(ob.deadline);
      const done = ob.status==='complete';
      return `<div class="obligation-item ${urg} ${done?'complete':''}">
        <div class="obligation-content">
          <div class="obligation-text">${Utils.esc(ob.obligation)}</div>
          <div class="obligation-meta">
            <span class="badge badge-info">${Utils.esc(ob.party)}</span>
            <span class="badge badge-pending">${Utils.esc(ob.type||'General')}</span>
            ${ob.frequency?`<span class="text-xs text-muted">↻ ${Utils.esc(ob.frequency)}</span>`:''}
            ${ob.deadlineDescription?`<span class="text-xs text-muted">📅 ${Utils.esc(ob.deadlineDescription)}</span>`:''}
          </div>
          ${ob.sourceClause?`<div class="source-ref mt-2" style="display:inline-flex;max-width:100%;overflow:hidden">📎 "${Utils.esc(ob.sourceClause.slice(0,80))}…"</div>`:''}
        </div>
        <div class="obligation-actions">
          ${Utils.daysBadge(ob.deadline)}
          <button class="btn btn-sm ${done?'btn-secondary':'btn-ghost'}"
            onclick="event.stopPropagation();App.toggleObligation('${c.id}','${ob.id}')">
            ${done?'↩ Reopen':'✓ Done'}
          </button>
        </div>
      </div>`;
    }).join('');
  },

  renderFlaggedClauses(c) {
    const el = document.getElementById('flagged-list');
    const sb = document.getElementById('flagged-summary-box');
    if (!el) return;
    const flags = c.analysis?.flaggedClauses||[];
    const highC = flags.filter(f=>f.risk==='High').length;
    const midC  = flags.filter(f=>f.risk==='Medium').length;
    if (sb) sb.innerHTML = flags.length
      ? `<strong>${flags.length} clause${flags.length!==1?'s':''} flagged</strong> — <span class="text-danger">${highC} high</span>, <span class="text-warning">${midC} medium</span>, <span class="text-success">${flags.length-highC-midC} low</span> risk.`
      : 'No flagged clauses. Positive sign — but always have legal review any agreement before signing.';
    if (!flags.length) { el.innerHTML=`<div class="empty-state" style="padding:var(--sp-8)"><span class="empty-icon">✅</span><h3>No flagged clauses</h3><p>No risky clauses were identified</p></div>`; return; }
    el.innerHTML = flags.map(f=>`<div class="flagged-item" id="flag-${f.id}">
      <div class="flagged-item-header" onclick="Views.toggleFlagged('${f.id}')">
        <span class="badge badge-${f.risk.toLowerCase()}">${f.risk}</span>
        <div class="flagged-item-title">${Utils.esc(f.title)}</div>
        <span class="badge badge-info" style="font-size:10px">${Utils.esc(f.type)}</span>
        <span style="color:var(--text-muted);margin-left:var(--sp-2)">▼</span>
      </div>
      <div class="flagged-body" id="flagbody-${f.id}">
        <div class="flagged-reason">${Utils.esc(f.reason)}</div>
        ${f.recommendation?`<div class="mt-3 p-3" style="background:rgba(79,141,255,.07);border:1px solid rgba(79,141,255,.15);border-radius:var(--r-md)"><div class="text-xs fw-700 text-accent mb-1">💡 Recommendation</div><div class="text-sm text-secondary">${Utils.esc(f.recommendation)}</div></div>`:''}
        ${f.text?`<div class="clause-text">${Utils.esc(f.text)}</div>`:''}
      </div>
    </div>`).join('');
  },

  toggleFlagged(id) {
    document.getElementById(`flagbody-${id}`)?.classList.toggle('open');
  },

  renderDetailTimeline(c) {
    const el = document.getElementById('detail-timeline');
    if (!el) return;
    const a = c.analysis;
    const items = [];
    if (a?.effectiveDate) items.push({ date:a.effectiveDate, title:'Contract Effective', sub:'Agreement begins', status:'complete' });
    (a?.obligations||[]).forEach(ob => {
      if (!ob.deadline) return;
      items.push({ date:ob.deadline, title:ob.obligation.length>70?ob.obligation.slice(0,67)+'…':ob.obligation, sub:`${ob.party} · ${ob.type||'Obligation'}`, status:ob.status });
    });
    if (a?.expirationDate) items.push({ date:a.expirationDate, title:'Contract Expires', sub:'Agreement ends' });
    items.sort((a,b)=>!a.date?1:!b.date?-1:new Date(a.date)-new Date(b.date));
    if (!items.length) { el.innerHTML=`<div class="empty-state" style="padding:var(--sp-8)"><span class="empty-icon">📅</span><h3>No dated events</h3></div>`; return; }
    el.innerHTML = items.map(i=>`<div class="timeline-item">
      <div class="timeline-dot ${Utils.dotClass(i.date,i.status)}"></div>
      <div class="timeline-date">${Utils.formatDate(i.date)}</div>
      <div class="timeline-content"><div class="timeline-title">${Utils.esc(i.title)}</div><div class="timeline-sub">${Utils.esc(i.sub||'')} ${Utils.daysBadge(i.date)}</div></div>
    </div>`).join('');
  },

  renderSummary(c) {
    const el = document.getElementById('summary-content');
    if (!el) return;
    const a = c.analysis;
    el.innerHTML = `
      <div class="summary-section"><h4>Executive Summary</h4><div class="summary-text">${Utils.esc(a.executiveSummary||'Not available')}</div></div>
      ${a.keyRisks?.length?`<div class="summary-section"><h4>⚠️ Key Risks</h4><ul style="padding-left:0">${a.keyRisks.map(r=>`<li class="flex items-start gap-2 mb-2 text-sm text-secondary"><span class="text-warning" style="flex-shrink:0;margin-top:2px">▸</span>${Utils.esc(r)}</li>`).join('')}</ul></div>`:''}
      ${a.keyBenefits?.length?`<div class="summary-section"><h4>✅ Key Benefits</h4><ul style="padding-left:0">${a.keyBenefits.map(b=>`<li class="flex items-start gap-2 mb-2 text-sm text-secondary"><span class="text-success" style="flex-shrink:0;margin-top:2px">▸</span>${Utils.esc(b)}</li>`).join('')}</ul></div>`:''}
      ${a.actionItems?.length?`<div class="summary-section"><h4>🎯 Action Items</h4><ul style="padding-left:0">${a.actionItems.map((it,i)=>`<li class="flex items-start gap-3 mb-3"><span style="width:22px;height:22px;border-radius:50%;background:linear-gradient(135deg,var(--blue),var(--violet));display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:800;flex-shrink:0;margin-top:2px">${i+1}</span><span class="text-sm text-secondary">${Utils.esc(it)}</span></li>`).join('')}</ul></div>`:''}
    `;
  },

  // ─── TRACKER ─────────────────────────────────────────────────
  renderTracker() {
    const search   = document.getElementById('tracker-search')?.value.toLowerCase()||'';
    const cFilter  = document.getElementById('tracker-contract-filter')?.value||'all';
    const cs = document.getElementById('tracker-contract-filter');
    if (cs) {
      const cur = cs.value;
      cs.innerHTML = `<option value="all">All Contracts</option>${State.contracts.map(c=>`<option value="${c.id}" ${cur===c.id?'selected':''}>${Utils.esc(c.name)}</option>`).join('')}`;
    }

    let obs = [];
    State.contracts.forEach(c => {
      if (!c.analysis?.obligations) return;
      c.analysis.obligations.forEach(ob => obs.push({...ob,contractName:c.name,contractId:c.id}));
    });

    if (cFilter!=='all') obs = obs.filter(o=>o.contractId===cFilter);
    if (search) obs = obs.filter(o=>o.obligation.toLowerCase().includes(search)||o.party.toLowerCase().includes(search)||o.contractName.toLowerCase().includes(search));
    const f = State.currentTrackerFilter;
    if (f==='overdue')  obs=obs.filter(o=>o.status!=='complete'&&o.deadline&&Utils.daysUntil(o.deadline)<0);
    else if (f==='due-soon') obs=obs.filter(o=>o.status!=='complete'&&o.deadline&&Utils.daysUntil(o.deadline)>=0&&Utils.daysUntil(o.deadline)<=30);
    else if (f==='pending')  obs=obs.filter(o=>o.status==='pending');
    else if (f==='complete') obs=obs.filter(o=>o.status==='complete');

    obs.sort((a,b)=>{
      if (a.status==='complete'&&b.status!=='complete') return 1;
      if (a.status!=='complete'&&b.status==='complete') return -1;
      return (a.deadline?Utils.daysUntil(a.deadline):9999)-(b.deadline?Utils.daysUntil(b.deadline):9999);
    });

    const el = document.getElementById('tracker-list');
    if (!el) return;
    if (!obs.length) { el.innerHTML=`<div class="empty-state"><span class="empty-icon">✅</span><h3>No obligations match</h3><p>Adjust filters or upload contracts</p></div>`; return; }
    el.innerHTML = obs.map(ob=>{
      const done=ob.status==='complete';
      return `<div class="obligation-item ${Utils.urgencyClass(ob.deadline)} ${done?'complete':''}">
        <div class="obligation-content">
          <div class="obligation-text">${Utils.esc(ob.obligation)}</div>
          <div class="obligation-meta">
            <span class="badge badge-info">${Utils.esc(ob.party)}</span>
            <span class="badge badge-pending">${Utils.esc(ob.type||'General')}</span>
            <span class="source-ref" onclick="Router.navigate('detail','${ob.contractId}')" style="cursor:pointer">📂 ${Utils.esc(ob.contractName)}</span>
          </div>
          ${ob.deadlineDescription?`<div class="text-xs text-muted mt-1">📅 ${Utils.esc(ob.deadlineDescription)}</div>`:''}
        </div>
        <div class="obligation-actions">
          ${Utils.daysBadge(ob.deadline)}
          <button class="btn btn-sm ${done?'btn-secondary':'btn-ghost'}" onclick="App.toggleObligation('${ob.contractId}','${ob.id}')">
            ${done?'↩ Reopen':'✓ Done'}
          </button>
        </div>
      </div>`;
    }).join('');
  },

  // ─── ALERTS ──────────────────────────────────────────────────
  renderAlerts() {
    const win = parseInt(document.getElementById('alert-window-select')?.value||'90');
    let alerts = this.buildAlerts(win);
    const cat = State.currentAlertFilter;
    if (cat!=='all') alerts = alerts.filter(a=>a.category===cat);
    const el = document.getElementById('alerts-list');
    if (!el) return;
    if (!alerts.length) { el.innerHTML=`<div class="empty-state"><span class="empty-icon">🔔</span><h3>No alerts</h3><p>No deadlines in the selected window</p></div>`; return; }
    el.innerHTML = alerts.map(a=>this.alertCardHTML(a)).join('');
  },

  // ─── COMPARE ─────────────────────────────────────────────────
  renderCompare() {
    const opts = State.contracts.map(c=>`<option value="${c.id}">${Utils.esc(c.name)}</option>`).join('');
    ['compare-a-select','compare-b-select'].forEach(id=>{
      const sel = document.getElementById(id);
      if (sel) sel.innerHTML = `<option value="">— Select contract —</option>${opts}`;
    });
    if (State.currentContractId) {
      const selA = document.getElementById('compare-a-select');
      if (selA) selA.value = State.currentContractId;
    }
    document.getElementById('compare-results')?.classList.add('hidden');
    document.getElementById('compare-processing')?.classList.add('hidden');
  },

  // ─── SETTINGS ────────────────────────────────────────────────
  renderSettings() {
    const u = Auth.getUser();
    const s = State.userSettings;
    if (u) {
      const nameEl  = document.getElementById('settings-name');
      const emailEl = document.getElementById('settings-email');
      if (nameEl)  nameEl.value      = u.name  || '';
      if (emailEl) emailEl.textContent = u.email || '';
    }
    if (s) {
      const model = document.getElementById('model-select');
      if (model) model.value = s.model || 'gemini-1.5-flash';
      const crit = document.getElementById('critical-threshold');
      if (crit) crit.value  = s.criticalThreshold || 14;
      const warn = document.getElementById('warning-threshold');
      if (warn) warn.value  = s.warningThreshold  || 45;

      // Show global-key banner
      const banner = document.getElementById('global-key-banner');
      if (banner) {
        if (s.globalKeyActive) {
          banner.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:13px;font-weight:600;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);color:#6ee7b7';
          banner.innerHTML = '✅ <span>Global API key is <strong>active</strong> — AI features work for all users automatically. You can optionally add a personal key to override it.</span>';
        } else if (!s.hasPersonalKey) {
          banner.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:13px;font-weight:600;background:rgba(245,158,11,.08);border:1px solid rgba(245,158,11,.28);color:#fde68a';
          banner.innerHTML = '⚠️ <span>No API key configured. Edit <code style="background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;font-family:monospace">.env</code> and set <code style="background:rgba(0,0,0,.3);padding:2px 6px;border-radius:4px;font-family:monospace">GEMINI_API_KEY</code>, or add a personal key below.</span>';
        } else {
          banner.style.cssText = 'display:flex;align-items:center;gap:12px;padding:12px 16px;border-radius:10px;margin-bottom:16px;font-size:13px;font-weight:600;background:rgba(79,141,255,.1);border:1px solid rgba(79,141,255,.3);color:#93c5fd';
          banner.innerHTML = '🔑 <span>Personal API key is active. Your key takes priority over any global key.</span>';
        }
      }
    }
    this.updateApiKeyPill(s?.hasApiKey);
  },

  updateApiKeyPill(hasKey) {
    const pill  = document.getElementById('api-key-pill');
    const label = document.getElementById('api-key-pill-label');
    const dot   = document.getElementById('api-key-dot');
    if (!pill) return;
    pill.className = `api-key-pill ${hasKey?'ok':'miss'}`;
    if (label) label.textContent = hasKey ? 'API Key Active' : 'No API Key';
    if (dot)   dot.style.color   = hasKey ? 'var(--emerald)' : 'var(--rose)';
  },
};

// ═══════════════════════════════════════════════════════════════
// UPLOAD MANAGER
// ═══════════════════════════════════════════════════════════════
const Upload = {
  open() {
    document.getElementById('upload-modal')?.classList.add('open');
    document.getElementById('upload-form-state')?.classList.remove('hidden');
    document.getElementById('upload-processing-state')?.classList.add('hidden');
    document.getElementById('upload-name').value = '';
    document.getElementById('upload-notes').value = '';
    document.getElementById('file-selected')?.classList.add('hidden');
    document.getElementById('upload-dropzone').style.display = '';
    State.uploadFile = null;
  },
  close() {
    document.getElementById('upload-modal')?.classList.remove('open');
  },
  handleFile(file) {
    if (!file) return;
    State.uploadFile = file;
    document.getElementById('upload-dropzone').style.display = 'none';
    document.getElementById('file-selected')?.classList.remove('hidden');
    document.getElementById('file-name-display').textContent = file.name;
    document.getElementById('file-size-display').textContent = Utils.fileSize(file.size);
    const nameEl = document.getElementById('upload-name');
    if (!nameEl.value) nameEl.value = file.name.replace(/\.[^.]+$/,'').replace(/[-_]/g,' ');
  },
  setProgress(pct, title, desc) {
    const p = document.getElementById('upload-progress');
    if (p) p.style.width = pct + '%';
    const t = document.getElementById('upload-step-title');
    if (t && title) t.textContent = title;
    const d = document.getElementById('upload-step-desc');
    if (d && desc)  d.textContent = desc;
  },
  async startAnalysis() {
    if (!State.uploadFile)    { Toast.warning('Please select a file.'); return; }
    const name = document.getElementById('upload-name').value.trim();
    if (!name) { Toast.warning('Please enter a contract name.'); return; }
    const type  = document.getElementById('upload-type').value;
    const notes = document.getElementById('upload-notes').value.trim();

    document.getElementById('upload-form-state')?.classList.add('hidden');
    document.getElementById('upload-processing-state')?.classList.remove('hidden');
    this.setProgress(8, 'Uploading & Parsing…', 'Extracting text from document');

    try {
      // 1. Parse file on server
      const { text } = await BackendAPI.parseFile(State.uploadFile);
      this.setProgress(25, 'Creating Record…', 'Saving contract to database');

      // 2. Create contract record
      const contract = await BackendAPI.createContract({ name, type, notes, text, fileName: State.uploadFile.name });
      State.contracts.unshift(contract);
      this.setProgress(40, 'Sending to Gemini AI…', 'Extracting parties, dates, obligations');

      // 3. Run AI analysis
      const { analysis } = await BackendAPI.analyzeContract(contract.id);
      this.setProgress(95, 'Saving Results…', 'Storing analysis');

      // 4. Update local state
      const idx = State.contracts.findIndex(c => c.id === contract.id);
      if (idx !== -1) State.contracts[idx].analysis = analysis;

      this.setProgress(100, 'Complete!', '');
      await new Promise(r => setTimeout(r, 500));

      this.close();
      Toast.success(`"${name}" analyzed successfully!`);
      Router.navigate('detail', contract.id);
    } catch (err) {
      this.close();
      Toast.error(err.message || 'Analysis failed. Check your API key in Settings.');
    }
  },
};

// ═══════════════════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════════════════
const App = {
  async init() {
    if (!Auth.check()) return;

    // Load user info
    try {
      const me = await BackendAPI.getMe();
      State.userSettings = me;
      Auth.setUser({ ...Auth.getUser(), ...me });
      this.renderUserProfile(me);
      Views.updateApiKeyPill(me.hasApiKey);
    } catch (e) {
      if (e.message === 'Session expired') return;
    }

    // Load contracts
    try {
      State.contracts = await BackendAPI.getContracts();
    } catch { State.contracts = []; }

    this.bindAll();
    Router.navigate('dashboard');
  },

  renderUserProfile(user) {
    const avatar = document.getElementById('user-avatar');
    const name   = document.getElementById('user-name');
    const email  = document.getElementById('user-email');
    if (avatar) avatar.textContent = (user.avatar || user.name?.charAt(0) || '?').toUpperCase();
    if (name)   name.textContent   = user.name || 'User';
    if (email)  email.textContent  = user.email || '';
  },

  async toggleObligation(contractId, obId) {
    const c = State.contracts.find(x => x.id === contractId);
    if (!c?.analysis) return;
    const ob = (c.analysis.obligations||[]).find(o=>o.id===obId);
    if (!ob) return;
    ob.status = ob.status==='complete' ? 'pending' : 'complete';

    try {
      await BackendAPI.updateContract(contractId, { analysis: c.analysis });
      if (State.currentView==='detail') Views.renderObligationsList(c,'obligations-list',State.currentOFilter,State.currentOFilterStatus);
      if (State.currentView==='tracker') Views.renderTracker();
      Router.updateAlertsBadge();
      Toast.success(`Obligation marked as ${ob.status}`);
    } catch { Toast.error('Failed to update obligation.'); ob.status = ob.status==='complete'?'pending':'complete'; }
  },

  bindAll() {
    // Nav
    document.querySelectorAll('.nav-item[data-view]').forEach(item => {
      item.addEventListener('click', () => Router.navigate(item.dataset.view));
    });

    // Logout
    document.getElementById('logout-btn')?.addEventListener('click', () => {
      if (confirm('Sign out of ContractLens?')) Auth.logout();
    });
    document.getElementById('signout-btn')?.addEventListener('click', () => {
      if (confirm('Sign out of ContractLens?')) Auth.logout();
    });

    // Dashboard quick actions
    document.getElementById('qa-upload')?.addEventListener('click', () => Upload.open());
    document.getElementById('qa-compare')?.addEventListener('click', () => Router.navigate('compare'));
    document.getElementById('qa-tracker')?.addEventListener('click', () => Router.navigate('tracker'));
    document.getElementById('welcome-upload-btn')?.addEventListener('click', () => Upload.open());
    document.getElementById('welcome-settings-btn')?.addEventListener('click', () => Router.navigate('settings'));

    // FAB
    document.getElementById('fab-btn')?.addEventListener('click', () => Upload.open());

    // Upload modal
    document.getElementById('upload-btn-top')?.addEventListener('click', () => Upload.open());
    document.getElementById('library-upload-btn')?.addEventListener('click', () => Upload.open());
    document.getElementById('upload-modal-close')?.addEventListener('click', () => Upload.close());
    document.getElementById('upload-cancel-btn')?.addEventListener('click', () => Upload.close());
    document.getElementById('upload-modal')?.addEventListener('click', e => { if (e.target===document.getElementById('upload-modal')) Upload.close(); });

    const fi = document.getElementById('file-input');
    fi?.addEventListener('change', e => { if (e.target.files[0]) Upload.handleFile(e.target.files[0]); });

    const dz = document.getElementById('upload-dropzone');
    dz?.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('drag-over'); });
    dz?.addEventListener('dragleave', () => dz.classList.remove('drag-over'));
    dz?.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('drag-over'); if (e.dataTransfer.files[0]) Upload.handleFile(e.dataTransfer.files[0]); });
    document.getElementById('start-analysis-btn')?.addEventListener('click', () => Upload.startAnalysis());

    // Library
    document.getElementById('library-search')?.addEventListener('input', () => Views.renderLibrary());
    document.getElementById('sort-select')?.addEventListener('change', () => Views.renderLibrary());
    document.querySelectorAll('.filter-chip[data-filter]').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('.filter-chip[data-filter]').forEach(b=>b.classList.remove('active'));
        c.classList.add('active');
        State.currentFilter = c.dataset.filter;
        Views.renderLibrary();
      });
    });

    // Detail
    document.getElementById('detail-back-btn')?.addEventListener('click', () => Router.navigate('library'));
    document.getElementById('detail-compare-btn')?.addEventListener('click', () => Router.navigate('compare'));
    document.getElementById('detail-delete-btn')?.addEventListener('click', async () => {
      const id = State.currentContractId;
      const c  = State.contracts.find(x=>x.id===id);
      if (!c || !confirm(`Delete "${c.name}"? This cannot be undone.`)) return;
      try {
        await BackendAPI.deleteContract(id);
        State.contracts = State.contracts.filter(x=>x.id!==id);
        Toast.success('Contract deleted.');
        Router.navigate('library');
      } catch { Toast.error('Failed to delete contract.'); }
    });

    // Tabs
    document.querySelectorAll('.tab[data-tab]').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach(t=>t.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(tc=>tc.classList.remove('active'));
        tab.classList.add('active');
        document.getElementById(`tab-${tab.dataset.tab}`)?.classList.add('active');
      });
    });

    // Obligation status filters
    document.querySelectorAll('[data-ofilter-status]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('[data-ofilter-status]').forEach(b=>b.classList.remove('active'));
        btn.classList.add('active');
        State.currentOFilterStatus = btn.dataset.ofilterStatus;
        const c = State.contracts.find(x=>x.id===State.currentContractId);
        if (c) Views.renderObligationsList(c,'obligations-list',State.currentOFilter,State.currentOFilterStatus);
      });
    });

    // Tracker
    document.getElementById('tracker-search')?.addEventListener('input', () => Views.renderTracker());
    document.getElementById('tracker-contract-filter')?.addEventListener('change', () => Views.renderTracker());
    document.querySelectorAll('[data-tfilter]').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('[data-tfilter]').forEach(b=>b.classList.remove('active'));
        c.classList.add('active');
        State.currentTrackerFilter = c.dataset.tfilter;
        Views.renderTracker();
      });
    });

    // Alerts
    document.getElementById('alert-window-select')?.addEventListener('change', () => Views.renderAlerts());
    document.querySelectorAll('[data-afilter]').forEach(c => {
      c.addEventListener('click', () => {
        document.querySelectorAll('[data-afilter]').forEach(b=>b.classList.remove('active'));
        c.classList.add('active');
        State.currentAlertFilter = c.dataset.afilter;
        Views.renderAlerts();
      });
    });

    // Compare
    document.getElementById('run-compare-btn')?.addEventListener('click', async () => {
      const idA = document.getElementById('compare-a-select')?.value;
      const idB = document.getElementById('compare-b-select')?.value;
      if (!idA||!idB) { Toast.warning('Select two contracts to compare.'); return; }
      if (idA===idB) { Toast.warning('Select two different contracts.'); return; }
      if (!State.userSettings?.hasApiKey) { Toast.error('Please add your API key in Settings.'); Router.navigate('settings'); return; }

      document.getElementById('compare-results')?.classList.add('hidden');
      document.getElementById('compare-processing')?.classList.remove('hidden');
      try {
        const result = await BackendAPI.compareContracts(idA, idB);
        document.getElementById('compare-processing')?.classList.add('hidden');
        document.getElementById('compare-results')?.classList.remove('hidden');
        const cA = State.contracts.find(c=>c.id===idA);
        const cB = State.contracts.find(c=>c.id===idB);
        document.getElementById('compare-a-label').textContent = cA?.name||'Contract A';
        document.getElementById('compare-b-label').textContent = cB?.name||'Contract B';

        const sumEl = document.getElementById('compare-summary-text');
        if (sumEl) sumEl.innerHTML = `<p>${Utils.esc(result.summary||'')}</p>
          ${result.majorChanges?.length?`<div class="divider"></div><div class="fw-700 text-sm mb-3">Major Changes (${result.changeCount||result.majorChanges.length})</div>
            ${result.majorChanges.map(ch=>`<div class="flex items-start gap-3 mb-3"><span class="badge badge-${ch.severity?.toLowerCase()||'medium'}">${ch.severity||'Medium'}</span><div><div class="fw-700 text-sm">${Utils.esc(ch.category)}</div><div class="text-sm text-secondary">${Utils.esc(ch.description)}</div></div></div>`).join('')}`:''}
          ${result.recommendation?`<div class="highlight-box mt-4"><strong>Recommendation:</strong> ${Utils.esc(result.recommendation)}</div>`:''}`;

        document.getElementById('compare-a-content').innerHTML = `<span class="diff-context">${Utils.esc('Contract A text loaded — see AI summary for key differences.')}</span>`;
        document.getElementById('compare-b-content').innerHTML = `<span class="diff-context">${Utils.esc('Contract B text loaded — see AI summary for key differences.')}</span>`;
        Toast.success('Comparison complete!');
      } catch(err) {
        document.getElementById('compare-processing')?.classList.add('hidden');
        Toast.error(err.message||'Comparison failed.');
      }
    });

    // Settings
    document.getElementById('save-name-btn')?.addEventListener('click', async () => {
      const name = document.getElementById('settings-name')?.value.trim();
      if (!name) { Toast.warning('Please enter a name.'); return; }
      try {
        await BackendAPI.saveSettings({ name });
        const u = Auth.getUser();
        Auth.setUser({ ...u, name });
        this.renderUserProfile({ ...u, name });
        Toast.success('Name updated!');
      } catch { Toast.error('Failed to update name.'); }
    });

    document.getElementById('save-api-key-btn')?.addEventListener('click', async () => {
      const val = document.getElementById('api-key-input')?.value.trim();
      if (!val) { Toast.warning('Please enter an API key.'); return; }
      if (!val.startsWith('sk-ant-')) Toast.warning('API key should start with "sk-ant-"');
      try {
        await BackendAPI.saveSettings({ apiKey: val });
        State.userSettings = { ...State.userSettings, hasApiKey: true };
        document.getElementById('api-key-input').value = '';
        Views.updateApiKeyPill(true);
        Toast.success('API key saved securely!');
      } catch { Toast.error('Failed to save API key.'); }
    });

    document.getElementById('model-select')?.addEventListener('change', async e => {
      try { await BackendAPI.saveSettings({ model: e.target.value }); Toast.success('Model updated.'); } catch {}
    });
    document.getElementById('critical-threshold')?.addEventListener('change', async e => {
      try { await BackendAPI.saveSettings({ criticalThreshold: parseInt(e.target.value) }); } catch {}
    });
    document.getElementById('warning-threshold')?.addEventListener('change', async e => {
      try { await BackendAPI.saveSettings({ warningThreshold: parseInt(e.target.value) }); } catch {}
    });

    // Export / Import
    const doExport = async () => {
      try {
        const data = await BackendAPI.exportData();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type:'application/json' });
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = `contractlens-export-${new Date().toISOString().slice(0,10)}.json`;
        a.click(); URL.revokeObjectURL(url);
        Toast.success('Data exported!');
      } catch { Toast.error('Export failed.'); }
    };
    document.getElementById('export-btn')?.addEventListener('click', doExport);
    document.getElementById('export-data-btn')?.addEventListener('click', doExport);

    document.getElementById('import-data-input')?.addEventListener('change', async e => {
      const file = e.target.files[0];
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!Array.isArray(data.contracts)) throw new Error('Invalid format');
        const { imported } = await BackendAPI.importData(data.contracts);
        State.contracts = await BackendAPI.getContracts();
        Toast.success(`Imported ${imported} contracts!`);
        Router.navigate('library');
      } catch { Toast.error('Import failed. Check the file format.'); }
      e.target.value = '';
    });

    // Chat
    const sendChat = async () => {
      const input = document.getElementById('chat-input');
      const q = input?.value?.trim();
      if (!q) return;
      const c = State.contracts.find(x => x.id === State.currentContractId);
      if (!c?.analysis) { Toast.warning('Contract not yet analyzed.'); return; }

      input.value = '';
      input.disabled = true;
      document.getElementById('chat-send-btn').disabled = true;
      this.addChatMsg('user', q);

      const typingEl = document.createElement('div');
      typingEl.className = 'chat-message assistant';
      typingEl.innerHTML = `<div class="chat-avatar">⚖️</div><div class="chat-bubble"><div class="chat-typing"><span></span><span></span><span></span></div></div>`;
      document.getElementById('chat-messages')?.appendChild(typingEl);
      this.scrollChat();

      try {
        State.chatHistory.push({ role:'user', content:q });
        const { response } = await BackendAPI.chat(c.id, State.chatHistory);
        State.chatHistory.push({ role:'assistant', content:response });
        if (State.chatHistory.length > 8) State.chatHistory = State.chatHistory.slice(-8);
        typingEl.remove();
        this.addChatMsg('assistant', response);
      } catch(err) {
        typingEl.remove();
        this.addChatMsg('assistant', `Sorry, I encountered an error: ${err.message}`);
      }

      input.disabled = false;
      document.getElementById('chat-send-btn').disabled = false;
      input.focus();
    };

    document.getElementById('chat-send-btn')?.addEventListener('click', sendChat);
    document.getElementById('chat-input')?.addEventListener('keydown', e => { if (e.key==='Enter'&&!e.shiftKey) { e.preventDefault(); sendChat(); } });
  },

  addChatMsg(role, text) {
    const el = document.createElement('div');
    el.className = `chat-message ${role}`;
    const formatted = Utils.esc(text)
      .replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,'<em>$1</em>')
      .replace(/`(.*?)`/g,'<code style="background:rgba(0,0,0,.4);padding:1px 5px;border-radius:3px;font-family:monospace;font-size:12px">$1</code>')
      .replace(/\n\n/g,'<br><br>').replace(/\n/g,'<br>');
    el.innerHTML = `<div class="chat-avatar">${role==='assistant'?'⚖️':'👤'}</div><div class="chat-bubble">${formatted}</div>`;
    document.getElementById('chat-messages')?.appendChild(el);
    this.scrollChat();
  },

  scrollChat() {
    const c = document.getElementById('chat-messages');
    if (c) c.scrollTop = c.scrollHeight;
  },
};

// ═══════════════════════════════════════════════════════════════
// INIT — check auth then boot
// ═══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  window.Router = Router;
  window.Views  = Views;
  window.Upload = Upload;
  window.App    = App;

  if (!Auth.getToken()) {
    window.location.href = '/login.html';
    return;
  }
  App.init();
});
