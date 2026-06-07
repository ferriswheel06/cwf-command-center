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
  ['Acquire', [['pulse', 'Pulse', I.spark]]],
  ['Operate', [['pipeline', 'Pipeline', I.pipeline], ['money', 'Money', I.money]]],
  ['Grow', [['activation', 'Activation', I.bolt]]],
]
const FLAT = NAV_GROUPS.flatMap(([, items]) => items)
const TITLE = { pulse: 'Pulse', pipeline: 'Pipeline', money: 'Money', activation: 'Activation' }

/* ---------------- login ---------------- */
function renderLogin(msg = '') {
  app.innerHTML = `<div class="login"><div class="login-card">
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
        <div class="side__logo"><span class="chip">CWF</span><span>Command</span></div>
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
  } catch (e) { /* 401 handled */ }
}

function tierBadge(j) {
  if (j.ticket_tier === 'HIGH') return `<span class="ai-score high">${I.spark}HIGH-TICKET</span>`
  return `<span class="ai-score">${I.spark}Standard</span>`
}
function emptyState(ttl, sub) { return `<div class="empty"><div class="ic">${I.bolt}</div><div class="ttl">${esc(ttl)}</div><div class="sub">${esc(sub)}</div></div>` }

/* ---------------- PULSE ---------------- */
function gauge(score) {
  const r = 54, circ = 2 * Math.PI * r, off = circ * (1 - Math.max(0, Math.min(100, score)) / 100)
  const col = score >= 66 ? '#44D07F' : score >= 33 ? '#E0922E' : '#F6736B'
  return `<svg viewBox="0 0 128 128" width="128" height="128" style="flex-shrink:0">
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="#1a1d22" stroke-width="10"/>
    <circle cx="64" cy="64" r="${r}" fill="none" stroke="${col}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 64 64)"/>
    <text x="64" y="62" text-anchor="middle" fill="#F4F5F7" font-size="32" font-weight="700" font-family="'JetBrains Mono',monospace">${score}</text>
    <text x="64" y="82" text-anchor="middle" fill="#868B98" font-size="9" letter-spacing="1.5">ENERGY</text></svg>`
}
function bdChip(name, val) { return `<span class="bd-chip"><span>${name}</span><b>${Math.round(val || 0)}</b></span>` }
function voiceCard(title, value, status, sub, question) {
  return `<div class="vcard"><div class="vh"><span class="vdot ${status || 'bad'}"></span><span class="vt">${title}</span></div>
    <div class="vv">${esc(value)}</div><div class="vs">${esc(sub)}</div><div class="vq">${esc(question)}</div></div>`
}
function goalBar(name, val, target, isMoney) {
  const pct = Math.min(100, Math.round((val / (target || 1)) * 100)); const f = (n) => isMoney ? money(n) : n
  return `<div class="gb"><div class="gb__top"><span>${name}</span><b class="num">${f(val)} / ${f(target)}</b></div>
    <div class="goal__track"><div class="goal__fill ${pct >= 100 ? 'over' : ''}" style="width:${pct}%"></div></div></div>`
}
async function viewPulse() {
  const d = await api('/api/pulse'); const e = d.energy || {}, v = d.voice || {}, om = d.oneMove || {}, g = d.goals || {}
  const deltaTxt = e.delta == null ? 'first read' : (e.delta > 0 ? `▲ ${e.delta} vs last` : e.delta < 0 ? `▼ ${Math.abs(e.delta)} vs last` : 'flat vs last')
  const bd = e.breakdown || {}
  setView(`
    <div class="pulse-grid">
      <div class="energy-hero panel">${gauge(e.score || 0)}
        <div class="energy-meta">
          <div class="energy-label ${e.label === 'Gaining' ? 'g' : e.label === 'Bleeding' ? 'b' : 'w'}">${esc(e.label || '')}</div>
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
      ${voiceCard('Respond', `${v.respond ? v.respond.open_leads : 0} open`, v.respond && v.respond.status, v.respond && v.respond.median_reply == null ? 'no replies yet' : `${v.respond.median_reply}m reply`, 'Did you answer fast?')}
    </div>
    <div class="sec-h"><span class="label">This week</span></div>
    <div class="panel goals-panel">
      ${goalBar('Leads', (v.hear ? v.hear.new_leads : 0) || 0, g.weekly_leads || 3)}
      ${goalBar('Revenue', d.rev_wk || 0, g.weekly_revenue || 1200, true)}
      ${goalBar('Posts', (v.transmit ? v.transmit.posts_wk : 0) || 0, g.posting_cadence || 3)}
    </div>
  `)
  const go = $('#om-go'); if (go) go.onclick = async () => {
    if (om.key === 'reply' && om.job_id) { openJob(om.job_id); return }
    await api('/api/pulse/action', { method: 'POST', body: JSON.stringify({ key: om.key }) }); renderApp('pulse')
  }
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

/* ---------------- ACTIVATION ---------------- */
async function viewActivation() {
  const d = await api('/api/activation'); const items = d.items || []
  const done = items.filter((i) => i.status === 'done').length
  setView(`
    <div class="brief"><span class="tag">${I.bolt} The machine is built — this turns it ON</span>
      <p>${done} of ${items.length} gates done. Each one you flip unlocks real leads. Top priority: send the 2 review-ask texts.</p></div>
    <div class="sec-h"><span class="label">Activation gates</span></div>
    <div class="list">${items.map(actRow).join('')}</div>
  `)
  app.querySelectorAll('[data-act]').forEach((el) => {
    el.querySelector('.act__check').onclick = async () => {
      const cur = el.dataset.status; const nx = cur === 'done' ? 'todo' : 'done'
      await api(`/api/activation/${el.dataset.act}`, { method: 'PATCH', body: JSON.stringify({ status: nx }) }); renderApp('activation')
    }
    el.querySelector('select').onchange = async (e) => { await api(`/api/activation/${el.dataset.act}`, { method: 'PATCH', body: JSON.stringify({ status: e.target.value }) }); renderApp('activation') }
  })
}
function actRow(it) {
  const on = it.status === 'done'
  return `<div class="act ${on ? 'done' : ''}" data-act="${it.id}" data-status="${it.status}">
    <div class="act__check ${on ? 'on' : ''}">${on ? I.check : ''}</div>
    <div class="grow"><div class="nm">${esc(it.label)}</div><div class="un">${esc(it.unlocks || '')}</div></div>
    <select><option value="todo" ${it.status === 'todo' ? 'selected' : ''}>To do</option>
      <option value="doing" ${it.status === 'doing' ? 'selected' : ''}>Doing</option>
      <option value="done" ${it.status === 'done' ? 'selected' : ''}>Done</option></select>
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
        <button class="btn primary sm" id="dquote">Quote</button></div>
      <div><div class="label" style="margin-bottom:var(--s2)">Activity</div>
        <div class="tl">${(d.activity || []).map((a) => `<div class="tl__i"><span class="dot"></span><div><div class="body">${esc(a.body || a.type)}</div><div class="when">${ago(a.created_at)} ago</div></div></div>`).join('') || '<span style="color:var(--fg4);font-size:12px">No activity yet</span>'}</div></div>
    </div></aside>`
  document.body.appendChild(wrap)
  const close = () => wrap.remove()
  $('.scrim', wrap).onclick = close; $('.drawer__close', wrap).onclick = close
  const adv = $('#dadv', wrap); if (adv) adv.onclick = async () => { await api(`/api/jobs/${id}/advance`, { method: 'POST' }); close(); renderApp() }
  $('#dquote', wrap).onclick = () => { close(); openQuote(j) }
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
if (token) renderApp('pulse'); else renderLogin()
