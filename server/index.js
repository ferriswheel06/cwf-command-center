// Cars With Fares — Command Center API + UI (Railway + Postgres)
// Free AI stays on the Cloudflare crm-api Worker (env.AI only lives there); we call it over HTTPS.
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { applySchema } from './db/apply-schema.js'

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
})
const q = (text, params) => pool.query(text, params)

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'

// --- heuristics (real AI scoring via the Worker is a later bolt-on) ---
const HIGH_RE = /suspension|control arm|ball joint|engine|transmission|clutch|alternator|timing|head gasket|strut|shock|no.?start|axle|differential|turbo|rack|cv|rebuild|head/i
const SAFETY_RE = /brake|steering|overheat|knock|smoke|stall|grinding|wobble|no.?brake/i
const tierOf = (issue, est) => (Number(est) || 0) >= 700 || HIGH_RE.test(issue || '') ? 'HIGH' : 'STANDARD'
const safetyOf = (issue) => SAFETY_RE.test(issue || '')

// --- seed the 2 real jobs the first time ---
async function seedIfEmpty() {
  try {
    const { rows } = await q('select count(*)::int as n from jobs')
    if (rows[0].n > 0) return
    const rob = (await q(`insert into customers (business_id,name,location,source) values (1,$1,$2,'referral') returning id`, ['Rob', 'Mississauga'])).rows[0]
    const robV = (await q(`insert into vehicles (business_id,customer_id,notes) values (1,$1,'Suspension') returning id`, [rob.id])).rows[0]
    await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,service,source,charge,est_value,is_high_ticket,ticket_tier,first_contact_at,paid_at,created_at)
             values (1,$1,$2,'paid','Full suspension refresh','Suspension','referral',1400,1400,true,'HIGH',now(),timestamptz '2026-05-30',timestamptz '2026-05-28')`, [rob.id, robV.id])
    const geo = (await q(`insert into customers (business_id,name,location,source) values (1,$1,$2,'referral') returning id`, ['George (Brothers Deals On Wheels)', 'Oakville'])).rows[0]
    const geoV = (await q(`insert into vehicles (business_id,customer_id,make,model,notes) values (1,$1,'Ram','2500','Diesel service') returning id`, [geo.id])).rows[0]
    await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,service,source,charge,est_value,is_high_ticket,ticket_tier,first_contact_at,paid_at,created_at)
             values (1,$1,$2,'paid','Ram 2500 diesel service','Diesel service','referral',450,450,false,'STANDARD',now(),timestamptz '2026-03-22',timestamptz '2026-03-20')`, [geo.id, geoV.id])
    console.log('[seed] inserted 2 real jobs ✓')
  } catch (e) { console.error('[seed] failed:', e.message) }
}

const app = new Hono()
app.use('/api/*', cors())

// ---- static cockpit UI ----
app.get('/', serveStatic({ path: './web/index.html' }))
app.get('/tokens.css', serveStatic({ path: './web/tokens.css' }))
app.get('/style.css', serveStatic({ path: './web/style.css' }))
app.get('/app.js', serveStatic({ path: './web/app.js' }))

app.get('/health', async (c) => {
  try { await q('select 1'); return c.json({ ok: true, db: 'up' }) }
  catch (e) { return c.json({ ok: false, db: 'down', error: String(e) }, 500) }
})

// ---- auth ----
app.post('/api/login', async (c) => {
  const { password } = await c.req.json().catch(() => ({}))
  const hash = createHash('sha256').update(password || '').digest('hex')
  if (!process.env.PASSWORD_HASH || hash !== process.env.PASSWORD_HASH.trim()) return c.json({ error: 'wrong password' }, 401)
  return c.json({ token: jwt.sign({ business_id: 1, sub: 'fares' }, JWT_SECRET, { expiresIn: '7d' }) })
})
const auth = async (c, next) => {
  const h = c.req.header('authorization') || ''
  const t = h.startsWith('Bearer ') ? h.slice(7) : null
  try { c.set('claims', jwt.verify(t, JWT_SECRET)) } catch { return c.json({ error: 'unauthorized' }, 401) }
  await next()
}
const biz = (c) => c.get('claims').business_id
app.get('/api/me', auth, (c) => c.json({ business_id: biz(c) }))

// ---- shared selects ----
const JOB_COLS = `j.id, j.status, j.issue, j.service, j.source, j.charge, j.est_value, j.parts_cost, j.gas_cost, j.est_profit,
  j.ticket_tier, j.likely_cause, j.safety_flag, j.is_high_ticket, j.first_contact_at, j.scheduled_date, j.follow_up_at, j.created_at,
  c.name as customer, c.phone, c.location, nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle`
const JOB_FROM = `from jobs j join customers c on c.id=j.customer_id left join vehicles v on v.id=j.vehicle_id`

// ---- TODAY ----
app.get('/api/today', auth, async (c) => {
  const b = biz(c)
  const stats = (await q(`select
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue,
      count(*) filter (where status='paid')::int as paid_jobs,
      count(*) filter (where status='lead')::int as new_leads,
      count(*) filter (where status not in ('paid','lost'))::int as open_jobs
    from jobs where business_id=$1`, [b])).rows[0]
  stats.avg_ticket = stats.paid_jobs ? Math.round(stats.revenue / stats.paid_jobs) : 0
  const callFirst = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status in ('lead','quoted')
      order by (j.ticket_tier='HIGH') desc, j.created_at desc limit 12`, [b])).rows
  const stale = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status in ('lead','quoted') and j.created_at < now() - interval '3 days'
      order by j.created_at asc limit 12`, [b])).rows
  const scheduledToday = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.scheduled_date = current_date order by j.created_at`, [b])).rows
  const unpaid = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status='completed' order by j.created_at`, [b])).rows
  // computed brief (real AI narration is a later bolt-on)
  const hot = callFirst.find((l) => l.ticket_tier === 'HIGH')
  let brief = `You're at $${stats.revenue.toLocaleString()} all-time across ${stats.paid_jobs} paid jobs (avg $${stats.avg_ticket.toLocaleString()}). `
  if (hot) brief += `Call ${hot.customer} first — high-ticket${hot.issue ? ` (${hot.issue})` : ''}. `
  else if (callFirst.length) brief += `${callFirst.length} lead${callFirst.length > 1 ? 's' : ''} to work. `
  else brief += `No leads in the pipe — flip an activation gate to turn the machine on. `
  if (stale.length) brief += `${stale.length} going stale. `
  if (unpaid.length) brief += `${unpaid.length} job${unpaid.length > 1 ? 's' : ''} completed and unpaid. `
  return c.json({ stats, brief, callFirst, stale, scheduledToday, unpaid })
})

// ---- PIPELINE ----
app.get('/api/jobs', auth, async (c) => {
  const rows = (await q(`select ${JOB_COLS} ${JOB_FROM} where j.business_id=$1 order by j.created_at desc`, [biz(c)])).rows
  return c.json({ jobs: rows })
})
app.get('/api/jobs/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const job = (await q(`select ${JOB_COLS}, c.id as customer_id, c.email ${JOB_FROM} where j.id=$1 and j.business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  const activity = (await q(`select type, body, created_at from activity where job_id=$1 order by created_at desc`, [id])).rows
  return c.json({ job, activity })
})
const FLOW = ['lead', 'quoted', 'scheduled', 'in_progress', 'completed', 'paid']
app.post('/api/jobs/:id/advance', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const cur = (await q(`select status from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!cur) return c.json({ error: 'not found' }, 404)
  const i = FLOW.indexOf(cur.status)
  const next = i >= 0 && i < FLOW.length - 1 ? FLOW[i + 1] : cur.status
  await q(`update jobs set status=$1${next === 'paid' ? ', paid_at=now()' : ''} where id=$2 and business_id=$3`, [next, id, b])
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'status_change',$3)`, [b, id, `→ ${next}`])
  return c.json({ status: next })
})
app.post('/api/jobs/:id/contact', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  await q(`update jobs set first_contact_at=coalesce(first_contact_at,now()) where id=$1 and business_id=$2`, [id, b])
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'contact','Contacted')`, [b, id])
  return c.json({ ok: true })
})
// quote builder ($1k profit floor, flat, no tax)
app.post('/api/jobs/:id/quote', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const charge = Number(d.charge) || 0, parts = Number(d.parts_cost) || 0, gas = Number(d.gas_cost) || 0
  const profit = charge - parts - gas
  await q(`update jobs set charge=$1, parts_cost=$2, gas_cost=$3, est_profit=$4, status=case when status='lead' then 'quoted' else status end
           where id=$5 and business_id=$6`, [charge, parts, gas, profit, id, b])
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'quote',$3)`, [b, id, `Quoted $${charge} · profit $${profit}`])
  return c.json({ charge, parts_cost: parts, gas_cost: gas, profit, below_floor: profit < 1000 })
})
app.patch('/api/jobs/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const sets = [], vals = []
  for (const k of ['status', 'issue', 'service', 'scheduled_date', 'notes']) {
    if (d[k] !== undefined) { vals.push(d[k]); sets.push(`${k}=$${vals.length}`) }
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400)
  vals.push(id, b)
  await q(`update jobs set ${sets.join(', ')} where id=$${vals.length - 1} and business_id=$${vals.length}`, vals)
  return c.json({ ok: true })
})

// ---- create lead (manual; mirrors the Worker intake contract) ----
app.post('/api/leads', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  if (!d.name && !d.phone) return c.json({ error: 'need a name or phone' }, 400)
  const norm = d.phone ? String(d.phone).replace(/\D/g, '').slice(-10) : null
  let cust = norm ? (await q(`select id from customers where business_id=$1 and phone_normalized=$2`, [b, norm])).rows[0] : null
  if (!cust) cust = (await q(`insert into customers (business_id,name,phone,phone_normalized,location,source) values ($1,$2,$3,$4,$5,$6) returning id`,
    [b, d.name || null, d.phone || null, norm, d.location || null, d.source || 'manual'])).rows[0]
  let vId = null
  if (d.vehicle) vId = (await q(`insert into vehicles (business_id,customer_id,notes) values ($1,$2,$3) returning id`, [b, cust.id, d.vehicle])).rows[0].id
  const est = d.est_value ? Number(String(d.est_value).replace(/[^\d.]/g, '')) : null
  const tier = tierOf(d.issue, est), safety = safetyOf(d.issue)
  const job = (await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,service,est_value,is_high_ticket,ticket_tier,safety_flag,source)
      values ($1,$2,$3,'lead',$4,$5,$6,$7,$8,$9,$10) returning id`,
    [b, cust.id, vId, d.issue || null, d.service || null, est, tier === 'HIGH', tier, safety, d.source || 'manual'])).rows[0]
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'system','Lead created')`, [b, job.id])
  return c.json({ id: job.id, ticket_tier: tier, safety_flag: safety })
})

// ---- MONEY (funnel/targets + profit) ----
app.get('/api/money', auth, async (c) => {
  const b = biz(c)
  const m = (await q(`select
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue,
      coalesce(sum(coalesce(charge,0)-coalesce(parts_cost,0)-coalesce(gas_cost,0)) filter (where status='paid'),0)::float as profit,
      count(*) filter (where status='paid')::int as paid,
      count(*) filter (where status='lead')::int as leads,
      count(*) filter (where status in ('quoted','scheduled','in_progress'))::int as active,
      count(*) filter (where status='lost')::int as lost,
      count(*)::int as total_jobs,
      coalesce(sum(charge) filter (where status='paid' and paid_at > now() - interval '12 months'),0)::float as rolling12
    from jobs where business_id=$1`, [b])).rows[0]
  m.avg_ticket = m.paid ? Math.round(m.revenue / m.paid) : 0
  const targets = (await q(`select value from settings where business_id=$1 and key='growth_targets'`, [b])).rows[0]?.value || {}
  const views = (await q(`select coalesce(sum(views),0)::int as v from traffic where business_id=$1`, [b])).rows[0].v
  const funnel = { views, contacts: m.total_jobs, jobs: m.paid, revenue: m.revenue }
  return c.json({ ...m, targets, funnel })
})
app.get('/api/targets', auth, async (c) => {
  const t = (await q(`select value from settings where business_id=$1 and key='growth_targets'`, [biz(c)])).rows[0]?.value || {}
  return c.json(t)
})
app.put('/api/targets', auth, async (c) => {
  const d = await c.req.json().catch(() => ({}))
  await q(`insert into settings (business_id,key,value) values ($1,'growth_targets',$2::jsonb)
           on conflict (business_id,key) do update set value=$2::jsonb, updated_at=now()`, [biz(c), JSON.stringify(d)])
  return c.json({ ok: true })
})
app.post('/api/traffic', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const day = d.day || new Date().toISOString().slice(0, 10), views = Number(d.views) || 0
  await q(`insert into traffic (business_id,day,views) values ($1,$2,$3)
           on conflict (business_id,day) do update set views=$3`, [b, day, views])
  return c.json({ ok: true })
})

// ---- ACTIVATION switchboard ----
app.get('/api/activation', auth, async (c) => {
  const rows = (await q(`select id,key,label,status,unlocks,doc_link,sort from activation where business_id=$1 order by sort`, [biz(c)])).rows
  return c.json({ items: rows })
})
app.patch('/api/activation/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  if (!['todo', 'doing', 'done'].includes(d.status)) return c.json({ error: 'bad status' }, 400)
  await q(`update activation set status=$1, updated_at=now() where id=$2 and business_id=$3`, [d.status, id, b])
  return c.json({ ok: true })
})

// ---- PULSE (the acquisition engine) ----
async function getJson(b, key, def) {
  const r = (await q(`select value from settings where business_id=$1 and key=$2`, [b, key])).rows[0]
  return r ? { ...def, ...r.value } : def
}
async function setJson(b, key, val) {
  await q(`insert into settings (business_id,key,value) values ($1,$2,$3::jsonb)
           on conflict (business_id,key) do update set value=$3::jsonb, updated_at=now()`, [b, key, JSON.stringify(val)])
}
const clamp = (n) => Math.max(0, Math.min(100, Math.round(n)))

app.get('/api/pulse', auth, async (c) => {
  const b = biz(c)
  const goals = await getJson(b, 'goals', { weekly_leads: 3, weekly_revenue: 1200, posting_cadence: 3 })
  const signals = await getJson(b, 'signals', { gbp_claimed: false, reviews_count: 0, reviews_target: 10 })
  const m = (await q(`select
      count(*) filter (where status='lead' and created_at > now()-interval '7 days')::int as leads_wk,
      count(*) filter (where status='lead')::int as open_leads,
      count(*) filter (where status in ('lead','quoted') and created_at < now()-interval '3 days')::int as stale,
      count(*) filter (where status in ('completed','paid'))::int as done_jobs,
      count(*) filter (where status in ('completed','paid') and review_ask_sent_at is not null)::int as asked,
      coalesce(sum(charge) filter (where status='paid' and paid_at > now()-interval '7 days'),0)::float as rev_wk,
      count(*) filter (where status='scheduled')::int as booked,
      count(*) filter (where status='completed')::int as unpaid
    from jobs where business_id=$1`, [b])).rows[0]
  const mr = (await q(`select percentile_cont(0.5) within group (order by extract(epoch from (first_contact_at-created_at))/60.0) as v
      from jobs where business_id=$1 and first_contact_at is not null and status<>'lead'`, [b])).rows[0].v
  const posts_wk = (await q(`select count(*)::int n from content where business_id=$1 and coalesce(posted_at,created_at) > now()-interval '7 days'`, [b])).rows[0].n
  const reviewsGate = (await q(`select status from activation where business_id=$1 and key='reviews'`, [b])).rows[0]?.status
  const hot = (await q(`select j.id, c.name as customer from jobs j join customers c on c.id=j.customer_id
      where j.business_id=$1 and j.status='lead' and j.first_contact_at is null order by (j.ticket_tier='HIGH') desc, j.created_at limit 1`, [b])).rows[0]

  const leadsS = clamp((m.leads_wk / (goals.weekly_leads || 3)) * 100)
  const postsS = clamp((posts_wk / (goals.posting_cadence || 3)) * 100)
  const findS = signals.gbp_claimed ? 100 : 0
  const acquisition = clamp(0.4 * leadsS + 0.3 * postsS + 0.3 * findS)
  const replyS = mr == null ? 50 : (mr <= 30 ? 100 : mr <= 60 ? 80 : mr <= 180 ? 50 : 20)
  const staleS = clamp(100 - m.stale * 25)
  const conversion = clamp((replyS + staleS) / 2)
  const reviewsS = clamp((signals.reviews_count / (signals.reviews_target || 10)) * 100)
  const askS = m.done_jobs ? clamp((m.asked / m.done_jobs) * 100) : 0
  const trust = clamp(0.6 * reviewsS + 0.4 * askS)
  const cashS = clamp((m.rev_wk / (goals.weekly_revenue || 1200)) * 100)
  const cash = clamp((cashS + clamp(m.booked * 50)) / 2)
  const score = clamp(0.4 * acquisition + 0.25 * conversion + 0.2 * trust + 0.15 * cash)

  const prev = (await q(`select score from momentum where business_id=$1 and day < current_date order by day desc limit 1`, [b])).rows[0]
  const delta = prev ? score - prev.score : null
  await q(`insert into momentum (business_id,day,score,breakdown) values ($1,current_date,$2,$3::jsonb)
           on conflict (business_id,day) do update set score=$2, breakdown=$3::jsonb`, [b, score, JSON.stringify({ acquisition, conversion, trust, cash })])
  const trend = (await q(`select day, score from momentum where business_id=$1 and day > current_date - 14 order by day`, [b])).rows

  let oneMove
  if (!signals.gbp_claimed) oneMove = { key: 'gbp', title: 'Claim + optimize your Google Business Profile', why: 'The loudest speaker you’re not using — local, ready-to-buy intent. The single biggest move on the board.', cta: 'Mark GBP claimed' }
  else if (reviewsGate && reviewsGate !== 'done') oneMove = { key: 'reviews', title: 'Send your 2 review-ask texts (Rob + George)', why: '#1 Google Maps ranking lever — proof that lowers the trust barrier for the next stranger.', cta: 'Mark texts sent' }
  else if (posts_wk < (goals.posting_cadence || 3)) oneMove = { key: 'post', title: 'Post today — keep the voice transmitting', why: 'Cadence is the voice. One a day beats ten in a burst.', cta: 'Log a post' }
  else if (hot) oneMove = { key: 'reply', title: `Reply to ${hot.customer} — they’re waiting`, why: 'A delayed reply is a dead lead. Speed is the #1 close lever.', cta: 'Open lead', job_id: hot.id }
  else oneMove = { key: 'steady', title: 'You’re transmitting — keep the cadence', why: 'Ask every happy customer for a review. Each one makes the next stranger trust you faster.', cta: null }

  const label = score >= 66 ? 'Gaining' : score >= 33 ? 'Warming' : 'Bleeding'
  return c.json({
    energy: { score, delta, label, breakdown: { acquisition, conversion, trust, cash } },
    voice: {
      transmit: { posts_wk, cadence: goals.posting_cadence || 3, findable: signals.gbp_claimed, status: postsS >= 66 ? 'good' : posts_wk > 0 ? 'warn' : 'bad' },
      hear: { new_leads: m.leads_wk, status: m.leads_wk > 0 ? 'good' : 'bad' },
      respond: { open_leads: m.open_leads, median_reply: mr == null ? null : Math.round(mr), status: replyS >= 80 ? 'good' : replyS >= 50 ? 'warn' : 'bad' },
    },
    oneMove, goals, signals, rev_wk: m.rev_wk, trend, needs: { stale: m.stale, unpaid: m.unpaid, hot: hot || null },
  })
})
app.post('/api/pulse/action', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  if (d.key === 'gbp') { const s = await getJson(b, 'signals', {}); s.gbp_claimed = true; await setJson(b, 'signals', s) }
  else if (d.key === 'reviews') {
    await q(`update activation set status='done', updated_at=now() where business_id=$1 and key='reviews'`, [b])
    const s = await getJson(b, 'signals', { reviews_count: 0 }); s.reviews_count = (s.reviews_count || 0) + 2; await setJson(b, 'signals', s)
  } else if (d.key === 'post') {
    await q(`insert into content (business_id,title,status,posted_at) values ($1,$2,'posted',now())`, [b, d.title || 'Post'])
  }
  return c.json({ ok: true })
})
app.get('/api/goals', auth, async (c) => c.json(await getJson(biz(c), 'goals', { weekly_leads: 3, weekly_revenue: 1200, posting_cadence: 3 })))
app.put('/api/goals', auth, async (c) => { await setJson(biz(c), 'goals', await c.req.json().catch(() => ({}))); return c.json({ ok: true }) })

// ---- QUOTES (Wave 2: stop the leaks) — tracked quote object, aging, $1k floor ----
// quote_status: draft | sent | accepted | declined. Flat amount only — NO tax, ever.
app.get('/api/quotes', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select ${JOB_COLS}, j.quote_status, j.quote_sent_at,
      coalesce(j.charge,0)-coalesce(j.parts_cost,0)-coalesce(j.gas_cost,0) as profit,
      case when j.quote_sent_at is not null then floor(extract(epoch from (now()-j.quote_sent_at))/86400.0)::int else null end as age_days
    ${JOB_FROM}
    where j.business_id=$1 and (j.charge is not null or coalesce(j.quote_status,'') <> '')
      and coalesce(j.quote_status,'draft') <> 'draft'
    order by (j.quote_status='sent') desc, j.quote_sent_at asc nulls last, j.created_at desc`, [b])).rows
  const quotes = rows.map((r) => {
    const profit = Number(r.profit) || 0
    const needs_follow_up = r.quote_status === 'sent' && r.age_days != null && r.age_days >= 3
    return { ...r, profit, below_floor: profit < 1000, needs_follow_up }
  })
  const summary = {
    open: quotes.filter((x) => x.quote_status === 'sent').length,
    needs_follow_up: quotes.filter((x) => x.needs_follow_up).length,
    below_floor: quotes.filter((x) => x.below_floor && x.quote_status !== 'declined').length,
    outstanding_value: quotes.filter((x) => x.quote_status === 'sent').reduce((s, x) => s + (Number(x.charge) || 0), 0),
  }
  return c.json({ quotes, summary })
})

// One-tap mark sent / accepted / declined — moves the job + logs to activity
app.post('/api/quotes/:id/status', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const qs = String(d.quote_status || '')
  if (!['sent', 'accepted', 'declined'].includes(qs)) return c.json({ error: 'bad quote status' }, 400)
  const job = (await q(`select status, charge, parts_cost, gas_cost from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  // keep the pipeline status honest with the quote outcome (don't downgrade a job already further along)
  let jobStatus = job.status
  if (qs === 'sent' && job.status === 'lead') jobStatus = 'quoted'
  if (qs === 'accepted' && ['lead', 'quoted'].includes(job.status)) jobStatus = 'scheduled'
  if (qs === 'declined') jobStatus = 'lost'
  const stampSent = qs === 'sent'
  await q(`update jobs set quote_status=$1${stampSent ? ', quote_sent_at=coalesce(quote_sent_at,now())' : ''}, status=$2 where id=$3 and business_id=$4`,
    [qs, jobStatus, id, b])
  const profit = (Number(job.charge) || 0) - (Number(job.parts_cost) || 0) - (Number(job.gas_cost) || 0)
  const label = qs === 'sent' ? `Quote sent — ${Number(job.charge) || 0} · profit ${profit}` : qs === 'accepted' ? 'Quote accepted ✓' : 'Quote declined'
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'quote',$3)`, [b, id, label])
  return c.json({ quote_status: qs, status: jobStatus, profit, below_floor: profit < 1000 })
})

// ---- GONE-QUIET detector — anything not moved in 3+ days raises its hand ----
// leads/quotes/scheduled with no activity row (and no contact) in 3+ days.
app.get('/api/quiet', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select ${JOB_COLS}, j.quote_status,
      coalesce((select max(a.created_at) from activity a where a.job_id=j.id), j.created_at) as last_touch,
      floor(extract(epoch from (now()-coalesce((select max(a.created_at) from activity a where a.job_id=j.id), j.created_at)))/86400.0)::int as quiet_days
    ${JOB_FROM}
    where j.business_id=$1 and j.status in ('lead','quoted','scheduled')
      and coalesce((select max(a.created_at) from activity a where a.job_id=j.id), j.created_at) < now() - interval '3 days'
    order by last_touch asc`, [b])).rows
  return c.json({ quiet: rows, count: rows.length })
})

// ---- END-OF-DAY CLOSEOUT — 60-second wrap. Today tally + still-open + roll a loose end ----
app.get('/api/closeout', auth, async (c) => {
  const b = biz(c)
  const today = (await q(`select
      count(*) filter (where status='lead' and created_at::date = current_date)::int as new_leads,
      count(*) filter (where quote_sent_at::date = current_date)::int as quotes_sent,
      count(*) filter (where status='completed' and updated_at::date = current_date)::int as completed,
      count(*) filter (where status='paid' and paid_at::date = current_date)::int as paid_jobs,
      coalesce(sum(charge) filter (where status='paid' and paid_at::date = current_date),0)::float as collected
    from jobs where business_id=$1`, [b])).rows[0]
  const openLeads = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status in ('lead','quoted') order by (j.ticket_tier='HIGH') desc, j.created_at desc limit 12`, [b])).rows
  const unpaid = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status='completed' order by j.created_at`, [b])).rows
  const scheduledTomorrow = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.scheduled_date = current_date + 1 order by j.created_at`, [b])).rows
  const quietCount = (await q(`select count(*)::int n from jobs j where j.business_id=$1 and j.status in ('lead','quoted','scheduled')
      and coalesce((select max(a.created_at) from activity a where a.job_id=j.id), j.created_at) < now() - interval '3 days'`, [b])).rows[0].n
  return c.json({ today, open: { leads: openLeads, unpaid, scheduledTomorrow, quiet: quietCount } })
})

// Log the closeout + optionally roll a loose end into a task for tomorrow
app.post('/api/closeout', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const note = (d.note || '').toString().trim()
  let rolled = null
  if (d.task && (d.task.title || '').toString().trim()) {
    const title = d.task.title.toString().trim()
    const jobId = d.task.job_id ? Number(d.task.job_id) : null
    const due = d.task.due_at || null
    rolled = (await q(`insert into tasks (business_id,job_id,kind,title,body,status,due_at)
        values ($1,$2,'todo',$3,$4,'open',coalesce($5::timestamptz, (current_date + 1)::timestamptz)) returning id`,
      [b, jobId, title, d.task.body || null, due])).rows[0]
  }
  const body = note ? `Day closed out — ${note}` : 'Day closed out'
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'closeout',$3)`, [b, d.job_id || null, body])
  return c.json({ ok: true, rolled_task_id: rolled ? rolled.id : null })
})

// ---- BACK-BURNER lane — non-nagging parking lot for strategic ideas (tasks kind=backburner) ----
app.get('/api/backburner', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select id, title, body, status, created_at, completed_at
      from tasks where business_id=$1 and kind='backburner' and status <> 'dismissed'
      order by created_at desc`, [b])).rows
  return c.json({ ideas: rows })
})
app.post('/api/backburner', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const title = (d.title || '').toString().trim()
  if (!title) return c.json({ error: 'need an idea' }, 400)
  const row = (await q(`insert into tasks (business_id,kind,title,body,status) values ($1,'backburner',$2,$3,'open') returning id, title, body, status, created_at`,
    [b, title, d.body || null])).rows[0]
  return c.json({ idea: row })
})
// Promote an idea into a normal actionable task
app.post('/api/backburner/:id/promote', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const row = (await q(`select id, title from tasks where id=$1 and business_id=$2 and kind='backburner'`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  await q(`update tasks set kind='todo', status='open', due_at=coalesce($1::timestamptz, due_at) where id=$2 and business_id=$3`,
    [d.due_at || null, id, b])
  await q(`insert into activity (business_id,type,body) values ($1,'system',$2)`, [b, `Promoted back-burner idea: ${row.title}`])
  return c.json({ ok: true, id: row.id })
})
// Archive an idea (let it rest — status=dismissed)
app.post('/api/backburner/:id/archive', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const r = await q(`update tasks set status='dismissed', completed_at=now() where id=$1 and business_id=$2 and kind='backburner'`, [id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// ---- ATTENTION GUARD — what's interrupt-worthy vs waits-for-the-brief (settings, no push infra yet) ----
const ATTENTION_DEF = { high_ticket_hot_lead: true, one_star_review: true, new_lead: false, quote_accepted: true, completed_unpaid: false }
app.get('/api/attention', auth, async (c) => c.json(await getJson(biz(c), 'attention', ATTENTION_DEF)))
app.put('/api/attention', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const cur = await getJson(b, 'attention', ATTENTION_DEF)
  const next = { ...cur }
  for (const k of Object.keys(ATTENTION_DEF)) if (d[k] !== undefined) next[k] = !!d[k]
  await setJson(b, 'attention', next)
  return c.json(next)
})


// ---- TEMPLATES (Wave 3: fast-reply library) — one-tap personalized replies, trust>price, flat, NO tax ----
// Tokens supported in body: {name} {vehicle} {issue}. Categories: first_contact|pricing|availability|do_you_do|follow_up|review_ask|general
app.get('/api/templates', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select id, category, label, body, created_at from templates
      where business_id=$1 order by category, created_at`, [b])).rows
  return c.json({ templates: rows })
})
app.post('/api/templates', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const label = (d.label || '').toString().trim()
  const body = (d.body || '').toString().trim()
  if (!label || !body) return c.json({ error: 'need a label and body' }, 400)
  const category = (d.category || 'general').toString().trim() || 'general'
  const row = (await q(`insert into templates (business_id,category,label,body) values ($1,$2,$3,$4)
      returning id, category, label, body, created_at`, [b, category, label, body])).rows[0]
  return c.json({ template: row })
})
app.put('/api/templates/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const sets = [], vals = []
  for (const k of ['category', 'label', 'body']) {
    if (d[k] !== undefined) {
      const v = (d[k] || '').toString().trim()
      if ((k === 'label' || k === 'body') && !v) return c.json({ error: `${k} can't be blank` }, 400)
      vals.push(k === 'category' ? (v || 'general') : v); sets.push(`${k}=$${vals.length}`)
    }
  }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400)
  vals.push(id, b)
  const r = await q(`update templates set ${sets.join(', ')} where id=$${vals.length - 1} and business_id=$${vals.length}`, vals)
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})
app.delete('/api/templates/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const r = await q(`delete from templates where id=$1 and business_id=$2`, [id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// ---- TRIAGE (Wave 3: high-value leads jump the queue) ----
// open leads (lead|quoted) sorted HIGH tier first, then safety, then recency — with the AI read.
app.get('/api/triage', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select ${JOB_COLS}
    ${JOB_FROM}
    where j.business_id=$1 and j.status in ('lead','quoted')
    order by (j.ticket_tier='HIGH') desc, j.safety_flag desc, j.created_at desc`, [b])).rows
  const summary = {
    total: rows.length,
    high: rows.filter((r) => r.ticket_tier === 'HIGH').length,
    safety: rows.filter((r) => r.safety_flag).length,
    uncontacted: rows.filter((r) => !r.first_contact_at).length,
  }
  return c.json({ triage: rows, summary })
})

// ---- ASSETS (Wave 3: file & photo drop per lead) — paste-a-link for now, no binary infra ----
// kind: photo | clip | quote | invoice | doc
const ASSET_KINDS = ['photo', 'clip', 'quote', 'invoice', 'doc']
app.get('/api/jobs/:id/assets', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const job = (await q(`select id from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  const rows = (await q(`select id, kind, url, label, is_before, created_at
      from assets where business_id=$1 and job_id=$2 order by created_at desc`, [b, id])).rows
  return c.json({ assets: rows })
})
app.post('/api/jobs/:id/assets', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const job = (await q(`select id, customer_id from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  const url = (d.url || '').toString().trim()
  if (!url) return c.json({ error: 'paste a link' }, 400)
  const kind = ASSET_KINDS.includes(d.kind) ? d.kind : 'photo'
  const label = (d.label || '').toString().trim() || null
  const isBefore = !!d.is_before
  const row = (await q(`insert into assets (business_id,job_id,customer_id,kind,url,label,is_before)
      values ($1,$2,$3,$4,$5,$6,$7) returning id, kind, url, label, is_before, created_at`,
    [b, id, job.customer_id, kind, url, label, isBefore])).rows[0]
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'attachment',$4)`,
    [b, id, job.customer_id, `Attached ${kind}${label ? ` — ${label}` : ''}`])
  return c.json({ asset: row })
})
app.post('/api/assets/:id/delete', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const r = await q(`delete from assets where id=$1 and business_id=$2`, [id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// ---- CUSTOMERS (Wave 3: profiles + history) — repeat customers become relationships ----
app.get('/api/customers', auth, async (c) => {
  const b = biz(c)
  const search = (c.req.query('q') || '').toString().trim()
  const params = [b]
  let where = `c.business_id=$1`
  if (search) {
    params.push(`%${search}%`)
    where += ` and (c.name ilike $${params.length} or c.phone ilike $${params.length} or c.location ilike $${params.length})`
  }
  const rows = (await q(`select c.id, c.name, c.phone, c.location, c.source, c.created_at,
      count(j.id)::int as jobs,
      coalesce(sum(j.charge) filter (where j.status='paid'),0)::float as total_spent,
      greatest(c.created_at, coalesce(max(j.created_at), c.created_at)) as last_seen
    from customers c left join jobs j on j.customer_id=c.id and j.business_id=c.business_id
    where ${where}
    group by c.id
    order by last_seen desc nulls last`, params)).rows
  return c.json({ customers: rows })
})
app.get('/api/customers/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const customer = (await q(`select c.id, c.name, c.phone, c.location, c.email, c.source, c.notes, c.created_at,
      count(j.id)::int as jobs,
      coalesce(sum(j.charge) filter (where j.status='paid'),0)::float as total_spent
    from customers c left join jobs j on j.customer_id=c.id and j.business_id=c.business_id
    where c.id=$1 and c.business_id=$2 group by c.id`, [id, b])).rows[0]
  if (!customer) return c.json({ error: 'not found' }, 404)
  const vehicles = (await q(`select id, year, make, model, vin, is_euro, notes, created_at
      from vehicles where customer_id=$1 and business_id=$2 order by created_at desc`, [id, b])).rows
  const jobs = (await q(`select j.id, j.status, j.issue, j.service, j.charge, j.est_value,
      coalesce(j.charge,0)-coalesce(j.parts_cost,0)-coalesce(j.gas_cost,0) as profit,
      j.ticket_tier, j.safety_flag, j.created_at, j.scheduled_date, j.paid_at,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from jobs j left join vehicles v on v.id=j.vehicle_id
    where j.customer_id=$1 and j.business_id=$2 order by j.created_at desc`, [id, b])).rows
  const activity = (await q(`select a.type, a.body, a.created_at, a.job_id
      from activity a where a.customer_id=$1 and a.business_id=$2
         or a.job_id in (select id from jobs where customer_id=$1 and business_id=$2)
      order by a.created_at desc limit 100`, [id, b])).rows
  return c.json({ customer, vehicles, jobs, activity })
})


// ============================================================================
// WAVE 4 — "Compound": schedule future energy, collapse the won workflow,
// chase the review every time, build the proof wall, reuse every asset,
// and pour energy into the content that actually pulls leads.
// All tenant-scoped via biz(c). Flat price, no tax, $1k profit floor honored.
// ============================================================================

// ---- RE-CONTACT ENGINE — schedule future energy now (tasks kind='recontact') ----
// Time-released reminders tied to a job/customer: "that Volvo belt was borderline — check in at 6 months".
app.get('/api/recontact', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select t.id, t.title, t.body, t.kind, t.status, t.due_at, t.created_at,
      t.job_id, t.customer_id,
      c.name as customer, c.phone, c.location,
      j.status as job_status, j.issue, j.ticket_tier,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle,
      case when t.due_at is not null then floor(extract(epoch from (now()-t.due_at))/86400.0)::int else null end as overdue_days
    from tasks t
    left join customers c on c.id=t.customer_id
    left join jobs j on j.id=t.job_id
    left join vehicles v on v.id=j.vehicle_id
    where t.business_id=$1 and t.kind='recontact' and t.status='open'
    order by t.due_at asc nulls last, t.created_at asc`, [b])).rows
  const due = rows.filter((r) => r.due_at == null || new Date(r.due_at) <= new Date())
  const upcoming = rows.filter((r) => r.due_at != null && new Date(r.due_at) > new Date())
  return c.json({ due, upcoming, count: { due: due.length, upcoming: upcoming.length } })
})
app.post('/api/recontact', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const title = (d.title || '').toString().trim()
  if (!title) return c.json({ error: 'need a reminder title' }, 400)
  const jobId = d.job_id ? Number(d.job_id) : null
  let custId = d.customer_id ? Number(d.customer_id) : null
  // tenant-scope + backfill the customer from the job if only a job was given
  if (jobId) {
    const job = (await q(`select customer_id from jobs where id=$1 and business_id=$2`, [jobId, b])).rows[0]
    if (!job) return c.json({ error: 'job not found' }, 404)
    if (!custId) custId = job.customer_id
  }
  if (custId) {
    const cust = (await q(`select id from customers where id=$1 and business_id=$2`, [custId, b])).rows[0]
    if (!cust) return c.json({ error: 'customer not found' }, 404)
  }
  const row = (await q(`insert into tasks (business_id,job_id,customer_id,kind,title,body,status,due_at)
      values ($1,$2,$3,'recontact',$4,$5,'open',$6::timestamptz)
      returning id, title, body, kind, status, due_at, created_at, job_id, customer_id`,
    [b, jobId, custId, title, d.body || null, d.due_at || null])).rows[0]
  if (jobId) await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'system',$4)`,
    [b, jobId, custId, `Re-contact scheduled: ${title}`])
  return c.json({ recontact: row })
})
app.post('/api/recontact/:id/done', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const row = (await q(`select id, job_id, customer_id, title from tasks
      where id=$1 and business_id=$2 and kind='recontact'`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  await q(`update tasks set status='done', completed_at=now() where id=$1 and business_id=$2`, [id, b])
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'system',$4)`,
    [b, row.job_id || null, row.customer_id || null, `Re-contact done: ${row.title}`])
  return c.json({ ok: true })
})

// ---- ONE-TAP WON — winning a job collapses the overhead into one button ----
// status=scheduled + quote_status=accepted, auto-create review-ask + photo-capture reminder, log it.
app.post('/api/jobs/:id/won', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const job = (await q(`select j.id, j.customer_id, j.charge, j.parts_cost, j.gas_cost, j.scheduled_date,
      c.name as customer, nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from jobs j join customers c on c.id=j.customer_id left join vehicles v on v.id=j.vehicle_id
    where j.id=$1 and j.business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  const profit = (Number(job.charge) || 0) - (Number(job.parts_cost) || 0) - (Number(job.gas_cost) || 0)
  await q(`update jobs set status='scheduled', quote_status='accepted' where id=$1 and business_id=$2`, [id, b])
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'status_change',$4)`,
    [b, id, job.customer_id, `Marked WON → scheduled ✓ (flat $${Number(job.charge) || 0} · profit $${profit})`])
  const who = job.customer || 'the customer'
  const ride = job.vehicle ? ` on the ${job.vehicle}` : ''
  const checklist = []
  // 1) review-ask task — ask every happy customer, every time
  const reviewTask = (await q(`insert into tasks (business_id,job_id,customer_id,kind,title,body,status)
      values ($1,$2,$3,'review_ask',$4,$5,'open')
      returning id, title`,
    [b, id, job.customer_id, `Ask ${who} for a Google review`,
      `After the job${ride} is done — send the review-ask text. Each review makes the next stranger trust you faster.`])).rows[0]
  checklist.push({ kind: 'review_ask', task_id: reviewTask.id, title: reviewTask.title, when: 'after the job' })
  // 2) photo-capture reminder — recontact due after the job (default 1 day out, or scheduled_date if known)
  const photoDue = job.scheduled_date
    ? `(date '${new Date(job.scheduled_date).toISOString().slice(0, 10)}' + 1)::timestamptz`
    : `(current_date + 1)::timestamptz`
  const photoTask = (await q(`insert into tasks (business_id,job_id,customer_id,kind,title,body,status,due_at)
      values ($1,$2,$3,'recontact',$4,$5,'open',${photoDue})
      returning id, title, due_at`,
    [b, id, job.customer_id, `Grab before/after photos${ride}`,
      `Capture the job photos/clips — they become content and the proof you drop to close the next hesitant prospect.`])).rows[0]
  checklist.push({ kind: 'recontact', task_id: photoTask.id, title: photoTask.title, when: 'after the job', due_at: photoTask.due_at })
  return c.json({
    ok: true, status: 'scheduled', quote_status: 'accepted',
    charge: Number(job.charge) || 0, profit, below_floor: profit < 1000,
    checklist,
  })
})

// ---- REVIEW ASK + GOT TRACKING — ask every happy customer, track ask-rate + got-rate ----
// eligible = completed|paid. ask-rate = asked/eligible. got-rate = received/asked.
app.get('/api/reviews', auth, async (c) => {
  const b = biz(c)
  const m = (await q(`select
      count(*) filter (where status in ('completed','paid'))::int as eligible,
      count(*) filter (where status in ('completed','paid') and review_ask_sent_at is not null)::int as asked,
      count(*) filter (where status in ('completed','paid') and review_received_at is not null)::int as received
    from jobs where business_id=$1`, [b])).rows[0]
  const askRate = m.eligible ? Math.round((m.asked / m.eligible) * 100) : 0
  const gotRate = m.asked ? Math.round((m.received / m.asked) * 100) : 0
  // eligible but never asked — the ones leaking trust
  const notAsked = (await q(`select ${JOB_COLS} ${JOB_FROM}
      where j.business_id=$1 and j.status in ('completed','paid') and j.review_ask_sent_at is null
      order by j.paid_at desc nulls last, j.created_at desc`, [b])).rows
  // asked but not yet got — the ones to nudge
  const notGot = (await q(`select ${JOB_COLS}, j.review_ask_sent_at,
      floor(extract(epoch from (now()-j.review_ask_sent_at))/86400.0)::int as asked_days_ago
    ${JOB_FROM}
      where j.business_id=$1 and j.status in ('completed','paid')
        and j.review_ask_sent_at is not null and j.review_received_at is null
      order by j.review_ask_sent_at asc`, [b])).rows
  return c.json({
    summary: { eligible: m.eligible, asked: m.asked, received: m.received, ask_rate: askRate, got_rate: gotRate },
    not_asked: notAsked, not_got: notGot,
  })
})
app.post('/api/jobs/:id/review-asked', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const job = (await q(`select id, customer_id from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  await q(`update jobs set review_ask_sent_at=coalesce(review_ask_sent_at,now()) where id=$1 and business_id=$2`, [id, b])
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'review','Review ask sent')`,
    [b, id, job.customer_id])
  return c.json({ ok: true })
})
app.post('/api/jobs/:id/review-got', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const job = (await q(`select id, customer_id from jobs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  // stamp asked too if it somehow skipped — a got review was obviously asked for
  await q(`update jobs set review_received_at=coalesce(review_received_at,now()),
      review_ask_sent_at=coalesce(review_ask_sent_at,now()) where id=$1 and business_id=$2`, [id, b])
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'review','Review received ✓')`,
    [b, id, job.customer_id])
  return c.json({ ok: true })
})

// ---- PROOF WALL — compile reviews/testimonials/results to drop into a closing DM ----
// kind: review | testimonial | result | before_after
const PROOF_KINDS = ['review', 'testimonial', 'result', 'before_after']
app.get('/api/proof', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select p.id, p.kind, p.author, p.text, p.stars, p.job_id, p.created_at,
      c.name as customer
    from proof p
    left join jobs j on j.id=p.job_id and j.business_id=p.business_id
    left join customers c on c.id=j.customer_id
    where p.business_id=$1 order by p.created_at desc`, [b])).rows
  return c.json({ proof: rows, count: rows.length })
})
app.post('/api/proof', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const text = (d.text || '').toString().trim()
  if (!text) return c.json({ error: 'paste the proof text' }, 400)
  const kind = PROOF_KINDS.includes(d.kind) ? d.kind : 'review'
  const author = (d.author || '').toString().trim() || null
  let stars = d.stars != null ? Number(d.stars) : null
  if (stars != null) stars = Math.max(0, Math.min(5, Math.round(stars)))
  let jobId = d.job_id ? Number(d.job_id) : null
  if (jobId) {
    const job = (await q(`select id from jobs where id=$1 and business_id=$2`, [jobId, b])).rows[0]
    if (!job) return c.json({ error: 'job not found' }, 404)
  }
  const row = (await q(`insert into proof (business_id,kind,author,text,stars,job_id)
      values ($1,$2,$3,$4,$5,$6) returning id, kind, author, text, stars, job_id, created_at`,
    [b, kind, author, text, stars, jobId])).rows[0]
  return c.json({ proof: row })
})
app.delete('/api/proof/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const r = await q(`delete from proof where id=$1 and business_id=$2`, [id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})

// ---- ASSET LIBRARY — every job's photos/clips, reusable for content + closing ----
// All assets across jobs with job + customer context. Filter: ?kind= &is_before=
app.get('/api/assets', auth, async (c) => {
  const b = biz(c)
  const kind = (c.req.query('kind') || '').toString().trim()
  const isBefore = c.req.query('is_before')
  const params = [b]
  let where = `a.business_id=$1`
  if (kind && ASSET_KINDS.includes(kind)) { params.push(kind); where += ` and a.kind=$${params.length}` }
  if (isBefore === 'true' || isBefore === 'false') { params.push(isBefore === 'true'); where += ` and a.is_before=$${params.length}` }
  const rows = (await q(`select a.id, a.kind, a.url, a.label, a.is_before, a.created_at,
      a.job_id, a.customer_id,
      c.name as customer,
      j.status as job_status, j.issue, j.service, j.ticket_tier,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from assets a
    left join jobs j on j.id=a.job_id and j.business_id=a.business_id
    left join customers c on c.id=a.customer_id and c.business_id=a.business_id
    left join vehicles v on v.id=j.vehicle_id
    where ${where}
    order by a.created_at desc`, params)).rows
  const counts = (await q(`select kind, count(*)::int n from assets where business_id=$1 group by kind`, [b])).rows
  const by_kind = {}
  for (const r of counts) by_kind[r.kind] = r.n
  return c.json({ assets: rows, total: rows.length, by_kind })
})

// ---- CONTENT → LEAD ATTRIBUTION — rank content by leads produced, not likes ----
const CONTENT_STATUSES = ['idea', 'draft', 'scheduled', 'posted']
app.get('/api/content', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select id, title, channel, status, url, notes,
      coalesce(leads_attributed,0)::int as leads_attributed,
      posted_at, created_at
    from content where business_id=$1
    order by coalesce(leads_attributed,0) desc, coalesce(posted_at,created_at) desc`, [b])).rows
  const summary = {
    pieces: rows.length,
    posted: rows.filter((r) => r.status === 'posted').length,
    total_leads: rows.reduce((s, r) => s + (Number(r.leads_attributed) || 0), 0),
  }
  // what's actually pulling — content with at least one attributed lead, best first
  const winners = rows.filter((r) => (Number(r.leads_attributed) || 0) > 0).slice(0, 10)
  return c.json({ content: rows, summary, winners })
})
app.post('/api/content', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const title = (d.title || '').toString().trim()
  if (!title) return c.json({ error: 'need a title' }, 400)
  const status = CONTENT_STATUSES.includes(d.status) ? d.status : 'posted'
  const channel = (d.channel || '').toString().trim() || null
  const url = (d.url || '').toString().trim() || null
  const notes = (d.notes || '').toString().trim() || null
  // posted_at: explicit, or now() if it's already posted, else null
  const postedAt = d.posted_at || (status === 'posted' ? new Date().toISOString() : null)
  const leads = d.leads_attributed != null ? Math.max(0, Number(d.leads_attributed) || 0) : 0
  const row = (await q(`insert into content (business_id,title,channel,status,url,notes,posted_at,leads_attributed)
      values ($1,$2,$3,$4,$5,$6,$7::timestamptz,$8)
      returning id, title, channel, status, url, notes, leads_attributed, posted_at, created_at`,
    [b, title, channel, status, url, notes, postedAt, leads])).rows[0]
  return c.json({ content: row })
})
// +1 a lead (delta), or set leads_attributed to an absolute number
app.post('/api/content/:id/attribute', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const row = (await q(`select id, title, coalesce(leads_attributed,0)::int as leads_attributed
      from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  let next
  if (d.set != null) next = Math.max(0, Number(d.set) || 0)
  else next = Math.max(0, row.leads_attributed + (d.delta != null ? Number(d.delta) || 0 : 1))
  await q(`update content set leads_attributed=$1 where id=$2 and business_id=$3`, [next, id, b])
  await q(`insert into activity (business_id,type,body) values ($1,'system',$2)`,
    [b, `Content lead attributed: "${row.title}" → ${next} lead${next === 1 ? '' : 's'}`])
  return c.json({ ok: true, leads_attributed: next })
})
app.post('/api/content/:id/delete', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const r = await q(`delete from content where id=$1 and business_id=$2`, [id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true })
})


// ============================================================================
// WAVE 5 — "See the field": book the week without double-booking, learn which
// funnel actually pays, keep proof + the local read in one place, and watch
// the energy score move over time. Tenant-scoped via biz(c). Flat price, no tax.
// ============================================================================

// ---- BOOKING CALENDAR + CAPACITY — see the week, don't double-book ----
// Window of ~14 days from today (or ?from=YYYY-MM-DD), scheduled jobs grouped by day with a per-day count.
app.get('/api/calendar', auth, async (c) => {
  const b = biz(c)
  const fromRaw = (c.req.query('from') || '').toString().trim()
  const days = Math.max(1, Math.min(31, Number(c.req.query('days')) || 14))
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : new Date().toISOString().slice(0, 10)
  const rows = (await q(`select j.id, j.status, j.issue, j.service, j.scheduled_date, j.scheduled_time, j.duration_min,
      j.charge, j.ticket_tier, j.safety_flag,
      coalesce(j.charge,0)-coalesce(j.parts_cost,0)-coalesce(j.gas_cost,0) as profit,
      c.name as customer, c.phone, c.location,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from jobs j join customers c on c.id=j.customer_id left join vehicles v on v.id=j.vehicle_id
    where j.business_id=$1 and j.scheduled_date is not null
      and j.scheduled_date >= $2::date and j.scheduled_date < ($2::date + $3::int)
    order by j.scheduled_date asc, j.scheduled_time asc nulls last, j.created_at asc`, [b, from, days])).rows
  // build a contiguous day grid so empty days still render
  const byDay = {}
  for (const r of rows) {
    const key = new Date(r.scheduled_date).toISOString().slice(0, 10)
    if (!byDay[key]) byDay[key] = []
    byDay[key].push({ ...r, profit: Number(r.profit) || 0, below_floor: (Number(r.profit) || 0) < 1000 })
  }
  const start = new Date(from + 'T00:00:00.000Z')
  const grid = []
  for (let i = 0; i < days; i++) {
    const d = new Date(start.getTime() + i * 86400000)
    const key = d.toISOString().slice(0, 10)
    const jobs = byDay[key] || []
    grid.push({
      date: key,
      dow: d.getUTCDay(),
      jobs,
      booked: jobs.length,
      booked_value: jobs.reduce((s, x) => s + (Number(x.charge) || 0), 0),
    })
  }
  const summary = {
    from,
    days,
    total_booked: rows.length,
    busiest: grid.reduce((mx, g) => (g.booked > (mx?.booked || 0) ? g : mx), null)?.date || null,
    open_days: grid.filter((g) => g.booked === 0).length,
  }
  return c.json({ grid, summary })
})

// Set / reschedule the date, time, and duration on a job — keeps status honest (a booked job is at least scheduled)
app.post('/api/jobs/:id/schedule', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const job = (await q(`select j.status, c.name as customer from jobs j join customers c on c.id=j.customer_id
      where j.id=$1 and j.business_id=$2`, [id, b])).rows[0]
  if (!job) return c.json({ error: 'not found' }, 404)
  const date = (d.scheduled_date || '').toString().trim()
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return c.json({ error: 'date must be YYYY-MM-DD' }, 400)
  const time = d.scheduled_time != null ? (d.scheduled_time || '').toString().trim() || null : null
  const dur = d.duration_min != null ? Math.max(0, Number(d.duration_min) || 0) : null
  // booking a date moves a still-early job forward to scheduled (don't downgrade one already further along)
  const bumps = ['lead', 'quoted'].includes(job.status) && !!date
  const newStatus = bumps ? 'scheduled' : job.status
  await q(`update jobs set scheduled_date=$1::date, scheduled_time=$2, duration_min=$3, status=$4 where id=$5 and business_id=$6`,
    [date || null, time, dur, newStatus, id, b])
  const when = date ? `${date}${time ? ` ${time}` : ''}` : 'cleared'
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'schedule',$3)`,
    [b, id, `Booked ${job.customer} → ${when}${dur ? ` (${dur} min)` : ''}`])
  return c.json({ ok: true, scheduled_date: date || null, scheduled_time: time, duration_min: dur, status: newStatus })
})

// ---- FUNNEL SOURCE ATTRIBUTION — learn which funnel actually pays ----
// Group every job by source: leads, paid, revenue, profit, conversion (paid/total).
app.get('/api/sources', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select coalesce(nullif(trim(source),''),'unknown') as source,
      count(*)::int as total,
      count(*) filter (where status='lead')::int as leads,
      count(*) filter (where status not in ('paid','lost'))::int as active,
      count(*) filter (where status='lost')::int as lost,
      count(*) filter (where status='paid')::int as paid,
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue,
      coalesce(sum(coalesce(charge,0)-coalesce(parts_cost,0)-coalesce(gas_cost,0)) filter (where status='paid'),0)::float as profit
    from jobs where business_id=$1
    group by 1
    order by revenue desc, paid desc, total desc`, [b])).rows
  const sources = rows.map((r) => ({
    ...r,
    avg_ticket: r.paid ? Math.round(r.revenue / r.paid) : 0,
    conversion: r.total ? Math.round((r.paid / r.total) * 100) : 0,
  }))
  const totals = sources.reduce((t, s) => ({
    total: t.total + s.total, leads: t.leads + s.leads, paid: t.paid + s.paid,
    revenue: t.revenue + s.revenue, profit: t.profit + s.profit,
  }), { total: 0, leads: 0, paid: 0, revenue: 0, profit: 0 })
  totals.conversion = totals.total ? Math.round((totals.paid / totals.total) * 100) : 0
  totals.avg_ticket = totals.paid ? Math.round(totals.revenue / totals.paid) : 0
  // the funnel actually producing — best by revenue with at least one paid job
  const best = sources.filter((s) => s.paid > 0)[0] || null
  return c.json({ sources, totals, best })
})

// ---- REPUTATION + MARKET PULSE — proof + ask-rate in one place, plus a manual local read ----
app.get('/api/market', auth, async (c) => {
  const b = biz(c)
  const signals = await getJson(b, 'signals', { gbp_claimed: false, reviews_count: 0, reviews_target: 10 })
  const market = await getJson(b, 'market_notes', { notes: '' })
  const m = (await q(`select
      count(*) filter (where status in ('completed','paid'))::int as eligible,
      count(*) filter (where status in ('completed','paid') and review_ask_sent_at is not null)::int as asked,
      count(*) filter (where status in ('completed','paid') and review_received_at is not null)::int as received
    from jobs where business_id=$1`, [b])).rows[0]
  const askRate = m.eligible ? Math.round((m.asked / m.eligible) * 100) : 0
  const gotRate = m.asked ? Math.round((m.received / m.asked) * 100) : 0
  const proofCount = (await q(`select count(*)::int n from proof where business_id=$1`, [b])).rows[0].n
  const recentProof = (await q(`select p.id, p.kind, p.author, p.text, p.stars, p.job_id, p.created_at,
      c.name as customer
    from proof p
    left join jobs j on j.id=p.job_id and j.business_id=p.business_id
    left join customers c on c.id=j.customer_id
    where p.business_id=$1 order by p.created_at desc limit 8`, [b])).rows
  return c.json({
    reputation: {
      reviews_count: Number(signals.reviews_count) || 0,
      reviews_target: Number(signals.reviews_target) || 10,
      gbp_claimed: !!signals.gbp_claimed,
      proof_count: proofCount,
      eligible: m.eligible, asked: m.asked, received: m.received,
      ask_rate: askRate, got_rate: gotRate,
    },
    recent_proof: recentProof,
    market_notes: (market.notes || '').toString(),
  })
})
app.put('/api/market', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const notes = (d.notes || '').toString()
  await setJson(b, 'market_notes', { notes, updated_at: new Date().toISOString() })
  return c.json({ ok: true, notes })
})

// ---- MOMENTUM TREND — the energy score over time, watchable ----
// Last 30 days of the daily snapshot: score + the 4 sub-scores, plus the delta.
app.get('/api/momentum', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select day, score,
      coalesce((breakdown->>'acquisition')::int,0) as acquisition,
      coalesce((breakdown->>'conversion')::int,0) as conversion,
      coalesce((breakdown->>'trust')::int,0) as trust,
      coalesce((breakdown->>'cash')::int,0) as cash
    from momentum where business_id=$1 and day > current_date - 30
    order by day asc`, [b])).rows
  const trend = rows.map((r) => ({
    day: new Date(r.day).toISOString().slice(0, 10),
    score: Number(r.score) || 0,
    acquisition: Number(r.acquisition) || 0,
    conversion: Number(r.conversion) || 0,
    trust: Number(r.trust) || 0,
    cash: Number(r.cash) || 0,
  }))
  const latest = trend.length ? trend[trend.length - 1] : null
  const first = trend.length ? trend[0] : null
  const prev = trend.length > 1 ? trend[trend.length - 2] : null
  const score = latest ? latest.score : 0
  const delta = latest && prev ? latest.score - prev.score : null
  const delta_30d = latest && first ? latest.score - first.score : null
  const label = score >= 66 ? 'Gaining' : score >= 33 ? 'Warming' : 'Bleeding'
  const high = trend.reduce((mx, t) => Math.max(mx, t.score), 0)
  const low = trend.length ? trend.reduce((mn, t) => Math.min(mn, t.score), 100) : 0
  return c.json({
    trend,
    summary: { score, delta, delta_30d, label, days: trend.length, high, low, breakdown: latest ? { acquisition: latest.acquisition, conversion: latest.conversion, trust: latest.trust, cash: latest.cash } : null },
  })
})


// ============================================================================
// PLAYBOOKS — make the toggles REAL: guided step-by-step playbooks with actual
// instructions, progress, and CONSEQUENCES (completing all steps flips the
// activation gate done + unlocks the next move; steps can dispatch work to
// Claude Code via the handoff queue). Tenant-scoped via biz(c).
// Progress lives in settings key 'gate_progress' = { gate_key:[doneStepIndexes] }.
// ============================================================================

const PLAYBOOKS = {
  gbp: [
    { title: 'Open Google Business Profile', detail: 'Your profile is already verified (since 2026-03-24). Sign in with the carswithfares@gmail.com account and open the Cars With Fares profile to manage it. Everything below is edited right here in the dashboard.', link: 'https://business.google.com/' },
    { title: 'Lock the business name', detail: 'Name must read exactly "Cars With Fares" — nothing else. Do NOT keyword-stuff it with "Mobile Mechanic Mississauga"; Google suspends profiles that do, and that suspension kills your Maps ranking.' },
    { title: 'Set the primary category', detail: 'Category is the single biggest ranking factor, so get this right. Set the primary category to "Mobile mechanic" if it is available in the picker, otherwise "Auto repair shop".' },
    { title: 'Add the supporting categories', detail: 'Add these as additional categories so you surface for more searches: Auto repair shop, Brake shop, Auto tune up service, Car repair and maintenance, Diagnostic center.' },
    { title: 'Make it a service-area business', detail: 'You go to them, so hide the street address and set it up as a service-area business. Add these service areas: Mississauga, Toronto, Brampton, Etobicoke, Oakville, Milton, Vaughan, Burlington, Hamilton.' },
    { title: 'List the big-job services', detail: 'Add every real job you want, each with a one-line description, so the profile reads like the high-ticket work you actually want: Suspension repair, Front-end / control arms, Brake repair, Engine repair, Clutch replacement, No-start diagnosis, Electrical, Cooling system, Pre-purchase inspection.' },
    { title: 'Paste the business description', detail: 'Drop this exact description into the "From the business" field — it is trust-led, names you, and lists the real jobs.', snippet: 'Cars With Fares is a trusted mobile mechanic serving Mississauga and the GTA - we come to you. From suspension and front-end work to brakes, diagnostics, and engine repair, I handle the real jobs right in your driveway, office, or roadside. Honest diagnosis, a flat quote before I start, and quality OEM-grade parts. No shop runaround - just one mechanic who puts his name on the work. Same-day service across the GTA. Better Call Fares - 647-450-0406.' },
    { title: 'Set hours, phone, and website', detail: 'Hours must match the site exactly (pick Mon-Sat 7am-9pm OR 24/7 and use the same one everywhere). Phone: 647-450-0406. Website: https://carswithfares.ca/mobile-mechanic. Under Attributes, turn on "Online appointments" and "Onsite services".', link: 'https://carswithfares.ca/mobile-mechanic' },
    { title: 'Upload 5-6 real job photos (biggest quick win)', detail: 'Profiles with photos get about 2x the clicks — this matters more than almost anything else here. On your next job shoot a suspension/front-end repair mid-work, a clean finished install, you with the customer car, and your tool setup, then upload them. No stock photos.' },
    { title: 'Seed the Q&A', detail: 'Post these 5 questions on your own profile and answer each from your account so customers see straight answers: do you come to my house, what jobs do you do, how do I get a quote, what areas do you cover, are you cheaper than a shop. Pull the exact answers from strategy/gbp-local-seo.md.' },
    { title: 'Grab your review link', detail: 'In GBP click "Ask for reviews" and copy your review link — this is the one you text after every job. Your live link is below; the full review system lives in the Reviews gate.', snippet: 'https://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg' },
    { title: 'Generate this week posts with Claude Code', detail: 'Posting 1-2 times a week keeps the profile active, which ranks better. Have Claude Code write a fresh batch in your voice (we come to you, big jobs done mobile, honest diagnosis, same-day at your door) so you are never staring at a blank box.', handoff: { kind: 'gbp_posts', title: 'Generate 10 fresh GBP posts in Fares voice (trust-led, we-come-to-you, big-job angles, each ending 647-450-0406) ready to paste 1-2 per week' } },
    { title: 'Post the first one now', detail: 'Paste one post into GBP today so the profile shows recent activity, then set a reminder to post 1-2 per week from the batch Claude Code generates.', snippet: 'Suspension clunking? Front end feeling loose? You dont need to drop your car at a shop for a week. I come to your driveway, diagnose it straight, and fix it on the spot. Mississauga & the GTA. Call 647-450-0406' },
  ],
  reviews: [
    { title: 'Confirm your one-tap review link', detail: 'This is the link that goes in every review text — it drops the customer straight onto the write-a-review screen. It is already live; save it so it is one tap for them.', snippet: 'https://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg' },
    { title: 'Text Rob now (suspension, $1,400)', detail: 'Rob is your best shot — big happy job last week, perfect timing. Send this exact text. Asking him to name the suspension job and the at-home service plants SEO keywords that also power the BMW/Audi pages.', snippet: 'Hey Rob! How is the car riding after the suspension/front-end work? Should feel tight again.\n\nIf you have got 30 seconds, a Google review would genuinely help me out - even one line. If you can mention it was the suspension job and that I came right to your place, that helps other people find me:\nhttps://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg\n\nAppreciate you - Fares' },
    { title: 'Text George now (Ram 2500 diesel, $450)', detail: 'George at Brothers Deals On Wheels in Oakville is your second easy review. Send this exact text — naming the diesel work and the Oakville visit adds another location keyword to your Maps presence.', snippet: 'Hey George! How is the Ram 2500 running since the diesel service?\n\nQuick favour - if you were happy with it, a Google review would mean a lot. A line about the diesel work and that I came out to you in Oakville goes a long way:\nhttps://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg\n\nThanks man - Fares' },
    { title: 'Ask out loud at the end of every job', detail: 'The ask starts in person, before any text. As you pack up say "If you are happy with it, a Google review would really help me out." That one line nearly doubles how many actually leave one.' },
    { title: 'Send the same-day text (2-4 hrs after)', detail: 'Catch them while the car still feels fixed and they are happy. Send this 2-4 hours after you finish, swapping in their name, vehicle, and service.', snippet: 'Hey [Name]! Just checking in - how is the [vehicle] feeling after the [service]? Everything running smooth?\n\nIf anything feels off, hit me up anytime.\n\nAlso, if you got 30 seconds, dropping a Google review would really help me out: https://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg\n\nThanks again - Fares' },
    { title: 'Nudge once at 1 week if no review', detail: 'If a week passes with no review, send ONE gentle reminder — then stop. Never ask more than twice; being annoying costs you the referral too.', snippet: 'Hey [Name]! Hope the [vehicle] is treating you well after the [service] last week.\n\nQuick favor - if you were happy with the work, a Google review would mean a lot. Takes 30 seconds and helps other people find a solid mechanic: https://search.google.com/local/writereview?placeid=ChIJAa99cVdDK4gR3_54nauBoEg\n\nNo pressure though. Appreciate you either way!' },
    { title: 'Plant the referral at 1-2 weeks', detail: 'Only for happy customers, 1-2 weeks out: turn the trust-job into the next lead with the shop-quote angle. High-ticket customers refer high-ticket customers.', snippet: 'Hey [Name]! Quick one - know anyone dreading a big repair bill, or sitting on a shop quote they are not sure about?\n\nSend them my way (647-450-0406 or carswithfares.ca) and I will take care of them the same way I did you - come to them, quote straight, no shop runaround.\n\nAppreciate you - Fares' },
    { title: 'Coach what a good review says', detail: 'Reviews that name the service ("suspension repair"), the location ("came to my house in Mississauga"), and the experience ("showed up on time, fair flat price, showed me the old parts") rank you higher in local search. Nudge customers toward those details naturally — never script them.' },
    { title: 'Track the flywheel and hit the targets', detail: 'For each closed job log four things: review asked (y/n), review left (y/n), referral asked (y/n), referral booked (who). Ask 100% of the time. Realistic conversion is 30-40% leaving a review and about 1 in 5 sending a referral. Goal: 15-20 reviews by month 3, 50+ by month 6.', handoff: { kind: 'review_tracker', title: 'Add a per-job review/referral tracker to the CRM (asked, review left, referral asked, referral booked) and surface the running counts against the 15-20 by month 3 target' } },
  ],
  google_ads: [
    { title: 'Open or claim the Google Ads account', detail: 'Sign in at ads.google.com with the Cars With Fares Google account. An account was started back in March and was stuck "verifying" — finish identity/business verification if it asks, or create a fresh account if you cannot get back in.', link: 'https://ads.google.com' },
    { title: 'Set up a Search-only campaign', detail: 'New campaign, objective "Leads", type "Search" only. Turn OFF Display network and Search Partners on the campaign settings page — they burn budget on no-intent clicks. Goal: people typing a real mobile-mechanic or bigger-repair need.' },
    { title: 'Lock the geo, schedule and budget', detail: 'Location: Mississauga + 20km (Brampton, Etobicoke, Oakville, west Toronto, Milton), set to "people IN this location" not "interested in". Schedule Mon-Sat 7am-9pm. Budget $30-40/day. Start on Manual CPC ~$2-4 max until conversion tracking is live, then switch to Maximize Conversions. Lean mobile.' },
    { title: 'Build the 3 ad groups + keywords', detail: 'AG1 mobile-mechanic intent, AG2 trusted/honest-mechanic intent, AG3 the specific bigger jobs (suspension, control arm, strut, timing chain, alternator, AC compressor, wheel bearing, CV axle). Phrase/exact match only. Add a new keyword every time a customer names the repair they needed.' },
    { title: 'Paste in the negative-keyword wall', detail: 'This is what protects your margin and filters the wrong customer. Add every cheap/DIY/dealer/job-seeker term as a campaign negative. Note: quote, estimate and price match are negatives on purpose — those are price-shoppers, not repair-need searchers.', snippet: 'oil change, oil, cheap, cheapest, free, quote, estimate, price match, beat quote, diy, how to, do it yourself, jobs, hiring, salary, school, course, apprentice, tools, scanner, obd2, parts only, used parts, junkyard, scrap, tire, tires, detailing, car wash, rental, insurance, warranty, dealership, canadian tire, jiffy lube, walmart, wiper, battery boost, key fob, light bulb' },
    { title: 'Load the responsive search ad', detail: 'One RSA per ad group. Trust + we-come-to-you voice, never "beat your quote". Final URL = the trust-led mobile-mechanic landing page (/mobile-mechanic). Path field: mobile-mechanic. Let Claude draft the full headline/description set in the next step.' },
    { title: 'Have Claude Code draft the copy + keyword lists', detail: 'Hand the ad-group structure and the negative wall to Claude Code and get back the 12 headlines, 4 descriptions and a per-ad-group keyword list, all in the trusted-mobile-mechanic voice, ready to paste straight into the Ads editor.', handoff: { kind: 'google_ads_copy', title: 'Draft 12 RSA headlines + 4 descriptions (trust/we-come-to-you voice) and the 3 ad-group keyword lists from strategy/google-ads-campaign.md, plus the final negative-keyword wall' } },
    { title: 'Go live, then watch the Search Terms report daily', detail: 'Launch at $30-40/day. Open the Search Terms report every day in week 1 and add anything cheap or irrelevant to the negative list — that daily pruning is 80% of running Ads well. Once generate_lead is importing as a conversion, flip bidding to Maximize Conversions.' },
  ],
  twilio: [
    { title: 'Why this is safe to turn on', detail: 'The instant speed-to-lead auto-text is already built and live in the code as a no-op — nothing fires until these 3 secrets exist. Once they do, every new lead gets a personalized text within seconds. Responding in under a minute vs 30 can multiply your close rate.' },
    { title: 'Create a Twilio account', detail: 'Sign up at twilio.com. Free trial is fine to test; add a small balance to go live. Texts cost about a penny each.', link: 'https://www.twilio.com/try-twilio' },
    { title: 'Buy a Canadian number with SMS', detail: 'In the Twilio console, Phone Numbers > Buy a number. Pick a local Canadian number with SMS capability (~$1-2/mo). This becomes the FROM number the auto-text sends from.', link: 'https://console.twilio.com/us1/develop/phone-numbers/manage/search' },
    { title: 'Grab the 3 secrets', detail: 'From the Twilio console dashboard copy: Account SID (starts AC...), Auth Token (click to reveal), and your new Twilio number in E.164 format like +16475551234. Keep them somewhere safe for the next step — do not paste them into any doc.', link: 'https://console.twilio.com' },
    { title: 'Preview the message it will send', detail: 'This fixed template fires automatically to every new lead the second they come in — reliable and instant. Replies route to your Twilio number; the text tells them to call/text your real line for the conversation.', snippet: 'Hey {name}, it is Fares from Cars With Fares — got your note about {issue}. I come to you and can take a look. What does your day look like? Reply here or call/text 647-450-0406.' },
    { title: 'Hand the 3 secrets to Claude Code to wire in', detail: 'Give Claude Code the Account SID, Auth Token and FROM number. Claude sets them as the worker secrets TWILIO_SID, TWILIO_TOKEN and TWILIO_FROM with no trailing newline, confirms the no-op flips live, and fires one test text so you see it land before real leads do.', handoff: { kind: 'twilio_secrets', title: 'Set TWILIO_SID, TWILIO_TOKEN and TWILIO_FROM as worker secrets (no trailing newline), confirm crm-api/src/sms.js goes live, and send one test text to 647-450-0406 to verify' } },
  ],
  ga4: [
    { title: 'Why this one matters most for Ads', detail: 'The site already fires a generate_lead event on every form submit — but until you mark it a Key Event, Google Ads is blind and burns budget on clicks that never convert. This is a 2-minute toggle and it is the gate that makes the Ads campaign actually optimize.' },
    { title: 'Open GA4 Admin > Events', detail: 'Go to analytics.google.com, pick the Cars With Fares property, click Admin (bottom-left gear), then under the Data display column click "Events". You should see generate_lead in the list (submit a quote form once if it has not shown up yet).', link: 'https://analytics.google.com' },
    { title: 'Toggle generate_lead to a Key Event', detail: 'In the Events table, find the generate_lead row and flip the "Mark as key event" toggle on the right to ON. That is it — GA4 now counts every form submit as a conversion.' },
    { title: 'Import it into Google Ads as a conversion', detail: 'In Google Ads go to Goals > Conversions > Summary > New conversion action > Import > Google Analytics 4 (GA4). Tick generate_lead and import it. Also add a tap-to-call conversion so phone clicks count too. Now Maximize Conversions has something real to optimize toward.', link: 'https://ads.google.com' },
  ],
  content: [
    { title: 'Lock the angle: trust, not price', detail: 'Every post sells trust + expertise + convenience, never "cheapest" or "beat your quote." The goal: a non-car-person watches and thinks "this is the guy I would actually trust with my car." No fake numbers (no "500+ cars"), no oil-change content, no shop-war drama.' },
    { title: 'Fix your bios to the honest versions', detail: 'Update Instagram and TikTok bios to the locked copy below. Link both to carswithfares.ca/mobile-mechanic. Personality + face is the brand — people book a person they trust, not a logo.', snippet: 'INSTAGRAM:\nFares - Mobile Mechanic - Mississauga & GTA\nThe big jobs, done right - at your door.\nHonest diagnosis. Quoted before I start.\nBook -> carswithfares.ca/mobile-mechanic\n\nTIKTOK:\nMobile mechanic | GTA\nSuspension - front-end - diagnostics - at your driveway\nThe mechanic you can actually trust\nBook -> carswithfares.ca/mobile-mechanic' },
    { title: 'Post 4x a week, rotate the 4 pillars', detail: 'Mon = Detective (a diagnostic win), Wed = Real Job (a bigger repair, before/after), Fri = Honest Car-Guy (face/personality), Sun = Teach (a generous expert tip). Keep ~60% solo so you never stall waiting on a job, and film every real big job you do — those convert hardest.' },
    { title: 'End every caption with the same soft CTA', detail: 'No hard sell. Close every video and caption the same way so the funnel is consistent. Drives to carswithfares.ca/mobile-mechanic.', snippet: 'Mississauga & the GTA - I come to you. Book at the link in bio.' },
    { title: 'Capture every big job on camera', detail: 'The Real Job + Detective clips are your highest-trust content. Shoot suspension, front-end refreshes, control arms, clutch, no-start revivals on the DJI Action 5 Pro. A 3-shop-stumped diagnostic win is the single best-performing format — always roll for it.' },
    { title: 'Pin your 3 best videos', detail: 'Pin your strongest Detective win, a big Real-Job before/after, and a "why I went mobile / who I am" trust video to the top of both profiles. New visitors judge you off those three.' },
    { title: 'Reply to every comment for 30 days', detail: 'For the first 30 days reply to every single comment — each reply re-surfaces the video to the algorithm and starts the relationship. Treat comments as inbound leads, not noise.' },
    { title: 'Have Claude Code write this week’s 4 posts', detail: 'Hand it off — Claude Code pulls from the 28 re-angled scripts and the concept bank in strategy/content-plan-v2.md and writes one post per pillar (hook + caption + the soft CTA), matched to your cadence and any real jobs you filmed this week.', handoff: { kind: 'content_week_posts', title: 'Generate this week’s 4 posts (one per pillar) from the 28 scripts + concept bank, each ending with the GTA / link-in-bio CTA, trust-led, no price-shaming' } },
  ],
  retell: [
    { title: 'Create your Retell AI account', detail: 'Retell runs the voice agent that answers when you are under a car. Sign up, verify your email, and grab the free trial credits so you can test before paying. This is the brain that catches every missed call instantly.', link: 'https://www.retellai.com' },
    { title: 'Create an ElevenLabs account for the voice', detail: 'ElevenLabs gives the agent a natural voice. Sign up, then pick a warm, casual male voice (not a corporate robot) so it sounds like a friend who happens to be a mechanic. Copy the voice ID — Retell needs it to connect.', link: 'https://elevenlabs.io' },
    { title: 'Buy or connect a phone number', detail: 'In Retell, provision a phone number (or port your business line) so calls route into the agent. Set it to answer only when you do not pick up — the agent catches the overflow, you stay on the tools.', link: 'https://dashboard.retellai.com' },
    { title: 'Load the agent prompt', detail: 'Paste the full agent prompt from ai-phone-agent/AGENT-PROMPT.md into Retell as the system prompt. It already has the identity, trust voice, services (lead with the big jobs), coverage, conversation flow, objections, and hard rules. Do not water it down.' },
    { title: 'Set the opening line + honesty rule', detail: 'Confirm the greeting and the "I am Fares’s AI assistant" honesty rule are intact. Never let it claim to be a different human or invent a name — honesty is the whole brand.', snippet: 'Hey, thanks for calling Cars With Fares - what’s going on with your car?\n(After 10pm: Hey, you’ve reached Cars With Fares - what’s going on?)' },
    { title: 'Wire the escalation patch to your cell', detail: 'Set the transfer number to 647-450-0406 and the rule: patch high-ticket consumer jobs straight to you — big repairs (suspension/front-end/engine/clutch/no-start), nicer cars (BMW/Mercedes/Audi), anything urgent, or when they ask for Fares by name. If you do not pick up, the agent reassures and captures everything.' },
    { title: 'Lock the pricing + diagnosis guardrails', detail: 'Never a hard price on the phone — "depends on the vehicle and what we find, but Fares quotes the flat price before he starts, no surprises." Never a definitive diagnosis — "Fares confirms it on-site." Never pitch price or "beat your quote." No tax/HST talk.' },
    { title: 'Turn on the after-call SMS follow-up', detail: 'Configure the post-call text so every caller gets a warm follow-up with your number and the AI advisor link. Keeps the lead warm until you call back.', snippet: 'Hey [name], it’s Cars With Fares - got your info, Fares will be in touch shortly. You can also describe your problem to our AI assistant here: carswithfares.ca/mobile-mechanic - or call/text 647-450-0406 anytime.' },
    { title: 'Test it with a real call', detail: 'Call the number yourself and run a real scenario (e.g. a clunk over bumps on a BMW). Check it captures name + number + symptom, gives an honest non-committal read, and offers to patch you in. Fix anything that sounds scripted or off-brand before it goes live.' },
    { title: 'Have Claude Code wire it end-to-end', detail: 'Once your accounts exist, hand off the keys and number — Claude Code loads the prompt, configures the ElevenLabs voice, sets the 647-450-0406 escalation logic, the SMS follow-up, and the missed-call routing, then runs a test-call checklist so you only have to confirm it.', handoff: { kind: 'retell_wire_agent', title: 'Wire the Retell phone agent: load AGENT-PROMPT.md, connect the ElevenLabs voice, set escalation to 647-450-0406, the after-call SMS, missed-call routing, and a test-call checklist' } },
  ],
}

// progress map helper — { gate_key:[doneStepIndexes] }, tenant-scoped via settings
async function gateProgress(b) { return await getJson(b, 'gate_progress', {}) }
function gatePct(key, done) {
  const total = (PLAYBOOKS[key] || []).length
  if (!total) return 0
  return Math.round((done.length / total) * 100)
}

// GET the playbook for a gate — steps + the gate row + which steps are done + pct
app.get('/api/playbook/:key', auth, async (c) => {
  const key = c.req.param('key'), b = biz(c)
  const steps = PLAYBOOKS[key]
  if (!steps) return c.json({ error: 'no playbook for that gate' }, 404)
  const gate = (await q(`select key, label, status from activation where business_id=$1 and key=$2`, [b, key])).rows[0]
    || { key, label: key, status: 'todo' }
  const prog = await gateProgress(b)
  const done = Array.isArray(prog[key]) ? prog[key].filter((i) => i >= 0 && i < steps.length) : []
  return c.json({ gate, steps, done, pct: gatePct(key, done) })
})

// Toggle a single step done/undone — completing ALL steps flips the gate done + logs it, returns the next gate to work
app.post('/api/playbook/:key/step', auth, async (c) => {
  const key = c.req.param('key'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const steps = PLAYBOOKS[key]
  if (!steps) return c.json({ error: 'no playbook for that gate' }, 404)
  const index = Number(d.index)
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return c.json({ error: 'bad step index' }, 400)
  const prog = await gateProgress(b)
  const set = new Set((Array.isArray(prog[key]) ? prog[key] : []).filter((i) => i >= 0 && i < steps.length))
  if (d.done === false) set.delete(index)
  else set.add(index)
  const done = [...set].sort((a, z) => a - z)
  prog[key] = done
  await setJson(b, 'gate_progress', prog)

  const gateComplete = done.length === steps.length
  let next_gate = null
  if (gateComplete) {
    const cur = (await q(`select status from activation where business_id=$1 and key=$2`, [b, key])).rows[0]
    await q(`update activation set status='done', updated_at=now() where business_id=$1 and key=$2`, [b, key])
    if (!cur || cur.status !== 'done') {
      const label = (await q(`select label from activation where business_id=$1 and key=$2`, [b, key])).rows[0]?.label || key
      await q(`insert into activity (business_id,type,body) values ($1,'activation',$2)`, [b, `Gate completed — ${label} ✓`])
    }
    next_gate = (await q(`select key, label from activation where business_id=$1 and status='todo' and key<>$2 order by sort asc limit 1`, [b, key])).rows[0] || null
  } else {
    // if a finished gate gets a step unchecked, walk it back to doing so the board stays honest
    if (d.done === false) await q(`update activation set status=case when status='done' then 'doing' else status end, updated_at=now() where business_id=$1 and key=$2`, [b, key])
  }
  return c.json({ done, pct: gatePct(key, done), gate_complete: gateComplete, next_gate })
})

// ---- HANDOFF QUEUE — the Claude Code bridge. A step (or the cockpit) dispatches
// real work to Claude Code; Claude Code picks it up, does it, marks it done. ----
const HANDOFF_STATUSES = ['new', 'in_progress', 'done']
app.get('/api/handoffs', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select id, kind, title, payload, status, result, created_at, done_at
      from handoffs where business_id=$1 order by created_at desc`, [b])).rows
  const summary = {
    total: rows.length,
    new: rows.filter((r) => r.status === 'new').length,
    in_progress: rows.filter((r) => r.status === 'in_progress').length,
    done: rows.filter((r) => r.status === 'done').length,
  }
  return c.json({ handoffs: rows, summary })
})
app.post('/api/handoffs', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const kind = (d.kind || '').toString().trim()
  const title = (d.title || '').toString().trim()
  if (!kind || !title) return c.json({ error: 'need a kind and title' }, 400)
  const payload = d.payload && typeof d.payload === 'object' ? d.payload : {}
  const row = (await q(`insert into handoffs (business_id,kind,title,payload,status)
      values ($1,$2,$3,$4::jsonb,'new')
      returning id, kind, title, payload, status, result, created_at, done_at`,
    [b, kind, title, JSON.stringify(payload)])).rows[0]
  await q(`insert into activity (business_id,type,body) values ($1,'handoff',$2)`, [b, `Dispatched to Claude Code: ${title}`])
  return c.json({ handoff: row })
})
app.post('/api/handoffs/:id/done', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const row = (await q(`select id, title from handoffs where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  const result = d.result != null ? (d.result || '').toString() : null
  await q(`update handoffs set status='done', result=$1, done_at=now() where id=$2 and business_id=$3`, [result, id, b])
  await q(`insert into activity (business_id,type,body) values ($1,'handoff',$2)`, [b, `Claude Code finished: ${row.title}`])
  return c.json({ ok: true, status: 'done' })
})
app.post('/api/handoffs/:id/status', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const status = (d.status || '').toString()
  if (!HANDOFF_STATUSES.includes(status)) return c.json({ error: 'bad status' }, 400)
  const stampDone = status === 'done'
  const r = await q(`update handoffs set status=$1${stampDone ? ', done_at=coalesce(done_at,now())' : ''} where id=$2 and business_id=$3`, [status, id, b])
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  return c.json({ ok: true, status })
})
// ---- boot ----
await applySchema().catch((e) => console.error('schema bootstrap error:', e))
await seedIfEmpty()

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (i) => console.log(`command-center listening on :${i.port}`))
