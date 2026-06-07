// Cars With Fares — Command Center (vanilla SPA)
let token = localStorage.getItem('cc_token') || ''
let tab = 'pulse'
const app = document.getElementById('app')
const $ = (s, el = document) => el.querySelector(s)
const money = (n) => '$' + Math.round(Number(n || 0)).toLocaleString()
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
const ago = (d) => { if (!d) return ''; const s = (Date.now() - new Date(d).getTime()) / 1000; const m = Math.floor(s / 60); if (m < 60) return m + 'm'; const h = Math.floor(m / 60); if (h < 24) return h + 'h'; return Math.floor(h / 24) + 'd' }

async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) } })
  if (r.status === 401) { token = ''; localStorage.removeItem('cc_token'); renderLogin(); throw new Error('401') }
  return r.json()
}

const I = {
  today: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 9.5 12 3l9 6.5V21H3z"/><path d="M9 21v-7h6v7"/></svg>',
  pipeline: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="4" width="5" height="16" rx="1"/><rect x="10" y="4" width="5" height="11" rx="1"/><rect x="17" y="4" width="4" height="7" rx="1"/></svg>',
  money: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M13 2 4 14h7l-1 8 9-12h-7z"/></svg>',
  spark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.8 5.4L19 9l-5.2 1.6L12 16l-1.8-5.4L5 9l5.2-1.6z"/></svg>',
  phone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 4h4l2 5-3 2a14 14 0 0 0 6 6l2-3 5 2v4a2 2 0 0 1-2 2A18 18 0 0 1 3 6a2 2 0 0 1 2-2z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M5 12l5 5L19 7"/></svg>',
}
const STATUS_COLOR = { lead: 'var(--fg4)', quoted: 'var(--yellow)', scheduled: 'var(--navy)', in_progress: 'var(--accent)', completed: 'var(--green)', paid: 'var(--green)', lost: 'var(--red)' }
const NAV_GROUPS = [
  ['Acquire', [['pulse', 'Pulse', I.spark], ['triage', 'Triage', I.bolt]]],
  ['Operate', [['pipeline', 'Pipeline', I.pipeline], ['calendar', 'Calendar', I.today], ['quotes', 'Quotes', I.money], ['customers', 'Customers', I.today], ['money', 'Money', I.money]]],
  ['Grow', [['field', 'Field', I.pipeline], ['activation', 'Activation', I.bolt], ['proof', 'Proof', I.check], ['content', 'Studio', I.spark]]],
  ['Plan', [['handoffs', 'To Claude Code', I.spark], ['vault', 'Vault', I.spark], ['templates', 'Templates', I.arrow], ['backburner', 'Back-burner', I.arrow]]],
]
const FLAT = NAV_GROUPS.flatMap(([, items]) => items)
const TITLE = { pulse: 'Pulse', triage: 'Triage', pipeline: 'Pipeline', calendar: 'Calendar', quotes: 'Quotes', customers: 'Customers', money: 'Money', field: 'Field', activation: 'Activation', proof: 'Proof', content: 'Studio', handoffs: 'To Claude Code', vault: 'Vault', assets: 'Vault', templates: 'Templates', backburner: 'Back-burner' }

/* ---------------- login ---------------- */
function renderLogin(msg = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
    <div class="login-brand"><svg class="cwf-mark" viewBox="0 0 24 24" width="46" height="46" fill="none" role="img" aria-label="Cars With Fares" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="var(--steel)" stroke-width="1.6"/><path d="M12 3a9 9 0 0 1 7.79 4.5" stroke="var(--accent)" stroke-width="1.9" stroke-linecap="round"/><path d="M9.4 14.6 12 8.2l2.6 6.4" stroke="var(--accent)" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/><circle cx="12" cy="15.4" r="1.15" fill="var(--fg)"/></svg></div>
    <div class="mark">Cars With Fares</div><div class="sub">Command Center</div>
    <input id="pw" type="password" placeholder="Password" autocomplete="current-password" />
    <button id="go">Enter</button><div class="err">${esc(msg)}</div>
  </div></div>`
  $('#pw').focus()
  $('#go').onclick = login
  $('#pw').onkeydown = (e) => { if (e.key === 'Enter') login() }
}
async function login() {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: $('#pw').value }) })
  if (!r.ok) return renderLogin('Wrong password')
  token = (await r.json()).token; localStorage.setItem('cc_token', token); renderApp('today')
}

/* ---------------- shell ---------------- */
function setView(html) { $('.view').innerHTML = html }
async function renderApp(next) {
  tab = next || tab
  app.innerHTML = `
    <div class="shell">
      <aside class="side">
        <div class="side__logo">
          <svg class="cwf-mark" viewBox="0 0 24 24" width="28" height="28" fill="none" role="img" aria-label="Cars With Fares" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" stroke="var(--steel)" stroke-width="1.6"/><path d="M12 3a9 9 0 0 1 7.79 4.5" stroke="var(--accent)" stroke-width="1.9" stroke-linecap="round"/><path d="M9.4 14.6 12 8.2l2.6 6.4" stroke="var(--accent)" stroke-width="1.9" stroke-linejoin="round" stroke-linecap="round"/><circle cx="12" cy="15.4" r="1.15" fill="var(--fg)"/></svg>
          <span class="side__wm"><b>Cars With Fares</b><i>Command Center</i></span>
        </div>
        ${NAV_GROUPS.map(([grp, items]) => `<div class="nav-group">${grp}</div>` + items.map(([k, l, ic]) => `<button class="nav-item ${k === tab ? 'on' : ''}" data-tab="${k}">${ic}<span>${l}</span></button>`).join('')).join('')}
        <div class="side__foot"><div class="side__biz"><span class="dot"></span>Cars With Fares</div></div>
      </aside>
      <div class="main">
        <header class="topbar"><h1>${TITLE[tab]}</h1><div class="right"></div></header>
        <div class="view"><div class="loading">Loading…</div></div>
      </div>
    </div>
    <nav class="bottombar">${FLAT.map(([k, l, ic]) => `<button class="${k === tab ? 'on' : ''}" data-tab="${k}">${ic}<span>${l}</span></button>`).join('')}</nav>`
  app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => renderApp(b.dataset.tab)))
  try {
    if (tab === 'pulse') await viewPulse()
    else if (tab === 'pipeline') await viewPipeline()
    else if (tab === 'money') await viewMoney()
    else if (tab === 'activation') await viewActivation()
    else if (tab === 'quotes') await viewQuotes()
    else if (tab === 'backburner') await viewBackburner()
else if (tab === 'triage') await viewTriage()
else if (tab === 'customers') await viewCustomers()
else if (tab === 'templates') await viewTemplates()
else if (tab === 'proof') await viewProof()
else if (tab === 'content') await viewContent()
else if (tab === 'vault') await viewVault()
else if (tab === 'assets') await viewVault()
else if (tab === 'calendar') await viewCalendar()
else if (tab === 'field') await viewField()
else if (tab === 'handoffs') await viewHandoffs()
  } catch (e) { /* 401 handled */ }
}

function tierBadge(j) {
  if (j.ticket_tier === 'HIGH') return `<span class="ai-score high">${I.spark}HIGH</span>`
  return `<span class="ai-score">${I.spark}Standard</span>`
}
function emptyState(ttl, sub) { return `<div class="empty"><div class="ic">${I.bolt}</div><div class="ttl">${esc(ttl)}</div><div class="sub">${esc(sub)}</div></div>` }

/* ---------------- PULSE ---------------- */
function gauge(score) {
  const r = 54, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(100, score)) / 100)
  const col = score >= 66 ? '#44D07F' : score >= 33 ? '#E0922E' : '#F6736B'
  return `<svg viewBox="0 0 132 132" width="132" height="132" style="flex-shrink:0">
    <circle cx="66" cy="66" r="${r}" fill="none" stroke="#1a1d22" stroke-width="9"/>
    <circle id="gring" class="gauge-ring" cx="66" cy="66" r="${r}" fill="none" stroke="${col}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${circ.toFixed(1)}" data-target="${off.toFixed(1)}" transform="rotate(-90 66 66)"/>
    <text id="gscore" x="66" y="64" text-anchor="middle" fill="#F4F5F7" font-size="34" font-weight="700" font-family="'JetBrains Mono',monospace">${Math.round(Math.max(0, Math.min(100, score)))}</text>
    <text x="66" y="84" text-anchor="middle" fill="#868B98" font-size="9" letter-spacing="1.5">ENERGY</text></svg>`
}
function countUp(el, to, dur = 950) {
  if (!el) return; const start = performance.now()
  const step = (t) => { const p = Math.min(1, (t - start) / dur); el.textContent = Math.round(p * to); if (p < 1) requestAnimationFrame(step) }
  requestAnimationFrame(step)
}
function bdChip(name, val) { return `<span class="bd-chip"><span>${name}</span><b>${Math.round(val || 0)}</b></span>` }
function voiceCard(title, value, status, sub, question) {
  return `<div class="vcard"><div class="vh"><span class="vdot ${status || 'bad'}"></span><span class="vt">${title}</span></div>
    <div class="vv">${esc(value)}</div><div class="vs">${esc(sub)}</div><div class="vq">${esc(question)}</div></div>`
}
function goalBar(name, val, target, isMoney) {
  const pct = Math.min(100, Math.round((val / (target || 1)) * 100)); const f = (n) => isMoney ? money(n) : n
  return `<div class="gb"><div class="gb__top"><span>${name}</span><b class="num">${f(val)} / ${f(target)}</b></div>
    <div class="goal__track"><div class="goal__fill ${pct >= 100 ? 'over' : ''}" data-w="${pct}%" style="width:0"></div></div></div>`
}
function sparkline(trend) {
  const slots = 14, data = (trend || []).slice(-slots)
  if (!data.length) return `<div class="spark-empty">No history yet — your daily reads will plot here as the loop runs.</div>`
  const max = Math.max(...data.map((t) => t.score || 0), 1), pad = slots - data.length, bars = []
  for (let i = 0; i < pad; i++) bars.push(`<i style="height:4px;opacity:.18"></i>`)
  data.forEach((t, i) => bars.push(`<i class="${i === data.length - 1 ? 'now' : ''}" style="height:${Math.max(5, Math.round(((t.score || 0) / max) * 44))}px"></i>`))
  return `<div class="spark">${bars.join('')}</div>`
}
function needsPanel(n) {
  const rows = []
  if (n && n.hot) rows.push(`<div class="lrow" data-job="${n.hot.id}"><div class="grow"><div class="nm">Call ${esc(n.hot.customer)} now</div><div class="sub">hot lead, no reply yet</div></div><span class="pill in_progress"><span class="dot"></span>now</span></div>`)
  if (n && n.stale) rows.push(`<div class="lrow"><div class="grow"><div class="nm">${n.stale} lead${n.stale > 1 ? 's' : ''} going stale</div><div class="sub">no movement in 3+ days</div></div></div>`)
  if (n && n.unpaid) rows.push(`<div class="lrow"><div class="grow"><div class="nm">${n.unpaid} job${n.unpaid > 1 ? 's' : ''} completed, unpaid</div><div class="sub">collect the money</div></div></div>`)
  return rows.length ? `<div class="list">${rows.join('')}</div>` : `<div class="needs-clear">Nothing's slipping. Go transmit.</div>`
}
function fmtReply(m) { if (m == null) return 'no replies yet'; if (m < 60) return m + 'm reply'; if (m < 1440) return Math.round(m / 60) + 'h reply'; return Math.round(m / 1440) + 'd reply' }
async function viewPulse() {
  const d = await api('/api/pulse'); const e = d.energy || {}, v = d.voice || {}, om = d.oneMove || {}, g = d.goals || {}
  const lc = e.label === 'Gaining' ? 'g' : e.label === 'Bleeding' ? 'b' : 'w'
  const deltaTxt = e.delta == null ? 'first read' : (e.delta > 0 ? `▲ ${e.delta} vs last` : e.delta < 0 ? `▼ ${Math.abs(e.delta)} vs last` : 'flat vs last')
  const bd = e.breakdown || {}
  const tr = $('.topbar .right')
  if (tr) { tr.innerHTML = `<span class="topdate">${new Date().toLocaleDateString('en-CA', { weekday: 'long', month: 'short', day: 'numeric' })}</span><button class="btn primary sm" id="newlead">${I.plus} New lead</button>`; const nl = $('#newlead'); if (nl) nl.onclick = openAddLead }
  setView(`
    <div class="pulse-grid">
      <div class="energy-hero panel ${lc}">${gauge(e.score || 0)}
        <div class="energy-meta">
          <div class="energy-label ${lc}">${esc(e.label || '')}</div>
          <div class="energy-delta">${deltaTxt}</div>
          <div class="energy-bd">${bdChip('Acquire', bd.acquisition)}${bdChip('Convert', bd.conversion)}${bdChip('Trust', bd.trust)}${bdChip('Cash', bd.cash)}</div>
        </div>
      </div>
      <div class="one-move"><div class="om-tag">${I.bolt} Do this now</div>
        <div class="om-title">${esc(om.title || '')}</div><div class="om-why">${esc(om.why || '')}</div>
        ${om.cta ? `<button class="btn primary" id="om-go">${esc(om.cta)}</button>` : ''}</div>
    </div>
    <div class="sec-h"><span class="label">The voice</span></div>
    <div class="triptych">
      ${voiceCard('Transmit', `${v.transmit ? v.transmit.posts_wk : 0}/${v.transmit ? v.transmit.cadence : 3} posts`, v.transmit && v.transmit.status, v.transmit && v.transmit.findable ? 'Findable on Google' : 'Not findable yet', 'Did the voice go out?')}
      ${voiceCard('Hear', `${v.hear ? v.hear.new_leads : 0} new`, v.hear && v.hear.status, 'inbound this week', 'Did anyone hear it?')}
      ${voiceCard('Respond', `${v.respond ? v.respond.open_leads : 0} open`, v.respond && v.respond.status, fmtReply(v.respond ? v.respond.median_reply : null), 'Did you answer fast?')}
    </div>
    <div class="mini-panels" style="margin-top:var(--s5)">
      <div class="panel"><div class="mini-h">Needs you</div>${needsPanel(d.needs)}</div>
      <div class="panel"><div class="mini-h">Momentum · last 14 days</div>${sparkline(d.trend)}</div>
    </div>
    <div class="sec-h"><span class="label">This week</span></div>
    <div class="panel goals-panel">
      ${goalBar('Leads', (v.hear ? v.hear.new_leads : 0) || 0, g.weekly_leads || 3)}
      ${goalBar('Revenue', d.rev_wk || 0, g.weekly_revenue || 1200, true)}
      ${goalBar('Posts', (v.transmit ? v.transmit.posts_wk : 0) || 0, g.posting_cadence || 3)}
    </div>
  `)
  bindRows()
  // Map the one-move to its guided gate playbook — these are deep walk-throughs, not flag-flips.
  const OM_GATE = { gbp: 'gbp', reviews: 'reviews', post: 'content' }
  const go = $('#om-go'); if (go) go.onclick = async () => {
    if (om.key === 'reply' && om.job_id) { openJob(om.job_id); return }
    if (OM_GATE[om.key]) { openPlaybook(OM_GATE[om.key], { onClose: () => renderApp('pulse') }); return }
    await api('/api/pulse/action', { method: 'POST', body: JSON.stringify({ key: om.key }) }); renderApp('pulse')
  }
  setTimeout(() => {
    const ring = $('#gring'); if (ring) ring.style.strokeDashoffset = ring.dataset.target
    app.querySelectorAll('.goal__fill[data-w]').forEach((f) => { f.style.width = f.dataset.w })
  }, 50)
  countUp($('#gscore'), e.score || 0)
  setTimeout(() => { const s = $('#gscore'); if (s) s.textContent = e.score || 0 }, 1100)
}

/* ---------------- TODAY ---------------- */
async function viewToday() {
  const d = await api('/api/today'); const s = d.stats || {}
  const sec = (title, rows, empty) => rows && rows.length
    ? `<div class="sec-h"><span class="label">${title}</span><span class="ct">${rows.length}</span></div><div class="list">${rows.map(leadRow).join('')}</div>`
    : `<div class="sec-h"><span class="label">${title}</span></div><div class="lrow" style="color:var(--fg4);justify-content:center">${esc(empty)}</div>`
  setView(`
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Revenue</div><div class="val">${money(s.revenue)}</div><div class="meta">all-time</div></div>
      <div class="kpi"><div class="lab">Paid jobs</div><div class="val">${s.paid_jobs || 0}</div><div class="meta">avg ${money(s.avg_ticket)}</div></div>
      <div class="kpi"><div class="lab">Open</div><div class="val">${s.open_jobs || 0}</div><div class="meta">in pipeline</div></div>
      <div class="kpi"><div class="lab">New leads</div><div class="val">${s.new_leads || 0}</div><div class="meta">waiting</div></div>
    </div>
    <div class="brief"><span class="tag">${I.spark} Briefing</span><p>${esc(d.brief || '')}</p></div>
    ${sec('Call first', d.callFirst, 'No leads to call — turn on an activation gate.')}
    ${d.scheduledToday && d.scheduledToday.length ? sec('Scheduled today', d.scheduledToday) : ''}
    ${d.stale && d.stale.length ? sec('Going stale', d.stale) : ''}
    ${d.unpaid && d.unpaid.length ? sec('Money owed', d.unpaid) : ''}
  `)
  bindRows()
}
function leadRow(j) {
  return `<div class="lrow" data-job="${j.id}">
    <div class="grow"><div class="nm">${esc(j.customer || 'Unknown')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
      <div class="sub">${esc([j.vehicle, j.issue].filter(Boolean).join(' · ') || 'No detail')} · ${ago(j.created_at)} ago</div></div>
    ${tierBadge(j)}
    <span class="amt">${j.charge || j.est_value ? money(j.charge || j.est_value) : ''}</span>
  </div>`
}
function bindRows() { app.querySelectorAll('[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job))) }

/* ---------------- PIPELINE ---------------- */
const COLS = [['lead', 'Lead'], ['quoted', 'Quoted'], ['scheduled', 'Scheduled'], ['in_progress', 'In progress'], ['completed', 'Completed'], ['paid', 'Paid']]
async function viewPipeline() {
  const d = await api('/api/jobs'); const jobs = d.jobs || []
  $('.topbar .right').innerHTML = `<button class="btn primary" id="addlead">${I.plus} Add lead</button>`
  $('#addlead').onclick = openAddLead
  setView(`<div class="board">${COLS.map(([k, label]) => {
    const items = jobs.filter((j) => j.status === k)
    const sum = items.reduce((a, j) => a + (Number(j.charge || j.est_value) || 0), 0)
    return `<div class="col"><div class="col__h"><span class="dot" style="background:${STATUS_COLOR[k]}"></span>
      <span class="ttl">${label}</span><span class="ct">${items.length}</span>${sum ? `<span class="sum">${money(sum)}</span>` : ''}</div>
      <div class="col__b">${items.map(jobCard).join('') || '<div class="col__empty">—</div>'}</div></div>`
  }).join('')}</div>`)
  bindRows()
  app.querySelectorAll('[data-adv]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); await api(`/api/jobs/${b.dataset.adv}/advance`, { method: 'POST' }); renderApp('pipeline') }))
}
function jobCard(j) {
  const val = j.charge || j.est_value
  const canAdv = j.status !== 'paid' && j.status !== 'lost'
  return `<div class="jc" data-job="${j.id}">
    <div class="jc__top"><div><div class="nm">${esc(j.customer || 'Unknown')}</div>${j.vehicle ? `<div class="veh">${esc(j.vehicle)}</div>` : ''}</div>${tierBadge(j)}</div>
    <div class="iss">${esc(j.issue || j.service || '')}</div>
    <div class="jc__foot">${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}
      <span class="val">${val ? money(val) : '—'}</span>
      ${canAdv ? `<button class="btn ghost sm" data-adv="${j.id}">${I.arrow}</button>` : ''}</div>
  </div>`
}

/* ---------------- MONEY ---------------- */
async function viewMoney() {
  const d = await api('/api/money'); const t = d.targets || {}
  const goal = t.target_revenue || 4800
  const pct = Math.min(100, Math.round(((d.revenue || 0) / goal) * 100))
  const fn = d.funnel || {}
  const fstep = (name, val, target, max) => `<div class="fstep"><span class="fname">${name}</span>
    <div class="fbar"><i style="width:${Math.max(4, Math.round((val / (max || 1)) * 100))}%"></i></div>
    <span class="fval">${typeof val === 'number' && name === 'Revenue' ? money(val) : (val || 0)}</span></div>`
  const maxF = Math.max(fn.views || 0, fn.contacts || 0, fn.jobs || 0, 1)
  setView(`
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Revenue</div><div class="val">${money(d.revenue)}</div><div class="meta">all-time</div></div>
      <div class="kpi"><div class="lab">Profit</div><div class="val">${money(d.profit)}</div><div class="meta">charge − parts − gas</div></div>
      <div class="kpi"><div class="lab">Avg ticket</div><div class="val">${money(d.avg_ticket)}</div><div class="meta">${d.paid || 0} paid</div></div>
      <div class="kpi"><div class="lab">Rolling 12mo</div><div class="val">${money(d.rolling12)}</div><div class="meta">HST reg at $30k</div></div>
    </div>
    <div class="sec-h"><span class="label">Monthly goal</span></div>
    <div class="panel"><div class="goal__lab"><span style="color:var(--fg2);font-weight:600">${money(d.revenue)} of ${money(goal)}</span><span class="num" style="color:var(--fg3)">${pct}%</span></div>
      <div class="goal__track"><div class="goal__fill ${pct >= 100 ? 'over' : ''}" style="width:${pct}%"></div></div></div>
    <div class="sec-h"><span class="label">Funnel · Views → Contacts → Jobs → Revenue</span></div>
    <div class="panel"><div class="funnel">
      ${fstep('Views', fn.views || 0, t.target_views, maxF)}
      ${fstep('Contacts', fn.contacts || 0, t.target_contacts, maxF)}
      ${fstep('Jobs', fn.jobs || 0, t.target_jobs, maxF)}
      ${fstep('Revenue', fn.revenue || 0, goal, goal)}
    </div>
    <p style="color:var(--fg3);font-size:12px;margin-top:var(--s4)">Cheapest levers are close-rate &amp; ticket size — not traffic. To hit ${money(goal)} you need ~${Math.ceil(goal / (d.avg_ticket || 925))} jobs at the ${money(d.avg_ticket || 925)} avg.</p></div>
  `)
}

/* ---------------- ACTIVATION (guided gates) ---------------- */
// Each gate opens its real playbook — a step-by-step checklist with instructions,
// snippets to copy, links to open, and steps you can hand to Claude Code. The
// checklist drives the gate to done; the old status dropdown is now a tiny override.
async function viewActivation() {
  const d = await api('/api/activation'); const items = d.items || []
  const done = items.filter((i) => i.status === 'done').length
  const next = items.find((i) => i.status !== 'done')
  setView(`
    <div class="brief"><span class="tag">${I.bolt} The machine is built — this turns it ON</span>
      <p>${done} of ${items.length} gates lit. These aren't checkboxes — tap one and it walks you through the actual moves, step by step, with the copy-paste and links right there.${next ? ` Do this next: <b>${esc(next.label)}</b>.` : ' Every gate is live — you’re fully on.'}</p></div>
    <div class="sec-h"><span class="label">Activation gates</span><span class="ct">${done}/${items.length}</span></div>
    <div class="list">${items.map(actRow).join('')}</div>
  `)
  const open = (el) => openPlaybook(el.dataset.actKey, { onClose: () => renderApp('activation') })
  app.querySelectorAll('[data-act]').forEach((el) => {
    el.onclick = (e) => { if (e.target.closest('.act__check') || e.target.closest('select')) return; open(el) }
    el.querySelector('.act__check').onclick = (e) => {
      e.stopPropagation()
      const cur = el.dataset.status; const nx = cur === 'done' ? 'todo' : 'done'
      api(`/api/activation/${el.dataset.act}`, { method: 'PATCH', body: JSON.stringify({ status: nx }) }).then(() => renderApp('activation'))
    }
    const sel = el.querySelector('select')
    if (sel) { sel.onclick = (e) => e.stopPropagation(); sel.onchange = async (e) => { e.stopPropagation(); await api(`/api/activation/${el.dataset.act}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); renderApp('activation') } }
  })
}
function actRow(it) {
  const on = it.status === 'done'
  const doing = it.status === 'doing'
  return `<div class="act guided ${on ? 'done' : ''}" data-act="${it.id}" data-act-key="${esc(it.key)}" data-status="${it.status}">
    <div class="act__check ${on ? 'on' : ''}" title="Manual override">${on ? I.check : ''}</div>
    <div class="grow"><div class="nm">${esc(it.label)}</div><div class="un">${esc(it.unlocks || '')}</div>
      ${doing ? `<div class="act-mini"><i style="width:50%"></i></div>` : ''}</div>
    ${on ? '<span class="act-pct">done</span>' : doing ? '<span class="act-pct">in progress</span>' : ''}
    <select title="Manual override"><option value="todo" ${it.status === 'todo' ? 'selected' : ''}>To do</option>
      <option value="doing" ${it.status === 'doing' ? 'selected' : ''}>Doing</option>
      <option value="done" ${it.status === 'done' ? 'selected' : ''}>Done</option></select>
    <span class="act-open">${I.arrow}</span>
  </div>`
}

/* ---------------- JOB DRAWER ---------------- */
async function openJob(id) {
  const d = await api(`/api/jobs/${id}`); const j = d.job
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer">
    <div class="drawer__h"><span class="pill ${j.status}"><span class="dot"></span>${j.status.replace('_', ' ')}</span>
      <button class="drawer__close">${I.x}</button></div>
    <div class="drawer__b">
      <div><div class="t-h2">${esc(j.customer || 'Unknown')}</div>
        <div style="color:var(--fg3);font-size:13px;margin-top:2px">${esc([j.vehicle, j.location].filter(Boolean).join(' · '))}</div></div>
      <div style="display:flex;gap:var(--s2);flex-wrap:wrap">${tierBadge(j)}${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}
        ${j.charge || j.est_value ? `<span class="pill" style="color:var(--fg);background:var(--bg4)">${money(j.charge || j.est_value)}</span>` : ''}</div>
      <div style="color:var(--fg2);font-size:13px">${esc(j.issue || 'No detail')}</div>
      <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
        ${j.phone ? `<a class="btn ghost sm" href="tel:${esc(j.phone)}">${I.phone} Call</a>` : ''}
        ${j.status !== 'paid' && j.status !== 'lost' ? `<button class="btn ghost sm" id="dadv">${I.arrow} Advance</button>` : ''}
        <button class="btn ghost sm" id="dreply">Quick reply</button>
        <button class="btn ghost sm" id="drecontact">${I.plus} Check-in</button>
        ${j.status === 'lead' || j.status === 'quoted' ? `<button class="btn primary sm" id="dwon">${I.check} Mark won</button>` : ''}
        <button class="btn ghost sm" id="dsched">${I.today} ${j.scheduled_date ? 'Reschedule' : 'Schedule'}</button>
        <button class="btn ghost sm" id="dquote">Quote</button></div>
      <div><div class="label" style="margin-bottom:var(--s2)">Files &amp; photos</div><div class="asset-host">Loading…</div></div>
      <div><div class="label" style="margin-bottom:var(--s2)">Activity</div>
        <div class="tl">${(d.activity || []).map((a) => `<div class="tl__i"><span class="dot"></span><div><div class="body">${esc(a.body || a.type)}</div><div class="when">${ago(a.created_at)} ago</div></div></div>`).join('') || '<span style="color:var(--fg4);font-size:12px">No activity yet</span>'}</div></div>
    </div></aside>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close; $('.drawer__close', wrap).onclick = close
  const adv = $('#dadv', wrap); if (adv) adv.onclick = async () => { await api(`/api/jobs/${id}/advance`, { method: 'POST' }); close(); renderApp() }
  $('#dquote', wrap).onclick = () => { close(); openQuote(j) }
  const dsc = $('#dsched', wrap); if (dsc) dsc.onclick = () => { close(); openSchedule(j) }
  const dr = $('#dreply', wrap); if (dr) dr.onclick = () => openQuickReply(j)
  const rc = $('#drecontact', wrap); if (rc) rc.onclick = () => openRecontact(j)
  const won = $('#dwon', wrap); if (won) won.onclick = async () => {
    won.disabled = true
    const res = await api(`/api/jobs/${id}/won`, { method: 'POST' })
    close(); showWonChecklist(res, j.customer); renderApp()
  }
  const ah = $('.asset-host', wrap); if (ah) loadAssets(id, ah)
}

/* ---------------- QUOTE MODAL ($1k profit floor) ---------------- */
function openQuote(j) {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Quote · ${esc(j.customer || '')}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Flat price (no tax)</label><input class="input" id="q-charge" inputmode="numeric" placeholder="$" value="${j.charge || ''}"></div>
      <div class="field"><label>Parts cost</label><input class="input" id="q-parts" inputmode="numeric" placeholder="$" value="${j.parts_cost || ''}"></div>
      <div class="field"><label>Gas / travel</label><input class="input" id="q-gas" inputmode="numeric" placeholder="$" value="${j.gas_cost || ''}"></div>
      <div class="profit-readout" id="q-read"><span>Your profit</span><span class="v">$0</span></div>
      <div class="floor-warn" id="q-warn" style="display:none">Below the $1,000 profit floor — re-price the job, not the hour.</div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="q-save">Save quote</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  const recalc = () => {
    const c = Number($('#q-charge', wrap).value) || 0, p = Number($('#q-parts', wrap).value) || 0, g = Number($('#q-gas', wrap).value) || 0
    const profit = c - p - g, bad = profit < 1000
    const read = $('#q-read', wrap); read.className = 'profit-readout ' + (bad ? 'bad' : 'ok')
    $('.v', read).textContent = money(profit)
    $('#q-warn', wrap).style.display = bad && c ? 'block' : 'none'
  }
  wrap.querySelectorAll('input').forEach((i) => (i.oninput = recalc)); recalc()
  $('#q-save', wrap).onclick = async () => {
    await api(`/api/jobs/${j.id}/quote`, { method: 'POST', body: JSON.stringify({ charge: $('#q-charge', wrap).value, parts_cost: $('#q-parts', wrap).value, gas_cost: $('#q-gas', wrap).value }) })
    close(); renderApp()
  }
}

/* ---------------- ADD LEAD MODAL ---------------- */
function openAddLead() {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">New lead</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Name</label><input class="input" id="l-name" placeholder="Customer name"></div>
      <div class="field"><label>Phone</label><input class="input" id="l-phone" placeholder="Phone"></div>
      <div class="field"><label>Vehicle</label><input class="input" id="l-veh" placeholder="2014 BMW 335i"></div>
      <div class="field"><label>What's wrong / the job</label><input class="input" id="l-issue" placeholder="e.g. clunking front end, suspension"></div>
      <div class="field"><label>Estimated value</label><input class="input" id="l-est" inputmode="numeric" placeholder="$"></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="l-save">Add lead</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#l-save', wrap).onclick = async () => {
    const body = { name: $('#l-name', wrap).value, phone: $('#l-phone', wrap).value, vehicle: $('#l-veh', wrap).value, issue: $('#l-issue', wrap).value, est_value: $('#l-est', wrap).value }
    if (!body.name && !body.phone) return
    await api('/api/leads', { method: 'POST', body: JSON.stringify(body) }); close(); renderApp('pipeline')
  }
}

/* ---------------- boot ---------------- */
/* ===================== WAVE 2 · STOP THE LEAKS ===================== */

/* --- shared quote/age helpers --- */
const QUOTE_PILL = { draft: 'lead', sent: 'quoted', accepted: 'scheduled', declined: 'lost' }
const QUOTE_LABEL = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', declined: 'Declined' }
function ageTag(days) {
  const d = Math.max(0, Math.round(Number(days || 0)))
  const cls = d >= 3 ? 'age-tag stale' : 'age-tag'
  const txt = d === 0 ? 'today' : d === 1 ? '1 day' : d + ' days'
  return `<span class="${cls}">${txt}</span>`
}
function profitTag(profit, below) {
  return `<span class="profit-tag ${below ? 'bad' : 'ok'}">${money(profit)} profit</span>`
}

/* --- reusable Gone-quiet section (used on Pulse + standalone) --- */
async function quietSection() {
  let d
  try { d = await api('/api/quiet') } catch (e) { return '' }
  const items = d.quiet || []
  if (!items.length) return `<div class="needs-clear">Nobody's gone quiet. Everyone's been touched in the last 3 days.</div>`
  return `<div class="list">${items.map((j) => `
    <div class="lrow" data-job="${j.id}">
      <div class="grow"><div class="nm">${esc(j.customer || 'Unknown')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
        <div class="sub">${esc([j.vehicle, j.issue].filter(Boolean).join(' · ') || 'No detail')} · last touch ${j.last_touch ? ago(j.last_touch) + ' ago' : 'never'}</div></div>
      <span class="pill ${j.status}"><span class="dot"></span>${esc((j.status || '').replace('_', ' '))}</span>
      ${ageTag(j.quiet_days)}
    </div>`).join('')}</div>`
}

/* Inject the Gone-quiet panel + Close-out button into the Pulse after it renders.
   Additive: we wrap renderApp so existing pulse code is untouched. */
const _renderApp_w2 = renderApp
renderApp = async function (next) {
  await _renderApp_w2(next)
  if (tab !== 'pulse') return
  const tr = $('.topbar .right')
  if (tr && !$('#closeout-btn', tr)) {
    const btn = document.createElement('button')
    btn.className = 'btn ghost sm'; btn.id = 'closeout-btn'; btn.innerHTML = `${I.check} Close out`
    btn.onclick = openCloseout
    tr.appendChild(btn)
  }
  const mp = $('.mini-panels')
  if (mp && !$('.quiet-panel')) {
    const panel = document.createElement('div')
    panel.className = 'panel quiet-panel'
    panel.innerHTML = `<div class="mini-h">Gone quiet · 3+ days untouched</div><div class="quiet-body">Loading…</div>`
    mp.appendChild(panel)
    panel.querySelector('.quiet-body').innerHTML = await quietSection()
    panel.querySelectorAll('[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  }
  if (mp && !$('.attn-panel')) {
    const ap = document.createElement('div'); ap.innerHTML = await attentionPanel()
    if (ap.firstElementChild) { mp.appendChild(ap.firstElementChild); bindAttention(mp) }
  }
}

/* ===================== QUOTES ===================== */
async function viewQuotes() {
  const d = await api('/api/quotes'); const quotes = d.quotes || []; const s = d.summary || {}
  $('.topbar .right').innerHTML = `<button class="btn primary" id="addlead">${I.plus} Add lead</button>`
  $('#addlead').onclick = openAddLead
  const follow = quotes.filter((q) => q.needs_follow_up)
  const live = quotes.filter((q) => !q.needs_follow_up)
  const sec = (title, rows) => `<div class="sec-h"><span class="label">${title}</span><span class="ct">${rows.length}</span></div>` +
    (rows.length ? `<div class="list">${rows.map(quoteRow).join('')}</div>` : `<div class="lrow" style="color:var(--fg4);justify-content:center">None right now</div>`)
  setView(`
    <div class="kpis">
      <div class="kpi"><div class="lab">Open quotes</div><div class="val">${s.open || 0}</div><div class="meta">awaiting an answer</div></div>
      <div class="kpi ${s.needs_follow_up ? 'warn' : ''}"><div class="lab">Needs follow-up</div><div class="val">${s.needs_follow_up || 0}</div><div class="meta">sent 3+ days ago</div></div>
      <div class="kpi ${s.below_floor ? 'warn' : ''}"><div class="lab">Below floor</div><div class="val">${s.below_floor || 0}</div><div class="meta">under $1,000 profit</div></div>
      <div class="kpi primary"><div class="lab">Outstanding</div><div class="val">${money(s.outstanding_value)}</div><div class="meta">flat price on the table</div></div>
    </div>
    ${quotes.length ? '' : emptyState('No quotes yet', 'Quote a job from its drawer and it lands here — then you can chase it before it goes cold.')}
    ${follow.length ? sec('Chase these — sent 3+ days ago', follow) : ''}
    ${live.length ? sec('Live quotes', live) : ''}
  `)
  bindQuoteRows()
}
function quoteRow(q) {
  const st = q.quote_status || 'draft'
  const profit = (q.charge || 0) - (q.parts_cost || 0) - (q.gas_cost || 0)
  return `<div class="lrow qrow ${q.needs_follow_up ? 'flag' : ''}">
    <div class="grow" data-job="${q.id}">
      <div class="nm">${esc(q.customer || 'Unknown')} ${q.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
      <div class="sub">${esc([q.vehicle, q.issue || q.service].filter(Boolean).join(' · ') || 'No detail')}</div>
      <div class="qmeta">
        <span class="pill ${QUOTE_PILL[st]}"><span class="dot"></span>${QUOTE_LABEL[st]}</span>
        ${profitTag(q.profit != null ? q.profit : profit, q.below_floor != null ? q.below_floor : (q.profit != null ? q.profit : profit) < 1000)}
        ${st === 'sent' || st === 'accepted' || st === 'declined' ? ageTag(q.age_days) : ''}
      </div>
    </div>
    <div class="qright">
      <span class="amt">${q.charge ? money(q.charge) : '—'}</span>
      <div class="qacts">
        ${st !== 'sent' && st !== 'accepted' && st !== 'declined' ? `<button class="btn ghost sm" data-qs="sent" data-id="${q.id}">Mark sent</button>` : ''}
        ${st !== 'accepted' ? `<button class="btn primary sm" data-qs="accepted" data-id="${q.id}">${I.check} Won</button>` : ''}
        ${st !== 'declined' ? `<button class="btn ghost sm" data-qs="declined" data-id="${q.id}">Lost</button>` : ''}
      </div>
    </div>
  </div>`
}
function bindQuoteRows() {
  app.querySelectorAll('.qrow .grow[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  app.querySelectorAll('[data-qs]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation()
    await api(`/api/quotes/${b.dataset.id}/status`, { method: 'POST', body: JSON.stringify({ quote_status: b.dataset.qs }) })
    renderApp('quotes')
  }))
}

/* ===================== CLOSEOUT MODAL ===================== */
async function openCloseout() {
  const d = await api('/api/closeout'); const t = d.today || {}; const o = d.open || {}
  const quiet = o.quiet || []; const unpaid = o.unpaid || []; const sched = o.scheduledTomorrow || []
  const looseOpts = [
    ...unpaid.map((j) => ({ id: j.id, label: `Collect from ${j.customer || 'Unknown'} · ${money(j.charge || j.est_value)}` })),
    ...quiet.map((j) => ({ id: j.id, label: `Re-touch ${j.customer || 'Unknown'} · quiet ${j.quiet_days || 0}d` })),
  ]
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">End-of-day close-out</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="co-tally">
        <div class="co-stat"><div class="v num">${t.new_leads || 0}</div><div class="k">New leads</div></div>
        <div class="co-stat"><div class="v num">${t.quotes_sent || 0}</div><div class="k">Quotes sent</div></div>
        <div class="co-stat"><div class="v num">${t.completed || 0}</div><div class="k">Completed</div></div>
        <div class="co-stat"><div class="v num">${t.paid_jobs || 0}</div><div class="k">Paid</div></div>
        <div class="co-stat wide"><div class="v num" style="color:var(--green)">${money(t.collected)}</div><div class="k">Collected today</div></div>
      </div>
      <div class="co-open">
        <div class="co-line"><span>Unpaid jobs</span><b class="num">${unpaid.length}</b></div>
        <div class="co-line"><span>Gone quiet</span><b class="num">${quiet.length}</b></div>
        <div class="co-line"><span>Scheduled tomorrow</span><b class="num">${sched.length}</b></div>
      </div>
      <div class="field"><label>Roll a loose end into tomorrow</label>
        <select class="input" id="co-job"><option value="">— nothing to roll —</option>${looseOpts.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}</select></div>
      <div class="field"><label>Task title (optional)</label><input class="input" id="co-task" placeholder="e.g. Call back on the BMW suspension quote"></div>
      <div class="field"><label>End-of-day note (optional)</label><input class="input" id="co-note" placeholder="What happened today / what's on your mind"></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="co-save">${I.check} Close out the day</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#co-save', wrap).onclick = async () => {
    const note = $('#co-note', wrap).value.trim()
    const title = $('#co-task', wrap).value.trim()
    const jobId = $('#co-job', wrap).value
    const body = {}
    if (note) body.note = note
    if (jobId) body.job_id = Number(jobId)
    if (title) body.task = { title, job_id: jobId ? Number(jobId) : undefined }
    await api('/api/closeout', { method: 'POST', body: JSON.stringify(body) })
    close(); renderApp('pulse')
  }
}

/* ===================== BACK-BURNER ===================== */
async function viewBackburner() {
  const d = await api('/api/backburner'); const ideas = (d.ideas || []).filter((i) => i.status !== 'dismissed')
  $('.topbar .right').innerHTML = `<button class="btn primary" id="bb-add">${I.plus} Add idea</button>`
  $('#bb-add').onclick = openBackburner
  setView(`
    <div class="brief"><span class="tag">${I.bolt} Parking lot</span>
      <p>Strategic ideas that shouldn't die — but shouldn't nag you either. They sit here quietly. Promote one to a real task only when you're ready to act on it.</p></div>
    <div class="sec-h"><span class="label">Ideas</span><span class="ct">${ideas.length}</span></div>
    ${ideas.length ? `<div class="list">${ideas.map(bbRow).join('')}</div>`
      : emptyState('Back-burner is empty', 'Drop the big-picture moves here — the euro specialty push, the review flywheel, the tooling buy. Nothing gets lost.')}
  `)
  app.querySelectorAll('[data-bb-promote]').forEach((b) => (b.onclick = async () => {
    await api(`/api/backburner/${b.dataset.bbPromote}/promote`, { method: 'POST', body: JSON.stringify({}) })
    renderApp('backburner')
  }))
  app.querySelectorAll('[data-bb-archive]').forEach((b) => (b.onclick = async () => {
    await api(`/api/backburner/${b.dataset.bbArchive}/archive`, { method: 'POST' })
    renderApp('backburner')
  }))
}
function bbRow(it) {
  return `<div class="lrow bb-row">
    <div class="grow"><div class="nm">${esc(it.title)}</div>${it.body ? `<div class="sub">${esc(it.body)}</div>` : ''}
      <div class="sub" style="color:var(--fg4)">parked ${ago(it.created_at)} ago</div></div>
    <div class="qacts">
      <button class="btn primary sm" data-bb-promote="${it.id}">${I.arrow} Promote</button>
      <button class="btn ghost sm" data-bb-archive="${it.id}">Archive</button>
    </div>
  </div>`
}
function openBackburner() {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">New idea</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Idea</label><input class="input" id="bb-title" placeholder="e.g. Build out the euro-specialist landing pages"></div>
      <div class="field"><label>Detail (optional)</label><input class="input" id="bb-body" placeholder="Why it matters / first step"></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="bb-save">Park it</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#bb-save', wrap).onclick = async () => {
    const title = $('#bb-title', wrap).value.trim()
    if (!title) return
    await api('/api/backburner', { method: 'POST', body: JSON.stringify({ title, body: $('#bb-body', wrap).value.trim() || undefined }) })
    close(); renderApp('backburner')
  }
}

/* ===================== ATTENTION GUARD (settings) ===================== */
const ATTENTION_ROWS = [
  ['high_ticket_hot_lead', 'HIGH-TICKET hot lead', 'A big job comes in — interrupt me'],
  ['one_star_review', '1-star review', 'Reputation hit — interrupt me'],
  ['quote_accepted', 'Quote accepted', 'A quote turned into a yes'],
  ['completed_unpaid', 'Job done, unpaid', 'Money on the table'],
  ['new_lead', 'Any new lead', 'Every inbound — off by default, lives in the brief'],
]
async function viewBackburnerSettings() { /* reserved */ }
async function attentionPanel() {
  let d
  try { d = await api('/api/attention') } catch (e) { return '' }
  return `<div class="panel attn-panel">
    <div class="mini-h">Attention guard</div>
    <p style="color:var(--fg3);font-size:12px;margin:calc(-1 * var(--s2)) 0 var(--s3)">What's worth interrupting you for vs. what waits for the daily brief. No pushes wired up yet — this just sets the rule.</p>
    ${ATTENTION_ROWS.map(([k, label, sub]) => `
      <div class="attn-row">
        <div class="grow"><div class="nm">${esc(label)}</div><div class="sub">${esc(sub)}</div></div>
        <button class="toggle ${d[k] ? 'on' : ''}" data-attn="${k}"><span class="knob"></span></button>
      </div>`).join('')}
  </div>`
}
function bindAttention(scope) {
  (scope || app).querySelectorAll('[data-attn]').forEach((b) => (b.onclick = async () => {
    const k = b.dataset.attn; const on = !b.classList.contains('on')
    b.classList.toggle('on', on)
    await api('/api/attention', { method: 'PUT', body: JSON.stringify({ [k]: on }) })
  }))
}

/* ===================== WAVE 3 · PULL ENERGY IN ===================== */

/* --- shared: token fill for templates --- */
function fillTokens(body, ctx) {
  return String(body || '')
    .replace(/\{name\}/g, (ctx.name || 'there').trim())
    .replace(/\{vehicle\}/g, (ctx.vehicle || 'your car').trim())
    .replace(/\{issue\}/g, (ctx.issue || 'the job').trim())
}
async function copyText(text, btn) {
  try { await navigator.clipboard.writeText(text) }
  catch (e) {
    const ta = document.createElement('textarea'); ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0'
    document.body.appendChild(ta); ta.select(); try { document.execCommand('copy') } catch (_) {} ta.remove()
  }
  if (btn) { const old = btn.innerHTML; btn.innerHTML = `${I.check} Copied`; btn.classList.add('copied'); setTimeout(() => { btn.innerHTML = old; btn.classList.remove('copied') }, 1400) }
}

/* ===================== TEMPLATES ===================== */
const TPL_CATS = ['pricing', 'availability', 'first-contact', 'do-you-do', 'follow-up', 'other']
async function viewTemplates() {
  const d = await api('/api/templates'); const items = d.templates || []
  const tr = $('.topbar .right'); if (tr) { tr.innerHTML = `<button class="btn primary" id="tpl-add">${I.plus} New template</button>`; $('#tpl-add').onclick = () => openTemplate() }
  const groups = {}
  items.forEach((t) => { const c = t.category || 'other'; (groups[c] = groups[c] || []).push(t) })
  const order = TPL_CATS.filter((c) => groups[c]).concat(Object.keys(groups).filter((c) => !TPL_CATS.includes(c)))
  setView(`
    <div class="brief"><span class="tag">${I.bolt} Fast replies</span>
      <p>Your go-to answers, one tap away. Use {name}, {vehicle} and {issue} — when you fire one from a lead's drawer it fills itself in and copies, ready to paste. Trust and straight answers, never lead with price.</p></div>
    ${items.length
      ? order.map((c) => `<div class="sec-h"><span class="label">${esc(c.replace(/-/g, ' '))}</span><span class="ct">${groups[c].length}</span></div><div class="list">${groups[c].map(tplRow).join('')}</div>`).join('')
      : emptyState('No templates yet', 'Build your common replies once — pricing, availability, "do you do X", first contact, follow-up — then send them in one tap from any lead.')}
  `)
  app.querySelectorAll('[data-tpl-copy]').forEach((b) => (b.onclick = () => { const t = items.find((x) => String(x.id) === b.dataset.tplCopy); copyText(t ? t.body : '', b) }))
  app.querySelectorAll('[data-tpl-edit]').forEach((b) => (b.onclick = () => { const t = items.find((x) => String(x.id) === b.dataset.tplEdit); openTemplate(t) }))
  app.querySelectorAll('[data-tpl-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this template?')) return
    await api(`/api/templates/${b.dataset.tplDel}`, { method: 'DELETE' }); renderApp('templates')
  }))
}
function tplRow(t) {
  return `<div class="lrow tpl-row">
    <div class="grow"><div class="nm">${esc(t.label)}</div><div class="tpl-body">${esc(t.body)}</div></div>
    <div class="qacts">
      <button class="btn primary sm" data-tpl-copy="${t.id}">${I.check} Copy</button>
      <button class="btn ghost sm" data-tpl-edit="${t.id}">Edit</button>
      <button class="btn ghost sm" data-tpl-del="${t.id}">${I.x}</button>
    </div>
  </div>`
}
function openTemplate(t) {
  const editing = !!(t && t.id)
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">${editing ? 'Edit template' : 'New template'}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Category</label>
        <select class="input" id="tpl-cat">${TPL_CATS.map((c) => `<option value="${c}" ${(t && t.category) === c ? 'selected' : ''}>${esc(c.replace(/-/g, ' '))}</option>`).join('')}</select></div>
      <div class="field"><label>Label</label><input class="input" id="tpl-label" placeholder="e.g. Pricing — how it works" value="${esc(t ? t.label : '')}"></div>
      <div class="field"><label>Message · use {name} {vehicle} {issue}</label>
        <textarea class="input ta" id="tpl-text" rows="6" placeholder="Hey {name} — happy to take a look at {vehicle}…">${esc(t ? t.body : '')}</textarea></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="tpl-save">${editing ? 'Save changes' : 'Add template'}</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#tpl-save', wrap).onclick = async () => {
    const label = $('#tpl-label', wrap).value.trim(), body = $('#tpl-text', wrap).value.trim(), category = $('#tpl-cat', wrap).value
    if (!label || !body) return
    if (editing) await api(`/api/templates/${t.id}`, { method: 'PUT', body: JSON.stringify({ label, body, category }) })
    else await api('/api/templates', { method: 'POST', body: JSON.stringify({ label, body, category }) })
    close(); renderApp('templates')
  }
}

/* --- Quick reply picker (fired from the job drawer) --- */
async function openQuickReply(j) {
  let d; try { d = await api('/api/templates') } catch (e) { d = { templates: [] } }
  const items = d.templates || []
  const ctx = { name: (j.customer || '').split(' ')[0] || j.customer, vehicle: j.vehicle, issue: j.issue || j.service }
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Quick reply · ${esc(j.customer || '')}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      ${items.length ? `<div class="field"><label>Template</label>
        <select class="input" id="qr-pick">${items.map((t, i) => `<option value="${i}">${esc((t.category ? t.category.replace(/-/g, ' ') + ' · ' : '') + t.label)}</option>`).join('')}</select></div>
        <div class="field"><label>Filled for ${esc(j.customer || 'this lead')}</label><textarea class="input ta" id="qr-text" rows="7"></textarea></div>`
        : `<div class="empty" style="padding:var(--s5) 0"><div class="ttl">No templates yet</div><div class="sub">Add a few in Templates first, then fire them from here in one tap.</div></div>`}
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Close</button>${items.length ? `<button class="btn primary" id="qr-copy">${I.check} Copy reply</button>` : ''}</div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  if (items.length) {
    const pick = $('#qr-pick', wrap), txt = $('#qr-text', wrap)
    const sync = () => { txt.value = fillTokens(items[Number(pick.value) || 0].body, ctx) }
    pick.onchange = sync; sync()
    $('#qr-copy', wrap).onclick = () => copyText(txt.value, $('#qr-copy', wrap))
  }
}

/* ===================== TRIAGE ===================== */
async function viewTriage() {
  const d = await api('/api/triage'); const items = d.triage || []; const s = d.summary || {}
  const tr = $('.topbar .right'); if (tr) { tr.innerHTML = `<button class="btn primary" id="addlead">${I.plus} Add lead</button>`; $('#addlead').onclick = openAddLead }
  setView(`
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Open leads</div><div class="val">${s.total || 0}</div><div class="meta">to triage</div></div>
      <div class="kpi"><div class="lab">High-ticket</div><div class="val">${s.high || 0}</div><div class="meta">work these first</div></div>
      <div class="kpi ${s.safety ? 'warn' : ''}"><div class="lab">Safety</div><div class="val">${s.safety || 0}</div><div class="meta">flagged urgent</div></div>
      <div class="kpi ${s.uncontacted ? 'warn' : ''}"><div class="lab">Untouched</div><div class="val">${s.uncontacted || 0}</div><div class="meta">no first contact</div></div>
    </div>
    <div class="sec-h"><span class="label">Triage queue · money first</span><span class="ct">${items.length}</span></div>
    ${items.length ? `<div class="list">${items.map(triageRow).join('')}</div>`
      : emptyState('Queue is clear', 'No open leads waiting. When inbound comes in, the biggest jobs jump to the top here so your attention goes where the money is.')}
  `)
  bindTriage(items)
}
function triageRow(j) {
  const val = j.charge || j.est_value
  const uncontacted = !j.first_contact_at
  return `<div class="lrow trow ${j.ticket_tier === 'HIGH' ? 'hi' : ''}">
    <div class="grow" data-job="${j.id}">
      <div class="nm">${esc(j.customer || 'Unknown')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''} ${uncontacted ? '<span class="age-tag stale">new</span>' : ''}</div>
      <div class="sub">${esc([j.vehicle, j.issue || j.service].filter(Boolean).join(' · ') || 'No detail')} · ${ago(j.created_at)} ago</div>
      ${j.likely_cause ? `<div class="ai-read">${I.spark}<span>${esc(j.likely_cause)}</span></div>` : ''}
      <div class="qmeta">${tierBadge(j)}${val ? `<span class="age-tag" style="color:var(--fg)">${money(val)}</span>` : ''}</div>
    </div>
    <div class="qright">
      <div class="qacts">
        ${j.phone ? `<a class="btn primary sm" href="tel:${esc(j.phone)}">${I.phone} Call</a>` : ''}
        <button class="btn ghost sm" data-tri-reply="${j.id}">Reply</button>
        <button class="btn ghost sm" data-job="${j.id}">Open</button>
      </div>
    </div>
  </div>`
}
function bindTriage(items) {
  bindRows()
  app.querySelectorAll('.trow .grow[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  app.querySelectorAll('[data-tri-reply]').forEach((b) => (b.onclick = (e) => { e.stopPropagation(); const j = items.find((x) => String(x.id) === b.dataset.triReply); if (j) openQuickReply(j) }))
}

/* ===================== ASSETS (inside job drawer) ===================== */
const ASSET_KINDS = [['photo', 'Photo'], ['clip', 'Clip'], ['quote', 'Quote'], ['invoice', 'Invoice'], ['doc', 'Doc']]
function assetTile(a) {
  const isImg = a.kind === 'photo'
  return `<div class="asset" data-asset="${a.id}">
    <div class="asset__media ${isImg ? '' : 'doc'}">${isImg ? `<img src="${esc(a.url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">` : `<span class="asset__kind">${esc((a.kind || 'doc').toUpperCase())}</span>`}</div>
    <div class="asset__meta">
      <a class="asset__lbl" href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.label || a.kind || 'attachment')}</a>
      <div class="asset__sub">${esc((a.kind || 'doc'))}${a.is_before ? ' · before' : ''} · ${ago(a.created_at)} ago</div>
    </div>
    <button class="asset__del" data-asset-del="${a.id}" title="Remove">${I.x}</button>
  </div>`
}
async function loadAssets(jobId, host) {
  let d; try { d = await api(`/api/jobs/${jobId}/assets`) } catch (e) { d = { assets: [] } }
  const items = d.assets || []
  host.innerHTML = `
    ${items.length ? `<div class="asset-grid">${items.map(assetTile).join('')}</div>` : `<div class="asset-empty">Nothing attached yet — drop the customer's photos, the quote or the invoice so it stops living in your camera roll.</div>`}
    <div class="asset-add">
      <div class="field"><label>Paste a link</label><input class="input" id="as-url" placeholder="https://… (photo, drive, PDF)"></div>
      <div class="asset-add__row">
        <select class="input" id="as-kind">${ASSET_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="input" id="as-label" placeholder="Label (e.g. front brakes before)">
      </div>
      <label class="as-check"><input type="checkbox" id="as-before"> <span>This is a "before" shot</span></label>
      <button class="btn primary sm" id="as-save">${I.plus} Attach</button>
    </div>`
  host.querySelectorAll('[data-asset-del]').forEach((b) => (b.onclick = async () => {
    await api(`/api/assets/${b.dataset.assetDel}/delete`, { method: 'POST' }); loadAssets(jobId, host)
  }))
  const saveBtn = $('#as-save', host)
  saveBtn.onclick = async () => {
    const url = $('#as-url', host).value.trim(); if (!url) return
    saveBtn.disabled = true
    await api(`/api/jobs/${jobId}/assets`, { method: 'POST', body: JSON.stringify({ url, kind: $('#as-kind', host).value, label: $('#as-label', host).value.trim() || undefined, is_before: $('#as-before', host).checked }) })
    loadAssets(jobId, host)
  }
}

/* ===================== CUSTOMERS ===================== */
async function viewCustomers() {
  const tr = $('.topbar .right'); if (tr) tr.innerHTML = `<input class="input cust-search" id="cust-q" placeholder="Search name, phone, area…" autocomplete="off">`
  setView(`<div id="cust-wrap"><div class="loading">Loading…</div></div>`)
  const load = async (q) => {
    const d = await api('/api/customers' + (q ? '?q=' + encodeURIComponent(q) : '')); const list = d.customers || []
    $('#cust-wrap').innerHTML = list.length
      ? `<div class="sec-h"><span class="label">${q ? 'Matches' : 'All customers'}</span><span class="ct">${list.length}</span></div><div class="list">${list.map(custRow).join('')}</div>`
      : (q ? `<div class="empty" style="padding:var(--s7) 0"><div class="ic">${I.today}</div><div class="ttl">No match for "${esc(q)}"</div><div class="sub">Try a name, phone number, or area.</div></div>`
           : emptyState('No customers yet', 'Every lead you add becomes a customer here — their cars, their jobs, the whole history. Repeat work starts as a relationship you keep warm.'))
    $('#cust-wrap').querySelectorAll('[data-cust]').forEach((el) => (el.onclick = () => openCustomer(el.dataset.cust)))
  }
  await load('')
  const inp = $('#cust-q'); if (inp) { let t; inp.oninput = () => { clearTimeout(t); t = setTimeout(() => load(inp.value.trim()), 220) }; inp.focus() }
}
function custRow(c) {
  return `<div class="lrow cust-row" data-cust="${c.id}">
    <div class="cust-av">${esc((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</div>
    <div class="grow"><div class="nm">${esc(c.name || 'Unknown')}</div>
      <div class="sub">${esc([c.phone, c.location].filter(Boolean).join(' · ') || 'No contact detail')}</div></div>
    <div class="cust-stats">
      <span class="cs"><b class="num">${c.jobs || 0}</b> job${(c.jobs || 0) === 1 ? '' : 's'}</span>
      <span class="cs"><b class="num">${money(c.total_spent)}</b> spent</span>
      <span class="cs cs-last">${c.last_seen ? ago(c.last_seen) + ' ago' : 'new'}</span>
    </div>
  </div>`
}
async function openCustomer(id) {
  const d = await api(`/api/customers/${id}`); const c = d.customer || {}; const vehicles = d.vehicles || []; const jobs = d.jobs || []; const activity = d.activity || []
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer">
    <div class="drawer__h"><span class="cust-av">${esc((c.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>
      <div style="min-width:0"><div class="t-h2" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name || 'Unknown')}</div>
        <div style="color:var(--fg3);font-size:12px">${esc([c.phone, c.location].filter(Boolean).join(' · ') || 'No contact detail')}</div></div>
      <button class="drawer__close">${I.x}</button></div>
    <div class="drawer__b">
      <div class="cust-tally">
        <div class="co-stat"><div class="v num">${jobs.length}</div><div class="k">Jobs</div></div>
        <div class="co-stat"><div class="v num" style="color:var(--green)">${money(c.total_spent)}</div><div class="k">Lifetime</div></div>
        <div class="co-stat"><div class="v num">${vehicles.length}</div><div class="k">Vehicles</div></div>
      </div>
      <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
        ${c.phone ? `<a class="btn primary sm" href="tel:${esc(c.phone)}">${I.phone} Call</a>` : ''}
        ${c.source ? `<span class="pill lead"><span class="dot"></span>${esc(c.source)}</span>` : ''}
      </div>
      ${vehicles.length ? `<div><div class="label" style="margin-bottom:var(--s2)">Vehicles</div><div class="list">${vehicles.map((v) => `
        <div class="lrow"><div class="grow"><div class="nm">${esc([v.year, v.make, v.model].filter(Boolean).join(' ') || 'Vehicle')} ${v.is_euro ? '<span class="ai-score">euro</span>' : ''}</div>
          ${v.vin ? `<div class="sub num">${esc(v.vin)}</div>` : ''}</div></div>`).join('')}</div></div>` : ''}
      <div><div class="label" style="margin-bottom:var(--s2)">Jobs</div>
        ${jobs.length ? `<div class="list">${jobs.map(custJobRow).join('')}</div>` : '<span style="color:var(--fg4);font-size:12px">No jobs yet</span>'}</div>
      <div><div class="label" style="margin-bottom:var(--s2)">History</div>
        <div class="tl">${activity.length ? activity.map((a) => `<div class="tl__i"><span class="dot"></span><div><div class="body">${esc(a.body || a.type)}</div><div class="when">${ago(a.created_at)} ago</div></div></div>`).join('') : '<span style="color:var(--fg4);font-size:12px">No history yet</span>'}</div></div>
    </div></aside>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close; $('.drawer__close', wrap).onclick = close
  wrap.querySelectorAll('[data-job]').forEach((el) => (el.onclick = () => { close(); openJob(el.dataset.job) }))
}
function custJobRow(j) {
  const val = j.charge || j.est_value
  return `<div class="lrow" data-job="${j.id}">
    <div class="grow"><div class="nm">${esc(j.issue || j.service || 'Job')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
      <div class="sub">${esc([j.vehicle, ago(j.created_at) + ' ago'].filter(Boolean).join(' · '))}</div></div>
    <span class="pill ${j.status}"><span class="dot"></span>${esc((j.status || '').replace('_', ' '))}</span>
    <span class="amt">${val ? money(val) : ''}</span>
  </div>`
}

/* ===================== WAVE 4 · COMPOUND ===================== */

/* --- star rendering (proof + reviews) --- */
function stars(n) {
  const s = Math.max(0, Math.min(5, Math.round(Number(n || 0))))
  if (!s) return ''
  return `<span class="stars">${'★'.repeat(s)}<span class="stars__off">${'★'.repeat(5 - s)}</span></span>`
}
const PROOF_KIND = { review: 'Review', testimonial: 'Testimonial', result: 'Result', before_after: 'Before / after' }
const PROOF_KINDS = [['review', 'Review'], ['testimonial', 'Testimonial'], ['result', 'Result'], ['before_after', 'Before / after']]

/* --- build the copy-block for a single proof card (text + author, no chrome) --- */
function proofToText(p) {
  const head = (p.stars ? '★'.repeat(Math.min(5, Math.round(p.stars))) + '  ' : '')
  const who = p.author ? ` — ${p.author}` : ''
  return `${head}"${String(p.text || '').trim()}"${who}`
}

/* ===================== PROOF (wall + review ask/got) ===================== */
async function viewProof() {
  const [pd, rd] = await Promise.all([api('/api/proof'), api('/api/reviews')])
  const proof = pd.proof || []
  const r = rd.summary || {}, notAsked = rd.not_asked || [], notGot = rd.not_got || []
  const tr = $('.topbar .right'); if (tr) { tr.innerHTML = `<button class="btn ghost sm" id="proof-copyall">${I.check} Copy all</button><button class="btn primary sm" id="proof-add">${I.plus} Add proof</button>` }
  const askRate = Math.round(Number(r.ask_rate || 0)), gotRate = Math.round(Number(r.got_rate || 0))
  setView(`
    <div class="brief"><span class="tag">${I.bolt} The close-the-deal stack</span>
      <p>Ask every happy customer, every time — then keep the proof in one place. When a prospect's on the fence, drop the wall into the DM. Trust closes the job, not a discount.</p></div>
    <div class="kpis">
      <div class="kpi"><div class="lab">Eligible</div><div class="val">${r.eligible || 0}</div><div class="meta">completed + paid</div></div>
      <div class="kpi ${askRate < 80 && r.eligible ? 'warn' : ''}"><div class="lab">Ask rate</div><div class="val">${askRate}%</div><div class="meta">${r.asked || 0} asked</div></div>
      <div class="kpi"><div class="lab">Got rate</div><div class="val">${gotRate}%</div><div class="meta">${r.received || 0} landed</div></div>
      <div class="kpi primary"><div class="lab">On the wall</div><div class="val">${proof.length}</div><div class="meta">ready to send</div></div>
    </div>

    ${notAsked.length ? `<div class="sec-h"><span class="label">Ask these now — happy + not asked</span><span class="ct">${notAsked.length}</span></div>
      <div class="list">${notAsked.map(reviewRow.bind(null, 'ask')).join('')}</div>` : ''}
    ${notGot.length ? `<div class="sec-h"><span class="label">Asked, still waiting — nudge or mark it landed</span><span class="ct">${notGot.length}</span></div>
      <div class="list">${notGot.map(reviewRow.bind(null, 'got')).join('')}</div>` : ''}

    <div class="sec-h"><span class="label">Proof wall</span><span class="ct">${proof.length}</span></div>
    ${proof.length
      ? `<div class="proof-grid">${proof.map(proofCard).join('')}</div>`
      : emptyState('Wall is empty', 'Drop in your first review, a text a customer sent, a "shop quoted $X, you did $Y" win. This becomes the thing you paste to close the next hesitant one.')}
  `)
  app.querySelectorAll('.rrow .grow[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  app.querySelectorAll('[data-rev-asked]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); await api(`/api/jobs/${b.dataset.revAsked}/review-asked`, { method: 'POST' }); renderApp('proof') }))
  app.querySelectorAll('[data-rev-got]').forEach((b) => (b.onclick = async (e) => { e.stopPropagation(); await api(`/api/jobs/${b.dataset.revGot}/review-got`, { method: 'POST' }); renderApp('proof') }))
  app.querySelectorAll('[data-proof-copy]').forEach((b) => (b.onclick = () => { const p = proof.find((x) => String(x.id) === b.dataset.proofCopy); copyText(p ? proofToText(p) : '', b) }))
  app.querySelectorAll('[data-proof-del]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Remove this from the wall?')) return
    await api(`/api/proof/${b.dataset.proofDel}`, { method: 'DELETE' }); renderApp('proof')
  }))
  const addBtn = $('#proof-add'); if (addBtn) addBtn.onclick = () => openProof()
  const copyAll = $('#proof-copyall'); if (copyAll) copyAll.onclick = () => {
    if (!proof.length) return
    copyText(proof.map(proofToText).join('\n\n'), copyAll)
  }
}
function reviewRow(mode, j) {
  const days = j.asked_days_ago != null ? Math.round(j.asked_days_ago) : null
  return `<div class="lrow rrow">
    <div class="grow" data-job="${j.id}">
      <div class="nm">${esc(j.customer || 'Unknown')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
      <div class="sub">${esc([j.vehicle, j.issue || j.service].filter(Boolean).join(' · ') || 'No detail')}${mode === 'got' && days != null ? ` · asked ${days === 0 ? 'today' : days + 'd ago'}` : ''}</div>
    </div>
    <div class="qright">
      <span class="amt">${j.charge || j.est_value ? money(j.charge || j.est_value) : ''}</span>
      <div class="qacts">
        ${mode === 'ask'
          ? `<button class="btn primary sm" data-rev-asked="${j.id}">${I.check} Mark asked</button>`
          : `<button class="btn primary sm" data-rev-got="${j.id}">${I.check} Got it</button><button class="btn ghost sm" data-rev-asked="${j.id}">Re-asked</button>`}
      </div>
    </div>
  </div>`
}
function proofCard(p) {
  return `<div class="proof-card" data-proof="${p.id}">
    <div class="proof-card__h"><span class="proof-kind ${esc(p.kind || 'review')}">${esc(PROOF_KIND[p.kind] || 'Review')}</span>${stars(p.stars)}
      <button class="proof-card__del" data-proof-del="${p.id}" title="Remove">${I.x}</button></div>
    <div class="proof-card__text">${esc(p.text || '')}</div>
    <div class="proof-card__foot">
      <span class="proof-author">${esc(p.author || (p.customer || 'Anonymous'))}<span class="proof-when"> · ${ago(p.created_at)} ago</span></span>
      <button class="btn ghost sm" data-proof-copy="${p.id}">${I.check} Copy</button>
    </div>
  </div>`
}
function openProof() {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Add proof</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Type</label>
        <select class="input" id="pf-kind">${PROOF_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div class="field"><label>Who said it</label><input class="input" id="pf-author" placeholder="e.g. Rob M. · Mississauga"></div>
      <div class="field"><label>Stars (optional)</label>
        <select class="input" id="pf-stars"><option value="0">— no rating —</option><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></div>
      <div class="field"><label>What they said / the result</label>
        <textarea class="input ta" id="pf-text" rows="5" placeholder="Shop quoted him $2,400 for the timing chain — did it at his place for less and it's running mint."></textarea></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="pf-save">Add to wall</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#pf-save', wrap).onclick = async () => {
    const text = $('#pf-text', wrap).value.trim(); if (!text) return
    const body = { text, kind: $('#pf-kind', wrap).value, author: $('#pf-author', wrap).value.trim() || undefined, stars: Number($('#pf-stars', wrap).value) || undefined }
    await api('/api/proof', { method: 'POST', body: JSON.stringify(body) })
    close(); renderApp('proof')
  }
}

/* ===================== STUDIO · CONTENT PIPELINE (Phase 2) ===================== */
/* The content factory. Raw footage in the Vault → a finished, captioned post.
   Kanban over content.pipeline_stage; moving a card to "Editing" fires a
   content_edit handoff carrying the source clips' R2 keys + the brief — that's
   the Claude-Code editing bridge. Free AI drafts captions via the crm-api Worker.
   The legacy lead-attribution lives on inside the card drawer (the stepper). */
const CONTENT_STATUS = [['idea', 'Idea'], ['draft', 'Draft'], ['scheduled', 'Scheduled'], ['posted', 'Posted']]
const CONTENT_PILL = { idea: 'lead', draft: 'lead', scheduled: 'quoted', posted: 'completed' }
const STUDIO_COLS = [
  ['idea', 'Idea', 'var(--fg4)'],
  ['raw', 'Raw', 'var(--ai)'],
  ['editing', 'Editing', 'var(--ai)'],
  ['ready', 'Ready', 'var(--green)'],
  ['scheduled', 'Scheduled', 'var(--navy)'],
  ['posted', 'Posted', 'var(--accent)'],
]
const STAGE_LABEL = { idea: 'Idea', raw: 'Raw', editing: 'Editing', ready: 'Ready', scheduled: 'Scheduled', posted: 'Posted' }
const STAGE_PILL = { idea: 'lead', raw: 'lead', editing: 'in_progress', ready: 'completed', scheduled: 'scheduled', posted: 'completed' }
// the channel a card is tagged with → a short chip color cue (purely cosmetic)
const CHANNELS = [['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['youtube', 'YouTube'], ['gbp', 'Google'], ['reel', 'Reel'], ['facebook', 'Facebook']]
let _pipelineData = null   // cached so card clicks reopen the drawer without a refetch

async function viewContent() {
  const d = await api('/api/pipeline')
  _pipelineData = d
  const stages = d.stages || {}, counts = d.counts || {}, order = (d.order && d.order.length) ? d.order : STUDIO_COLS.map((c) => c[0])
  const all = Object.values(stages).flat()
  const inEditing = (stages.editing || []).length
  const live = all.filter((p) => p.pipeline_stage === 'posted').length
  const totalLeads = all.reduce((s, p) => s + (Number(p.leads_attributed) || 0), 0)
  const tr = $('.topbar .right')
  if (tr) { tr.innerHTML = `<button class="btn ghost sm" id="st-claude">${I.spark} Editing queue</button><button class="btn primary" id="st-add">${I.plus} New piece</button>`
    $('#st-add').onclick = () => openContentComposer()
    $('#st-claude').onclick = () => renderApp('handoffs') }
  setView(`
    <div class="brief"><span class="tag">${I.spark} Footage in, finished posts out</span>
      <p>Turn the raw clips you dumped in the Vault into posts — Claude Code does the cut. Move a card to <b>Editing</b> and it ships the source clips + the brief straight to the editing bench; it comes back a captioned, sized post in <b>Ready</b>, one tap from going live.</p></div>
    <div class="kpis">
      <div class="kpi"><div class="lab">In the pipeline</div><div class="val">${all.length}</div><div class="meta">pieces</div></div>
      <div class="kpi ${inEditing ? 'warn' : ''}"><div class="lab">Editing now</div><div class="val">${inEditing}</div><div class="meta">Claude's on it</div></div>
      <div class="kpi"><div class="lab">Posted</div><div class="val">${live}</div><div class="meta">live</div></div>
      <div class="kpi primary"><div class="lab">Leads from content</div><div class="val">${totalLeads}</div><div class="meta">DMs it pulled</div></div>
    </div>
    ${all.length ? '' : emptyState('Pipeline is empty', 'Hit "New piece", give it a title, and pick the source clips from your Vault. Move it to Editing and Claude Code cuts it into a captioned post — that\'s the whole loop.')}
    <div class="board studio-board">${order.map((k) => {
      const col = STUDIO_COLS.find((c) => c[0] === k) || [k, STAGE_LABEL[k] || k, 'var(--fg4)']
      const items = stages[k] || []
      return `<div class="col"><div class="col__h"><span class="dot" style="background:${col[2]}"></span>
        <span class="ttl">${esc(col[1])}</span><span class="ct">${counts[k] != null ? counts[k] : items.length}</span></div>
        <div class="col__b">${items.map(studioCard).join('') || '<div class="col__empty">—</div>'}</div></div>`
    }).join('')}</div>
  `)
  bindStudio()
}

function thumbStrip(assets) {
  const list = (assets || []).slice(0, 4)
  if (!list.length) return ''
  const more = (assets || []).length - list.length
  return `<div class="st-strip">${list.map((a) => {
    const isClip = a.kind === 'clip'
    return `<span class="st-thumb ${isClip ? 'clip' : ''}">${a.thumb_url
      ? `<img src="${esc(a.thumb_url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">`
      : `<span class="st-kind">${esc((a.kind || 'doc').slice(0, 3).toUpperCase())}</span>`}${isClip ? `<span class="st-play">${I.spark}</span>` : ''}</span>`
  }).join('')}${more > 0 ? `<span class="st-thumb more">+${more}</span>` : ''}</div>`
}

function studioCard(p) {
  const stage = p.pipeline_stage || 'idea'
  const sc = (p.source_count != null ? p.source_count : (p.assets || []).length)
  const clips = (p.assets || []).filter((a) => a.kind === 'clip').length
  const photos = (p.assets || []).filter((a) => a.kind === 'photo').length
  const srcLabel = sc ? [clips ? `${clips} clip${clips === 1 ? '' : 's'}` : '', photos ? `${photos} photo${photos === 1 ? '' : 's'}` : ''].filter(Boolean).join(' · ') || `${sc} source${sc === 1 ? '' : 's'}` : 'no sources yet'
  const editing = stage === 'editing'
  const claudeLive = editing && p.handoff_id && p.handoff_status && p.handoff_status !== 'done'
  return `<div class="jc st-card ${editing ? 'editing' : ''}" data-piece="${p.id}">
    <div class="jc__top"><div style="min-width:0"><div class="nm">${esc(p.title || 'Untitled')}</div>
      ${p.channel ? `<div class="veh">${esc(channelLabel(p.channel))}</div>` : ''}</div>
      ${(Number(p.leads_attributed) || 0) > 0 ? `<span class="ai-score">${I.spark}${p.leads_attributed} lead${p.leads_attributed === 1 ? '' : 's'}</span>` : ''}</div>
    ${thumbStrip(p.assets)}
    ${claudeLive ? `<div class="st-claude-live">${I.spark}<span>Claude Code is on it</span></div>`
      : (stage === 'ready' && p.edited_url) ? `<div class="st-ready-mark">${I.check}<span>Cut ready — preview &amp; post</span></div>` : ''}
    <div class="jc__foot">
      <span class="st-src">${esc(srcLabel)}</span>
      ${p.pipeline_stage !== 'posted' ? `<button class="btn ghost sm st-fwd" data-piece-fwd="${p.id}" data-stage="${stage}" title="Move forward">${I.arrow}</button>` : ''}
    </div>
  </div>`
}
function channelLabel(ch) { const m = CHANNELS.find((c) => c[0] === String(ch).toLowerCase()); return m ? m[1] : ch }
function nextStage(stage) { const i = STUDIO_COLS.findIndex((c) => c[0] === stage); return (i >= 0 && i < STUDIO_COLS.length - 1) ? STUDIO_COLS[i + 1][0] : null }

function bindStudio() {
  app.querySelectorAll('[data-piece]').forEach((el) => (el.onclick = (e) => { if (e.target.closest('[data-piece-fwd]')) return; openPieceDrawer(el.dataset.piece) }))
  app.querySelectorAll('[data-piece-fwd]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation()
    const nx = nextStage(b.dataset.stage); if (!nx) return
    await moveStage(b.dataset.pieceFwd, nx)
  }))
}

// Move a piece to a stage; surface the Claude-Code confirmation when it fires the bridge.
async function moveStage(id, stage) {
  const res = await api(`/api/content/${id}/stage`, { method: 'POST', body: JSON.stringify({ stage }) })
  if (stage === 'editing' && res && res.handoff) studioSentToast()
  else if (stage === 'editing' && res && !res.handoff) toast('Add source clips first — then Editing sends them to Claude Code.', 'warn')
  await renderApp('content')
  return res
}

// the magic moment: a violet confirmation that the clips went to the editing bench
function studioSentToast() {
  const t = document.createElement('div')
  t.className = 'st-toast'
  t.innerHTML = `<span class="st-toast__ic">${I.spark}</span>
    <div class="st-toast__body"><b>Sent to Claude Code to edit ✦</b>
      <span>The source clips + the brief are on the editing bench. The finished cut lands in <b>Ready</b>.</span></div>
    <button class="st-toast__go">Editing queue ${I.arrow}</button>`
  document.body.appendChild(t)
  requestAnimationFrame(() => t.classList.add('in'))
  const kill = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 260) }
  t.querySelector('.st-toast__go').onclick = () => { kill(); renderApp('handoffs') }
  setTimeout(kill, 5200)
}
function toast(msg, kind) {
  const t = document.createElement('div')
  t.className = 'st-toast mini' + (kind ? ' ' + kind : '')
  t.innerHTML = `<span class="st-toast__ic">${kind === 'warn' ? I.bolt : I.check}</span><div class="st-toast__body"><span>${esc(msg)}</span></div>`
  document.body.appendChild(t)
  requestAnimationFrame(() => t.classList.add('in'))
  setTimeout(() => { t.classList.remove('in'); setTimeout(() => t.remove(), 260) }, 3200)
}

/* ---- NEW PIECE composer: title, channel, source clips from the Vault, optional brief ---- */
async function openContentComposer() {
  let vault = []
  try { vault = (await api('/api/vault')).assets || [] } catch (e) { vault = [] }
  // photos + clips are the shootable sources; docs/quotes/invoices aren't content material
  const pickable = vault.filter((a) => a.kind === 'clip' || a.kind === 'photo')
  const picked = new Set()
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal st-composer">
    <div class="modal__h"><div class="t-h2">New piece</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Title / the angle</label><input class="input" id="st-title" placeholder='e.g. "Shop quoted $2,400 — I did it at his door" reel'></div>
      <div class="st-row2">
        <div class="field"><label>Channel</label>
          <select class="input" id="st-channel"><option value="">— pick one —</option>${CHANNELS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
        <div class="field"><label>Start in</label>
          <select class="input" id="st-stage">${STUDIO_COLS.slice(0, 2).map(([v, l]) => `<option value="${v}" ${v === 'raw' ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      </div>
      <div class="field"><label>Source clips from the Vault</label>
        ${pickable.length
          ? `<div class="st-pick" id="st-pick">${pickable.map(composerTile).join('')}</div>
             <div class="st-pick-note"><span id="st-picksum">0 selected</span> — these are the clips Claude Code will cut from.</div>`
          : `<div class="st-pick-empty">No photos or clips in the Vault yet. Dump some in the Vault first, then pick them here.</div>`}
      </div>
      <div class="field"><label>Brief for the edit (optional)</label>
        <textarea class="input ta" id="st-brief" rows="3" placeholder="The hook, the cut you want, the on-screen text — anything Claude needs to make the post. Leave blank and it'll draft from the title in Fares' voice."></textarea></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="st-save">${I.plus} Create piece</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  const sum = $('#st-picksum', wrap)
  wrap.querySelectorAll('[data-pick]').forEach((el) => (el.onclick = () => {
    const id = el.dataset.pick
    if (picked.has(id)) { picked.delete(id); el.classList.remove('on') } else { picked.add(id); el.classList.add('on') }
    if (sum) sum.textContent = `${picked.size} selected`
  }))
  $('#st-save', wrap).onclick = async () => {
    const title = $('#st-title', wrap).value.trim(); if (!title) { $('#st-title', wrap).focus(); return }
    const body = {
      title,
      channel: $('#st-channel', wrap).value || undefined,
      pipeline_stage: $('#st-stage', wrap).value || 'raw',
      brief: $('#st-brief', wrap).value.trim() || undefined,
      asset_ids: [...picked].map(Number),
    }
    const btn = $('#st-save', wrap); btn.disabled = true
    await api('/api/content', { method: 'POST', body: JSON.stringify(body) })
    close(); renderApp('content')
  }
}
function composerTile(a) {
  const isClip = a.kind === 'clip'
  return `<button class="st-ptile" data-pick="${a.id}" title="${esc(a.label || a.kind || '')}">
    ${a.thumb_url ? `<img src="${esc(a.thumb_url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">` : `<span class="st-kind">${esc((a.kind || 'doc').toUpperCase())}</span>`}
    ${isClip ? `<span class="st-play">${I.spark}</span>${a.duration_s ? `<span class="st-dur">${fmtDur(a.duration_s)}</span>` : ''}` : ''}
    <span class="st-ptile__check">${I.check}</span>
  </button>`
}

/* ---- PIECE detail drawer: sources, caption (AI draft + copy), edited preview, stage move + post + leads ---- */
async function openPieceDrawer(id) {
  // pull the freshest copy from the cached pipeline payload, fall back to a tiny refetch
  let p = null
  if (_pipelineData) p = Object.values(_pipelineData.stages || {}).flat().find((x) => String(x.id) === String(id))
  if (!p) { try { const d = await api('/api/pipeline'); _pipelineData = d; p = Object.values(d.stages || {}).flat().find((x) => String(x.id) === String(id)) } catch (e) {} }
  if (!p) return
  const stage = p.pipeline_stage || 'idea'
  const hashtags = Array.isArray(p.hashtags) ? p.hashtags : []
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer st-drawer">
    <div class="drawer__h"><span class="pill ${STAGE_PILL[stage] || 'lead'}"><span class="dot"></span>${esc(STAGE_LABEL[stage] || stage)}</span>
      ${p.channel ? `<span class="age-tag">${esc(channelLabel(p.channel))}</span>` : ''}
      <button class="drawer__close">${I.x}</button></div>
    <div class="drawer__b">
      <div class="t-h2">${esc(p.title || 'Untitled')}</div>
      ${p.source_note ? `<div class="st-brief-read">${esc(p.source_note)}</div>` : ''}

      ${stage === 'editing' && p.handoff_id && p.handoff_status !== 'done'
        ? `<div class="st-claude-banner">${I.spark}<div><b>Claude Code is editing this now</b><span>Source clips + the brief are on the editing bench. The finished cut drops into Ready.</span></div></div>`
        : ''}

      ${p.edited_asset_id ? `<div><div class="label" style="margin-bottom:var(--s2)">The finished cut</div>
        <div class="st-edited" id="st-edited"><div class="loading">Loading the cut…</div></div></div>` : ''}

      <div><div class="label" style="margin-bottom:var(--s2)">Source clips <span class="st-srcct">${(p.assets || []).length}</span></div>
        <div class="st-sources" id="st-sources">${(p.assets || []).length ? (p.assets || []).map(sourceTile).join('') : '<div class="st-pick-empty">No sources attached. Add clips from the Vault below.</div>'}</div>
        <button class="btn ghost sm" id="st-addsrc" style="margin-top:var(--s2)">${I.plus} Add source clips</button></div>

      <div><div class="label" style="margin-bottom:var(--s2)">Caption</div>
        <div class="st-caption-wrap">
          <div class="field"><input class="input" id="st-hook" placeholder="Hook (scroll-stopping first line)" value="${esc(p.hook || '')}"></div>
          <textarea class="input ta" id="st-cap" rows="4" placeholder="The caption — Fares' voice, ends on a soft come-to-you CTA. Tap AI draft to fill it.">${esc(p.caption || '')}</textarea>
          <input class="input" id="st-tags" placeholder="#hashtags" value="${esc(hashtags.join(' '))}">
          <div class="st-cap-acts">
            <button class="btn ai sm" id="st-ai">${I.spark} AI draft</button>
            <button class="btn ghost sm" id="st-copy">${I.check} Copy caption</button>
          </div>
        </div></div>

      <div><div class="label" style="margin-bottom:var(--s2)">Move it along</div>
        <div class="st-stage-row">${STUDIO_COLS.map(([k, l]) => `<button class="st-stage-chip ${k === stage ? 'on' : ''}" data-mv="${k}">${esc(l)}</button>`).join('')}</div>
        ${stage !== 'editing' && stage !== 'posted' ? `<button class="btn ai sm st-send" id="st-send">${I.spark} Send to Claude Code to edit</button>` : ''}
      </div>

      <div class="st-post" id="st-post"><div class="loading">Loading posting…</div></div>

      <div class="st-leads">
        <div><div class="label">Leads it pulled</div><div class="st-leads-sub">Tick one every time a DM lands because of this piece.</div></div>
        <div class="lead-stepper">
          <button class="step-btn" id="st-lead-dec" title="Remove a lead">−</button>
          <b class="num" id="st-lead-n">${Number(p.leads_attributed) || 0}</b>
          <button class="step-btn primary" id="st-lead-inc" title="A lead came from this">+</button>
        </div>
      </div>

      <div class="st-drawer-foot">
        ${p.url ? `<a class="btn ghost sm" href="${esc(p.url)}" target="_blank" rel="noopener">${I.arrow} View post</a>` : ''}
        <button class="btn ghost sm st-del" id="st-del">${I.x} Delete piece</button>
      </div>
    </div></aside>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close; $('.drawer__close', wrap).onclick = close

  // resolve a fresh, playable URL for the finished cut (signed GET) and render the player
  const ed = $('#st-edited', wrap)
  if (ed && p.edited_asset_id) {
    let full = p.edited_url, mime = ''
    try { const u = await api(`/api/assets/${p.edited_asset_id}/url`); if (u && u.url) { full = u.url; mime = u.mime || '' } } catch (e) { /* fall back to the thumb */ }
    const isImg = /^image\//.test(mime) || (!mime && /\.(jpe?g|png|webp|gif)(\?|$)/i.test(full || ''))
    ed.innerHTML = isImg
      ? `<img src="${esc(full || '')}" alt="">`
      : `<video src="${esc(full || '')}" controls playsinline preload="metadata" poster="${esc(p.edited_url || '')}"></video>`
  }

  // stage chips + the explicit send-to-editing CTA
  wrap.querySelectorAll('[data-mv]').forEach((b) => (b.onclick = async () => {
    if (b.dataset.mv === stage) return
    close(); await moveStage(id, b.dataset.mv)
  }))
  const send = $('#st-send', wrap); if (send) send.onclick = async () => { close(); await moveStage(id, 'editing') }

  // AI draft (violet) — fills hook/caption/hashtags, editable
  const ai = $('#st-ai', wrap); if (ai) ai.onclick = async () => {
    const old = ai.innerHTML; ai.disabled = true; ai.innerHTML = `${I.spark} Drafting…`
    try {
      const r = await api(`/api/content/${id}/caption`, { method: 'POST', body: JSON.stringify({ channel: p.channel || undefined }) })
      if (r && r.drafted) {
        if (r.hook != null) $('#st-hook', wrap).value = r.hook || ''
        if (r.caption != null) $('#st-cap', wrap).value = r.caption || ''
        if (Array.isArray(r.hashtags)) $('#st-tags', wrap).value = r.hashtags.join(' ')
        toast('AI drafted the caption — tweak it and copy.')
      } else toast((r && r.note) || 'AI is busy — type it yourself or try again.', 'warn')
    } catch (e) { toast('AI is busy — try again in a sec.', 'warn') }
    ai.disabled = false; ai.innerHTML = old
  }
  const copy = $('#st-copy', wrap); if (copy) copy.onclick = () => {
    const txt = [$('#st-hook', wrap).value.trim(), $('#st-cap', wrap).value.trim(), $('#st-tags', wrap).value.trim()].filter(Boolean).join('\n\n')
    copyText(txt, copy)
  }

  // add more sources from the Vault
  const addSrc = $('#st-addsrc', wrap); if (addSrc) addSrc.onclick = () => openSourcePicker(id, async () => { close(); openPieceDrawer(id) })
  // detach a source
  wrap.querySelectorAll('[data-src-del]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation()
    await api(`/api/content/${id}/assets/${b.dataset.srcDel}`, { method: 'DELETE' })
    // refresh the drawer with the new source set
    try { const d = await api('/api/pipeline'); _pipelineData = d } catch (_) {}
    close(); openPieceDrawer(id)
  }))

  // posting panel (schedule + assisted post + per-channel metrics) — rebuilds in place
  renderPostPanel(wrap, p)

  // leads stepper (legacy attribution preserved)
  const ln = $('#st-lead-n', wrap)
  const bump = async (delta) => { const r = await api(`/api/content/${id}/attribute`, { method: 'POST', body: JSON.stringify({ delta }) }); if (ln && r) ln.textContent = r.leads_attributed }
  const li = $('#st-lead-inc', wrap); if (li) li.onclick = () => bump(1)
  const ld = $('#st-lead-dec', wrap); if (ld) ld.onclick = () => bump(-1)

  const del = $('#st-del', wrap); if (del) del.onclick = async () => {
    if (!confirm('Delete this piece? Its source clips stay in the Vault.')) return
    await api(`/api/content/${id}/delete`, { method: 'POST' }); close(); renderApp('content')
  }
}
function sourceTile(a) {
  const isClip = a.kind === 'clip'
  return `<div class="st-srctile ${isClip ? 'clip' : ''}">
    ${a.thumb_url ? `<img src="${esc(a.thumb_url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">` : `<span class="st-kind">${esc((a.kind || 'doc').toUpperCase())}</span>`}
    ${isClip ? `<span class="st-play">${I.spark}</span>${a.duration_s ? `<span class="st-dur">${fmtDur(a.duration_s)}</span>` : ''}` : ''}
    <button class="st-srctile__x" data-src-del="${a.id}" title="Remove">${I.x}</button>
  </div>`
}
/* ---- POSTING (Phase 3): schedule + assisted "post now" + per-channel reach/leads ----
   Honest by design: no full IG/TikTok auto-post. "Post now" copies the caption, opens
   the channel, and you mark it posted + paste the URL. Per-channel reach/leads feed the
   funnel. content_posts is the spine; the 'social' activation gate wires real auto-post. */
const POST_CHANNELS_UI = [['gbp', 'Google Business'], ['youtube', 'YouTube'], ['instagram', 'Instagram'], ['tiktok', 'TikTok'], ['facebook', 'Facebook'], ['reel', 'Reel']]
// where "post now" opens — the create/upload surface per channel
const CHANNEL_OPEN = {
  gbp: 'https://business.google.com/posts',
  youtube: 'https://www.youtube.com/upload',
  instagram: 'https://www.instagram.com/',
  tiktok: 'https://www.tiktok.com/upload',
  facebook: 'https://www.facebook.com/',
  reel: 'https://www.instagram.com/',
}
// friction note per channel (sets honest expectations inline)
const CHANNEL_NOTE = {
  gbp: 'Easiest — paste & post', youtube: 'Easiest real auto-upload (later)',
  instagram: 'Auto-post needs 2-4wk app review', tiktok: 'Public needs a TikTok audit',
  facebook: 'Auto-post via Meta app review', reel: 'IG Reel — paste & post',
}

function captionFor(wrap, p) {
  const hook = wrap ? ($('#st-hook', wrap)?.value || '').trim() : ''
  const cap = wrap ? ($('#st-cap', wrap)?.value || '').trim() : ''
  const tags = wrap ? ($('#st-tags', wrap)?.value || '').trim() : ''
  return [hook || p.hook, cap || p.caption, tags || (Array.isArray(p.hashtags) ? p.hashtags.join(' ') : '')].filter(Boolean).join('\n\n')
}

function renderPostPanel(wrap, p) {
  const host = $('#st-post', wrap); if (!host) return
  const stage = p.pipeline_stage || 'idea'
  const posts = p.posts || []   // content_posts rows ride along on the pipeline payload (added below)
  const scheduled = !!p.scheduled_for
  // only meaningful once a cut exists / piece is past editing — but allow scheduling from Ready onward
  const canPost = stage === 'ready' || stage === 'scheduled' || stage === 'posted'
  if (!canPost) {
    host.innerHTML = `<div class="label" style="margin-bottom:var(--s2)">Posting</div>
      <div class="st-post-locked">${I.spark}<span>Get it to <b>Ready</b> (Claude Code cuts it), then schedule + post it here — one tap copies the caption and opens the channel.</span></div>`
    return
  }
  const whenTxt = scheduled ? new Date(p.scheduled_for).toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : null
  host.innerHTML = `
    <div class="label" style="margin-bottom:var(--s2)">Posting</div>
    <div class="st-sched-bar">
      <div class="st-sched-when">${scheduled ? `${I.today} <b>${esc(whenTxt)}</b>` : `<span class="st-sched-no">Not scheduled yet</span>`}</div>
      <button class="btn ghost sm" id="st-sched">${I.today} ${scheduled ? 'Reschedule' : 'Schedule'}</button>
    </div>
    ${posts.length ? `<div class="st-channels">${posts.map((c) => postChannelRow(c)).join('')}</div>`
      : `<div class="st-post-note">${I.bolt}<span>Schedule it to one or more channels — each becomes a one-tap post here.</span></div>`}
    <div class="st-post-hint">Honest mode: "Post now" copies the caption + opens the channel. Paste, post, then mark it + drop the link. Auto-post is the <b>social</b> activation gate.</div>
  `
  // schedule
  const sb = $('#st-sched', host); if (sb) sb.onclick = () => openScheduleContent(p, () => refreshPiece(wrap, p.id))
  // per-channel actions
  host.querySelectorAll('[data-post-now]').forEach((b) => (b.onclick = async () => {
    const ch = b.dataset.postNow
    await copyText(captionFor(wrap, p), b)
    window.open(CHANNEL_OPEN[ch] || '#', '_blank', 'noopener')
    toast('Caption copied — paste it in ' + channelLabel(ch) + ', then mark it posted.')
  }))
  host.querySelectorAll('[data-post-mark]').forEach((b) => (b.onclick = () => openMarkPosted(p, b.dataset.postMark, () => refreshPiece(wrap, p.id))))
  host.querySelectorAll('[data-post-metrics]').forEach((b) => (b.onclick = () => openPostMetrics(p, b.dataset.postMetrics, () => refreshPiece(wrap, p.id))))
}
function postChannelRow(c) {
  const posted = c.status === 'posted'
  return `<div class="st-chrow ${posted ? 'posted' : ''}">
    <span class="st-chrow__ch"><span class="cc-ch ${esc(c.channel)}">${esc(channelShort(c.channel))}</span>${esc(channelLabel(c.channel))}</span>
    <span class="st-chrow__stat">${posted ? `${I.check} posted` : 'planned'}${(c.reach || c.leads) ? ` · ${(c.reach || 0).toLocaleString()} reach${c.leads ? ` · ${c.leads} lead${c.leads === 1 ? '' : 's'}` : ''}` : ''}</span>
    <div class="st-chrow__acts">
      ${posted
        ? `${c.external_url ? `<a class="btn ghost sm" href="${esc(c.external_url)}" target="_blank" rel="noopener">${I.arrow}</a>` : ''}<button class="btn ghost sm" data-post-metrics="${esc(c.channel)}">${I.spark} Stats</button>`
        : `<button class="btn primary sm" data-post-now="${esc(c.channel)}">${I.arrow} Post now</button><button class="btn ghost sm" data-post-mark="${esc(c.channel)}" title="Mark posted">${I.check}</button>`}
    </div>
  </div>`
}
// re-pull the pipeline payload and re-open the drawer so post rows refresh in place
async function refreshPiece(wrap, id) {
  try { const d = await api('/api/pipeline'); _pipelineData = d } catch (_) {}
  if (wrap) wrap.remove()
  openPieceDrawer(id)
}

/* schedule-to-channels modal */
function openScheduleContent(p, onDone) {
  const cur = p.scheduled_for ? new Date(p.scheduled_for) : new Date(Date.now() + 86400000)
  const curDate = cur.toISOString().slice(0, 10)
  const curTime = String(cur.getHours()).padStart(2, '0') + ':' + String(cur.getMinutes()).padStart(2, '0')
  const already = new Set((p.posts || []).map((x) => x.channel))
  if (p.channel) already.add(p.channel)
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Schedule · ${esc(p.title || '')}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="st-row2">
        <div class="field"><label>Day</label><input class="input" id="sc-date" type="date" value="${curDate}"></div>
        <div class="field"><label>Time</label><input class="input" id="sc-time" type="time" value="${curTime}"></div>
      </div>
      <div class="field"><label>Channels</label>
        <div class="st-chpick" id="sc-channels">${POST_CHANNELS_UI.map(([v, l]) => `<button class="st-chpick__b ${already.has(v) ? 'on' : ''}" data-chpick="${v}"><span class="cc-ch ${v}">${channelShort(v)}</span>${esc(l)}<i class="st-chpick__note">${esc(CHANNEL_NOTE[v] || '')}</i></button>`).join('')}</div>
        <div class="st-pick-note">Each picked channel becomes a one-tap post. YouTube + Google are the low-friction ones — IG/TikTok auto-post is the gated future.</div>
      </div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="sc-save">${I.check} Schedule it</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  const picked = new Set(already)
  wrap.querySelectorAll('[data-chpick]').forEach((b) => (b.onclick = () => {
    const v = b.dataset.chpick
    if (picked.has(v)) { picked.delete(v); b.classList.remove('on') } else { picked.add(v); b.classList.add('on') }
  }))
  $('#sc-save', wrap).onclick = async () => {
    const date = $('#sc-date', wrap).value, time = $('#sc-time', wrap).value || '09:00'
    if (!date) { $('#sc-date', wrap).focus(); return }
    const when = new Date(date + 'T' + time).toISOString()
    const btn = $('#sc-save', wrap); btn.disabled = true
    await api(`/api/content/${p.id}/schedule`, { method: 'POST', body: JSON.stringify({ scheduled_for: when, channels: [...picked] }) })
    close(); onDone && onDone()
  }
}

/* mark a channel posted (optionally paste the live URL) */
function openMarkPosted(p, channel, onDone) {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Mark posted · ${esc(channelLabel(channel))}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Link to the post (optional)</label><input class="input" id="mp-url" placeholder="https://… the live post"></div>
      <div class="vault-note">Pasting the URL lets you jump back to it and helps tie leads to this exact post in the funnel.</div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="mp-save">${I.check} It's live</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#mp-save', wrap).onclick = async () => {
    const btn = $('#mp-save', wrap); btn.disabled = true
    const r = await api(`/api/content/${p.id}/post`, { method: 'POST', body: JSON.stringify({ channel, external_url: $('#mp-url', wrap).value.trim() || undefined }) })
    close()
    if (r && r.all_posted) toast('All channels posted — piece is live ✦')
    onDone && onDone()
  }
}

/* per-channel reach + leads entry (feeds the funnel) */
function openPostMetrics(p, channel, onDone) {
  const cur = (p.posts || []).find((x) => x.channel === channel) || {}
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Stats · ${esc(channelLabel(channel))}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="st-row2">
        <div class="field"><label>Reach / views</label><input class="input" id="pm-reach" inputmode="numeric" placeholder="0" value="${cur.reach || ''}"></div>
        <div class="field"><label>Leads it pulled</label><input class="input" id="pm-leads" inputmode="numeric" placeholder="0" value="${cur.leads || ''}"></div>
      </div>
      <div class="vault-note">Enter these by hand off the app's insights. The Field funnel reads them to show which channel actually turns reach into booked jobs.</div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="pm-save">${I.check} Save stats</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#pm-save', wrap).onclick = async () => {
    const reach = $('#pm-reach', wrap).value.trim(), leads = $('#pm-leads', wrap).value.trim()
    const btn = $('#pm-save', wrap); btn.disabled = true
    await api(`/api/content/${p.id}/metrics`, { method: 'POST', body: JSON.stringify({ channel, reach: reach === '' ? undefined : Number(reach), leads: leads === '' ? undefined : Number(leads) }) })
    close(); onDone && onDone()
  }
}

/* pick more Vault clips to attach to an existing piece */
async function openSourcePicker(contentId, onDone) {
  let vault = []
  try { vault = (await api('/api/vault')).assets || [] } catch (e) { vault = [] }
  const pickable = vault.filter((a) => a.kind === 'clip' || a.kind === 'photo')
  const picked = new Set()
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal st-composer">
    <div class="modal__h"><div class="t-h2">Add source clips</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      ${pickable.length
        ? `<div class="st-pick">${pickable.map(composerTile).join('')}</div>
           <div class="st-pick-note"><span id="st-picksum2">0 selected</span> from the Vault.</div>`
        : `<div class="st-pick-empty">No photos or clips in the Vault yet.</div>`}
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="st-attach">${I.plus} Attach</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  const sum = $('#st-picksum2', wrap)
  wrap.querySelectorAll('[data-pick]').forEach((el) => (el.onclick = () => {
    const id = el.dataset.pick
    if (picked.has(id)) { picked.delete(id); el.classList.remove('on') } else { picked.add(id); el.classList.add('on') }
    if (sum) sum.textContent = `${picked.size} selected`
  }))
  $('#st-attach', wrap).onclick = async () => {
    if (!picked.size) return close()
    await api(`/api/content/${contentId}/assets`, { method: 'POST', body: JSON.stringify({ asset_ids: [...picked].map(Number) }) })
    close(); onDone && onDone()
  }
}

/* ===================== ASSETS LIBRARY ===================== */
const LIB_KINDS = [['', 'All'], ['photo', 'Photos'], ['clip', 'Clips'], ['quote', 'Quotes'], ['invoice', 'Invoices'], ['doc', 'Docs']]
let _libFilter = { kind: '', is_before: '' }
async function viewAssets() {
  const tr = $('.topbar .right'); if (tr) tr.innerHTML = ''
  setView(`<div id="lib-wrap"><div class="loading">Loading…</div></div>`)
  await loadLibrary()
}
async function loadLibrary() {
  const qs = []
  if (_libFilter.kind) qs.push('kind=' + encodeURIComponent(_libFilter.kind))
  if (_libFilter.is_before) qs.push('is_before=' + encodeURIComponent(_libFilter.is_before))
  const d = await api('/api/assets' + (qs.length ? '?' + qs.join('&') : ''))
  const assets = d.assets || [], byKind = d.by_kind || {}
  const host = $('#lib-wrap'); if (!host) return
  const chips = LIB_KINDS.map(([v, l]) => `<button class="lib-chip ${_libFilter.kind === v ? 'on' : ''}" data-lib-kind="${v}">${l}${v && byKind[v] ? ` <b>${byKind[v]}</b>` : ''}</button>`).join('')
  host.innerHTML = `
    <div class="brief"><span class="tag">${I.bolt} Every job, one shelf</span>
      <p>All the photos and clips off your jobs, pulled out of your camera roll and tied to who and what they're from. Reuse them for content and to close — the before/after that sells the next big one.</p></div>
    <div class="lib-bar">
      <div class="lib-chips">${chips}</div>
      <button class="lib-chip before ${_libFilter.is_before === 'true' ? 'on' : ''}" data-lib-before>${I.spark} Before shots</button>
    </div>
    ${assets.length
      ? `<div class="sec-h"><span class="label">${_libFilter.kind ? (LIB_KINDS.find((k) => k[0] === _libFilter.kind) || [, 'Assets'])[1] : 'All assets'}${_libFilter.is_before === 'true' ? ' · before' : ''}</span><span class="ct">${d.total || assets.length}</span></div>
        <div class="lib-grid">${assets.map(libTile).join('')}</div>`
      : emptyState('Nothing here yet', 'Attach photos and clips from the job drawer — they all flow into this shelf, organized and ready to reuse for content or to show the next customer.')}
  `
  host.querySelectorAll('[data-lib-kind]').forEach((b) => (b.onclick = () => { _libFilter.kind = b.dataset.libKind; loadLibrary() }))
  const bf = host.querySelector('[data-lib-before]'); if (bf) bf.onclick = () => { _libFilter.is_before = _libFilter.is_before === 'true' ? '' : 'true'; loadLibrary() }
  host.querySelectorAll('[data-lib-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.libJob)))
}
function libTile(a) {
  const isImg = a.kind === 'photo'
  return `<div class="lib-tile">
    <div class="lib-tile__media ${isImg ? '' : 'doc'}" ${a.job_id ? `data-lib-job="${a.job_id}"` : ''}>
      ${isImg ? `<img src="${esc(a.url)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">` : `<span class="lib-kind">${esc((a.kind || 'doc').toUpperCase())}</span>`}
      ${a.is_before ? '<span class="lib-before">BEFORE</span>' : ''}
      <a class="lib-open" href="${esc(a.url)}" target="_blank" rel="noopener" title="Open">${I.arrow}</a>
    </div>
    <div class="lib-tile__meta" ${a.job_id ? `data-lib-job="${a.job_id}"` : ''}>
      <div class="lib-tile__lbl">${esc(a.label || a.kind || 'attachment')}</div>
      <div class="lib-tile__sub">${esc([a.customer, a.vehicle].filter(Boolean).join(' · ') || (a.issue || a.service || ''))}</div>
    </div>
  </div>`
}

/* ===================== RE-CONTACT ===================== */
function recontactRow(j, overdue) {
  return `<div class="lrow rc-row ${overdue ? 'over' : ''}">
    <div class="grow" ${j.job_id ? `data-job="${j.job_id}"` : ''}>
      <div class="nm">${esc(j.title || 'Check in')} ${j.safety_flag ? '<span class="safety">SAFETY</span>' : ''}</div>
      <div class="sub">${esc([j.customer, j.vehicle].filter(Boolean).join(' · ') || (j.body || 'No context'))}</div>
      ${j.body && (j.customer || j.vehicle) ? `<div class="sub" style="color:var(--fg4)">${esc(j.body)}</div>` : ''}
    </div>
    <div class="qright">
      ${j.due_at ? `<span class="age-tag ${overdue ? 'stale' : ''}">${overdue ? (j.overdue_days > 0 ? j.overdue_days + 'd overdue' : 'due now') : 'due ' + esc(new Date(j.due_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' }))}</span>` : '<span class="age-tag stale">whenever</span>'}
      <div class="qacts">
        ${j.phone ? `<a class="btn ghost sm" href="tel:${esc(j.phone)}">${I.phone}</a>` : ''}
        <button class="btn primary sm" data-rc-done="${j.id}">${I.check} Done</button>
      </div>
    </div>
  </div>`
}
function bindRecontact(scope) {
  (scope || app).querySelectorAll('.rc-row .grow[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  ;(scope || app).querySelectorAll('[data-rc-done]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation(); await api(`/api/recontact/${b.dataset.rcDone}/done`, { method: 'POST' })
    if (tab === 'pulse') renderApp('pulse'); else renderApp()
  }))
}

/* Schedule a future check-in from a job drawer */
function openRecontact(j) {
  const wrap = document.createElement('div')
  const presets = [['+7', 'In 1 week'], ['+30', 'In 1 month'], ['+90', 'In 3 months'], ['+180', 'In 6 months'], ['+365', 'In a year']]
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Schedule a check-in</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>What to check on</label><input class="input" id="rc-title" placeholder="e.g. That ${esc(j.vehicle || 'Volvo')} belt was borderline — see how it's holding"></div>
      <div class="field"><label>When</label>
        <div class="rc-presets">${presets.map(([v, l], i) => `<button class="rc-chip ${i === 2 ? 'on' : ''}" data-rc-when="${v}">${l}</button>`).join('')}</div></div>
      <div class="field"><label>Or pick a date</label><input class="input" id="rc-date" type="date"></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="rc-save">${I.plus} Schedule it</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  let offset = 90
  const chips = wrap.querySelectorAll('[data-rc-when]')
  chips.forEach((b) => (b.onclick = () => { chips.forEach((x) => x.classList.remove('on')); b.classList.add('on'); offset = Number(b.dataset.rcWhen.replace('+', '')); $('#rc-date', wrap).value = '' }))
  $('#rc-save', wrap).onclick = async () => {
    const title = $('#rc-title', wrap).value.trim() || `Check in on ${j.customer || 'this customer'}`
    let due
    const picked = $('#rc-date', wrap).value
    if (picked) due = new Date(picked + 'T12:00:00').toISOString()
    else { const dt = new Date(); dt.setDate(dt.getDate() + offset); due = dt.toISOString() }
    await api('/api/recontact', { method: 'POST', body: JSON.stringify({ title, due_at: due, job_id: j.id, customer_id: j.customer_id || undefined }) })
    close()
  }
}

/* Won-workflow fired-checklist confirmation */
function showWonChecklist(res, customer) {
  const list = res.checklist || []
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">${I.check} Won — ${esc(customer || 'job')} is on the board</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="won-line">Booked at <b class="num">${money(res.charge)}</b> flat${res.profit != null ? ` · <span class="${res.below_floor ? 'won-bad' : 'won-ok'}">${money(res.profit)} profit</span>` : ''}</div>
      ${res.below_floor ? `<div class="floor-warn">Under the $1,000 profit floor — make sure the price holds up.</div>` : ''}
      <div class="label" style="margin-top:var(--s2)">Auto-fired for you</div>
      <div class="won-checklist">${list.length ? list.map((c) => `
        <div class="won-item"><span class="won-ic">${I.check}</span>
          <div><div class="won-t">${esc(c.title || (c.kind === 'review_ask' ? 'Ask for the review' : 'Capture the after photos'))}</div>
            ${c.when || c.due_at ? `<div class="won-when">${esc(c.when || ('due ' + new Date(c.due_at).toLocaleDateString('en-CA', { month: 'short', day: 'numeric' })))}</div>` : ''}</div></div>`).join('')
        : '<div class="won-when">Scheduled and status updated.</div>'}</div>
    </div>
    <div class="modal__f"><button class="btn primary mclose">Got it</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
}

/* Inject the Re-contact "due now" panel into the Pulse (additive wrap, like Wave 2). */
const _renderApp_w4 = renderApp
renderApp = async function (next) {
  await _renderApp_w4(next)
  if (tab !== 'pulse') return
  const mp = $('.mini-panels')
  if (mp && !$('.rc-panel')) {
    let d; try { d = await api('/api/recontact') } catch (e) { d = null }
    const due = d && d.due ? d.due : []
    const upcoming = d && d.count ? (d.count.upcoming || 0) : 0
    const panel = document.createElement('div')
    panel.className = 'panel rc-panel'
    panel.style.gridColumn = '1 / -1'
    panel.innerHTML = `<div class="mini-h">Re-contact · scheduled energy coming due${upcoming ? ` <span class="rc-up">+${upcoming} upcoming</span>` : ''}</div>
      ${due.length ? `<div class="list">${due.map((j) => recontactRow(j, true)).join('')}</div>`
        : `<div class="needs-clear">Nothing due. Schedule a check-in from any job — that Volvo belt, the Impala exhaust — and it surfaces here when it's time.</div>`}`
    mp.appendChild(panel)
    bindRecontact(panel)
  }
}


/* ===================== WAVE 5 · SEE THE FIELD ===================== */

/* --- shared: date helpers for the calendar --- */
function isoDay(d) { const z = new Date(d); z.setHours(12, 0, 0, 0); return z.getFullYear() + '-' + String(z.getMonth() + 1).padStart(2, '0') + '-' + String(z.getDate()).padStart(2, '0') }
function todayIso() { return isoDay(new Date()) }
function dayParts(iso) {
  const d = new Date(iso + 'T12:00:00')
  return { dow: d.toLocaleDateString('en-CA', { weekday: 'short' }), num: d.getDate(), mon: d.toLocaleDateString('en-CA', { month: 'short' }) }
}
function calChargeOf(j) { return j.charge || j.est_value || 0 }

/* ===================== CALENDAR ===================== */
let _calFrom = todayIso()
let _calMode = 'jobs'   // 'jobs' (booked work) | 'content' (scheduled posts) — Phase-3 toggle
function calToggle() {
  return `<div class="seg cal-mode">
    <button class="${_calMode === 'jobs' ? 'on' : ''}" data-cal-mode="jobs">${I.today} Jobs</button>
    <button class="${_calMode === 'content' ? 'on' : ''}" data-cal-mode="content">${I.spark} Content</button>
  </div>`
}
function bindCalNav() {
  app.querySelectorAll('[data-cal-mode]').forEach((b) => (b.onclick = () => { _calMode = b.dataset.calMode; renderApp('calendar') }))
  const ct = $('#cal-today'); if (ct) ct.onclick = () => { _calFrom = todayIso(); renderApp('calendar') }
  const cp = $('#cal-prev'); if (cp) cp.onclick = () => { _calFrom = shiftIso(_calFrom, -14); renderApp('calendar') }
  const cn = $('#cal-next'); if (cn) cn.onclick = () => { _calFrom = shiftIso(_calFrom, 14); renderApp('calendar') }
}
async function viewCalendar() {
  if (_calMode === 'content') return viewContentCalendar()
  const d = await api(`/api/calendar?from=${encodeURIComponent(_calFrom)}&days=14`)
  const grid = d.grid || [], s = d.summary || {}
  const tr = $('.topbar .right')
  if (tr) tr.innerHTML = `${calToggle()}<div class="cal-nav">
      <button class="btn ghost sm" id="cal-prev">${I.arrow}<span class="cal-flip">${I.arrow}</span></button>
      <button class="btn ghost sm" id="cal-today">Today</button>
      <button class="btn ghost sm" id="cal-next">${I.arrow}</button>
    </div><button class="btn primary sm" id="cal-add">${I.plus} Add lead</button>`
  const tot = grid.reduce((a, g) => a + (g.booked || 0), 0)
  const totVal = grid.reduce((a, g) => a + (g.booked_value || 0), 0)
  const busiest = s.busiest || (grid.slice().sort((a, b) => (b.booked || 0) - (a.booked || 0))[0] || {}).date
  setView(`
    <div class="brief"><span class="tag">${I.bolt} Your real week</span>
      <p>Time's the one thing you can't make more of. Here's what's actually booked over the next two weeks — so you don't double-book, and you know the day you're full. Tap a job to open it, "Reschedule" to move it.</p></div>
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Booked</div><div class="val">${tot}</div><div class="meta">next 14 days</div></div>
      <div class="kpi"><div class="lab">On the books</div><div class="val">${money(totVal)}</div><div class="meta">scheduled value</div></div>
      <div class="kpi"><div class="lab">Busiest day</div><div class="val" style="font-size:15px">${busiest ? esc(calLabel(busiest)) : '—'}</div><div class="meta">most jobs</div></div>
      <div class="kpi"><div class="lab">Open days</div><div class="val">${s.open_days != null ? s.open_days : grid.filter((g) => !(g.booked || 0)).length}</div><div class="meta">room to book</div></div>
    </div>
    <div class="sec-h"><span class="label">Two-week view</span><span class="ct">${calLabel(grid.length ? grid[0].date : _calFrom)}${grid.length ? ' – ' + calLabel(grid[grid.length - 1].date) : ''}</span></div>
    <div class="cal-grid">${grid.map(calDay).join('')}</div>
  `)
  app.querySelectorAll('[data-cal-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.calJob)))
  app.querySelectorAll('[data-cal-resched]').forEach((b) => (b.onclick = async (e) => {
    e.stopPropagation()
    let j = b.dataset.calJob ? null : null
    try { const jd = await api(`/api/jobs/${b.dataset.calResched}`); j = jd.job } catch (_) {}
    if (j) openSchedule(j)
  }))
  const cad = $('#cal-add'); if (cad) cad.onclick = openAddLead
  bindCalNav()
}

/* --- Calendar · CONTENT mode: scheduled posts grouped by day, channel-colored chips --- */
async function viewContentCalendar() {
  const d = await api(`/api/calendar/content?from=${encodeURIComponent(_calFrom)}&days=14`)
  const grid = d.grid || [], s = d.summary || {}
  const tr = $('.topbar .right')
  if (tr) tr.innerHTML = `${calToggle()}<div class="cal-nav">
      <button class="btn ghost sm" id="cal-prev">${I.arrow}<span class="cal-flip">${I.arrow}</span></button>
      <button class="btn ghost sm" id="cal-today">Today</button>
      <button class="btn ghost sm" id="cal-next">${I.arrow}</button>
    </div><button class="btn primary sm" id="cc-new">${I.plus} New piece</button>`
  const tot = grid.reduce((a, g) => a + (g.count || 0), 0)
  const posted = grid.reduce((a, g) => a + (g.pieces || []).filter((p) => p.stage === 'posted').length, 0)
  // overlay the 4-pillar cadence so empty pillar-days read as gaps
  const PILLARS = { 1: 'Detective', 3: 'Real-job', 5: 'Honest', 0: 'Teach' }
  setView(`
    <div class="brief"><span class="tag">${I.spark} Your posting week</span>
      <p>Cadence is the voice — one a day beats ten in a burst. Here's what's scheduled to go out over the next two weeks. Empty pillar-days (Mon detective · Wed real-job · Fri honest · Sun teach) glow as gaps to fill. Tap a card to open it in the Studio and post.</p></div>
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Scheduled</div><div class="val">${tot}</div><div class="meta">next 14 days</div></div>
      <div class="kpi"><div class="lab">Posted</div><div class="val">${posted}</div><div class="meta">already live</div></div>
      <div class="kpi"><div class="lab">Empty days</div><div class="val">${s.open_days != null ? s.open_days : grid.filter((g) => !g.count).length}</div><div class="meta">nothing planned</div></div>
      <div class="kpi"><div class="lab">Pillars</div><div class="val" style="font-size:15px">4 / week</div><div class="meta">Det · Job · Honest · Teach</div></div>
    </div>
    <div class="sec-h"><span class="label">Two-week posting view</span><span class="ct">${calLabel(grid.length ? grid[0].date : _calFrom)}${grid.length ? ' – ' + calLabel(grid[grid.length - 1].date) : ''}</span></div>
    <div class="cal-grid">${grid.map((g) => ccDay(g, PILLARS)).join('')}</div>
  `)
  app.querySelectorAll('[data-cc-piece]').forEach((el) => (el.onclick = () => openPieceDrawer(el.dataset.ccPiece)))
  const nw = $('#cc-new'); if (nw) nw.onclick = () => openContentComposer()
  bindCalNav()
}
function ccDay(g, PILLARS) {
  const p = dayParts(g.date)
  const today = g.date === todayIso()
  const pieces = g.pieces || []
  const pillar = PILLARS[g.dow]
  const gap = pillar && !pieces.length
  const isWknd = p.dow === 'Sat' || p.dow === 'Sun'
  return `<div class="cal-day ${today ? 'today' : ''} ${isWknd ? 'wknd' : ''} ${gap ? 'cc-gap' : ''}">
    <div class="cal-day__h">
      <div class="cal-dow">${esc(p.dow)}</div>
      <div class="cal-date">${p.num}</div>
      ${pillar ? `<div class="cc-pillar ${gap ? 'gap' : ''}">${esc(pillar)}</div>` : (pieces.length ? `<div class="cal-cap some">${pieces.length}</div>` : '')}
    </div>
    <div class="cal-day__b">
      ${pieces.length ? pieces.map(ccChip).join('') : (gap ? `<div class="cc-gap-note">${esc(pillar)} day — open</div>` : `<div class="cal-free">—</div>`)}
    </div>
  </div>`
}
function ccChip(p) {
  const chs = (p.channels || []).slice(0, 3)
  const posted = p.stage === 'posted'
  const thumb = p.thumb_url
  return `<div class="cc-chip ${posted ? 'posted' : ''}" data-cc-piece="${p.id}" title="${esc(p.title || '')}">
    ${thumb ? `<span class="cc-thumb"><img src="${esc(thumb)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')"></span>` : `<span class="cc-thumb ph">${I.spark}</span>`}
    <div class="cc-chip__b">
      <div class="cc-chip__t">${esc(p.title || 'Untitled')}</div>
      <div class="cc-chip__ch">${chs.length ? chs.map((c) => `<span class="cc-ch ${esc(c)}">${esc(channelShort(c))}</span>`).join('') : '<span class="cc-ch none">no channel</span>'}${posted ? `<span class="cc-live">${I.check} live</span>` : ''}</div>
    </div>
  </div>`
}
function channelShort(ch) { const m = { instagram: 'IG', tiktok: 'TT', youtube: 'YT', gbp: 'GBP', facebook: 'FB', reel: 'Reel' }; return m[String(ch).toLowerCase()] || ch }
function shiftIso(iso, days) { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + days); return isoDay(d) }
function calLabel(iso) { if (!iso) return ''; const p = dayParts(iso); return p.mon + ' ' + p.num }
function calDay(g) {
  const p = dayParts(g.date)
  const today = g.date === todayIso()
  const jobs = g.jobs || []
  const booked = g.booked != null ? g.booked : jobs.length
  const cap = booked >= 3 ? 'full' : booked === 2 ? 'busy' : booked === 1 ? 'some' : 'open'
  const isWknd = p.dow === 'Sat' || p.dow === 'Sun'
  return `<div class="cal-day ${today ? 'today' : ''} ${isWknd ? 'wknd' : ''} cap-${cap}">
    <div class="cal-day__h">
      <div class="cal-dow">${esc(p.dow)}</div>
      <div class="cal-date">${p.num}</div>
      <div class="cal-cap ${cap}">${booked ? booked + (booked >= 3 ? ' · full' : ' booked') : 'open'}</div>
    </div>
    <div class="cal-day__b">
      ${jobs.length ? jobs.map(calJobChip).join('') : `<div class="cal-free">—</div>`}
    </div>
    ${g.booked_value ? `<div class="cal-day__f"><span class="num">${money(g.booked_value)}</span></div>` : ''}
  </div>`
}
function calJobChip(j) {
  const below = j.below_floor
  return `<div class="cal-job ${below ? 'below' : ''}" data-cal-job="${j.id}">
    <div class="cal-job__top">
      <span class="cal-time num">${esc(j.scheduled_time || '—')}</span>
      ${j.safety_flag ? '<span class="cal-safety">!</span>' : ''}
      ${j.ticket_tier === 'HIGH' ? `<span class="cal-hi">HIGH</span>` : ''}
    </div>
    <div class="cal-job__nm">${esc(j.customer || 'Unknown')}</div>
    <div class="cal-job__sub">${esc([j.vehicle, j.service || j.issue].filter(Boolean).join(' · ') || 'No detail')}</div>
    <div class="cal-job__foot">
      <span class="cal-amt num">${calChargeOf(j) ? money(calChargeOf(j)) : ''}</span>
      <button class="cal-resched" data-cal-resched="${j.id}" title="Reschedule">${I.arrow} move</button>
    </div>
  </div>`
}

/* --- Schedule / reschedule modal (used from Calendar + job drawer) --- */
function openSchedule(j) {
  const TIMES = ['7:00am', '8:00am', '9:00am', '10:00am', '11:00am', '12:00pm', '1:00pm', '2:00pm', '3:00pm', '4:00pm', '5:00pm', '6:00pm']
  const DURS = [['60', '1 hr'], ['90', '1.5 hr'], ['120', '2 hr'], ['180', '3 hr'], ['240', 'Half day'], ['480', 'Full day']]
  const curDate = j.scheduled_date ? isoDay(j.scheduled_date) : ''
  const curTime = j.scheduled_time || '9:00am'
  const curDur = String(j.duration_min || 120)
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">${j.scheduled_date ? 'Reschedule' : 'Book'} · ${esc(j.customer || '')}</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="sched-ctx">${esc([j.vehicle, j.service || j.issue].filter(Boolean).join(' · ') || 'No detail')}${calChargeOf(j) ? ` · <b class="num">${money(calChargeOf(j))}</b>` : ''}</div>
      <div class="field"><label>Day</label><input class="input" id="sc-date" type="date" value="${curDate}"></div>
      <div class="field"><label>Time</label>
        <select class="input" id="sc-time">${TIMES.map((t) => `<option value="${t}" ${t === curTime ? 'selected' : ''}>${t}</option>`).join('')}</select></div>
      <div class="field"><label>How long</label>
        <select class="input" id="sc-dur">${DURS.map(([v, l]) => `<option value="${v}" ${v === curDur ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    </div>
    <div class="modal__f">
      ${j.scheduled_date ? `<button class="btn ghost mclose-clear" id="sc-clear">Clear booking</button>` : '<button class="btn ghost mclose">Cancel</button>'}
      <button class="btn primary" id="sc-save">${I.check} ${j.scheduled_date ? 'Move it' : 'Book it'}</button>
    </div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  const save = async (clear) => {
    const date = clear ? '' : $('#sc-date', wrap).value
    if (!clear && !date) return
    await api(`/api/jobs/${j.id}/schedule`, { method: 'POST', body: JSON.stringify({ scheduled_date: date, scheduled_time: clear ? '' : $('#sc-time', wrap).value, duration_min: clear ? null : Number($('#sc-dur', wrap).value) }) })
    close()
    if (tab === 'calendar') renderApp('calendar'); else renderApp()
  }
  $('#sc-save', wrap).onclick = () => save(false)
  const cl = $('#sc-clear', wrap); if (cl) cl.onclick = () => save(true)
}

/* ===================== FIELD (sources + reputation + momentum) ===================== */
async function viewField() {
  const [src, mkt, mom, fun] = await Promise.all([
    api('/api/sources').catch(() => ({ sources: [], totals: {} })),
    api('/api/market').catch(() => ({ reputation: {}, recent_proof: [], market_notes: '' })),
    api('/api/momentum').catch(() => ({ trend: [], summary: {} })),
    api('/api/funnel').catch(() => ({ funnel: [], channels: [], totals: {}, honest: {} })),
  ])
  const sources = src.sources || [], st = src.totals || {}, best = src.best
  const rep = mkt.reputation || {}, recent = mkt.recent_proof || []
  const mtrend = mom.trend || [], ms = mom.summary || {}
  const tr = $('.topbar .right'); if (tr) tr.innerHTML = ''
  const lc = ms.label === 'Gaining' ? 'g' : ms.label === 'Bleeding' ? 'b' : 'w'
  const dTxt = ms.delta == null ? 'first read' : (ms.delta > 0 ? `▲ ${ms.delta}` : ms.delta < 0 ? `▼ ${Math.abs(ms.delta)}` : 'flat')
  const d30 = ms.delta_30d
  const askRate = Math.round(Number(rep.ask_rate || 0)), gotRate = Math.round(Number(rep.got_rate || 0))
  const maxRev = Math.max(1, ...sources.map((s) => s.revenue || 0))
  setView(`
    <div class="brief"><span class="tag">${I.bolt} The field — where it comes from, what they say</span>
      <p>Stop spreading energy evenly. This shows which funnel actually produces, what your reputation looks like, and whether your momentum's climbing or bleeding. Pour into what works.</p></div>

    <div class="field-hero">
      <div class="panel mom-card ${lc}">
        ${momRing(ms.score || 0)}
        <div class="mom-meta">
          <div class="mom-label ${lc}">${esc(ms.label || 'Momentum')}</div>
          <div class="mom-delta">${dTxt} vs yesterday${d30 != null ? ` · <span class="${d30 >= 0 ? 'up' : 'down'}">${d30 >= 0 ? '▲' : '▼'} ${Math.abs(d30)} in 30d</span>` : ''}</div>
          <div class="mom-bd">${momChip('Acquire', (ms.breakdown || {}).acquisition)}${momChip('Convert', (ms.breakdown || {}).conversion)}${momChip('Trust', (ms.breakdown || {}).trust)}${momChip('Cash', (ms.breakdown || {}).cash)}</div>
        </div>
      </div>
      <div class="panel mom-chart-panel">
        <div class="mini-h">Energy · last 30 days</div>
        ${momChart(mtrend)}
      </div>
    </div>

    <div class="sec-h"><span class="label">Where the leads come from</span>${best ? `<span class="ct">best · ${esc(best.source || best)}</span>` : ''}</div>
    ${sources.length ? `
      <div class="panel src-totals">
        <div class="src-tot"><div class="k">Leads</div><div class="v num">${st.leads || st.total || 0}</div></div>
        <div class="src-tot"><div class="k">Paid</div><div class="v num">${st.paid || 0}</div></div>
        <div class="src-tot"><div class="k">Revenue</div><div class="v num" style="color:var(--green)">${money(st.revenue)}</div></div>
        <div class="src-tot"><div class="k">Conversion</div><div class="v num">${Math.round(Number(st.conversion || 0))}%</div></div>
      </div>
      <div class="src-table">
        <div class="src-row src-head">
          <span class="src-name">Source</span><span>Leads</span><span>Paid</span><span>Conv.</span><span>Avg</span><span class="src-rev">Revenue</span>
        </div>
        ${sources.map((s) => srcRow(s, maxRev, best)).join('')}
      </div>`
      : emptyState('No sources to read yet', 'As leads come in tagged by where they came from — website, the AI widget, referrals, phone — this breaks down which funnel actually turns into paid jobs.')}

    ${contentFunnelSection(fun)}

    <div class="sec-h"><span class="label">Reputation</span><span class="ct">${rep.proof_count || 0} on the wall</span></div>
    <div class="kpis">
      <div class="kpi primary"><div class="lab">Reviews</div><div class="val">${rep.reviews_count || 0}${rep.reviews_target ? ` <span style="font-size:12px;color:var(--fg4)">/ ${rep.reviews_target}</span>` : ''}</div><div class="meta">${rep.gbp_claimed ? 'Google profile claimed' : 'claim your Google profile'}</div></div>
      <div class="kpi ${askRate < 80 && rep.eligible ? 'warn' : ''}"><div class="lab">Ask rate</div><div class="val">${askRate}%</div><div class="meta">${rep.asked || 0} of ${rep.eligible || 0} asked</div></div>
      <div class="kpi"><div class="lab">Got rate</div><div class="val">${gotRate}%</div><div class="meta">${rep.received || 0} landed</div></div>
      <div class="kpi"><div class="lab">Proof pieces</div><div class="val">${rep.proof_count || 0}</div><div class="meta">ready to send</div></div>
    </div>
    <div class="field-split">
      <div class="panel">
        <div class="mini-h">Recent proof</div>
        ${recent.length ? `<div class="list">${recent.map(fieldProofRow).join('')}</div>`
          : `<div class="needs-clear">Nothing on the wall yet. Ask every happy customer, then log what they say in Proof — it surfaces here.</div>`}
        <button class="btn ghost sm" id="field-proof" style="margin-top:var(--s3)">${I.arrow} Go to Proof wall</button>
      </div>
      <div class="panel">
        <div class="mini-h">Market notes · what the local shops are doing</div>
        <p style="color:var(--fg3);font-size:12px;margin:calc(-1 * var(--s2)) 0 var(--s3)">Awareness, not scraping. Jot what shops near you charge or post — so you price and pitch with eyes open. Trust over price, always.</p>
        <textarea class="input ta" id="mkt-notes" rows="7" placeholder="e.g. Local euro shop quoting ~$2,400 on N20 timing chains · Brampton mobile guy posting brake jobs at $280 (cheap, attracts hagglers) · dealer wait times 2+ wks">${esc(mkt.market_notes || '')}</textarea>
        <div class="mkt-foot"><span class="mkt-saved" id="mkt-saved"></span><button class="btn primary sm" id="mkt-save">${I.check} Save notes</button></div>
      </div>
    </div>
  `)
  app.querySelectorAll('.field-proof-row[data-job]').forEach((el) => (el.onclick = () => openJob(el.dataset.job)))
  const gs = $('#field-studio'); if (gs) gs.onclick = () => renderApp('content')
  const gp = $('#field-proof'); if (gp) gp.onclick = () => renderApp('proof')
  const save = $('#mkt-save'); if (save) save.onclick = async () => {
    save.disabled = true
    await api('/api/market', { method: 'PUT', body: JSON.stringify({ notes: $('#mkt-notes').value }) })
    save.disabled = false
    const tag = $('#mkt-saved'); if (tag) { tag.textContent = 'Saved'; tag.classList.add('on'); setTimeout(() => { tag.textContent = ''; tag.classList.remove('on') }, 1600) }
  }
  setTimeout(() => { const r = $('#mring'); if (r) r.style.strokeDashoffset = r.dataset.target }, 50)
}
function momRing(score) {
  const r = 42, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(100, score)) / 100)
  const col = score >= 66 ? '#44D07F' : score >= 33 ? '#E0922E' : '#F6736B'
  return `<svg viewBox="0 0 104 104" width="104" height="104" style="flex-shrink:0">
    <circle cx="52" cy="52" r="${r}" fill="none" stroke="#1a1d22" stroke-width="8"/>
    <circle id="mring" class="gauge-ring" cx="52" cy="52" r="${r}" fill="none" stroke="${col}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${circ.toFixed(1)}" data-target="${off.toFixed(1)}" transform="rotate(-90 52 52)"/>
    <text x="52" y="50" text-anchor="middle" fill="#F4F5F7" font-size="27" font-weight="700" font-family="'JetBrains Mono',monospace">${Math.round(Math.max(0, Math.min(100, score)))}</text>
    <text x="52" y="66" text-anchor="middle" fill="#868B98" font-size="8" letter-spacing="1.4">ENERGY</text></svg>`
}
function momChip(name, val) { return `<span class="bd-chip"><span>${name}</span><b>${Math.round(val || 0)}</b></span>` }
function momChart(trend) {
  const data = (trend || []).slice(-30)
  if (!data.length) return `<div class="spark-empty">No 30-day history yet — each daily read plots here as the loop runs.</div>`
  const W = 100, H = 56, n = data.length
  const x = (i) => n === 1 ? 0 : (i / (n - 1)) * W
  const y = (v) => H - (Math.max(0, Math.min(100, v || 0)) / 100) * H
  const pts = data.map((t, i) => `${x(i).toFixed(2)},${y(t.score).toFixed(2)}`).join(' ')
  const area = `0,${H} ` + pts + ` ${W},${H}`
  const last = data[data.length - 1] || {}
  const lo = ms_min(data, 'score'), hi = ms_max(data, 'score')
  return `<div class="mom-chart">
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="mom-svg">
      <defs><linearGradient id="momg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgba(110,170,255,.30)"/><stop offset="1" stop-color="rgba(110,170,255,0)"/></linearGradient></defs>
      <polygon points="${area}" fill="url(#momg)"></polygon>
      <polyline points="${pts}" fill="none" stroke="var(--navy)" stroke-width="1.6" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"></polyline>
      <circle cx="${x(n - 1).toFixed(2)}" cy="${y(last.score).toFixed(2)}" r="2.4" fill="var(--accent)" stroke="var(--bg2)" stroke-width="1"></circle>
    </svg>
    <div class="mom-chart__ax"><span>30d ago</span><span class="num">low ${Math.round(lo)} · high ${Math.round(hi)}</span><span>today</span></div>
  </div>`
}
function ms_min(arr, k) { return arr.reduce((m, t) => Math.min(m, Number(t[k] || 0)), Infinity) }
function ms_max(arr, k) { return arr.reduce((m, t) => Math.max(m, Number(t[k] || 0)), -Infinity) }
function srcRow(s, maxRev, best) {
  const conv = Math.round(Number(s.conversion || 0))
  const isBest = best && (s.source === (best.source || best)) && (s.paid || 0) > 0
  const w = Math.max(2, Math.round(((s.revenue || 0) / maxRev) * 100))
  return `<div class="src-row ${isBest ? 'best' : ''}">
    <span class="src-name">${esc(srcLabel(s.source))}${isBest ? `<span class="src-badge">top</span>` : ''}</span>
    <span class="num">${s.leads != null ? s.leads : s.total || 0}</span>
    <span class="num">${s.paid || 0}</span>
    <span class="num ${conv >= 30 ? 'good' : ''}">${conv}%</span>
    <span class="num">${s.avg_ticket ? money(s.avg_ticket) : '—'}</span>
    <span class="src-rev"><span class="src-bar"><i style="width:${w}%"></i></span><b class="num">${money(s.revenue)}</b></span>
  </div>`
}
function srcLabel(src) {
  if (!src) return 'Unknown'
  return ({ 'website': 'Website', 'website:ai-widget': 'AI widget', 'website:triage': 'Site triage', 'phone-ai': 'Phone AI', 'referral': 'Referral', 'manual': 'Manual entry' })[src] || String(src)
}
function fieldProofRow(p) {
  return `<div class="lrow field-proof-row" ${p.job_id ? `data-job="${p.job_id}"` : ''}>
    <div class="grow"><div class="nm">${esc(p.author || p.customer || 'Anonymous')} ${stars(p.stars)}</div>
      <div class="sub field-proof-text">${esc(p.text || '')}</div></div>
    <span class="age-tag">${ago(p.created_at)}</span>
  </div>`
}

/* --- the CONTENT FUNNEL (Phase 3) — Posts -> Reach -> Leads -> Booked -> Revenue + per-channel $/post --- */
function contentFunnelSection(fun) {
  const f = fun || {}, steps = f.funnel || [], channels = f.channels || [], t = f.totals || {}, honest = f.honest || {}
  const hasAny = (t.posts || 0) + (t.planned || 0) + (t.reach || 0) + (t.leads || 0) + (t.pieces || 0) > 0
  return `
    <div class="sec-h"><span class="label">What content actually pulls</span><span class="ct">${t.posts || 0} posted · ${t.planned || 0} planned</span></div>
    ${hasAny ? `
      <div class="panel cf-panel">
        <div class="cf-chain">${steps.map((s, i) => cfStep(s, i, steps)).join('')}</div>
        ${honest.note ? `<div class="cf-note">${I.bolt}<span>${esc(honest.note)}</span></div>` : ''}
        ${channels.length ? `
          <div class="cf-table">
            <div class="cf-row cf-head"><span class="cf-ch">Channel</span><span>Posts</span><span>Reach</span><span>Leads</span><span class="cf-rev">$/post</span></div>
            ${channels.map((ch) => cfChannelRow(ch, channels, t)).join('')}
          </div>` : `<div class="cf-empty-mini">Schedule a Ready piece to channels in the Studio and they show up here, ranked by what pays.</div>`}
        <div class="cf-foot">
          <span class="cf-revtot">${money(t.revenue)} attributed to content${t.booked ? ` · ${t.booked} booked` : ''}${t.revenue_per_post ? ` · ${money(t.revenue_per_post)}/post` : ''}</span>
          <button class="btn ghost sm" id="field-studio">${I.arrow} Open the Studio</button>
        </div>
      </div>`
      : emptyState('No content in the funnel yet', 'Cut a clip into a post in the Studio, schedule it to a channel, and post it. As you log reach + the leads each post pulls, this chain shows you exactly which channel turns footage into booked jobs.')}
  `
}
function cfStep(s, i, steps) {
  const prev = i > 0 ? steps[i - 1] : null
  const val = Number(s.value || 0)
  const conv = prev && Number(prev.value) > 0 ? Math.round((val / Number(prev.value)) * 100) : null
  return `<div class="cf-step">
    ${i > 0 ? `<span class="cf-arrow">${I.arrow}${conv != null ? `<i class="cf-conv">${conv}%</i>` : ''}</span>` : ''}
    <div class="cf-cell"><div class="cf-val num">${s.money ? money(val) : val.toLocaleString()}</div><div class="cf-lab">${esc(s.stage)}</div></div>
  </div>`
}
function cfChannelRow(ch, channels, t) {
  const maxReach = Math.max(1, ...channels.map((x) => x.reach || 0))
  const w = Math.max(2, Math.round(((ch.reach || 0) / maxReach) * 100))
  // $/post per channel is honest-zero for organic; show a dash until revenue is actually attributable per channel
  return `<div class="cf-row">
    <span class="cf-ch">${esc(channelLabel(ch.channel))}${ch.planned ? `<span class="cf-planned">${ch.planned} planned</span>` : ''}</span>
    <span class="num">${ch.posts || 0}</span>
    <span class="num"><span class="cf-bar"><i style="width:${w}%"></i></span>${(ch.reach || 0).toLocaleString()}</span>
    <span class="num ${ch.leads ? 'good' : ''}">${ch.leads || 0}</span>
    <span class="cf-rev num">${ch.posts ? '$0' : '—'}</span>
  </div>`
}


/* ===================== GUIDED PLAYBOOKS (gates made real) ===================== */
/* A gate is no longer a flag-flip. Clicking one opens its playbook drawer:
   a step-by-step checklist with the actual instructions, Copy snippets, Open
   links, and "Hand to Claude Code" buttons. Finishing every step trips the gate
   done + points you at the next move. Shared by Activation + the Pulse one-move. */

const PLAYBOOK_PILL = { todo: 'lead', doing: 'in_progress', done: 'completed' }

async function openPlaybook(key, opts = {}) {
  let d
  try { d = await api(`/api/playbook/${encodeURIComponent(key)}`) }
  catch (e) { return }
  if (!d || !d.steps) { // no playbook wired for this gate — fall back to the row, do nothing loud
    return
  }
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer pb-drawer">
    <div class="drawer__h">
      <span class="pill ${PLAYBOOK_PILL[(d.gate || {}).status] || 'lead'}"><span class="dot"></span>${esc(((d.gate || {}).status || 'todo').replace('_', ' '))}</span>
      <div class="pb-htitle">${esc((d.gate || {}).label || 'Playbook')}</div>
      <button class="drawer__close">${I.x}</button>
    </div>
    <div class="drawer__b">
      <div class="pb-prog">
        <div class="pb-prog__top"><span class="pb-prog__lab">Playbook progress</span><b class="num pb-pct">${d.pct || 0}%</b></div>
        <div class="goal__track"><div class="goal__fill ${(d.pct || 0) >= 100 ? 'over' : ''}" data-w="${d.pct || 0}%" style="width:0"></div></div>
        <div class="pb-prog__sub"><span class="pb-donect">${(d.done || []).length}</span> of ${d.steps.length} moves done</div>
      </div>
      <div class="pb-steps">${d.steps.map((s, i) => playbookStep(s, i, (d.done || []).includes(i))).join('')}</div>
      <div class="pb-complete" style="display:${(d.pct || 0) >= 100 ? 'flex' : 'none'}"></div>
    </div>
  </aside>`
  document.body.appendChild(wrap)
  const close = () => { wrap.remove(); if (opts.onClose) opts.onClose() }
  $('.scrim', wrap).onclick = close
  $('.drawer__close', wrap).onclick = close

  const paint = (res) => {
    const done = res.done || []
    $('.pb-pct', wrap).textContent = (res.pct || 0) + '%'
    $('.pb-donect', wrap).textContent = done.length
    const fill = $('.pb-steps', wrap).closest('.drawer__b').querySelector('.goal__fill')
    fill.style.width = (res.pct || 0) + '%'; fill.classList.toggle('over', (res.pct || 0) >= 100)
    wrap.querySelectorAll('.pb-step').forEach((el) => {
      const on = done.includes(Number(el.dataset.idx))
      el.classList.toggle('on', on)
      el.querySelector('.pb-check').classList.toggle('on', on)
      el.querySelector('.pb-check').innerHTML = on ? I.check : ''
    })
    const cm = $('.pb-complete', wrap)
    if (res.gate_complete) {
      cm.style.display = 'flex'
      cm.innerHTML = `<div class="pb-done-mark">${I.check}</div>
        <div class="pb-done-copy"><div class="pb-done-t">Gate complete</div>
          <div class="pb-done-s">${res.next_gate ? `Next move: <b>${esc(res.next_gate.label)}</b>` : 'Every gate is lit. The machine is fully on.'}</div></div>
        ${res.next_gate ? `<button class="btn primary sm" id="pb-next">${I.arrow} Open next</button>` : ''}`
      const nx = $('#pb-next', wrap)
      if (nx) nx.onclick = () => { close(); openPlaybook(res.next_gate.key, opts) }
    } else {
      cm.style.display = 'none'; cm.innerHTML = ''
    }
  }

  const bindSteps = () => {
    wrap.querySelectorAll('.pb-check').forEach((b) => (b.onclick = async () => {
      const el = b.closest('.pb-step'); const idx = Number(el.dataset.idx)
      const turningOn = !el.classList.contains('on')
      const res = await api(`/api/playbook/${encodeURIComponent(key)}/step`, { method: 'POST', body: JSON.stringify({ index: idx, done: turningOn }) })
      paint(res)
    }))
    wrap.querySelectorAll('[data-pb-copy]').forEach((b) => (b.onclick = () => copyText(b.dataset.pbCopy, b)))
    wrap.querySelectorAll('[data-pb-hand]').forEach((b) => (b.onclick = async () => {
      const el = b.closest('.pb-step'); const idx = Number(el.dataset.idx)
      const s = d.steps[idx] || {}
      b.disabled = true; const old = b.innerHTML; b.innerHTML = `${I.spark} Dispatched`
      await api('/api/handoffs', { method: 'POST', body: JSON.stringify({
        kind: 'gate_step',
        title: `${(d.gate || {}).label || key}: ${s.title || ('Step ' + (idx + 1))}`,
        payload: { gate: key, step: idx, step_title: s.title || '', context: s.handoff || s.detail || '' },
      }) })
      b.classList.add('ai'); setTimeout(() => { b.innerHTML = old.replace('Hand to Claude', 'Re-send to Claude'); b.disabled = false }, 1500)
    }))
  }
  bindSteps()
  setTimeout(() => { const f = wrap.querySelector('.goal__fill[data-w]'); if (f) f.style.width = f.dataset.w }, 60)
}

function playbookStep(s, i, done) {
  const snippet = (s.snippet || '').trim()
  return `<div class="pb-step ${done ? 'on' : ''}" data-idx="${i}">
    <button class="pb-check ${done ? 'on' : ''}">${done ? I.check : ''}</button>
    <div class="pb-body">
      <div class="pb-step__t">${esc(s.title || ('Step ' + (i + 1)))}</div>
      ${s.detail ? `<div class="pb-step__d">${esc(s.detail)}</div>` : ''}
      ${snippet ? `<div class="pb-snippet"><code>${esc(snippet)}</code></div>` : ''}
      <div class="pb-acts">
        ${snippet ? `<button class="btn ghost sm" data-pb-copy="${esc(snippet)}">${I.check} Copy</button>` : ''}
        ${s.link ? `<a class="btn ghost sm" href="${esc(s.link)}" target="_blank" rel="noopener">${I.arrow} ${esc(s.link_label || 'Open')}</a>` : ''}
        ${s.handoff ? `<button class="btn ai sm" data-pb-hand="${i}">${I.spark} Hand to Claude Code</button>` : ''}
      </div>
    </div>
  </div>`
}

/* ===================== HANDOFFS (To Claude Code) ===================== */
/* The cockpit dispatches real work to Claude Code and tracks it. Each handoff
   carries a payload you can copy as a clean markdown brief and paste straight in. */
const HANDOFF_STATUS = { new: 'lead', in_progress: 'in_progress', done: 'completed' }
const HANDOFF_STATUS_LABEL = { new: 'New', in_progress: 'In progress', done: 'Done' }
const HANDOFF_KIND_LABEL = { gate_step: 'Gate step', task: 'Task', build: 'Build', fix: 'Fix', research: 'Research' }

function handoffReport(h) {
  const p = h.payload || {}
  const lines = [`# ${h.title || 'Handoff'}`, '']
  lines.push(`**For:** Claude Code (Desk / Nyx)`)
  if (h.kind) lines.push(`**Kind:** ${HANDOFF_KIND_LABEL[h.kind] || h.kind}`)
  lines.push(`**Dispatched:** ${ago(h.created_at)} ago`)
  lines.push('')
  if (p.gate) lines.push(`**Gate:** ${p.gate}${p.step != null ? ` · step ${Number(p.step) + 1}` : ''}`)
  if (p.step_title) lines.push(`**Step:** ${p.step_title}`)
  if (p.context) { lines.push('', '## Context', p.context) }
  if (p.note) { lines.push('', '## Note', p.note) }
  lines.push('', '---', 'Sent from the Command Center. Do the work, then mark it done in the cockpit.')
  return lines.join('\n')
}
function payloadPreview(h) {
  const p = h.payload || {}
  const bits = []
  if (p.gate) bits.push(`gate: ${p.gate}${p.step != null ? ` #${Number(p.step) + 1}` : ''}`)
  if (p.step_title) bits.push(p.step_title)
  else if (p.context) bits.push(p.context)
  else if (p.note) bits.push(p.note)
  return bits.join(' · ')
}

async function viewHandoffs() {
  const d = await api('/api/handoffs'); const items = d.handoffs || []; const s = d.summary || {}
  const tr = $('.topbar .right'); if (tr) { tr.innerHTML = `<button class="btn ai sm" id="ho-add">${I.spark} New handoff</button>`; $('#ho-add').onclick = () => openHandoffNew() }
  const live = items.filter((h) => h.status !== 'done')
  const done = items.filter((h) => h.status === 'done')
  const sec = (title, rows) => rows.length
    ? `<div class="sec-h"><span class="label">${title}</span><span class="ct">${rows.length}</span></div><div class="list">${rows.map(handoffRow).join('')}</div>`
    : ''
  setView(`
    <div class="brief"><span class="tag">${I.spark} The cockpit's line to Claude Code</span>
      <p>When a move needs the heavy machine — a build, a fix, a deep research run — dispatch it here and it queues for Claude Code. Copy any one as a clean brief, paste it in, and tick it done when it lands. The gates fire these automatically when a step needs real work.</p></div>
    <div class="kpis">
      <div class="kpi primary"><div class="lab">New</div><div class="val">${s.new || 0}</div><div class="meta">waiting to send</div></div>
      <div class="kpi ${s.in_progress ? 'warn' : ''}"><div class="lab">In progress</div><div class="val">${s.in_progress || 0}</div><div class="meta">Claude's on it</div></div>
      <div class="kpi"><div class="lab">Done</div><div class="val">${s.done || 0}</div><div class="meta">shipped</div></div>
      <div class="kpi"><div class="lab">Total</div><div class="val">${s.total || 0}</div><div class="meta">all-time</div></div>
    </div>
    ${items.length ? '' : emptyState('Nothing dispatched yet', 'Hit "New handoff" or fire one from a gate step. It becomes a clean brief you paste into Claude Code — the cockpit dispatching the heavy work and tracking it to done.')}
    ${sec('In the queue', live)}
    ${done.length ? sec('Shipped', done) : ''}
  `)
  bindHandoffs(items)
}
function handoffRow(h) {
  const prev = payloadPreview(h)
  const done = h.status === 'done'
  return `<div class="lrow ho-row ${done ? 'done' : ''}">
    <div class="grow">
      <div class="nm">${esc(h.title || 'Handoff')}</div>
      <div class="qmeta">
        <span class="pill ${HANDOFF_STATUS[h.status] || 'lead'}"><span class="dot"></span>${esc(HANDOFF_STATUS_LABEL[h.status] || h.status)}</span>
        ${h.kind ? `<span class="age-tag">${esc(HANDOFF_KIND_LABEL[h.kind] || h.kind)}</span>` : ''}
        <span class="ct-when">${ago(h.created_at)} ago${done && h.done_at ? ` · shipped ${ago(h.done_at)} ago` : ''}</span>
      </div>
      ${prev ? `<div class="sub ho-prev">${esc(prev)}</div>` : ''}
    </div>
    <div class="qright">
      <div class="qacts">
        <button class="btn primary sm" data-ho-copy="${h.id}">${I.check} Copy report</button>
        ${h.status === 'new' ? `<button class="btn ghost sm" data-ho-status="in_progress" data-ho-id="${h.id}">Mark sent</button>` : ''}
        ${!done ? `<button class="btn ghost sm" data-ho-done="${h.id}">${I.check} Done</button>` : `<button class="btn ghost sm" data-ho-status="new" data-ho-id="${h.id}">Reopen</button>`}
      </div>
    </div>
  </div>`
}
function bindHandoffs(items) {
  app.querySelectorAll('[data-ho-copy]').forEach((b) => (b.onclick = () => { const h = items.find((x) => String(x.id) === b.dataset.hoCopy); if (h) copyText(handoffReport(h), b) }))
  app.querySelectorAll('[data-ho-status]').forEach((b) => (b.onclick = async () => {
    await api(`/api/handoffs/${b.dataset.hoId}/status`, { method: 'POST', body: JSON.stringify({ status: b.dataset.hoStatus }) }); renderApp('handoffs')
  }))
  app.querySelectorAll('[data-ho-done]').forEach((b) => (b.onclick = async () => {
    await api(`/api/handoffs/${b.dataset.hoDone}/done`, { method: 'POST', body: JSON.stringify({}) }); renderApp('handoffs')
  }))
}
function openHandoffNew() {
  const KINDS = [['build', 'Build'], ['fix', 'Fix'], ['research', 'Research'], ['task', 'Task']]
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">New handoff to Claude Code</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>What needs doing</label><input class="input" id="ho-title" placeholder="e.g. Build the Beat-Your-Quote landing page"></div>
      <div class="field"><label>Kind</label>
        <select class="input" id="ho-kind">${KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select></div>
      <div class="field"><label>Context / the brief (optional)</label>
        <textarea class="input ta" id="ho-note" rows="6" placeholder="Spell out what done looks like — the goal, files, copy angle, anything Claude needs cold."></textarea></div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn ai" id="ho-save">${I.spark} Dispatch</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#ho-save', wrap).onclick = async () => {
    const title = $('#ho-title', wrap).value.trim(); if (!title) return
    const note = $('#ho-note', wrap).value.trim()
    await api('/api/handoffs', { method: 'POST', body: JSON.stringify({ kind: $('#ho-kind', wrap).value, title, payload: note ? { note } : undefined }) })
    close(); renderApp('handoffs')
  }
}

/* ===================== CONTENT STUDIO Phase 1 · THE VAULT ===================== */
/* One place to dump it all, from any device. Bytes go browser→R2 direct (presigned
   PUT / multipart); Railway only brokers tickets + holds rows. Previews/downloads are
   fresh short-lived signed GETs. Paste-a-link (Drive/YouTube) kept as a fallback. */
const VAULT_KINDS = [['', 'All'], ['photo', 'Photos'], ['clip', 'Clips'], ['quote', 'Quotes'], ['invoice', 'Invoices'], ['doc', 'Docs']]
const MP_THRESHOLD = 100 * 1024 * 1024            // ≥100MB → multipart (big GoPro/4K)
const MP_PART = 8 * 1024 * 1024                    // ~8MB parts
const MP_PARALLEL = 3                              // parts in flight at once
const _vaultFilter = { kind: '', q: '' }
let _vaultStorage = false                          // R2 wired? (drives upload vs paste-only)
let _vaultUploads = []                             // live upload rows in the tray
let _vaultUid = 0

function fmtBytes(n) {
  n = Number(n || 0); if (!n) return ''
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}
function fmtDur(s) {
  s = Math.round(Number(s || 0)); if (!s) return ''
  const m = Math.floor(s / 60), r = s % 60
  return m + ':' + String(r).padStart(2, '0')
}
const kindOfFile = (f) => /^video\//.test(f.type) ? 'clip' : /^image\//.test(f.type) ? 'photo' : 'doc'

async function viewVault() {
  const tr = $('.topbar .right')
  if (tr) tr.innerHTML = `
    <input class="input vault-search" id="vault-q" placeholder="Search label, tag, caption…" autocomplete="off" value="${esc(_vaultFilter.q)}">
    <button class="btn ghost sm" id="vault-link">${I.arrow} Paste link</button>
    <button class="btn primary sm" id="vault-pick">${I.plus} Upload</button>`
  setView(`
    <input type="file" id="vault-file" accept="image/*,video/*" multiple hidden>
    <div class="vault-drop" id="vault-drop">
      <div class="vault-drop__ic">${I.spark}</div>
      <div class="vault-drop__t">Dump it all here</div>
      <div class="vault-drop__s">Drag photos &amp; clips in, or tap to grab them straight off your camera roll. Goes to one shelf, on every device.</div>
      <button class="btn primary sm" id="vault-pick2">${I.plus} Choose files</button>
    </div>
    <div class="vault-tray" id="vault-tray"></div>
    <div id="vault-wrap"><div class="loading">Loading…</div></div>`)
  // wire pickers + drag-drop
  const fileInput = $('#vault-file')
  const pick = () => fileInput.click()
  $('#vault-pick') && ($('#vault-pick').onclick = pick)
  $('#vault-pick2') && ($('#vault-pick2').onclick = pick)
  $('#vault-link') && ($('#vault-link').onclick = () => openVaultLink())
  fileInput.onchange = () => { if (fileInput.files.length) queueUploads([...fileInput.files]); fileInput.value = '' }
  const drop = $('#vault-drop')
  if (drop) {
    ;['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over') }))
    ;['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); if (ev === 'dragleave' && drop.contains(e.relatedTarget)) return; drop.classList.remove('over') }))
    drop.addEventListener('drop', (e) => { const fs = [...(e.dataTransfer?.files || [])]; if (fs.length) queueUploads(fs) })
  }
  const sb = $('#vault-q')
  if (sb) { let t; sb.oninput = () => { clearTimeout(t); t = setTimeout(() => { _vaultFilter.q = sb.value.trim(); loadVault() }, 240) } }
  renderTray()
  await loadVault()
}

async function loadVault() {
  const host = $('#vault-wrap'); if (!host) return
  const qs = []
  if (_vaultFilter.kind) qs.push('kind=' + encodeURIComponent(_vaultFilter.kind))
  if (_vaultFilter.q) qs.push('q=' + encodeURIComponent(_vaultFilter.q))
  let d; try { d = await api('/api/vault' + (qs.length ? '?' + qs.join('&') : '')) } catch (e) { d = { assets: [], by_kind: {} } }
  const assets = d.assets || [], byKind = d.by_kind || {}
  _vaultStorage = !!d.storage_configured
  // reflect storage state on the dropzone (paste-only until R2 is wired)
  const drop = $('#vault-drop')
  if (drop) drop.classList.toggle('off', !_vaultStorage)
  const ds = $('.vault-drop__s', drop || document)
  if (ds && !_vaultStorage) ds.textContent = "Direct upload turns on the moment R2 storage is connected. Until then, paste a Drive/YouTube link from the top right."
  const chips = VAULT_KINDS.map(([v, l]) => `<button class="lib-chip ${_vaultFilter.kind === v ? 'on' : ''}" data-vault-kind="${v}">${l}${v && byKind[v] ? ` <b>${byKind[v]}</b>` : ''}</button>`).join('')
  host.innerHTML = `
    <div class="lib-bar"><div class="lib-chips">${chips}</div>
      <span class="vault-count">${d.total || assets.length} item${(d.total || assets.length) === 1 ? '' : 's'}</span></div>
    ${assets.length
      ? `<div class="lib-grid vault-grid">${assets.map(vaultTile).join('')}</div>`
      : (_vaultFilter.q || _vaultFilter.kind
          ? `<div class="empty" style="padding:var(--s7) 0"><div class="ic">${I.today}</div><div class="ttl">Nothing matches</div><div class="sub">Try a different word or clear the filter.</div></div>`
          : emptyState('Vault is empty', 'Drop a clip or a photo up top — from your phone or this desktop — and it lands here, on one searchable shelf, ready to cut into content or show the next customer.'))}`
  host.querySelectorAll('[data-vault-kind]').forEach((b) => (b.onclick = () => { _vaultFilter.kind = b.dataset.vaultKind; loadVault() }))
  host.querySelectorAll('[data-vault-open]').forEach((el) => (el.onclick = () => {
    const a = assets.find((x) => String(x.id) === el.dataset.vaultOpen); if (a) openVaultAsset(a)
  }))
}

function vaultTile(a) {
  const isImg = a.kind === 'photo'
  const isClip = a.kind === 'clip'
  // images: any preview is a valid <img>. clips: only a real poster (thumb_key) is — never put a video URL in <img>.
  const imgThumb = isImg ? (a.thumb_url || a.preview_url || a.url) : (isClip && a.thumb_key ? a.thumb_url : null)
  const sub = [a.customer, a.vehicle].filter(Boolean).join(' · ') || a.service || a.issue || (a.storage === 'link' ? 'pasted link' : 'unsorted')
  const meta = [fmtBytes(a.bytes), a.created_at ? ago(a.created_at) + ' ago' : ''].filter(Boolean).join(' · ')
  return `<div class="lib-tile vault-tile" data-vault-open="${a.id}">
    <div class="lib-tile__media ${imgThumb ? '' : 'doc'} ${isClip ? 'clip' : ''}">
      ${imgThumb
        ? `<img src="${esc(imgThumb)}" alt="" loading="lazy" onerror="this.parentNode.classList.add('broken')">`
        : `<span class="lib-kind">${esc((a.kind || 'doc').toUpperCase())}</span>`}
      ${isClip ? `<span class="vault-play">${I.spark}</span>${a.duration_s ? `<span class="vault-dur">${fmtDur(a.duration_s)}</span>` : ''}` : ''}
      ${a.is_before ? '<span class="lib-before">BEFORE</span>' : ''}
      ${a.storage === 'link' ? '<span class="vault-src">LINK</span>' : ''}
    </div>
    <div class="lib-tile__meta">
      <div class="lib-tile__lbl">${esc(a.label || a.kind || 'attachment')}</div>
      <div class="lib-tile__sub">${esc(sub)}</div>
      ${meta ? `<div class="vault-tile__meta">${esc(meta)}</div>` : ''}
    </div>
  </div>`
}

/* ---- per-asset preview drawer: signed full URL, delete, link-to-a-job ---- */
async function openVaultAsset(a) {
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><aside class="drawer vault-drawer">
    <div class="drawer__h"><span class="pill" style="color:var(--fg2);background:var(--bg4)"><span class="dot"></span>${esc(a.kind || 'asset')}</span>
      ${a.is_before ? '<span class="lib-before" style="position:static">BEFORE</span>' : ''}
      <button class="drawer__close">${I.x}</button></div>
    <div class="drawer__b">
      <div class="vault-preview" id="vp"><div class="loading">Loading…</div></div>
      <div><div class="t-h2">${esc(a.label || a.kind || 'Attachment')}</div>
        <div style="color:var(--fg3);font-size:12px;margin-top:2px">${esc([a.customer, a.vehicle].filter(Boolean).join(' · ') || a.service || (a.storage === 'link' ? 'Pasted link' : 'Unsorted — not tied to a job yet'))}</div></div>
      <div class="vault-facts">
        ${a.bytes ? `<span class="vault-fact">${fmtBytes(a.bytes)}</span>` : ''}
        ${a.duration_s ? `<span class="vault-fact">${fmtDur(a.duration_s)}</span>` : ''}
        ${a.mime ? `<span class="vault-fact">${esc(a.mime)}</span>` : ''}
        ${a.created_at ? `<span class="vault-fact">${ago(a.created_at)} ago</span>` : ''}
      </div>
      ${a.ai_caption ? `<div class="ai-read">${I.spark}<span>${esc(a.ai_caption)}</span></div>` : ''}
      <div style="display:flex;gap:var(--s2);flex-wrap:wrap">
        <a class="btn ghost sm" id="vp-open" target="_blank" rel="noopener">${I.arrow} Open / download</a>
        ${a.job_id ? `<button class="btn ghost sm" id="vp-job">${I.pipeline} View job</button>` : `<button class="btn ghost sm" id="vp-link">${I.plus} Link to a job</button>`}
        <button class="btn ghost sm vault-del" id="vp-del">${I.x} Delete</button>
      </div>
    </div></aside>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close; $('.drawer__close', wrap).onclick = close
  // resolve a fresh full URL, then render the right preview element
  let fullUrl = a.preview_url || a.url
  try { const u = await api(`/api/assets/${a.id}/url`); if (u && u.url) fullUrl = u.url } catch (e) { /* fall back to preview */ }
  const vp = $('#vp', wrap)
  if (vp) {
    if (a.kind === 'clip') vp.innerHTML = `<video src="${esc(fullUrl)}" controls playsinline preload="metadata" poster="${esc(a.thumb_url || '')}"></video>`
    else if (a.kind === 'photo') vp.innerHTML = `<img src="${esc(fullUrl)}" alt="${esc(a.label || '')}" onerror="this.parentNode.classList.add('broken')">`
    else vp.innerHTML = `<div class="vault-preview__doc"><span class="lib-kind">${esc((a.kind || 'doc').toUpperCase())}</span></div>`
  }
  const open = $('#vp-open', wrap); if (open) open.href = fullUrl
  const vj = $('#vp-job', wrap); if (vj) vj.onclick = () => { close(); openJob(a.job_id) }
  const vl = $('#vp-link', wrap); if (vl) vl.onclick = () => openLinkToJob(a, () => { close(); loadVault() })
  const del = $('#vp-del', wrap); if (del) del.onclick = async () => {
    if (!confirm('Delete this asset? This removes it from R2 too.')) return
    del.disabled = true
    await api(`/api/assets/${a.id}/delete`, { method: 'POST' })
    close(); loadVault()
  }
}

/* ---- link an unsorted asset to a job (re-record under the job) ---- */
async function openLinkToJob(a, onDone) {
  let jobs = []
  try { jobs = (await api('/api/jobs')).jobs || [] } catch (e) { jobs = [] }
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Link to a job</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>Job</label>
        <select class="input" id="ltj-job">${jobs.map((j) => `<option value="${j.id}">${esc([j.customer, j.vehicle, j.issue].filter(Boolean).join(' · ') || ('Job #' + j.id))}</option>`).join('') || '<option value="">No jobs yet</option>'}</select></div>
      <div class="vault-note">Ties this clip/photo to the customer + vehicle so it shows on their job and in before/after.</div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="ltj-save">${I.check} Link it</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#ltj-save', wrap).onclick = async () => {
    const jobId = $('#ltj-job', wrap).value; if (!jobId) return close()
    // for R2 assets: re-record under the job (keeps the same object); then drop the old row.
    if (a.storage === 'r2' && a.r2_key) {
      await api('/api/uploads/record', { method: 'POST', body: JSON.stringify({ r2_key: a.r2_key, kind: a.kind, mime: a.mime || undefined, bytes: a.bytes || undefined, filename: a.label || undefined, job_id: Number(jobId), is_before: a.is_before }) })
      await api(`/api/assets/${a.id}/delete`, { method: 'POST' })
    } else {
      // link asset: attach a fresh copy to the job via the legacy paste route, then drop the loose row
      await api(`/api/jobs/${jobId}/assets`, { method: 'POST', body: JSON.stringify({ url: a.url, kind: a.kind, label: a.label || undefined, is_before: a.is_before }) })
      await api(`/api/assets/${a.id}/delete`, { method: 'POST' })
    }
    close(); onDone && onDone()
  }
}

/* ---- paste-a-link fallback (Drive / YouTube / PDF) — storage='link' ----
   The link path reuses the legacy per-job assets route (which is the only insert
   for storage='link'), so a link is attached to a job. Photos/clips belong up top. */
async function openVaultLink() {
  let jobs = []
  try { jobs = (await api('/api/jobs')).jobs || [] } catch (e) { jobs = [] }
  const wrap = document.createElement('div')
  wrap.innerHTML = `<div class="scrim"></div><div class="modal">
    <div class="modal__h"><div class="t-h2">Paste a link</div><button class="drawer__close mclose">${I.x}</button></div>
    <div class="modal__b">
      <div class="field"><label>URL</label><input class="input" id="vl-url" placeholder="https://… (Drive, YouTube, PDF)"></div>
      <div class="vault-add__row">
        <select class="input" id="vl-kind">${ASSET_KINDS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
        <input class="input" id="vl-label" placeholder="Label (optional)">
      </div>
      <div class="field"><label>Attach to job</label>
        <select class="input" id="vl-job">${jobs.map((j) => `<option value="${j.id}">${esc([j.customer, j.vehicle, j.issue].filter(Boolean).join(' · ') || ('Job #' + j.id))}</option>`).join('') || '<option value="">No jobs yet — add a lead first</option>'}</select></div>
      <label class="as-check"><input type="checkbox" id="vl-before"> <span>This is a "before" shot</span></label>
      <div class="vault-note">For files you'd rather keep on Drive/YouTube. Photos &amp; clips are better dumped straight up top — they get a real thumbnail and live on R2.</div>
    </div>
    <div class="modal__f"><button class="btn ghost mclose">Cancel</button><button class="btn primary" id="vl-save">${I.plus} Add link</button></div>
  </div>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close
  wrap.querySelectorAll('.mclose').forEach((b) => (b.onclick = close))
  $('#vl-save', wrap).onclick = async () => {
    const url = $('#vl-url', wrap).value.trim(); if (!url) return
    const jobId = $('#vl-job', wrap).value; if (!jobId) { alert('Add a lead first, then a link can hang off the job.'); return }
    await api(`/api/jobs/${jobId}/assets`, { method: 'POST', body: JSON.stringify({ url, kind: $('#vl-kind', wrap).value, label: $('#vl-label', wrap).value.trim() || undefined, is_before: $('#vl-before', wrap).checked }) })
    close(); loadVault()
  }
}

/* ================= UPLOAD ENGINE (browser → R2 direct, real progress) ================= */
function renderTray() {
  const tray = $('#vault-tray'); if (!tray) return
  const live = _vaultUploads.filter((u) => u.status !== 'gone')
  if (!live.length) { tray.innerHTML = ''; return }
  const anyBig = live.some((u) => u.size >= MP_THRESHOLD && u.status === 'uploading')
  tray.innerHTML = `
    <div class="vault-tray__h"><span class="label">Uploading · ${live.filter((u) => u.status === 'uploading').length} active</span>
      ${anyBig ? `<span class="vault-keep">Keep this tab open while big videos finish</span>` : ''}
      <button class="vault-tray__clear" id="vault-clear">Clear done</button></div>
    ${live.map((u) => `
      <div class="vup ${u.status}">
        <span class="vup__ic">${u.status === 'done' ? I.check : u.status === 'error' ? I.x : I.spark}</span>
        <div class="vup__body">
          <div class="vup__name">${esc(u.name)} <span class="vup__sz">${fmtBytes(u.size)}${u.size >= MP_THRESHOLD ? ' · multipart' : ''}</span></div>
          <div class="vup__bar"><i style="width:${Math.round(u.pct)}%"></i></div>
        </div>
        <span class="vup__pct">${u.status === 'done' ? 'Done' : u.status === 'error' ? 'Failed' : Math.round(u.pct) + '%'}</span>
        ${u.status === 'uploading' ? `<button class="vup__x" data-vup-cancel="${u.id}" title="Cancel">${I.x}</button>` : u.status === 'error' ? `<button class="vup__x retry" data-vup-retry="${u.id}" title="Retry">${I.arrow}</button>` : ''}
      </div>`).join('')}`
  const clr = $('#vault-clear'); if (clr) clr.onclick = () => { _vaultUploads = _vaultUploads.filter((u) => u.status === 'uploading'); renderTray() }
  tray.querySelectorAll('[data-vup-cancel]').forEach((b) => (b.onclick = () => cancelUpload(b.dataset.vupCancel)))
  tray.querySelectorAll('[data-vup-retry]').forEach((b) => (b.onclick = () => { const u = _vaultUploads.find((x) => String(x.id) === b.dataset.vupRetry); if (u) startUpload(u) }))
}
function setUp(u, patch) { Object.assign(u, patch); renderTray() }

function queueUploads(files) {
  if (!_vaultStorage) { alert('Direct upload turns on once R2 storage is connected. Use "Paste link" for now.'); return }
  for (const f of files) {
    const u = { id: ++_vaultUid, file: f, name: f.name, size: f.size, type: f.type || 'application/octet-stream', kind: kindOfFile(f), pct: 0, status: 'uploading', xhr: null, aborted: false, mp: null }
    _vaultUploads.unshift(u); startUpload(u)
  }
  renderTray()
}
async function startUpload(u) {
  setUp(u, { status: 'uploading', pct: 0, aborted: false })
  try {
    if (u.size >= MP_THRESHOLD) await uploadMultipart(u)
    else await uploadSingle(u)
    if (u.aborted) return
    // record the row (storage='r2'); then refresh the grid
    const dur = u.kind === 'clip' ? await probeDuration(u.file).catch(() => null) : null
    await api('/api/uploads/record', { method: 'POST', body: JSON.stringify({ r2_key: u.r2_key, kind: u.kind, mime: u.type, bytes: u.size, filename: u.name, duration_s: dur || undefined }) })
    setUp(u, { status: 'done', pct: 100 })
    loadVault()
  } catch (e) {
    if (u.aborted) return
    console.error('[upload]', e && e.message)
    setUp(u, { status: 'error' })
  }
}

// XHR PUT with real progress; resolves on 2xx, rejects otherwise (so we can retry just this PUT)
function putWithProgress(url, body, contentType, onPct, hold) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    if (hold) hold.xhr = xhr
    xhr.open('PUT', url, true)
    if (contentType) xhr.setRequestHeader('Content-Type', contentType)
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onPct) onPct(e.loaded / e.total) }
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve({ etag: xhr.getResponseHeader('ETag') })
      else reject(new Error('PUT ' + xhr.status))
    }
    xhr.onerror = () => reject(new Error('network'))
    xhr.onabort = () => reject(new Error('aborted'))
    xhr.send(body)
  })
}

async function uploadSingle(u) {
  const sign = await api('/api/uploads/sign', { method: 'POST', body: JSON.stringify({ filename: u.name, content_type: u.type, size: u.size, kind: u.kind }) })
  if (!sign || !sign.url) throw new Error(sign && sign.error || 'sign failed')
  u.r2_key = sign.r2_key
  await putWithProgress(sign.url, u.file, sign.content_type || u.type, (p) => { if (!u.aborted) setUp(u, { pct: p * 100 }) }, u)
}

async function uploadMultipart(u) {
  const create = await api('/api/uploads/multipart/create', { method: 'POST', body: JSON.stringify({ filename: u.name, content_type: u.type, kind: u.kind }) })
  if (!create || !create.uploadId) throw new Error(create && create.error || 'create failed')
  u.r2_key = create.r2_key; u.mp = { uploadId: create.uploadId }
  const total = Math.ceil(u.size / MP_PART)
  const parts = []                 // [{PartNumber, ETag}]
  const progress = new Array(total).fill(0)
  const bump = () => { if (!u.aborted) setUp(u, { pct: (progress.reduce((a, b) => a + b, 0) / total) * 100 }) }
  let next = 1
  const worker = async () => {
    while (next <= total) {
      if (u.aborted) return
      const partNumber = next++
      const start = (partNumber - 1) * MP_PART
      const blob = u.file.slice(start, Math.min(start + MP_PART, u.size))   // never buffer the whole file
      await uploadOnePart(u, partNumber, blob, (p) => { progress[partNumber - 1] = p; bump() }, parts)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MP_PARALLEL, total) }, worker))
  if (u.aborted) return
  const out = await api('/api/uploads/multipart/complete', { method: 'POST', body: JSON.stringify({ r2_key: u.r2_key, uploadId: u.mp.uploadId, parts }) })
  if (!out || !out.ok) throw new Error(out && out.error || 'complete failed')
}

async function uploadOnePart(u, partNumber, blob, onPct, parts) {
  let lastErr
  for (let attempt = 0; attempt < 3; attempt++) {       // retry ONLY this part on flaky LTE
    if (u.aborted) return
    try {
      const s = await api('/api/uploads/multipart/sign', { method: 'POST', body: JSON.stringify({ r2_key: u.r2_key, uploadId: u.mp.uploadId, partNumber }) })
      if (!s || !s.url) throw new Error(s && s.error || 'sign part failed')
      const res = await putWithProgress(s.url, blob, null, onPct)
      const etag = res.etag || ''
      parts.push({ PartNumber: partNumber, ETag: etag })
      onPct(1)
      return
    } catch (e) { lastErr = e; onPct(0); await new Promise((r) => setTimeout(r, 600 * (attempt + 1))) }
  }
  throw lastErr || new Error('part ' + partNumber + ' failed')
}

function cancelUpload(id) {
  const u = _vaultUploads.find((x) => String(x.id) === String(id)); if (!u) return
  u.aborted = true
  try { u.xhr && u.xhr.abort() } catch (e) { /* noop */ }
  if (u.mp && u.r2_key) api('/api/uploads/multipart/abort', { method: 'POST', body: JSON.stringify({ r2_key: u.r2_key, uploadId: u.mp.uploadId }) }).catch(() => {})
  u.status = 'gone'; renderTray()
}

// read a clip's duration locally (no upload needed) for the asset row
function probeDuration(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'; v.muted = true
    const url = URL.createObjectURL(file)
    const done = (val) => { URL.revokeObjectURL(url); resolve(val) }
    v.onloadedmetadata = () => done(isFinite(v.duration) ? Math.round(v.duration) : null)
    v.onerror = () => { URL.revokeObjectURL(url); reject(new Error('probe')) }
    v.src = url
  })
}

if (token) renderApp('pulse'); else renderLogin()
