# sportsex

A virtual stock market for EPL players and teams. Buy and sell shares in players and teams with in-app coins — values move with on-pitch performance and real trading pressure.

See [AGENTS.md](AGENTS.md) for the full spec and dev guide. This README covers how to run, how to sync real match data, and what's been built.

## Quickstart

Requires Node 20+ and pnpm.

```bash
cd apps/web
pnpm install
pnpm exec prisma db push
pnpm db:seed           # loads ~560 EPL players + 21 teams from the 24/25 CSVs in repo root
pnpm dev               # http://localhost:3000
```

## What's live in v1

- **Auth**: email + password (NextAuth credentials provider). OAuth env vars stubbed for Google/Apple.
- **10,000 coin starting balance** on first signup, plus a +500 coin onboarding bonus for picking 3 players to follow.
- **Pages**: home (hero, top movers, top performers), `/players`, `/players/[id]`, `/teams`, `/teams/[id]`, `/portfolio`, `/leaderboard` (global + private groups), `/friends`, `/quests`, `/predictions`, `/onboarding`, `/admin/moderate`.
- **Trading**: `POST /api/orders` — buy/sell shares of players or teams. Enforces a 1s cooldown, max 5% of float per order, and a 2,000 share position cap per asset.
- **Tick pricing**: every trade refreshes the asset's price via a 24h net-buys demand multiplier.
- **Match settlement**: `POST /api/admin/simulate-match` (header `x-admin-token`) simulates a match between two teams, or settles an existing scheduled match by ID. Distributes goals/assists, applies the pricing algorithm, and resolves any outstanding predictions.
- **Real match sync**: `sync-matches.ts` hits the football-data.org free API and settles all finished PL matches. Prices move on win/draw/loss result; goals/assists come from `update-player-stats.ts`.
- **Comments** on player pages, with word-list moderation flagging, a report button, and a `/admin/moderate` queue.
- **Quests**: daily login, place a trade, comment on a player — each grants coins.
- **Predictions**: stake coins on match results; payouts resolve automatically when the match settles.
- **Friends** and **private leaderboards** with join codes.
- **CI**: GitHub Actions runs typecheck, ESLint, and 119 Vitest tests against a Postgres service container on every push/PR.

## Pricing algorithm

The entire v1 algorithm lives in [`apps/web/src/lib/pricing.ts`](apps/web/src/lib/pricing.ts). Swap that file to change pricing without touching anything else. See AGENTS.md §4 for the formulas.

## Syncing real match data (25/26 season)

These jobs require `FOOTBALL_DATA_API_KEY` in `apps/web/.env` (free at football-data.org).

### 1. Settle finished matches (prices move on result)

```bash
cd apps/web
npx tsx --env-file=.env src/jobs/sync-matches.ts
```

Fetches all finished PL matches, upserts them into `Match`, applies win/draw/loss price deltas to every player on each squad, and recomputes team prices. Idempotent — already-settled matches are skipped.

### 2. Import 25/26 player stats (goals, assists, minutes)

```bash
# Step 1: scrape the stats CSV
python3 apps/jobs/epl_2526_fbref_scrape.py   # writes epl_player_stats_25_26.csv

# Step 2: import into DB (creates missing players automatically)
cd apps/web
npx tsx --env-file=.env src/jobs/update-player-stats.ts
```

Matches players by canonical name. New players not yet in the DB (transfers, call-ups) are created automatically with a seed valuation.

### 3. Add promoted teams

```bash
cd apps/web
npx tsx --env-file=.env src/jobs/add-promoted-teams.ts
```

Fetches the current PL team list from football-data.org, adds any promoted clubs (Leeds, Burnley, Sunderland for 25/26) and their squads, and seeds initial valuations. Run before `sync-matches.ts` when the promoted teams aren't yet in the DB.

### 4. Patch missing minutes

If players have appearances but `minutes = 0`, estimate from appearances × 75:

```bash
npx tsx --env-file=.env src/jobs/patch-minutes.ts
```

### 5. Recompute season totals from match stats

After a full sync, recalculate player season aggregates from `PlayerMatchStat` rows (zeroes out players with no appearances):

```bash
npx tsx --env-file=.env src/jobs/recalc-stats.ts
```

### 6. Reset and re-sync from scratch

Clears match settlement data (keeps users, holdings, and trades) so `sync-matches.ts` can reprocess everything:

```bash
npx tsx --env-file=.env src/jobs/reset-for-resync.ts
```

## Simulating a match manually

```bash
curl -X POST http://localhost:3000/api/admin/simulate-match \
  -H "x-admin-token: dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"homeTeamId":1,"awayTeamId":2,"homeScore":2,"awayScore":1}'
```

To settle an existing scheduled match (and resolve predictions for it):

```bash
curl -X POST http://localhost:3000/api/admin/simulate-match \
  -H "x-admin-token: dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"matchId":42,"homeScore":1,"awayScore":1}'
```

## Repo layout

```
sportsex/
├─ AGENTS.md                              spec + dev guide (read first)
├─ README.md                              this file
├─ apps/
│  ├─ web/                                Next.js 14 app (TypeScript, Prisma, SQLite for dev)
│  │  ├─ prisma/schema.prisma             data model
│  │  ├─ src/lib/pricing.ts              v1 pricing algorithm (swap to change everything)
│  │  └─ src/jobs/                        one-shot TypeScript data jobs
│  │     ├─ sync-matches.ts              settle finished PL matches via football-data.org
│  │     ├─ update-player-stats.ts       import goals/assists/minutes from CSV
│  │     ├─ add-promoted-teams.ts        add promoted clubs + squads
│  │     ├─ patch-minutes.ts             backfill estimated minutes
│  │     ├─ recalc-stats.ts              recompute season totals from match stats
│  │     └─ reset-for-resync.ts          wipe settlement data for a clean re-run
│  └─ jobs/                               Python jobs
│     ├─ legacy/                          original Python pipeline (kept for v2 reference)
│     ├─ epl_2526_fbref_scrape.py        scrape 25/26 player stats → CSV
│     └─ patch_minutes_api_football.py   patch minutes via api-football.com free tier
├─ packages/db/                           (reserved; Prisma currently lives in apps/web)
├─ epl_player_stats_24_25.csv            24/25 seed data
├─ epl_player_stats_25_26.csv            25/26 season stats (generated by scrape job)
├─ investable_players_pred_202426-26.csv predicted GA90 used by seed pricing
└─ pl_setup.py, predict_investable_players.py, *.py  original pipeline (kept; not used in v1)
```

## Dev DB

Both dev and prod are Postgres (Neon). Set `DATABASE_URL` to your connection string. To wipe and reseed:

```bash
pnpm db:reset
```

## Running tests

The suite needs a real Postgres, since the Prisma schema targets `postgresql`. A disposable one is defined at the repo root:

```bash
docker compose up -d          # postgres on localhost:5433, db `sportsex_test`
pnpm --dir apps/web test      # 119 tests
docker compose down -v        # throw it away
```

Override the target with `TEST_DATABASE_URL` if you want a different host. The suite runs `prisma db push --force-reset` on startup, which drops every table, so `src/test/globalSetup.ts` refuses any URL that isn't Postgres on localhost with a database name ending in `_test`. That guard is what stands between `pnpm test` and the production database in `apps/web/.env`.

CI runs the same suite against a `postgres:16` service container.

## Environment

Copy `.env.example` → `.env`. Defaults work out of the box for local dev.

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | everything | Postgres connection string (Neon) |
| `TEST_DATABASE_URL` | tests | defaults to the `docker compose` database on `localhost:5433` |
| `AUTH_SECRET` | auth | any 32+ char string |
| `ADMIN_TOKEN` | simulate-match endpoint | `dev-admin-token` works locally |
| `FOOTBALL_DATA_API_KEY` | real match sync | free at football-data.org |
| `API_FOOTBALL_KEY` | minutes patch job | free tier, 100 req/day |
| `AUTH_GOOGLE_ID/SECRET` | Google OAuth | optional |
| `AUTH_APPLE_ID/SECRET` | Apple OAuth | optional |

## What's next (post-v1)

- **T8.1–T8.2** — flip Prisma provider to `postgresql`, provision Neon, deploy to Vercel.
- **T5.1–T5.4** — real fixture polling (Football-Data.org, 6h cron), match-status poller, fbref match-detail scraper, automatic settle hook (replacing the manual jobs above).
- **T8.3** — Modal or Render Cron for the Python jobs once real ingestion is automated.
- **T8.4** — Sentry error tracking.
- **v1.1** — top-5 European leagues.
