# sportsex

A virtual stock-market for EPL players and teams. Buy and sell shares in players and teams with in-app coins — values move with on-pitch performance and other users' trading activity.

See [AGENTS.md](AGENTS.md) for the full spec and dev guide. This README is just how to run.

## Quickstart

Requires Node 20+ and pnpm.

```bash
cd apps/web
pnpm install
pnpm exec prisma db push
pnpm db:seed           # loads ~560 EPL players + 21 teams from the CSVs in repo root
pnpm dev               # http://localhost:3000
```

## What works in v1

- **Auth**: email + password (NextAuth credentials provider). OAuth env vars stubbed.
- **10,000 coin starting balance** on signup.
- **Pages**: home (top movers + scorers), `/players`, `/players/[id]`, `/teams`, `/teams/[id]`, `/portfolio`, `/leaderboard` (global + private groups), `/friends`.
- **Trading**: `POST /api/orders` — buy/sell shares of players or teams. Cooldown, float cap, position cap.
- **Tick pricing**: every trade refreshes the player's price via a 24h-net-buys demand multiplier.
- **Match settlement**: `POST /api/admin/simulate-match` (header `x-admin-token`) generates a fake match between two teams, distributes goals/assists across the roster, applies the rudimentary algorithm in `src/lib/pricing.ts`, and refreshes team prices.
- **Comments** on players, with a word-list moderation flag.
- **Friends** and **private leaderboards** with join codes.
- **Predictions** schema is in place; payouts resolve inside the settle hook (UI for placing predictions is post-v1).

## Pricing algorithm

The whole rudimentary v1 algorithm lives in [apps/web/src/lib/pricing.ts](apps/web/src/lib/pricing.ts). Swap that file to change pricing without touching anything else. See AGENTS.md §4 for the formulas.

## Simulating a match

```bash
curl -X POST http://localhost:3000/api/admin/simulate-match \
  -H "x-admin-token: dev-admin-token" \
  -H "Content-Type: application/json" \
  -d '{"homeTeamId":1,"awayTeamId":2,"homeScore":2,"awayScore":1}'
```

This writes a `Match`, generates a `PlayerMatchStat` row for ~15 players per side, updates season stats, applies a percentage price delta per player (based on goals + assists + result), and recomputes both team prices.

## Repo layout

```
sportsex/
├─ AGENTS.md          spec + dev guide (read first)
├─ README.md          this
├─ apps/
│  ├─ web/            Next.js 14 app (TypeScript, Prisma, SQLite for dev)
│  └─ jobs/legacy/    original Python pipeline, kept for v2 reference
├─ packages/db/       (reserved for shared Prisma client; currently lives in apps/web)
├─ epl_player_stats_24_25.csv          seed data
├─ investable_players_pred_202426-26.csv seed data
└─ pl_setup.py, predict_investable_players.py, *.py  original pipeline (kept; not used in v1)
```

## Dev DB

Dev uses SQLite at `apps/web/prisma/dev.db`. To wipe and reseed:

```bash
pnpm db:reset
```

For production: swap the Prisma provider to `postgresql` and point `DATABASE_URL` at Neon or Supabase.

## Environment

Copy `.env.example` → `.env`. Defaults work out of the box. To enable Google/Apple OAuth, fill the `AUTH_*` vars and add the corresponding providers to `src/lib/auth.ts`.
