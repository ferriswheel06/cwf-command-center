// Cars With Fares — Command Center API (Railway + Postgres)
// Free AI stays on the Cloudflare crm-api Worker (env.AI only lives there); we call it over HTTPS.
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createHash } from 'node:crypto'
import jwt from 'jsonwebtoken'
import pg from 'pg'
import { applySchema } from './db/apply-schema.js'

const { Pool } = pg
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Railway internal networking needs no SSL; external/public URLs do.
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
})
export const q = (text, params) => pool.query(text, params)

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me'
const AI_URL = (process.env.AI_SERVICE_URL || 'https://api.carswithfares.ca').replace(/\/$/, '')

// --- free AI bridge → Cloudflare Workers-AI service ---
export async function aiCall(path, body) {
  const r = await fetch(`${AI_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!r.ok) throw new Error(`AI bridge ${path} -> ${r.status}`)
  return r.json()
}

const app = new Hono()
app.use('*', cors())

// --- health (also confirms DB is reachable) ---
app.get('/health', async (c) => {
  try { await q('select 1'); return c.json({ ok: true, db: 'up' }) }
  catch (e) { return c.json({ ok: false, db: 'down', error: String(e) }, 500) }
})

// --- auth: single-password login -> 7-day JWT carrying business_id ---
app.post('/api/login', async (c) => {
  const { password } = await c.req.json().catch(() => ({}))
  const hash = createHash('sha256').update(password || '').digest('hex')
  if (!process.env.PASSWORD_HASH || hash !== process.env.PASSWORD_HASH.trim())
    return c.json({ error: 'wrong password' }, 401)
  const token = jwt.sign({ business_id: 1, sub: 'fares' }, JWT_SECRET, { expiresIn: '7d' })
  return c.json({ token })
})

const auth = async (c, next) => {
  const h = c.req.header('authorization') || ''
  const token = h.startsWith('Bearer ') ? h.slice(7) : null
  try { c.set('claims', jwt.verify(token, JWT_SECRET)) }
  catch { return c.json({ error: 'unauthorized' }, 401) }
  await next()
}
// every tenant-scoped query passes through this
export const biz = (c) => c.get('claims').business_id

app.get('/api/me', auth, (c) => c.json({ business_id: biz(c) }))

// --- Phase 1 module routers (built next) ---
// app.route('/api/today',  todayRouter)   // morning home + AI briefing
// app.route('/api/jobs',   jobsRouter)    // pipeline board + detail drawer + speed-to-lead
// app.route('/api/leads',  leadsRouter)   // intake + paste/voice capture (dedup-safe)
// app.route('/api/tasks',  tasksRouter)   // un-droppable follow-up engine
// app.route('/api/money',  moneyRouter)   // Targets funnel board
// app.route('/api/ai',     aiRouter)      // score / draft / briefing via aiCall()

// initialize the database on boot (idempotent; waits for Postgres on first deploy)
await applySchema().catch((e) => console.error('schema bootstrap error:', e))

const port = Number(process.env.PORT) || 3000
serve({ fetch: app.fetch, port }, (i) => console.log(`command-center listening on :${i.port}`))
