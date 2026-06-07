# Cars With Fares — Command Center

The one screen to run the business. Rebuilt per `strategy/command-center-blueprint.md`.

- **Host:** Railway (app + Postgres + cron in one project)
- **AI:** free, via the Cloudflare `crm-api` Worker (`env.AI` Workers AI only lives on CF) — called over HTTPS by this app
- **Alerts:** existing Telegram lead-alert bot (kept)
- **Marketing site:** stays on Cloudflare Pages (untouched)

## Structure
```
command-center/
  db/schema.sql        # Postgres schema (multi-tenant-ready: business_id everywhere)
  server/index.js      # Hono API — auth, health, AI bridge, module routers
  server/db/           # schema apply + queries (built next)
  web/                 # vanilla componentized SPA cockpit (built next)
  package.json
  .env.example
```

## Deploy (one-time setup — Fares does 3 things, Nyx does the rest)
1. Create a [Railway](https://railway.app) account.
2. **New Project → add a PostgreSQL database** (one click — Railway auto-injects `DATABASE_URL`).
3. **Project Settings → Tokens → create a token** and hand it over.

Then (automated from desk):
```
railway up                         # deploy the app service
railway run psql $DATABASE_URL -f db/schema.sql   # load the schema
# set JWT_SECRET, PASSWORD_HASH, TELEGRAM_* vars
```

## Phase 1 scope
PIPELINE (rebuilt CRM) · TODAY (home + AI briefing) · speed-to-lead clock · un-droppable follow-up engine · paste/voice → AI lead · AI scoring at intake · $1K profit-floor quote guard · MONEY (Targets board) · Reddit Lead Radar (free background worker). Full detail + the deliberately-deferred list: `strategy/command-center-blueprint.md`.
