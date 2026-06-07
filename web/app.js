// Cars With Fares — Command Center (vanilla SPA)
let token = localStorage.getItem('cc_token') || ''
const app = document.getElementById('app')
const $ = (s, el = document) => el.querySelector(s)
const money = (n) => '$' + Number(n || 0).toLocaleString()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ago = (d) => {
  if (!d) return ''
  const s = (Date.now() - new Date(d).getTime()) / 1000
  const m = Math.floor(s / 60); if (m < 60) return m + 'm ago'
  const h = Math.floor(m / 60); if (h < 24) return h + 'h ago'
  return Math.floor(h / 24) + 'd ago'
}

async function api(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
  })
  if (r.status === 401) { token = ''; localStorage.removeItem('cc_token'); renderLogin(); throw new Error('401') }
  return r.json()
}

/* ---------------- login ---------------- */
function renderLogin(msg = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="brand">Cars With Fares</div>
    <div class="brand-sub">Command Center</div>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password" />
    <button id="go">Enter</button>
    <div class="err">${esc(msg)}</div>
  </div></div>`
  const pw = $('#pw'); pw.focus()
  $('#go').onclick = login
  pw.onkeydown = (e) => { if (e.key === 'Enter') login() }
}
async function login() {
  const password = $('#pw').value
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) })
  if (!r.ok) return renderLogin('Wrong password')
  token = (await r.json()).token
  localStorage.setItem('cc_token', token)
  renderApp('today')
}

/* ---------------- shell ---------------- */
const TABS = [['today', 'Today'], ['pipeline', 'Pipeline'], ['money', 'Money']]
function setView(html) { $('.view').innerHTML = html }
async function renderApp(tab = 'today') {
  app.innerHTML = `<div class="topbar">
      <div class="logo">CWF</div>
      <div class="tabs">${TABS.map(([k, l]) => `<button class="tab ${k === tab ? 'on' : ''}" data-tab="${k}">${l}</button>`).join('')}</div>
      <button class="signout" id="signout">Sign out</button>
    </div><div class="view"><div class="loading">Loading…</div></div>`
  app.querySelectorAll('.tab').forEach((b) => (b.onclick = () => renderApp(b.dataset.tab)))
  $('#signout').onclick = () => { token = ''; localStorage.removeItem('cc_token'); renderLogin() }
  try {
    if (tab === 'today') await viewToday()
    else if (tab === 'pipeline') await viewPipeline()
    else if (tab === 'money') await viewMoney()
  } catch (e) { /* 401 already handled */ }
}

/* ---------------- today ---------------- */
function focusLine(s, leads) {
  if (leads.length) return `<b>${leads.length} lead${leads.length > 1 ? 's' : ''} waiting.</b> Call the freshest first — speed is the #1 thing that closes them.`
  return `No leads in the pipe right now. You're at <b>${money(s.revenue)}</b> across ${s.paid_jobs || 0} paid jobs (avg ${money(s.avg_ticket)}). Time to feed the machine.`
}
async function viewToday() {
  const d = await api('/api/today'); const s = d.stats || {}; const leads = d.leads || []
  setView(`
    <div class="kpis">
      <div class="kpi"><div class="kpi-n">${money(s.revenue)}</div><div class="kpi-l">Revenue</div></div>
      <div class="kpi"><div class="kpi-n">${s.paid_jobs || 0}</div><div class="kpi-l">Paid jobs</div></div>
      <div class="kpi"><div class="kpi-n">${money(s.avg_ticket)}</div><div class="kpi-l">Avg ticket</div></div>
      <div class="kpi"><div class="kpi-n">${s.new_leads || 0}</div><div class="kpi-l">New leads</div></div>
    </div>
    <div class="brief"><span class="ai-tag">Today</span><div>${focusLine(s, leads)}</div></div>
    <div class="section-h">New leads</div>
    ${leads.length ? `<div class="lead-list">${leads.map(leadRow).join('')}</div>` : `<div class="empty">Nothing's rotting. Go get a lead.</div>`}
    <div class="section-h">Recent jobs</div>
    <div class="lead-list">${(d.recent || []).map(jobLine).join('') || `<div class="empty">No jobs yet.</div>`}</div>
  `)
  bindContact()
}
function jobLine(j) {
  return `<div class="lead-row">
    <div class="grow"><div class="nm">${esc(j.name || 'Unknown')}</div><div class="sub">${esc(j.issue || '')}</div></div>
    <span class="amt">${money(j.charge || j.est_value)}</span>
    <span class="status-pill ${esc(j.status)}">${esc(j.status)}</span>
  </div>`
}
function leadRow(l) {
  const band = l.ai_band ? `<span class="pill ${l.ai_band}">${l.ai_score || ''} ${l.ai_band}</span>` : ''
  return `<div class="lead-row">
    <div class="grow"><div class="nm">${esc(l.name || 'Unknown')}</div>
      <div class="sub">${esc(l.issue || 'No detail')} · ${ago(l.created_at)}</div></div>
    ${band}
    <button class="btn-sm" data-contact="${l.id}">${l.first_contact_at ? 'Contacted' : 'Mark contacted'}</button>
  </div>`
}
function bindContact() {
  app.querySelectorAll('[data-contact]').forEach((b) => (b.onclick = async () => {
    await api(`/api/jobs/${b.dataset.contact}/contact`, { method: 'POST' }); renderApp('today')
  }))
}

/* ---------------- pipeline ---------------- */
const COLS = [['lead', 'Lead'], ['quoted', 'Quoted'], ['scheduled', 'Scheduled'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['paid', 'Paid']]
async function viewPipeline() {
  const d = await api('/api/jobs'); const jobs = d.jobs || []
  setView(`
    <div class="pipe-actions"><button class="btn-primary" id="addlead">+ Add lead</button></div>
    <div class="board">${COLS.map(([k, label]) => {
      const items = jobs.filter((j) => j.status === k)
      return `<div class="col"><div class="col-h">${label}<span class="count">${items.length}</span></div>
        ${items.map(jobCard).join('') || '<div class="col-empty">—</div>'}</div>`
    }).join('')}</div>`)
  $('#addlead').onclick = openAddLead
  app.querySelectorAll('[data-advance]').forEach((b) => (b.onclick = async () => {
    await api(`/api/jobs/${b.dataset.advance}/advance`, { method: 'POST' }); renderApp('pipeline')
  }))
}
function jobCard(j) {
  const val = j.charge || j.est_value
  const canAdvance = j.status !== 'paid' && j.status !== 'lost'
  return `<div class="card">
    <div class="nm">${esc(j.customer || 'Unknown')}</div>
    <div class="sub">${esc([j.vehicle, j.issue].filter(Boolean).join(' · ') || 'No detail')}</div>
    <div class="row">
      <span class="val">${val ? money(val) : '—'}</span>
      ${canAdvance ? `<button class="adv" data-advance="${j.id}">Advance →</button>` : (j.is_high_ticket ? '<span class="ht">HIGH TICKET</span>' : '')}
    </div>
  </div>`
}
function openAddLead() {
  const wrap = document.createElement('div'); wrap.className = 'modal'
  wrap.innerHTML = `<div class="modal-card">
    <h3>New lead</h3>
    <input id="m-name" placeholder="Name" />
    <input id="m-phone" placeholder="Phone" />
    <input id="m-vehicle" placeholder="Vehicle (e.g. 2014 BMW 335i)" />
    <input id="m-issue" placeholder="What's wrong / the job" />
    <input id="m-est" placeholder="Estimated value ($)" inputmode="numeric" />
    <div class="modal-row"><button class="btn-ghost" id="m-cancel">Cancel</button><button class="btn-primary" id="m-save">Add lead</button></div>
  </div>`
  document.body.appendChild(wrap)
  $('#m-cancel', wrap).onclick = () => wrap.remove()
  wrap.onclick = (e) => { if (e.target === wrap) wrap.remove() }
  $('#m-save', wrap).onclick = async () => {
    const body = {
      name: $('#m-name', wrap).value, phone: $('#m-phone', wrap).value,
      vehicle: $('#m-vehicle', wrap).value, issue: $('#m-issue', wrap).value, est_value: $('#m-est', wrap).value,
    }
    if (!body.name && !body.phone) return
    await api('/api/leads', { method: 'POST', body: JSON.stringify(body) })
    wrap.remove(); renderApp('pipeline')
  }
}

/* ---------------- money ---------------- */
async function viewMoney() {
  const d = await api('/api/money'); const goal = (d.targets && d.targets.goal_monthly_revenue) || 4800
  const pct = Math.min(100, Math.round(((d.revenue || 0) / goal) * 100))
  setView(`
    <div class="kpis">
      <div class="kpi"><div class="kpi-n">${money(d.revenue)}</div><div class="kpi-l">Revenue (all-time)</div></div>
      <div class="kpi"><div class="kpi-n">${money(d.avg_ticket)}</div><div class="kpi-l">Avg ticket</div></div>
      <div class="kpi"><div class="kpi-n">${d.paid || 0}</div><div class="kpi-l">Paid jobs</div></div>
      <div class="kpi"><div class="kpi-n">${d.active || 0}</div><div class="kpi-l">In progress</div></div>
    </div>
    <div class="goal-wrap">
      <div class="lab"><span>Monthly goal</span><span class="mono">${money(d.revenue)} / ${money(goal)}</span></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
    </div>
    <div class="section-h">Funnel</div>
    <div class="funnel">
      <div class="kpi"><div class="kpi-n">${d.leads || 0}</div><div class="kpi-l">Leads</div></div>
      <div class="kpi"><div class="kpi-n">${d.active || 0}</div><div class="kpi-l">Active</div></div>
      <div class="kpi"><div class="kpi-n">${d.paid || 0}</div><div class="kpi-l">Won</div></div>
      <div class="kpi"><div class="kpi-n">${d.lost || 0}</div><div class="kpi-l">Lost</div></div>
    </div>
  `)
}

/* ---------------- boot ---------------- */
if (token) renderApp('today'); else renderLogin()
