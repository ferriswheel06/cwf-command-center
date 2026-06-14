// Cars With Fares — Command Center API + UI (Railway + Postgres)
// Free AI stays on the Cloudflare crm-api Worker (env.AI only lives there); we call it over HTTPS.
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createHash, randomUUID } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand,
  CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { applySchema } from './db/apply-schema.js'
import cron from 'node-cron'

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

// Asset kinds — ONE module-level source reused everywhere (per-job assets, library filter, R2 uploads).
// kind: photo | clip | quote | invoice | doc
const ASSET_KINDS = ['photo', 'clip', 'quote', 'invoice', 'doc']

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
  // stamp completion/payment timestamps on the transition INTO that stage (coalesce so they're never overwritten on a re-advance)
  const stamp = next === 'paid' ? ', paid_at=coalesce(paid_at,now())'
    : next === 'completed' ? ', completed_at=coalesce(completed_at,now())' : ''
  await q(`update jobs set status=$1${stamp} where id=$2 and business_id=$3`, [next, id, b])
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

// ---- WON WORKFLOW (shared) — winning a job collapses the overhead into one move ----
// Sets status=scheduled + quote_status=accepted, auto-creates the review-ask + photo-capture
// tasks, and logs it. Idempotent: dedupes the checklist tasks so calling it twice (e.g. /won
// then a quote marked 'accepted') can't double-create them. Tenant-scoped via b. Flat, no tax.
async function fireWonWorkflow(b, jobId) {
  const job = (await q(`select j.id, j.customer_id, j.charge, j.parts_cost, j.gas_cost, j.scheduled_date, j.status, j.quote_status,
      c.name as customer, nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from jobs j join customers c on c.id=j.customer_id left join vehicles v on v.id=j.vehicle_id
    where j.id=$1 and j.business_id=$2`, [jobId, b])).rows[0]
  if (!job) return null
  const profit = (Number(job.charge) || 0) - (Number(job.parts_cost) || 0) - (Number(job.gas_cost) || 0)
  // don't downgrade a job already further along the flow — only nudge lead/quoted forward to scheduled
  const nextStatus = ['lead', 'quoted'].includes(job.status) ? 'scheduled' : job.status
  const alreadyWon = job.quote_status === 'accepted'
  await q(`update jobs set status=$1, quote_status='accepted' where id=$2 and business_id=$3`, [nextStatus, jobId, b])
  if (!alreadyWon) {
    await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'status_change',$4)`,
      [b, jobId, job.customer_id, `Marked WON → ${nextStatus} ✓ (flat $${Number(job.charge) || 0} · profit $${profit})`])
  }
  const who = job.customer || 'the customer'
  const ride = job.vehicle ? ` on the ${job.vehicle}` : ''
  const checklist = []
  // 1) review-ask task — ask every happy customer, every time (dedupe: one open review_ask per job)
  const reviewTask = (await q(`insert into tasks (business_id,job_id,customer_id,kind,title,body,status)
      select $1,$2,$3,'review_ask',$4,$5,'open'
      where not exists (select 1 from tasks where business_id=$1 and job_id=$2 and kind='review_ask' and status='open')
      returning id, title`,
    [b, jobId, job.customer_id, `Ask ${who} for a Google review`,
      `After the job${ride} is done — send the review-ask text. Each review makes the next stranger trust you faster.`])).rows[0]
  if (reviewTask) checklist.push({ kind: 'review_ask', task_id: reviewTask.id, title: reviewTask.title, when: 'after the job' })
  // 2) photo-capture reminder — recontact due after the job (default 1 day out, or scheduled_date if known)
  const photoDue = job.scheduled_date
    ? `(date '${new Date(job.scheduled_date).toISOString().slice(0, 10)}' + 1)::timestamptz`
    : `(current_date + 1)::timestamptz`
  const photoTask = (await q(`insert into tasks (business_id,job_id,customer_id,kind,title,body,status,due_at)
      select $1,$2,$3,'recontact',$4,$5,'open',${photoDue}
      where not exists (select 1 from tasks where business_id=$1 and job_id=$2 and kind='recontact' and status='open' and title like 'Grab before/after photos%')
      returning id, title, due_at`,
    [b, jobId, job.customer_id, `Grab before/after photos${ride}`,
      `Capture the job photos/clips — they become content and the proof you drop to close the next hesitant prospect.`])).rows[0]
  if (photoTask) checklist.push({ kind: 'recontact', task_id: photoTask.id, title: photoTask.title, when: 'after the job', due_at: photoTask.due_at })
  return {
    ok: true, status: nextStatus, quote_status: 'accepted',
    charge: Number(job.charge) || 0, profit, below_floor: profit < 1000,
    already_won: alreadyWon, checklist,
  }
}

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
  // accepting a quote = winning the job: fire the shared won workflow (review-ask + photo tasks).
  // idempotent + deduped, so it won't double-create even if /won already ran.
  let checklist
  if (qs === 'accepted') {
    const won = await fireWonWorkflow(b, id)
    if (won) { jobStatus = won.status; checklist = won.checklist }
  }
  return c.json({ quote_status: qs, status: jobStatus, profit, below_floor: profit < 1000, ...(checklist ? { checklist } : {}) })
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
      count(*) filter (where status='completed' and completed_at::date = current_date)::int as completed,
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
// kind list lives in the module-level ASSET_KINDS const (top of file).
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
  // Phase-1: if it's an R2 asset, best-effort delete the object (+ thumb) before dropping the row.
  const row = (await q(`select id, storage, r2_key, thumb_key from assets where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.storage === 'r2' && r2Client()) {
    for (const k of [row.r2_key, row.thumb_key]) {
      if (!k) continue
      try { await r2Client().send(new DeleteObjectCommand({ Bucket: R2_BUCKET(), Key: k })) } catch (e) { console.error('[r2 delete]', e.message) }
    }
  }
  await q(`delete from assets where id=$1 and business_id=$2`, [id, b])
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
  const result = await fireWonWorkflow(b, id)
  if (!result) return c.json({ error: 'not found' }, 404)
  return c.json(result)
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
// Phase-2 pipeline (kanban) stages — the editing-bridge lifecycle (see the Content Studio block below).
const STUDIO_STAGES = ['idea', 'raw', 'editing', 'ready', 'scheduled', 'posted']
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
// Create a piece. Back-compat: logging an already-posted piece (status defaults 'posted', Wave-4).
// Phase-2: also accepts pipeline_stage, hook, caption, hashtags[], source_note, asset_ids[] (Vault sources).
app.post('/api/content', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const title = (d.title || '').toString().trim()
  if (!title) return c.json({ error: 'need a title' }, 400)
  // Phase-2 kanban stage. If a stage is given but no explicit status, derive the legacy status from it
  // so the old leads-attribution view keeps working. If neither is given, default to the Wave-4 'posted'.
  const stage = STUDIO_STAGES.includes(d.pipeline_stage || d.stage) ? (d.pipeline_stage || d.stage) : null
  const status = CONTENT_STATUSES.includes(d.status) ? d.status
    : (stage ? (stage === 'posted' ? 'posted' : stage === 'scheduled' ? 'scheduled' : stage === 'idea' ? 'idea' : 'draft') : 'posted')
  const pipelineStage = stage || (status === 'posted' ? 'posted' : status === 'scheduled' ? 'scheduled' : status === 'draft' ? 'raw' : 'idea')
  const channel = (d.channel || '').toString().trim() || null
  const url = (d.url || '').toString().trim() || null
  const notes = (d.notes || '').toString().trim() || null
  const hook = (d.hook || '').toString().trim() || null
  const caption = (d.caption || '').toString().trim() || null
  const sourceNote = (d.source_note || d.brief || '').toString().trim() || null
  const hashtags = Array.isArray(d.hashtags) ? d.hashtags.map((x) => String(x).trim()).filter(Boolean) : []
  // posted_at: explicit, or now() if it's already posted, else null
  const postedAt = d.posted_at || (status === 'posted' ? new Date().toISOString() : null)
  const leads = d.leads_attributed != null ? Math.max(0, Number(d.leads_attributed) || 0) : 0
  const row = (await q(`insert into content (business_id,title,channel,status,pipeline_stage,url,notes,hook,caption,hashtags,source_note,posted_at,leads_attributed)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::timestamptz,$13)
      returning id, title, channel, status, pipeline_stage, url, notes, hook, caption, hashtags, source_note, leads_attributed, posted_at, created_at`,
    [b, title, channel, status, pipelineStage, url, notes, hook, caption, JSON.stringify(hashtags), sourceNote, postedAt, leads])).rows[0]
  // attach any seed Vault assets as sources (tenant-scoped, order preserved)
  if (Array.isArray(d.asset_ids) && d.asset_ids.length) {
    let sort = 0
    for (const aid of d.asset_ids) {
      const a = (await q(`select id from assets where id=$1 and business_id=$2`, [Number(aid), b])).rows[0]
      if (!a) continue
      await q(`insert into content_assets (business_id,content_id,asset_id,role,sort) values ($1,$2,$3,'source',$4)
               on conflict (content_id, asset_id, role) do nothing`, [b, row.id, a.id, sort++])
    }
  }
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
  social: [
    { title: 'Why one-tap posting first (the honest version)', detail: 'Real talk: nobody can skip platform app-review. Self-hosting a posting tool still needs YOUR own approved developer app per platform — that is the wall, and it takes weeks for Instagram/TikTok. So the Studio already does the smart thing: it produces the finished, captioned, correctly-sized post and drops it in Ready, you tap "post now" and it copies the caption + opens the channel. That ships value today with zero API risk. This gate connects the low-friction channels for true auto-post, in friction order.' },
    { title: 'Connect Google Business Profile posts first (lowest friction)', detail: 'GBP is the easiest win and you are already half set up — your profile is verified and the GBP gate has the post copy. GBP "localPosts" is not deprecated and posting 1-2x a week keeps you ranking. To auto-post you need Google Business Profile API access: request it via the Business Profile APIs form (Basic Access, ~14-day review; profile must be 60+ days old — yours is). Until that lands, keep using one-tap: the Studio copies the caption, you paste it in GBP.', link: 'https://developers.google.com/my-business/content/basic-setup' },
    { title: 'Connect YouTube next (Shorts auto-upload)', detail: 'YouTube is the easiest real auto-upload. Create/confirm your channel, then in Google Cloud Console enable the "YouTube Data API v3" and create an OAuth client. Quota note (Dec 2025): an upload costs ~100 units against the default ~10,000/day, so ~100 uploads/day free — plenty. Vertical cuts go up as Shorts. This is the first channel worth fully automating.', link: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com' },
    { title: 'Set expectations on Instagram + TikTok (weeks, not minutes)', detail: 'These are the slow ones — do NOT block posting on them. Instagram (Business/Creator) needs a Meta app with instagram_content_publish, and App Review runs 2-4 weeks; video must be a public URL (R2 already serves that). TikTok unaudited apps can only post privately (SELF_ONLY) — public posting needs a TikTok audit, days to ~2 weeks. Start their approvals the day you commit to daily posting, not before. Until approved, they stay one-tap in the Studio.' },
    { title: 'Skip the paid aggregators', detail: 'For the record so you do not waste money: Ayrshare free is images-only/20-posts-a-month (useless for video), paid is $149/mo (breaks the $0 rule). Postiz self-host still needs your own Meta/TikTok apps and is a heavy service to babysit for one user. Stay Cloudflare-native + one-tap until you are actually posting 8+ times a day across channels.' },
    { title: 'Try the assisted post flow now (no setup needed)', detail: 'Open a Ready piece in the Studio, schedule it, then hit "post now" on a channel — it copies the caption to your clipboard and opens that app. Paste, post, paste the post URL back and mark it posted. Then enter the reach + any leads on the post so the Funnel learns which channel actually pays. This works today, before any API.' },
    { title: 'Hand GBP wiring to Claude Code (when access lands)', detail: 'Once your Google Business Profile API access is approved, hand off the OAuth credentials — Claude Code wires the GBP localPosts auto-post into the Studio so scheduled GBP pieces publish themselves, with the one-tap path kept as the fallback.', handoff: { kind: 'social_wire_gbp', title: 'Wire Google Business Profile auto-post (localPosts API) into the Content Studio: OAuth credentials -> publish scheduled GBP pieces, keep one-tap as fallback, log post URLs back to content_posts' } },
    { title: 'Hand YouTube wiring to Claude Code (when OAuth is ready)', detail: 'Once the YouTube Data API v3 + OAuth client exist, hand off the credentials — Claude Code wires Shorts auto-upload into the Studio so scheduled YouTube pieces publish the finished cut from R2 and write the video URL back to the post row.', handoff: { kind: 'social_wire_youtube', title: 'Wire YouTube Data API v3 auto-upload (Shorts) into the Content Studio: OAuth client -> upload the R2 cut for scheduled YouTube pieces, write the video URL + status back to content_posts' } },
    { title: 'Start IG + TikTok approvals last, hand to Claude Code', detail: 'When you commit to daily posting, kick off the multi-week Meta + TikTok app reviews. Hand off the app setup so Claude Code preps the Meta app (instagram_content_publish) and the TikTok app + audit submission, wires both to publish from the R2 public URL once approved, and leaves them in one-tap mode until then.', handoff: { kind: 'social_wire_meta_tiktok', title: 'Prep Instagram (instagram_content_publish, App Review) + TikTok (content posting + audit) apps for the Content Studio: publish from the R2 public URL once approved, keep one-tap mode until approval lands' } },
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
// ============================================================================
// CONTENT STUDIO Phase 1 — THE VAULT (Cloudflare R2, private bucket, signed links)
// Bytes NEVER pass through Railway: the browser uploads DIRECT to R2 over a
// presigned PUT (single <100MB) or multipart (big GoPro/4K). Previews/downloads
// are short-lived presigned GETs (bucket is private). If the R2 env vars are
// missing, the upload endpoints return a clean 503 and the rest of the app is
// unaffected. Tenant-scoped via biz(c). Paste-a-link stays as a fallback (storage='link').
// Railway env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET (=cwf-media).
// ============================================================================
let _r2 = null
function r2Client() {
  const { R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET } = process.env
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY || !R2_BUCKET) return null
  if (!_r2) {
    _r2 = new S3Client({
      region: 'auto',
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: R2_ACCESS_KEY_ID, secretAccessKey: R2_SECRET_ACCESS_KEY },
      // R2 rejects the SDK's default flexible-checksums on presigned PUTs (an empty-body CRC32
      // gets baked into the signed URL → checksum mismatch on the real bytes → 400). Force
      // checksums off unless explicitly required so presigned PUT/UploadPart URLs sign clean.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
  }
  return _r2
}
const R2_BUCKET = () => process.env.R2_BUCKET
const r2Down = (c) => c.json({ error: 'storage not configured yet' }, 503)
const GET_TTL = 3600   // 1h presigned GET — long enough to play/scrub a clip
const PUT_TTL = 3600   // 1h presigned PUT — covers a slow driveway-LTE upload

// asset kinds reuse the single module-level ASSET_KINDS const (top of file)
const safeExt = (filename) => {
  const m = /\.([a-z0-9]{1,8})$/i.exec((filename || '').toString())
  return m ? m[1].toLowerCase() : 'bin'
}
// key layout: media/{job-id|unsorted}/{uuid}.{ext}
const buildKey = (jobId, filename) => `media/${jobId ? Number(jobId) : 'unsorted'}/${randomUUID()}.${safeExt(filename)}`
// fresh short-lived presigned GET for previews/downloads
const signGet = (key) => getSignedUrl(r2Client(), new GetObjectCommand({ Bucket: R2_BUCKET(), Key: key }), { expiresIn: GET_TTL })

// scope a job to this tenant; returns the job row (id, customer_id) or null
async function ownedJob(b, jobId) {
  if (!jobId) return null
  return (await q(`select id, customer_id from jobs where id=$1 and business_id=$2`, [Number(jobId), b])).rows[0] || null
}

// ---- single-shot upload: presigned PUT for files under ~100MB ----
app.post('/api/uploads/sign', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const filename = (d.filename || '').toString().trim()
  if (!filename) return c.json({ error: 'need a filename' }, 400)
  const contentType = (d.content_type || '').toString().trim() || 'application/octet-stream'
  let jobId = null
  if (d.job_id) { const job = await ownedJob(b, d.job_id); if (!job) return c.json({ error: 'job not found' }, 404); jobId = job.id }
  const key = buildKey(jobId, filename)
  const url = await getSignedUrl(r2Client(),
    new PutObjectCommand({ Bucket: R2_BUCKET(), Key: key, ContentType: contentType }),
    { expiresIn: PUT_TTL })
  return c.json({ url, r2_key: key, content_type: contentType, expires_in: PUT_TTL })
})

// ---- multipart upload (big GoPro/iPhone 4K): create → sign each part → complete/abort ----
app.post('/api/uploads/multipart/create', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const filename = (d.filename || '').toString().trim()
  if (!filename) return c.json({ error: 'need a filename' }, 400)
  const contentType = (d.content_type || '').toString().trim() || 'application/octet-stream'
  let jobId = null
  if (d.job_id) { const job = await ownedJob(b, d.job_id); if (!job) return c.json({ error: 'job not found' }, 404); jobId = job.id }
  const key = buildKey(jobId, filename)
  const out = await r2Client().send(new CreateMultipartUploadCommand({ Bucket: R2_BUCKET(), Key: key, ContentType: contentType }))
  return c.json({ uploadId: out.UploadId, r2_key: key, content_type: contentType })
})
app.post('/api/uploads/multipart/sign', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const d = await c.req.json().catch(() => ({}))
  const key = (d.r2_key || '').toString().trim()
  const uploadId = (d.uploadId || '').toString().trim()
  const partNumber = Number(d.partNumber)
  if (!key || !uploadId || !Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) return c.json({ error: 'need r2_key, uploadId and a valid partNumber (1-10000)' }, 400)
  const url = await getSignedUrl(r2Client(),
    new UploadPartCommand({ Bucket: R2_BUCKET(), Key: key, UploadId: uploadId, PartNumber: partNumber }),
    { expiresIn: PUT_TTL })
  return c.json({ url, partNumber, expires_in: PUT_TTL })
})
app.post('/api/uploads/multipart/complete', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const d = await c.req.json().catch(() => ({}))
  const key = (d.r2_key || '').toString().trim()
  const uploadId = (d.uploadId || '').toString().trim()
  const parts = Array.isArray(d.parts) ? d.parts : []
  if (!key || !uploadId || !parts.length) return c.json({ error: 'need r2_key, uploadId and parts[]' }, 400)
  const Parts = parts
    .map((p) => ({ PartNumber: Number(p.PartNumber), ETag: (p.ETag || '').toString() }))
    .filter((p) => Number.isInteger(p.PartNumber) && p.ETag)
    .sort((a, z) => a.PartNumber - z.PartNumber)
  if (!Parts.length) return c.json({ error: 'parts need PartNumber + ETag' }, 400)
  const out = await r2Client().send(new CompleteMultipartUploadCommand({
    Bucket: R2_BUCKET(), Key: key, UploadId: uploadId, MultipartUpload: { Parts },
  }))
  return c.json({ ok: true, r2_key: key, location: out.Location || null })
})
app.post('/api/uploads/multipart/abort', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const d = await c.req.json().catch(() => ({}))
  const key = (d.r2_key || '').toString().trim()
  const uploadId = (d.uploadId || '').toString().trim()
  if (!key || !uploadId) return c.json({ error: 'need r2_key and uploadId' }, 400)
  try { await r2Client().send(new AbortMultipartUploadCommand({ Bucket: R2_BUCKET(), Key: key, UploadId: uploadId })) }
  catch (e) { return c.json({ ok: false, error: e.message }, 200) } // best-effort cleanup, never block the UI
  return c.json({ ok: true })
})

// ---- record the uploaded object as a Vault asset (storage='r2') ----
// Call this AFTER the browser finished the direct-to-R2 PUT (single or multipart complete).
app.post('/api/uploads/record', auth, async (c) => {
  if (!r2Client()) return r2Down(c)
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  const key = (d.r2_key || '').toString().trim()
  if (!key) return c.json({ error: 'need r2_key' }, 400)
  const kind = ASSET_KINDS.includes(d.kind) ? d.kind : 'photo'
  let jobId = null, customerId = null
  if (d.job_id) { const job = await ownedJob(b, d.job_id); if (!job) return c.json({ error: 'job not found' }, 404); jobId = job.id; customerId = job.customer_id }
  const mime = (d.mime || '').toString().trim() || null
  const bytes = d.bytes != null ? Math.max(0, Number(d.bytes) || 0) : null
  const durationS = d.duration_s != null ? Math.max(0, Math.round(Number(d.duration_s) || 0)) : null
  const label = (d.label || d.filename || '').toString().trim() || null
  const isBefore = !!d.is_before
  // url stays NOT NULL on the table — store the r2_key as the canonical url (private; real access is the signed GET)
  const row = (await q(`insert into assets (business_id,job_id,customer_id,kind,url,label,is_before,storage,r2_key,mime,bytes,duration_s,status)
      values ($1,$2,$3,$4,$5,$6,$7,'r2',$8,$9,$10,$11,'ready')
      returning id, kind, label, is_before, storage, r2_key, mime, bytes, duration_s, status, created_at`,
    [b, jobId, customerId, kind, key, label, isBefore, key, mime, bytes, durationS])).rows[0]
  await q(`insert into activity (business_id,job_id,customer_id,type,body) values ($1,$2,$3,'attachment',$4)`,
    [b, jobId, customerId, `Uploaded ${kind}${label ? ` — ${label}` : ''}`])
  const preview_url = await signGet(key)
  return c.json({ asset: { ...row, preview_url } })
})

// ---- THE VAULT — list assets (r2 + link), newest first, fresh signed GET per r2 asset ----
// Filters: ?kind= &q= (label/service/ai_caption/tags) &job_id=
app.get('/api/vault', auth, async (c) => {
  const b = biz(c)
  const kind = (c.req.query('kind') || '').toString().trim()
  const search = (c.req.query('q') || '').toString().trim()
  const jobId = (c.req.query('job_id') || '').toString().trim()
  const params = [b]
  let where = `a.business_id=$1`
  if (kind && ASSET_KINDS.includes(kind)) { params.push(kind); where += ` and a.kind=$${params.length}` }
  if (jobId && /^\d+$/.test(jobId)) { params.push(Number(jobId)); where += ` and a.job_id=$${params.length}` }
  if (search) {
    params.push(`%${search}%`)
    where += ` and (coalesce(a.label,'') ilike $${params.length} or coalesce(a.service,'') ilike $${params.length}
      or coalesce(a.ai_caption,'') ilike $${params.length} or coalesce(a.tags::text,'') ilike $${params.length})`
  }
  const rows = (await q(`select a.id, a.kind, a.url, a.label, a.is_before, a.created_at,
      a.storage, a.r2_key, a.mime, a.bytes, a.duration_s, a.thumb_key, a.status,
      a.tags, a.vehicle_id, a.service, a.rating, a.ai_caption,
      a.job_id, a.customer_id,
      cu.name as customer,
      j.status as job_status, j.issue, j.ticket_tier,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from assets a
    left join jobs j on j.id=a.job_id and j.business_id=a.business_id
    left join customers cu on cu.id=a.customer_id and cu.business_id=a.business_id
    left join vehicles v on v.id=coalesce(a.vehicle_id, j.vehicle_id)
    where ${where}
    order by a.created_at desc`, params)).rows
  const haveR2 = !!r2Client()
  const assets = []
  for (const r of rows) {
    let preview_url = null, thumb_url = null
    if (r.storage === 'r2' && haveR2) {
      if (r.r2_key) preview_url = await signGet(r.r2_key)
      thumb_url = r.thumb_key ? await signGet(r.thumb_key) : preview_url
    } else if (r.storage !== 'r2') {
      preview_url = r.url   // paste-a-link assets resolve straight to the pasted URL
      thumb_url = r.url
    }
    assets.push({ ...r, preview_url, thumb_url })
  }
  const counts = (await q(`select kind, count(*)::int n from assets where business_id=$1 group by kind`, [b])).rows
  const by_kind = {}
  for (const r of counts) by_kind[r.kind] = r.n
  return c.json({ assets, total: assets.length, by_kind, storage_configured: haveR2 })
})

// ---- fresh presigned GET for opening/downloading the full asset ----
app.get('/api/assets/:id/url', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const row = (await q(`select id, storage, r2_key, url, mime from assets where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!row) return c.json({ error: 'not found' }, 404)
  if (row.storage !== 'r2') return c.json({ url: row.url, storage: row.storage })   // link assets: the pasted URL is the URL
  if (!r2Client()) return r2Down(c)
  if (!row.r2_key) return c.json({ error: 'asset has no r2 key' }, 409)
  const url = await signGet(row.r2_key)
  return c.json({ url, storage: 'r2', mime: row.mime || null, expires_in: GET_TTL })
})

// (Asset delete with R2 cleanup is handled by the upgraded POST /api/assets/:id/delete above.)

// ============================================================================
// CONTENT STUDIO Phase 2 — THE PIPELINE + the Claude-Code editing bridge.
// Raw footage -> pipeline pieces -> a finished, captioned post. Moving a piece
// into 'editing' (with source clips attached) auto-fires a 'content_edit' handoff
// carrying the clips' R2 keys + the brief; Claude Code pulls them, cuts with ffmpeg,
// uploads the result, and calls /edited to link it back + advance to 'ready'.
// Free AI (captions/hooks/hashtags) goes through the Cloudflare crm-api Worker —
// NEVER a paid LLM. If the Worker is unreachable, endpoints degrade gracefully.
// Tenant-scoped via biz(c). Flat price, no tax, trust>price, no dealers.
// ============================================================================
const PIPELINE_STAGES = STUDIO_STAGES   // the kanban lifecycle (declared up by the content routes)
const AI_WORKER_URL = process.env.AI_WORKER_URL || 'https://api.carswithfares.ca/triage'

// Call the FREE Workers-AI advisor over HTTPS (the /triage contract: {messages}->{reply}).
// Returns the reply string, or '' if the worker is unreachable/erroring (callers degrade).
async function askWorker(messages, ms = 12000) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    const res = await fetch(AI_WORKER_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messages }),
      signal: ctl.signal,
    }).finally(() => clearTimeout(t))
    if (!res.ok) return ''
    const j = await res.json().catch(() => ({}))
    return (j && typeof j.reply === 'string') ? j.reply.trim() : ''
  } catch (e) { console.error('[ai worker]', e.message); return '' }
}

// load a piece's attached source assets (with fresh signed thumbs where it's an r2 clip)
async function pieceAssets(b, contentId, withSigned = true) {
  const rows = (await q(`select a.id, a.kind, a.url, a.label, a.is_before, a.storage, a.r2_key,
      a.thumb_key, a.mime, a.bytes, a.duration_s, a.status, ca.role, ca.sort
    from content_assets ca
    join assets a on a.id=ca.asset_id and a.business_id=ca.business_id
    where ca.business_id=$1 and ca.content_id=$2
    order by ca.sort asc, ca.id asc`, [b, contentId])).rows
  const haveR2 = withSigned && !!r2Client()
  const out = []
  for (const r of rows) {
    let thumb_url = null
    if (r.storage === 'r2' && haveR2) thumb_url = r.thumb_key ? await signGet(r.thumb_key) : (r.r2_key ? await signGet(r.r2_key) : null)
    else if (r.storage !== 'r2') thumb_url = r.url
    out.push({ ...r, thumb_url })
  }
  return out
}

// ---- THE PIPELINE — content grouped by pipeline_stage (the kanban), each with sources + handoff status ----
app.get('/api/pipeline', auth, async (c) => {
  const b = biz(c)
  const rows = (await q(`select co.id, co.title, co.channel, co.status,
      coalesce(co.pipeline_stage,'idea') as pipeline_stage,
      co.caption, co.hook, co.hashtags, co.scheduled_for, co.source_note,
      co.edited_asset_id, coalesce(co.leads_attributed,0)::int as leads_attributed,
      co.url, co.posted_at, co.created_at,
      ea.r2_key as edited_r2_key, ea.thumb_key as edited_thumb_key, ea.storage as edited_storage, ea.url as edited_url,
      h.id as handoff_id, h.status as handoff_status,
      (select count(*)::int from content_assets ca where ca.content_id=co.id and ca.business_id=co.business_id) as source_count
    from content co
    left join assets ea on ea.id=co.edited_asset_id and ea.business_id=co.business_id
    left join handoffs h on h.business_id=co.business_id and h.kind='content_edit'
      and h.payload->>'content_id' = co.id::text
      and h.id = (select max(h2.id) from handoffs h2 where h2.business_id=co.business_id and h2.kind='content_edit' and h2.payload->>'content_id' = co.id::text)
    where co.business_id=$1
    order by co.created_at desc`, [b])).rows
  const haveR2 = !!r2Client()
  // Phase 3: per-channel posting rows ride along so the drawer can schedule + post without a refetch
  const postRows = (await q(`select content_id, channel, status, external_url, posted_at, reach, leads
      from content_posts where business_id=$1 order by id`, [b])).rows
  const postsByPiece = {}
  for (const pr of postRows) { (postsByPiece[pr.content_id] = postsByPiece[pr.content_id] || []).push(pr) }
  const stages = {}
  for (const s of PIPELINE_STAGES) stages[s] = []
  for (const r of rows) {
    const assets = await pieceAssets(b, r.id)
    let edited_url = null
    if (r.edited_asset_id) {
      if (r.edited_storage === 'r2' && haveR2) edited_url = r.edited_thumb_key ? await signGet(r.edited_thumb_key) : (r.edited_r2_key ? await signGet(r.edited_r2_key) : null)
      else if (r.edited_storage && r.edited_storage !== 'r2') edited_url = r.edited_url
    }
    const stage = PIPELINE_STAGES.includes(r.pipeline_stage) ? r.pipeline_stage : 'idea'
    stages[stage].push({ ...r, assets, edited_url, posts: postsByPiece[r.id] || [] })
  }
  const counts = {}
  for (const s of PIPELINE_STAGES) counts[s] = stages[s].length
  return c.json({ stages, order: PIPELINE_STAGES, counts, storage_configured: haveR2 })
})

// (Creating a piece is handled by the upgraded POST /api/content above — it now also
//  accepts pipeline_stage, hook, caption, hashtags, source_note, and asset_ids[].)

// ---- move a piece between stages; moving->'editing' WITH sources auto-fires a content_edit handoff ----
app.post('/api/content/:id/stage', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const stage = (d.stage || '').toString().trim()
  if (!PIPELINE_STAGES.includes(stage)) return c.json({ error: 'bad stage' }, 400)
  const piece = (await q(`select id, title, channel, hook, caption, source_note from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const legacyStatus = stage === 'posted' ? 'posted' : stage === 'scheduled' ? 'scheduled' : stage === 'idea' ? 'idea' : 'draft'
  await q(`update content set pipeline_stage=$1, status=$2${stage === 'posted' ? ', posted_at=coalesce(posted_at,now())' : ''} where id=$3 and business_id=$4`,
    [stage, legacyStatus, id, b])
  await q(`insert into activity (business_id,type,body) values ($1,'content',$2)`, [b, `"${piece.title}" → ${stage}`])

  let handoff = null
  if (stage === 'editing') {
    const sources = await pieceAssets(b, id, false)
    const asset_keys = sources.filter((s) => s.storage === 'r2' && s.r2_key).map((s) => s.r2_key)
    if (asset_keys.length) {
      // don't double-fire if there's already an open content_edit handoff for this piece
      const existing = (await q(`select id, status from handoffs where business_id=$1 and kind='content_edit'
          and payload->>'content_id'=$2::text and status<>'done' order by id desc limit 1`, [b, id])).rows[0]
      if (!existing) {
        const channel = piece.channel || 'reel'
        const brief = piece.source_note || piece.hook || `Cut "${piece.title}" into a ${channel} post in Fares' voice — trust>price, "we come to you", the "$X -> $Y" angle. Burn captions, 9:16, vertical, under 30s, end on the soft CTA.`
        const payload = { content_id: Number(id), asset_keys, brief, channel }
        const row = (await q(`insert into handoffs (business_id,kind,title,payload,status)
            values ($1,'content_edit',$2,$3::jsonb,'new')
            returning id, kind, title, payload, status, created_at`,
          [b, `Edit "${piece.title}" into a ${channel} post`, JSON.stringify(payload)])).rows[0]
        await q(`insert into activity (business_id,type,body) values ($1,'handoff',$2)`,
          [b, `Dispatched to Claude Code: edit "${piece.title}" (${asset_keys.length} clip${asset_keys.length === 1 ? '' : 's'})`])
        handoff = row
      } else handoff = existing
    }
  }
  return c.json({ ok: true, pipeline_stage: stage, handoff })
})

// ---- attach Vault assets as sources for a piece ----
app.post('/api/content/:id/assets', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const ids = Array.isArray(d.asset_ids) ? d.asset_ids : (d.asset_id != null ? [d.asset_id] : [])
  if (!ids.length) return c.json({ error: 'need asset_ids[]' }, 400)
  const role = (d.role || 'source').toString().trim() || 'source'
  // start sort after the current max so new attaches keep order
  const maxSort = (await q(`select coalesce(max(sort),-1)::int as m from content_assets where business_id=$1 and content_id=$2`, [b, id])).rows[0].m
  let sort = maxSort + 1, attached = 0
  for (const aid of ids) {
    const a = (await q(`select id from assets where id=$1 and business_id=$2`, [Number(aid), b])).rows[0]
    if (!a) continue
    const r = await q(`insert into content_assets (business_id,content_id,asset_id,role,sort) values ($1,$2,$3,$4,$5)
                       on conflict (content_id, asset_id, role) do nothing`, [b, id, a.id, role, sort++])
    if (r.rowCount) attached++
  }
  const assets = await pieceAssets(b, id)
  return c.json({ ok: true, attached, assets })
})

// ---- detach a source asset from a piece ----
app.delete('/api/content/:id/assets/:assetId', auth, async (c) => {
  const id = c.req.param('id'), assetId = c.req.param('assetId'), b = biz(c)
  const piece = (await q(`select id from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const r = await q(`delete from content_assets where business_id=$1 and content_id=$2 and asset_id=$3`, [b, id, assetId])
  if (!r.rowCount) return c.json({ error: 'not attached' }, 404)
  const assets = await pieceAssets(b, id)
  return c.json({ ok: true, assets })
})

// ---- AI: draft caption + hook + hashtags in Fares' voice (FREE Workers-AI). Degrades gracefully. ----
app.post('/api/content/:id/caption', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id, title, channel, hook, source_note from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  // gather context: piece title/angle + the source clips' captions/labels
  const sources = await pieceAssets(b, id, false)
  const clipNotes = sources.map((s) => s.label || s.kind).filter(Boolean).slice(0, 6).join(', ')
  const channel = (d.channel || piece.channel || 'instagram').toString().trim()
  const angle = (d.brief || piece.source_note || piece.hook || piece.title || '').toString().trim()
  const ask = `Write a ${channel} post for Cars With Fares, the trusted mobile mechanic in Mississauga & the GTA — "we come to you", trust over price, the honest "shop said $X, I did $Y at your door" angle (no exact prices, never "beat your quote", no dealer talk).
Job/footage: ${piece.title}${clipNotes ? ` (clips: ${clipNotes})` : ''}${angle ? `\nAngle: ${angle}` : ''}.
Reply ONLY as strict JSON, no markdown, exactly: {"hook":"<scroll-stopping first line>","caption":"<2-4 punchy sentences in Fares' voice, ends on a soft come-to-you CTA>","hashtags":["#tag", ...]}  (5-8 lowercase hashtags, GTA + automotive).`
  const reply = await askWorker([{ role: 'user', content: ask }])
  let parsed = null
  if (reply) {
    try {
      const m = reply.match(/\{[\s\S]*\}/)
      if (m) parsed = JSON.parse(m[0])
    } catch { parsed = null }
  }
  if (!parsed) {
    // graceful empty so the UI degrades — never 500 the editor
    return c.json({ ok: true, drafted: false, hook: null, caption: null, hashtags: [], note: 'AI is busy — type it yourself or try again.' })
  }
  const hook = (parsed.hook || '').toString().trim() || null
  const caption = (parsed.caption || '').toString().trim() || null
  const hashtags = Array.isArray(parsed.hashtags) ? parsed.hashtags.map((x) => String(x).trim()).filter(Boolean).slice(0, 8) : []
  if (d.save !== false) {
    await q(`update content set hook=coalesce($1,hook), caption=coalesce($2,caption), hashtags=$3::jsonb where id=$4 and business_id=$5`,
      [hook, caption, JSON.stringify(hashtags), id, b])
  }
  return c.json({ ok: true, drafted: true, hook, caption, hashtags })
})

// ---- Claude Code calls this after editing: link the finished cut + advance to 'ready' ----
app.post('/api/content/:id/edited', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id, title from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const assetId = Number(d.asset_id)
  if (!Number.isInteger(assetId)) return c.json({ error: 'need asset_id' }, 400)
  const asset = (await q(`select id from assets where id=$1 and business_id=$2`, [assetId, b])).rows[0]
  if (!asset) return c.json({ error: 'asset not found' }, 404)
  await q(`update content set edited_asset_id=$1, pipeline_stage='ready', status='draft' where id=$2 and business_id=$3`, [assetId, id, b])
  // mark the open content_edit handoff done if there is one
  const h = (await q(`select id from handoffs where business_id=$1 and kind='content_edit'
      and payload->>'content_id'=$2::text and status<>'done' order by id desc limit 1`, [b, id])).rows[0]
  if (h) await q(`update handoffs set status='done', result=$1, done_at=now() where id=$2 and business_id=$3`,
    [(d.result || 'Edited cut linked').toString(), h.id, b])
  await q(`insert into activity (business_id,type,body) values ($1,'content',$2)`, [b, `Claude Code finished the edit for "${piece.title}" → Ready`])
  return c.json({ ok: true, pipeline_stage: 'ready', edited_asset_id: assetId, handoff_done: h ? h.id : null })
})

// ============================================================================
// CONTENT STUDIO Phase 3 — SCHEDULING + ASSISTED POSTING + THE FUNNEL.
// Honest posting: NOT full IG/TikTok auto-posting (weeks of platform app review).
// Instead: schedule a piece -> a 'planned' content_posts row per channel -> a
// "post now" flow that copies the caption, opens the channel, and you mark it
// posted -> per-channel reach/leads tracking that powers the funnel. The 'social'
// activation gate (PLAYBOOKS.social) walks connecting YouTube + GBP first (lowest
// friction), API auto-post as the gated future. content_posts is the spine: one
// piece -> many channel posts -> reach -> leads -> (booked/revenue where attributable).
// Tenant-scoped via biz(c). Flat price, no tax, trust>price, $0 AI, no dealers.
// ============================================================================
const POST_CHANNELS = ['instagram', 'tiktok', 'youtube', 'gbp', 'facebook', 'reel']
const normChannels = (arr) => {
  const seen = new Set(), out = []
  for (const x of Array.isArray(arr) ? arr : []) {
    const ch = String(x || '').trim().toLowerCase()
    if (ch && POST_CHANNELS.includes(ch) && !seen.has(ch)) { seen.add(ch); out.push(ch) }
  }
  return out
}

// ---- schedule a piece: set scheduled_for, move to 'scheduled', upsert a planned post per channel ----
app.post('/api/content/:id/schedule', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id, title, channel from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const when = (d.scheduled_for || '').toString().trim()
  if (!when || isNaN(new Date(when).getTime())) return c.json({ error: 'need a valid scheduled_for' }, 400)
  // channels: explicit list, else the piece's own channel, else nothing planned (still schedules the piece)
  let channels = normChannels(d.channels)
  if (!channels.length && piece.channel) channels = normChannels([piece.channel])
  await q(`update content set scheduled_for=$1::timestamptz, pipeline_stage='scheduled', status='scheduled'
           where id=$2 and business_id=$3`, [when, id, b])
  // upsert a 'planned' content_posts row per channel (don't clobber one already posted)
  for (const ch of channels) {
    await q(`insert into content_posts (business_id,content_id,channel,status)
             values ($1,$2,$3,'planned')
             on conflict (content_id, channel) do update
               set status = case when content_posts.status='posted' then content_posts.status else 'planned' end`,
      [b, id, ch])
  }
  const when_h = new Date(when).toLocaleString('en-CA', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  await q(`insert into activity (business_id,type,body) values ($1,'content',$2)`,
    [b, `Scheduled "${piece.title}" → ${when_h}${channels.length ? ` on ${channels.join(', ')}` : ''}`])
  const posts = (await q(`select id, channel, status, external_url, posted_at, reach, leads
      from content_posts where business_id=$1 and content_id=$2 order by id`, [b, id])).rows
  return c.json({ ok: true, pipeline_stage: 'scheduled', scheduled_for: when, channels, posts })
})

// ---- mark a channel posted (assisted flow): flips its row 'posted'; all-posted advances the piece ----
app.post('/api/content/:id/post', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id, title from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const channel = String(d.channel || '').trim().toLowerCase()
  if (!POST_CHANNELS.includes(channel)) return c.json({ error: 'bad channel' }, 400)
  const externalUrl = (d.external_url || '').toString().trim() || null
  // upsert the channel's post row to 'posted' (handles posting a channel that was never planned)
  await q(`insert into content_posts (business_id,content_id,channel,status,external_url,posted_at)
           values ($1,$2,$3,'posted',$4,now())
           on conflict (content_id, channel) do update
             set status='posted', posted_at=coalesce(content_posts.posted_at,now()),
                 external_url=coalesce($4, content_posts.external_url)`,
    [b, id, channel, externalUrl])
  // when every planned/posted row for this piece is posted, advance the piece to 'posted'
  const tally = (await q(`select count(*)::int as total, count(*) filter (where status='posted')::int as posted
      from content_posts where business_id=$1 and content_id=$2`, [b, id])).rows[0]
  const allPosted = tally.total > 0 && tally.posted === tally.total
  if (allPosted) {
    await q(`update content set pipeline_stage='posted', status='posted', posted_at=coalesce(posted_at,now())
             where id=$1 and business_id=$2`, [id, b])
  }
  await q(`insert into activity (business_id,type,body) values ($1,'content',$2)`,
    [b, `Posted "${piece.title}" on ${channel}${allPosted ? ' — piece is now live' : ` (${tally.posted}/${tally.total} channels)`}`])
  const posts = (await q(`select id, channel, status, external_url, posted_at, reach, leads
      from content_posts where business_id=$1 and content_id=$2 order by id`, [b, id])).rows
  return c.json({ ok: true, channel, all_posted: allPosted, pipeline_stage: allPosted ? 'posted' : 'scheduled', posts })
})

// ---- manual per-channel metrics (reach / leads) — the funnel reads these ----
app.post('/api/content/:id/metrics', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const piece = (await q(`select id, title from content where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!piece) return c.json({ error: 'not found' }, 404)
  const channel = String(d.channel || '').trim().toLowerCase()
  if (!POST_CHANNELS.includes(channel)) return c.json({ error: 'bad channel' }, 400)
  const reach = d.reach != null ? Math.max(0, Math.round(Number(d.reach) || 0)) : null
  const leads = d.leads != null ? Math.max(0, Math.round(Number(d.leads) || 0)) : null
  if (reach == null && leads == null) return c.json({ error: 'need reach or leads' }, 400)
  // ensure the row exists (metrics can land before a manual "post now"), then patch only what's given
  await q(`insert into content_posts (business_id,content_id,channel,status) values ($1,$2,$3,'planned')
           on conflict (content_id, channel) do nothing`, [b, id, channel])
  await q(`update content_posts set reach=coalesce($1,reach), leads=coalesce($2,leads)
           where business_id=$3 and content_id=$4 and channel=$5`, [reach, leads, b, id, channel])
  const row = (await q(`select id, channel, status, reach, leads from content_posts
      where business_id=$1 and content_id=$2 and channel=$3`, [b, id, channel])).rows[0]
  return c.json({ ok: true, post: row })
})

// ---- CONTENT CALENDAR — scheduled pieces grouped by day, for the Calendar's Content toggle ----
// Same window contract as /api/calendar (?from= &days=). Each day: pieces with title,
// channel(s), stage, and a signed thumb of the edited cut (or first source) for the chip.
app.get('/api/calendar/content', auth, async (c) => {
  const b = biz(c)
  const fromRaw = (c.req.query('from') || '').toString().trim()
  const days = Math.max(1, Math.min(31, Number(c.req.query('days')) || 14))
  const from = /^\d{4}-\d{2}-\d{2}$/.test(fromRaw) ? fromRaw : new Date().toISOString().slice(0, 10)
  const rows = (await q(`select co.id, co.title, co.pipeline_stage, co.channel, co.scheduled_for,
      co.edited_asset_id,
      ea.storage as edited_storage, ea.r2_key as edited_r2_key, ea.thumb_key as edited_thumb_key, ea.url as edited_url,
      (select array_agg(cp.channel order by cp.channel) from content_posts cp
         where cp.business_id=co.business_id and cp.content_id=co.id) as post_channels,
      (select count(*)::int from content_posts cp where cp.business_id=co.business_id and cp.content_id=co.id and cp.status='posted') as posted_count
    from content co
    left join assets ea on ea.id=co.edited_asset_id and ea.business_id=co.business_id
    where co.business_id=$1 and co.scheduled_for is not null
      and co.scheduled_for >= $2::date and co.scheduled_for < ($2::date + $3::int)
    order by co.scheduled_for asc, co.id asc`, [b, from, days])).rows
  const haveR2 = !!r2Client()
  // resolve a thumb per piece: edited cut's poster, else first source asset's thumb
  const byDay = {}
  for (const r of rows) {
    let thumb_url = null
    if (r.edited_asset_id) {
      if (r.edited_storage === 'r2' && haveR2) thumb_url = r.edited_thumb_key ? await signGet(r.edited_thumb_key) : (r.edited_r2_key ? await signGet(r.edited_r2_key) : null)
      else if (r.edited_storage && r.edited_storage !== 'r2') thumb_url = r.edited_url
    }
    if (!thumb_url) {
      const srcs = await pieceAssets(b, r.id)
      const firstThumb = srcs.find((s) => s.thumb_url)
      if (firstThumb) thumb_url = firstThumb.thumb_url
    }
    const channels = Array.isArray(r.post_channels) && r.post_channels.length ? r.post_channels : (r.channel ? [r.channel] : [])
    const key = new Date(r.scheduled_for).toISOString().slice(0, 10)
    if (!byDay[key]) byDay[key] = []
    byDay[key].push({
      id: r.id, title: r.title, stage: r.pipeline_stage || 'scheduled',
      channels, posted_count: r.posted_count || 0, thumb_url,
      scheduled_for: r.scheduled_for,
    })
  }
  const start = new Date(from + 'T00:00:00.000Z')
  const grid = []
  for (let i = 0; i < days; i++) {
    const dd = new Date(start.getTime() + i * 86400000)
    const key = dd.toISOString().slice(0, 10)
    const pieces = byDay[key] || []
    grid.push({ date: key, dow: dd.getUTCDay(), pieces, count: pieces.length })
  }
  const summary = { from, days, total: rows.length, open_days: grid.filter((g) => !g.count).length }
  return c.json({ grid, summary })
})

// ---- THE CONTENT FUNNEL — Posts -> Reach -> Leads -> (Booked/Revenue), per channel + $/post ----
// Honest where data is thin: zeros, not invented numbers. Lead count = per-channel content_posts.leads
// (single source of truth — no double-count). Legacy piece-level content.leads_attributed is surfaced
// read-only as totals.legacy_leads, never folded into the headline `leads`.
// Booked/revenue ties leads to paid jobs sourced from content (jobs.source like 'website%'/'content%')
// — attributable but coarse, flagged as such so he reads it honestly.
app.get('/api/funnel', auth, async (c) => {
  const b = biz(c)
  // per-channel posting + reach + the new per-channel leads
  const perChannel = (await q(`select channel,
      count(*) filter (where status='posted')::int as posts,
      count(*) filter (where status='planned')::int as planned,
      coalesce(sum(reach),0)::int as reach,
      coalesce(sum(leads),0)::int as post_leads
    from content_posts where business_id=$1 group by channel`, [b])).rows
  // legacy piece-level attribution (sum of content.leads_attributed) — kept honest as its own line
  const legacy = (await q(`select coalesce(sum(leads_attributed),0)::int as n,
      count(*) filter (where pipeline_stage='posted' or status='posted')::int as posted_pieces,
      count(*)::int as pieces
    from content where business_id=$1`, [b])).rows[0]
  // revenue attributable to content: paid jobs whose source traces to the content funnel
  const contentRev = (await q(`select count(*) filter (where status='paid')::int as paid_jobs,
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue
    from jobs where business_id=$1 and source ~* 'content|website:ai|website:triage|instagram|tiktok|youtube|social'`, [b])).rows[0]
  const channels = perChannel.map((r) => ({
    channel: r.channel,
    posts: r.posts || 0,
    planned: r.planned || 0,
    reach: r.reach || 0,
    leads: r.post_leads || 0,
    cost_per_post: 0,                          // organic — $0; column exists so the UI can show $/post honestly
  })).sort((a, z) => z.posts - a.posts || z.reach - a.reach)
  // SINGLE SOURCE OF TRUTH for leads = per-channel content_posts.leads (no double-count).
  // legacy content.leads_attributed is surfaced read-only as `legacy_leads`, never folded into `leads`.
  const channelPostLeads = channels.reduce((s, r) => s + r.leads, 0)
  const totalLeads = channelPostLeads
  const totals = {
    posts: channels.reduce((s, r) => s + r.posts, 0),
    planned: channels.reduce((s, r) => s + r.planned, 0),
    reach: channels.reduce((s, r) => s + r.reach, 0),
    channel_leads: channelPostLeads,
    legacy_leads: legacy.n || 0,   // read-only piece-level attribution (pre-Phase-3) — NOT in `leads`
    leads: totalLeads,
    posted_pieces: legacy.posted_pieces || 0,
    pieces: legacy.pieces || 0,
    booked: contentRev.paid_jobs || 0,
    revenue: contentRev.revenue || 0,
    revenue_per_post: 0,
  }
  totals.revenue_per_post = totals.posts ? Math.round(totals.revenue / totals.posts) : 0
  // honest read of whether the chain has real signal yet
  const has_reach = totals.reach > 0
  const has_revenue = totals.revenue > 0
  return c.json({
    funnel: [
      { stage: 'Posts', value: totals.posts },
      { stage: 'Reach', value: totals.reach },
      { stage: 'Leads', value: totals.leads },
      { stage: 'Booked', value: totals.booked },
      { stage: 'Revenue', value: totals.revenue, money: true },
    ],
    channels, totals,
    honest: { has_reach, has_revenue, note: has_reach ? null : 'Reach/leads are entered by hand on each post — add a couple and this chain fills in.' },
  })
})

// ===================== LEAD SCOUT → OPPORTUNITIES =====================
// Reddit intercepts (scored + AI-drafted in the crm-api Worker) become a worked pipeline here.
// The Worker owns the 30-min scan + the free AI; this server pulls the persisted hits
// service-to-service (X-Scout-Key) and tracks Fares' worked state in Postgres.
const SCOUT_FEED_URL  = process.env.SCOUT_FEED_URL  || 'https://api.carswithfares.ca/scout/hits'
const SCOUT_DRAFT_URL = process.env.SCOUT_DRAFT_URL || 'https://api.carswithfares.ca/scout/draft-test'
const SCOUT_FEED_KEY  = process.env.SCOUT_FEED_KEY  || ''

async function scoutFetch(url, opts = {}, ms = 12000) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), ms)
    const res = await fetch(url, {
      ...opts,
      headers: { 'content-type': 'application/json', 'X-Scout-Key': SCOUT_FEED_KEY, ...(opts.headers || {}) },
      signal: ctl.signal,
    }).finally(() => clearTimeout(t))
    if (!res.ok) { console.error('[scout] fetch', url, res.status); return null }
    return await res.json().catch(() => null)
  } catch (e) { console.error('[scout]', e.message); return null }
}

// Pull the worker's persisted hits and upsert into opportunities. Dedupe by external_id;
// NEVER overwrite Fares' worked state (status/notes). Defensive per-row so one bad row or a
// missing table never aborts the batch. Returns counts for the refresh button.
async function syncOpportunities(b = 1) {
  const j = await scoutFetch(SCOUT_FEED_URL)
  const hits = j && Array.isArray(j.hits) ? j.hits : []
  let upserted = 0, fresh = 0
  for (const h of hits) {
    const ext = (h.id || '').toString().trim()
    if (!ext) continue
    const tags = Array.isArray(h.tags) ? h.tags : []
    let r
    try {
      r = await q(
        `insert into opportunities
           (business_id, source, external_id, subreddit, link, title, score, tags, ai_draft, posted_at, status)
         values ($1,'scout',$2,$3,$4,$5,$6,$7::jsonb,$8,$9,'new')
         on conflict (business_id, external_id) do update set
           subreddit = excluded.subreddit, link = excluded.link, title = excluded.title,
           score = excluded.score, tags = excluded.tags,
           ai_draft = coalesce(opportunities.ai_draft, excluded.ai_draft),
           updated_at = now()
         returning (xmax = 0) as inserted`,
        [b, ext, h.subreddit || null, h.link || null, h.title || null,
         Number(h.score) || 0, JSON.stringify(tags), h.draft || null,
         h.created_utc ? new Date(h.created_utc * 1000).toISOString() : null]
      )
    } catch (e) { console.error('[scout] upsert', e.message); continue }
    upserted++
    if (r.rows[0] && r.rows[0].inserted) {
      fresh++
      try { await q(`insert into activity (business_id,type,body) values ($1,'scout',$2)`, [b, `New opportunity: ${(h.title || 'Reddit lead').slice(0, 80)}`]) } catch (e) {}
    }
  }
  return { fetched: hits.length, upserted, fresh }
}

// GET /api/opportunities — ranked board (worked-stage, then score, then recency), filterable, with live counts.
app.get('/api/opportunities', auth, async (c) => {
  const b = biz(c)
  const status = (c.req.query('status') || '').toString().trim()
  const tag = (c.req.query('tag') || '').toString().trim()
  const params = [b]
  let where = `o.business_id=$1 and o.status <> 'dismissed'`
  if (status === 'dismissed') where = `o.business_id=$1 and o.status='dismissed'`
  else if (status) { params.push(status); where += ` and o.status=$${params.length}` }
  if (tag) { params.push(tag); where += ` and o.tags ? $${params.length}` }
  try {
    const rows = (await q(
      `select o.id, o.source, o.external_id, o.subreddit, o.link, o.title, o.score, o.tags,
              o.ai_draft, o.status, o.notes, o.posted_at, o.created_at, o.updated_at
       from opportunities o where ${where}
       order by case o.status when 'new' then 0 when 'replied' then 1 when 'engaged' then 2 when 'won' then 3 else 4 end,
                o.score desc nulls last, coalesce(o.posted_at, o.created_at) desc`, params)).rows
    const counts = (await q(
      `select
         count(*) filter (where status <> 'dismissed')::int as all,
         count(*) filter (where status='new')::int as new,
         count(*) filter (where status='replied')::int as replied,
         count(*) filter (where status='engaged')::int as engaged,
         count(*) filter (where status='won')::int as won,
         count(*) filter (where status='dismissed')::int as dismissed,
         count(*) filter (where status <> 'dismissed' and tags ? 'HIGH-TICKET')::int as high_ticket,
         count(*) filter (where status <> 'dismissed' and tags ? 'HAS QUOTE')::int as has_quote,
         count(*) filter (where status <> 'dismissed' and tags ? 'WANTS MECHANIC')::int as wants_mechanic
       from opportunities where business_id=$1`, [b])).rows[0]
    return c.json({ opportunities: rows, counts })
  } catch (e) { console.error('[opps] list', e.message); return c.json({ opportunities: [], counts: {} }) }
})

// PATCH /api/opportunities/:id — worked state (status / notes / edited draft).
app.patch('/api/opportunities/:id', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c), d = await c.req.json().catch(() => ({}))
  const ALLOWED = ['new', 'replied', 'engaged', 'won', 'dismissed']
  const sets = [], vals = []
  if (d.status !== undefined) {
    if (!ALLOWED.includes(d.status)) return c.json({ error: 'bad status' }, 400)
    vals.push(d.status); sets.push(`status=$${vals.length}`)
  }
  for (const k of ['notes', 'ai_draft']) if (d[k] !== undefined) { vals.push(d[k]); sets.push(`${k}=$${vals.length}`) }
  if (!sets.length) return c.json({ error: 'nothing to update' }, 400)
  sets.push(`updated_at=now()`)
  vals.push(id, b)
  const r = await q(`update opportunities set ${sets.join(', ')} where id=$${vals.length - 1} and business_id=$${vals.length} returning id, title`, vals)
  if (!r.rowCount) return c.json({ error: 'not found' }, 404)
  if (d.status) { try { await q(`insert into activity (business_id,type,body) values ($1,'scout',$2)`, [b, `Opportunity → ${d.status}: ${(r.rows[0].title || '').slice(0, 70)}`]) } catch (e) {} }
  // Won → auto-create a source='scout' job so Scout revenue shows up in Numbers/Money (closes the loop).
  let job_id = null
  if (d.status === 'won') {
    try {
      const o = (await q(`select title, link, subreddit, job_id from opportunities where id=$1 and business_id=$2`, [id, b])).rows[0]
      if (o && !o.job_id) {
        const cust = (await q(`insert into customers (business_id,name,source) values ($1,$2,'scout') returning id`, [b, `Reddit lead — r/${o.subreddit || 'scout'}`])).rows[0]
        const issue = `${(o.title || 'Reddit lead').slice(0, 180)}${o.link ? ' — ' + o.link : ''}`
        const tier = tierOf(issue, null)
        const job = (await q(`insert into jobs (business_id,customer_id,status,issue,is_high_ticket,ticket_tier,source) values ($1,$2,'lead',$3,$4,$5,'scout') returning id`, [b, cust.id, issue, tier === 'HIGH', tier])).rows[0]
        await q(`update opportunities set job_id=$1 where id=$2 and business_id=$3`, [job.id, id, b])
        await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'system','Won from Lead Scout (Reddit) — fill in contact + quote')`, [b, job.id])
        job_id = job.id
      } else if (o) job_id = o.job_id
    } catch (e) { console.error('[opps] won-convert', e.message) }
  }
  return c.json({ ok: true, job_id })
})

// POST /api/opportunities/:id/regenerate — redraft the reply via the worker, persist it.
app.post('/api/opportunities/:id/regenerate', auth, async (c) => {
  const id = c.req.param('id'), b = biz(c)
  const o = (await q(`select title, subreddit, ai_draft from opportunities where id=$1 and business_id=$2`, [id, b])).rows[0]
  if (!o) return c.json({ error: 'not found' }, 404)
  const body = await c.req.json().catch(() => ({}))
  const j = await scoutFetch(SCOUT_DRAFT_URL, { method: 'POST', body: JSON.stringify({ title: o.title || '', selftext: body.selftext || '', subreddit: o.subreddit || '' }) })
  const draft = j && typeof j.draft === 'string' ? j.draft.trim() : ''
  if (!draft) return c.json({ error: 'draft service unavailable' }, 502)
  await q(`update opportunities set ai_draft=$1, updated_at=now() where id=$2 and business_id=$3`, [draft, id, b])
  return c.json({ ok: true, draft })
})

// POST /api/opportunities/refresh — pull fresh intercepts from Scout right now.
app.post('/api/opportunities/refresh', auth, async (c) => {
  const r = await syncOpportunities(biz(c))
  return c.json({ ok: true, ...r })
})
// =====================================================================

// ---- boot ----
await applySchema().catch((e) => console.error('schema bootstrap error:', e))
await seedIfEmpty()

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (i) => console.log(`command-center listening on :${i.port}`))

// ---- Lead Scout poll: pull new intercepts every 15 min (the worker scans Reddit every 30) ----
cron.schedule('*/15 * * * *', async () => {
  try {
    const r = await syncOpportunities(1)
    if (r.fresh) console.log(`[cron scout] +${r.fresh} new (${r.upserted} upserted)`)
  } catch (e) { console.error('[cron scout]', e.message) }
}, { timezone: 'America/Toronto' })
// warm pull a few seconds after boot so the board isn't empty on a cold start
setTimeout(() => { syncOpportunities(1).catch(() => {}) }, 8000)
