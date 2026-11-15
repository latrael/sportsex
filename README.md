# SportsEx

[![CI](https://github.com/latrael/sportsex/actions/workflows/ci.yml/badge.svg)](https://github.com/latrael/sportsex/actions/workflows/ci.yml)
[![Live App](https://img.shields.io/badge/demo-sportsex.vercel.app-10b981)](https://sportsex.vercel.app)
[![Next.js 14](https://img.shields.io/badge/Next.js-14-black)](https://nextjs.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)](https://www.postgresql.org/)

**SportsEx** is a virtual stock market and prediction exchange for the English Premier League. Trade shares of **all Premier League players and clubs** using virtual coins — prices respond in real time to on-pitch performance, injury/availability news, and trading pressure through a mathematically conserved bonding-curve AMM and double-entry ledger.

> **Virtual currency only.** No real money, deposits, or cashouts.

---

## Why SportsEx?

Fantasy football locks your squad behind static weekly prices, and traditional sportsbooks flatten player performance into binary props. SportsEx bridges fantasy analytics and market mechanics:

- **Full-League Universe:** Every registered Premier League goalkeeper, defender, midfielder, forward, and club is a continuously priced, tradeable asset — not just top goalscorers.
- **Position-Fair Valuation:** Keepers and defenders compete directly with attackers via position-cohort z-scoring across saves, clean sheets, tackles, recoveries, defensive contributions, and xGC suppression.
- **Path-Independent Liquidity:** Trades execute against an exponential automated market maker (AMM) backed by exact integer minor-unit (`BigInt`) accounting, guaranteeing zero round-trip exploits and 100% coin conservation.
- **Live Match Odds & Quests:** Stake coins on Premier League fixtures priced with a Poisson + Dixon-Coles model (`~5%` house margin) and complete action-verified daily quests and leaderboards.

---

## How It Works

SportsEx separates **football fundamentals** from **market supply and demand** across two pricing layers:

```mermaid
flowchart LR
    FPL["FPL Live API<br/>(bootstrap / fixtures / live)"] --> Ingest["Idempotent Ingest &<br/>Immutable Event Rows"]
    Ingest --> Stats["Derived Season Stats<br/>(player_season_stat)"]
    Stats --> FV["Layer 1: Fair Value V<br/>(Cohort Z-Score + Shrinkage + Form + Avail)"]
    FV --> AMM["Layer 2: AMM Curve P(q)<br/>P(q) = V · exp((q - q0) / L)"]
    Users["Buy / Sell Orders"] -->|"SELECT ... FOR UPDATE"| AMM
    AMM --> Ledger["Double-Entry Ledger<br/>(USER_CASH / AMM_LIQUIDITY / FEE_SINK / MINT)"]
```

1. **Layer 1 — Fundamental Fair Value ($V$)** ([`apps/web/src/lib/valuation/`](apps/web/src/lib/valuation/fairValue.ts))
   - **Performance Score:** Gameweek stats are z-scored within position cohorts (`GKP`, `DEF`, `MID`, `FWD`) over active appearances.
   - **Empirical Bayes Baseline & EWMA Form:** Career/season per-90 rate is shrunk toward the cohort prior ($k = 6$) and blended (`0.6 × Baseline + 0.4 × Form`, half-life $h = 4$ matches).
   - **Availability Multiplier ($M$):** Incorporates recent minutes share, starts rate, and official injury/suspension status.
2. **Layer 2 — Exponential AMM Bonding Curve ($P(q)$)** ([`apps/web/src/lib/market/curve.ts`](apps/web/src/lib/market/curve.ts))
   - Spot price follows $P(q) = V \cdot \exp((q - q_0)/L)$ with liquidity depth $L = 0.20 \times \text{float}$.
   - Trade subtotals integrate the exact curve over $[q_{\text{low}}, q_{\text{high}}]$ in integer minor units (`100` minor units = `1` coin) with a `0.5%` trading fee burned to `FEE_SINK`.
3. **Double-Entry Ledger (`ledger_entry`)** ([`apps/web/src/lib/market/ledger.ts`](apps/web/src/lib/market/ledger.ts))
   - Balances are derived from `SUM(USER_CASH)` rather than mutable counters; every trade, quest reward, and prediction payout records balanced legs summing to `0n`.
4. **Match Predictions & Daily Reconciliation**
   - [`odds.ts`](apps/web/src/lib/predictions/odds.ts): Computes home/draw/away odds from attacking/defensive team strength and historical expected goals conceded.
   - [`reconcile/index.ts`](apps/web/src/lib/reconcile/index.ts): Verifies global coin conservation and recomputed event-row stats daily, forwarding alerts to Sentry when `SENTRY_DSN` is configured.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Framework & UI** | Next.js 14 (App Router), React 18, TypeScript, Tailwind CSS, Recharts |
| **Auth** | NextAuth v5 (Credentials + optional Google / Apple OAuth) |
| **Database & ORM** | PostgreSQL 16 + Prisma (`Decimal` prices, `BigInt` minor-unit ledger) |
| **Data Source** | Official Fantasy Premier League API (`bootstrap-static`, `fixtures`, `event/{gw}/live`) |
| **Testing & CI** | Vitest (26 suites / 227 unit, fuzz, and Postgres integration tests), ESLint, GitHub Actions |
| **Hosting & Cron** | Vercel + Scheduled GitHub Actions |

---

## Quickstart (Local Development)

### Prerequisites
- **Node.js** `20+`
- **pnpm** `10+` (`corepack enable`)
- **Docker** (for local PostgreSQL)

### 1. Clone & install dependencies

```bash
git clone https://github.com/latrael/sportsex.git
cd sportsex/apps/web
pnpm install
```

### 2. Start a local PostgreSQL database

```bash
docker run -d --name sportsex-dev-db \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=sportsex_dev \
  -p 5432:5432 \
  postgres:16
```

### 3. Configure environment variables

Copy [`apps/web/.env.example`](apps/web/.env.example) to `apps/web/.env` and point `DATABASE_URL` at your local Postgres container:

```bash
cp .env.example .env
```

```env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/sportsex_dev"
AUTH_SECRET="replace-with-a-random-32-plus-character-secret"
AUTH_URL="http://localhost:3000"
```

### 4. Apply migrations, seed quests, and ingest live EPL data

```bash
# Apply Prisma schema migrations
pnpm exec prisma migrate deploy

# Seed quests
pnpm db:seed

# Pull current season squads, fixtures, and settled gameweeks from the FPL API
pnpm exec tsx -e "
import { PrismaClient } from '@prisma/client';
import { FplClient } from './src/lib/fpl';
import { runBootstrapCron, runFixturesCron, runSettleCron } from './src/lib/cron';

const db = new PrismaClient();
const client = new FplClient();
(async () => {
  await runBootstrapCron(db, { client });
  await runFixturesCron(db, { client });
  await runSettleCron(db, { client, fetchLive: true });
})().finally(() => db.\$disconnect());
"
```

### 5. Run the app

```bash
pnpm dev
```

Open **http://localhost:3000**, sign up at `/signup` to receive your starting coins, and explore `/players`, `/teams`, `/predictions`, `/quests`, `/portfolio`, and `/leaderboard`.

---

## Running Tests & Quality Checks

The test suite runs against an isolated tmpfs PostgreSQL container (`sportsex_test` on port `5433`) defined in [`docker-compose.yml`](docker-compose.yml). A built-in guard in [`src/test/globalSetup.ts`](apps/web/src/test/globalSetup.ts) refuses to run against any non-local or non-`_test` database.

```bash
# From repo root: start disposable test Postgres
docker compose up -d

# Run typecheck, lint, full test suite (227 tests), and production build
cd apps/web
pnpm exec tsc --noEmit
pnpm lint
pnpm test
pnpm build

# Tear down test Postgres when finished
docker compose -f ../../docker-compose.yml down -v
```

---

## Environment Variables & Automation

| Variable | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | Yes | PostgreSQL connection string (local Docker or Neon) |
| `TEST_DATABASE_URL` | Tests only | Defaults to `postgresql://postgres:postgres@localhost:5433/sportsex_test` |
| `AUTH_SECRET` | Yes | NextAuth v5 session signing secret (32+ chars) |
| `AUTH_URL` | Yes | Canonical app URL (`http://localhost:3000` locally) |
| `CRON_SECRET` | Production | Bearer token protecting `/api/cron/*` routes (`>=16` chars, fail-closed `503`/`401`) |
| `SENTRY_DSN` | Optional | Enables exception and invariant-drift alert forwarding |
| `AUTH_GOOGLE_ID` / `SECRET` | Optional | Google OAuth provider credentials |
| `AUTH_APPLE_ID` / `SECRET` | Optional | Apple OAuth provider credentials |

### Cron Endpoints

Protected by constant-time `Authorization: Bearer $CRON_SECRET` verification ([`cronAuth.ts`](apps/web/src/lib/cronAuth.ts)):

| Endpoint | Frequency | Responsibility |
|---|---|---|
| `GET /api/cron/bootstrap` | Daily (`vercel.json`) | Sync squads, club rosters, and injury/availability fair values |
| `GET /api/cron/reconcile` | Daily (`vercel.json`) | Assert ledger conservation and stat recomputation invariants |
| `GET /api/cron/fixtures` | Hourly ([`.github/workflows/crons.yml`](.github/workflows/crons.yml)) | Sync fixture schedules and final scorelines |
| `GET /api/cron/live` | Every 5m ([`.github/workflows/crons.yml`](.github/workflows/crons.yml)) | Poll live gameweek stats during active match windows only |
| `GET /api/cron/settle` | Every 15m ([`.github/workflows/crons.yml`](.github/workflows/crons.yml)) | Idempotently settle `data_checked` gameweeks, fair values, and predictions |

---

## Project Structure

```text
sportsex/
├── .github/workflows/
│   ├── ci.yml                  # Typecheck, ESLint, Vitest (Postgres service), Next.js build
│   └── crons.yml               # High-frequency fixtures / live / settle cron triggers
├── docker-compose.yml          # Disposable Postgres 16 test database (port 5433)
└── apps/web/
    ├── prisma/
    │   ├── schema.prisma       # Reference, event, derived, AMM market, ledger & product tables
    │   ├── migrations/         # Versioned SQL migrations
    │   └── seed.ts             # Quest definitions + season valuation bootstrap
    ├── vercel.json             # Daily Vercel cron configuration
    └── src/
        ├── app/                # Next.js App Router pages & REST API endpoints
        ├── components/         # UI components including TradeWidget & price charts
        ├── lib/
        │   ├── cron/           # Bootstrap, fixtures, live, and settlement orchestration
        │   ├── derive/         # Recomputed player_season_stat aggregates
        │   ├── economy/        # 30-day coin supply & sink simulation
        │   ├── fpl/            # Typed, retrying FPL API client & parsers
        │   ├── ingest/         # Diff-based reference, fixture, and live stats ingestion
        │   ├── market/         # AMM bonding curve, quotes, trade execution & double-entry ledger
        │   ├── predictions/    # Poisson + Dixon-Coles fixture odds model
        │   ├── reconcile/      # Daily invariant verification
        │   ├── rollover/       # Inter-season rollover & rollback helpers
        │   └── valuation/      # Position-cohort z-score, EWMA form, availability & fair value
        └── test/               # Unit, 10k-trade AMM fuzz, concurrency, and Postgres integration tests
```
