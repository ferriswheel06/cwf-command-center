// Idempotent DB bootstrap — runs on every boot.
// First deploy: waits for Postgres to come up, then applies the schema + seeds.
// Later boots: detects the schema is present and skips.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import pg from 'pg'

const { Pool } = pg
const here = dirname(fileURLToPath(import.meta.url))

export async function applySchema() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  })
  try {
    // Postgres may still be booting on the first deploy — wait for it.
    let up = false
    for (let i = 0; i < 20 && !up; i++) {
      try { await pool.query('select 1'); up = true }
      catch { await new Promise((r) => setTimeout(r, 3000)) }
    }
    if (!up) { console.error('[schema] DB not reachable after ~60s — skipping'); return }

    const present = await pool.query("select to_regclass('public.businesses') as t")
    if (present.rows[0].t) { console.log('[schema] already applied — skipping'); return }

    const sql = readFileSync(join(here, '..', '..', 'db', 'schema.sql'), 'utf8')
    await pool.query(sql)
    console.log('[schema] applied + seeded ✓')
  } catch (e) {
    console.error('[schema] apply failed:', e.message)
  } finally {
    await pool.end()
  }
}
