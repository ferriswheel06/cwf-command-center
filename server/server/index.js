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
const AI_URL = (process.env.AI_SERVICE_URL || 'https://api.carswithfares.ca').replace(/\/$/, '')

export async function aiCall(path, body) {
  const r = await fetch(`${AI_URL}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  if (!r.ok) throw new Error(`AI bridge ${path} -> ${r.status}`)
  return r.json()
}

// Seed the 2 real jobs the first time (idempotent — only if the pipeline is empty).
async function seedIfEmpty() {
  try {
    const { rows } = await q('select count(*)::int as n from jobs')
    if (rows[0].n > 0) return
    const rob = (await q(`insert into customers (business_id,name,location,source) values (1,$1,$2,'referral') returning id`, ['Rob', 'Mississauga'])).rows[0]
    const robV = (await q(`insert into vehicles (business_id,customer_id,notes) values (1,$1,'Suspension') returning id`, [rob.id])).rows[0]
    await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,service,source,charge,est_value,is_high_ticket,first_contact_at,paid_at,created_at)
             values (1,$1,$2,'paid','Full suspension refresh','Suspension','referral',1400,1400,true,now(),timestamptz '2026-05-30',timestamptz '2026-05-28')`, [rob.id, robV.id])
    const geo = (await q(`insert into customers (business_id,name,location,source) values (1,$1,$2,'referral') returning id`, ['George (Brothers Deals On Wheels)', 'Oakville'])).rows[0]
    const geoV = (await q(`insert into vehicles (business_id,customer_id,make,model,notes) values (1,$1,'Ram','2500','Diesel service') returning id`, [geo.id])).rows[0]
    await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,service,source,charge,est_value,is_high_ticket,first_contact_at,paid_at,created_at)
             values (1,$1,$2,'paid','Ram 2500 diesel service','Diesel service','referral',450,450,false,now(),timestamptz '2026-03-22',timestamptz '2026-03-20')`, [geo.id, geoV.id])
    console.log('[seed] inserted 2 real jobs ✓')
  } catch (e) { console.error('[seed] failed:', e.message) }
}

const app = new Hono()
app.use('/api/*', cors())

// ---- static cockpit UI ----
app.get('/', serveStatic({ path: './web/index.html' }))
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

// ---- TODAY ----
app.get('/api/today', auth, async (c) => {
  const b = biz(c)
  const stats = (await q(`select
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue,
      count(*) filter (where status='paid')::int as paid_jobs,
      count(*) filter (where status='lead')::int as new_leads
    from jobs where business_id=$1`, [b])).rows[0]
  stats.avg_ticket = stats.paid_jobs ? Math.round(stats.revenue / stats.paid_jobs) : 0
  const targets = (await q(`select value from settings where business_id=$1 and key='targets'`, [b])).rows[0]?.value || {}
  const leads = (await q(`select j.id, c.name, j.issue, j.est_value, j.ai_score, j.ai_band, j.created_at, j.first_contact_at
      from jobs j join customers c on c.id=j.customer_id
      where j.business_id=$1 and j.status='lead' order by j.created_at desc`, [b])).rows
  return c.json({ stats, targets, leads })
})

// ---- PIPELINE ----
app.get('/api/jobs', auth, async (c) => {
  const rows = (await q(`select j.id, j.status, j.issue, j.service, j.charge, j.est_value, j.ai_score, j.ai_band,
      j.is_high_ticket, j.first_contact_at, j.created_at, c.name as customer, c.location,
      nullif(trim(concat_ws(' ', v.year::text, v.make, v.model)),'') as vehicle
    from jobs j join customers c on c.id=j.customer_id left join vehicles v on v.id=j.vehicle_id
    where j.business_id=$1 order by j.created_at desc`, [biz(c)])).rows
  return c.json({ jobs: rows })
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

// ---- create lead ----
app.post('/api/leads', auth, async (c) => {
  const b = biz(c), d = await c.req.json().catch(() => ({}))
  if (!d.name && !d.phone) return c.json({ error: 'need a name or phone' }, 400)
  const norm = d.phone ? String(d.phone).replace(/\D/g, '').slice(-10) : null
  let cust = norm ? (await q(`select id from customers where business_id=$1 and phone_normalized=$2`, [b, norm])).rows[0] : null
  if (!cust) cust = (await q(`insert into customers (business_id,name,phone,phone_normalized,location,source) values ($1,$2,$3,$4,$5,'manual') returning id`,
    [b, d.name || null, d.phone || null, norm, d.location || null])).rows[0]
  let vId = null
  if (d.vehicle) vId = (await q(`insert into vehicles (business_id,customer_id,notes) values ($1,$2,$3) returning id`, [b, cust.id, d.vehicle])).rows[0].id
  const est = d.est_value ? Number(String(d.est_value).replace(/[^\d.]/g, '')) : null
  const job = (await q(`insert into jobs (business_id,customer_id,vehicle_id,status,issue,est_value,is_high_ticket,source) values ($1,$2,$3,'lead',$4,$5,$6,'manual') returning id`,
    [b, cust.id, vId, d.issue || null, est, est != null && est >= 700])).rows[0]
  await q(`insert into activity (business_id,job_id,type,body) values ($1,$2,'system','Lead created')`, [b, job.id])
  return c.json({ id: job.id })
})

// ---- MONEY ----
app.get('/api/money', auth, async (c) => {
  const b = biz(c)
  const m = (await q(`select
      coalesce(sum(charge) filter (where status='paid'),0)::float as revenue,
      count(*) filter (where status='paid')::int as paid,
      count(*) filter (where status='lead')::int as leads,
      count(*) filter (where status in ('quoted','scheduled','in_progress'))::int as active,
      count(*) filter (where status='lost')::int as lost
    from jobs where business_id=$1`, [b])).rows[0]
  const targets = (await q(`select value from settings where business_id=$1 and key='targets'`, [b])).rows[0]?.value || {}
  m.avg_ticket = m.paid ? Math.round(m.revenue / m.paid) : 0
  return c.json({ ...m, targets })
})

// ---- boot ----
await applySchema().catch((e) => console.error('schema bootstrap error:', e))
await seedIfEmpty()

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (i) => console.log(`command-center listening on :${i.port}`))
