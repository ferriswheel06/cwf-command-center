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


// ---- boot ----
await applySchema().catch((e) => console.error('schema bootstrap error:', e))
await seedIfEmpty()

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (i) => console.log(`command-center listening on :${i.port}`))
