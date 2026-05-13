# sportsex — Agent Development Guide

This is the single source of truth for any AI coding agent (or human) picking up sportsex development. If credits run out mid-session and a new agent starts cold, **read this file first, then `git log -20 --oneline`, then check the Progress section at the bottom**. That gives you full context.

---

## 1. What sportsex is

A virtual stock-market for EPL players and teams. Users get a starting balance of virtual coins, earn more via predictions/quests, and buy/sell **shares** of players and teams. Prices move via a **hybrid algorithm**: a deterministic performance score (extending the existing `pl_setup.py` weighted z-score model) blended with a supply/demand multiplier driven by in-app order flow. Valuations settle in batch after each match.

**Locked product decisions (do not redebate without owner approval):**
- v1: EPL only. Top-5 European leagues in v1.1.
- Web first (Next.js + Postgres). Mobile later.
- Virtual currency only — no real money, no cashout, no DFS regulation.
- Starting balance 10,000 coins + earn via predictions/quests.
- Buy/sell shares of both players AND teams. Market orders only in MVP (schema allows future limit orders).
- Valuation cadence: post-match batch.
- Auth: Email magic link + Google + Apple OAuth.
- Social: global leaderboard, friends + private leaderboards, comments on players/teams.
- Stack: Next.js 14 (app router) + Postgres + Python scheduled jobs.
- Timeline: ~4 weeks to MVP.

---

## 2. Existing assets in this repo (reuse, don't rewrite)

Today the repo is a Python EPL data pipeline. Everything below is being **kept** and wrapped, not rewritten.

| File | What it does | What to reuse |
|---|---|---|
| `pl_setup.py` | Cleans 24/25 CSV, computes per-90 z-scores, outputs `value_index_v0` + `value_score_v0` per player | v1 ignores this; v2 may reintroduce `role_weights` for a richer algorithm. |
| `predict_investable_players.py` | Trains HistGradientBoostingRegressor on consecutive seasons → predicts next-season GA90 | `canon_name()` / `player_key` logic (lines 47-58) for player identity. `pred_GA90_next` output feeds `B_base`. |
| `epl_2324_fbref_scrape.py`, `epl_2223_fbref_scrape.py` | Scrape fbref season tables via `TABLE_PATHS` dict | Pattern + the `TABLE_PATHS` dict. Extend with a `/en/matches/{id}/` mode for the new match-detail scraper. |
| `epl_player_stats_24_25.csv` | 24/25 season player stats | Phase 1 seed for the `players` table. |
| `epl_players_2022_23_fbref_like.csv`, `epl_players_2023_24_fbref_like.csv` | Historical season stats | Used by `predict_investable_players.py` for training; also useful for backfill. |
| `investable_players_pred_202426-26.csv` | Per-player `pred_GA90_next` + `investable` flag | Initial `B_base` per player at seed time. |
| `graphs.ipynb` | Exploratory plots | Reference only; not productionised. |

**Do not duplicate logic.** If you're about to write z-scoring, role weighting, or player-name canonicalisation, port the existing function instead.

---

## 3. Architecture

```
 Vercel (Next.js 14 app router)
   NextAuth (Email + Google + Apple)
   /api/* route handlers (trading, social, predictions)
        │  Prisma
        ▼
 Postgres (Neon or Supabase)
   users · players · teams · matches · player_match_stats
   valuations · holdings · transactions · orders
   friendships · private_leaderboards · comments · quests · predictions
        ▲ writes valuations + stats
        │
 Python jobs host (Modal or Render Cron)
   ingest/fixtures.py        — Football-Data.org poll, 6h cron
   ingest/match_stats.py     — fbref scrape on FT
   valuation/run_valuation.py — chain on settle event
   valuation/{score, match_score, fair_value, demand, team_price}.py

 Data sources (priority):
   fbref scrape (post-match stats)
   Football-Data.org free (fixtures + final scores)
   API-Football free (fallback)
   ESPN unofficial (emergency)
```

**Target monorepo layout:**

```
sportsex/
├─ apps/
│  ├─ web/        Next.js app
│  └─ jobs/       Python jobs
│     ├─ legacy/  existing *.py untouched
│     ├─ ingest/
│     └─ valuation/
├─ packages/
│  └─ db/         Prisma schema + migrations + seed
├─ AGENTS.md      ← this file
└─ README.md
```

---

## 4. Pricing algorithm (rudimentary v1 — designed to be swapped)

The goal for v1 is a **simple, transparent** algorithm using only the columns already present in `epl_player_stats_24_25.csv` and `investable_players_pred_202426-26.csv`. We keep it in **one file**, `apps/web/src/lib/pricing.ts`, so swapping it later is one PR.

**Inputs**: a player has `goals`, `assists`, `minutes` (season-to-date) and optionally `predGA90Next` from the predictions CSV. Trading produces `netBuys24h` (shares).

**Seed price** (used at DB seed time and as the long-run anchor):
```ts
const productivity   = goals * 5 + assists * 3;
const minutesFactor  = min(minutes / 1000, 3) * 10;     // caps at 30
const projectionBump = (predGA90Next ?? 0) * 20;        // 0 if no projection
const seedPrice      = clamp(50 + productivity + minutesFactor + projectionBump, 5, 1000);
```

**Demand multiplier**:
```ts
const demandMult = clamp(1 + 0.0005 * netBuys24h, 0.7, 1.5);
```

**Live price** at any moment is the latest `valuations.price`. It changes by:
- **On every fill** (tick): write a new `valuations` row at `seedPrice * demandMult`, recomputed from the rolling 24h trade window.
- **On match settle**: apply a percentage delta:
  ```ts
  const perfPoints = matchGoals * 8 + matchAssists * 5 + (matchMinutes >= 60 ? 1 : 0);
  const resultBonus = won ? 2 : drew ? 0 : -2;
  const deltaPct = (perfPoints + resultBonus) / 100;     // e.g. +0.10 = +10%
  const newPrice = clamp(lastPrice * (1 + deltaPct), 5, 2000);
  ```

**Team price** (also dead-simple): average of the 11 most-played player prices on the roster, plus a small form bonus:
```ts
const rosterAvg = mean(top11ByMinutes(team).map(p => p.price));
const formBonus = teamPoints6Match * 2;   // 18 pts max → +36 coins
const teamPrice = clamp(rosterAvg + formBonus, 50, 5000);
```

**That's it.** No EWMA, no z-scores, no role weights for v1. The function signatures stay stable so a v2 algorithm (re-introducing position weighting, form decay, etc.) is a drop-in replacement of `lib/pricing.ts`.

**Settle pass must be idempotent** on `(player_id, match_id)`.

---

## 5. Data model (Postgres)

Tables and ownership:

| Table | Written by | Notes |
|---|---|---|
| `users` | web | id, email, handle, oauth, `coin_balance bigint DEFAULT 10000` |
| `teams` | jobs (seed) | id, fbref_id, name, league, crest_url |
| `players` | jobs (seed + transfer windows) | id, `player_key` (from `canon_name`), full_name, current_team_id, position, pos_bucket, `total_shares=10000`, `shares_held` (denormalised) |
| `matches` | jobs | id, fbref_match_id, home_team_id, away_team_id, kickoff_at, status (`scheduled`\|`live`\|`finished`\|`settled`), scores, settled_at |
| `player_match_stats` | jobs | UNIQUE(player_id, match_id), `raw_json jsonb` for forward-compat |
| `valuations` | jobs + web tick | INDEX (player_id, computed_at DESC), (team_id, computed_at DESC). Columns: price, base_component, form_component, demand_multiplier, decay, match_id (nullable) |
| `holdings` | web | (user_id, player_id\|team_id, shares, avg_cost). PK includes COALESCE asset ids. |
| `transactions` | web | Immutable ledger. side ∈ {buy, sell, credit, debit}. |
| `orders` | web | Market-only in MVP. Schema allows limit orders. |
| `friendships` | web | (user_id, friend_id, status) |
| `private_leaderboards`, `private_leaderboard_members` | web | join codes |
| `comments` | web | player_id\|team_id, status ∈ {visible, hidden, flagged} |
| `quests`, `user_quests` | jobs (seed quests) + web (completions) | repeat_kind: daily\|weekly\|one_shot |
| `predictions` | web | match_id, pick (H\|D\|A), coins_staked, resolved, payout. Resolved inside settle hook. |

Full column-level schema is in `/Users/ndjaber/.claude/plans/an-app-that-allows-harmonic-creek.md`; mirror it into `packages/db/schema.prisma`.

---

## 6. Data ingestion

**Free-first source ranking:**

| Source | EPL? | In-match? | Limit | Use |
|---|---|---|---|---|
| fbref scrape | ✓ | No | ≥1 req / 3s, cache hard | source of truth for per-player stats |
| Football-Data.org free | ✓ | No | 10 req/min | **primary** fixtures + scores |
| API-Football free (RapidAPI) | ✓ | partial | 100 req/day | fallback |
| ESPN unofficial endpoints | ✓ | ~1-5 min lag | unknown | emergency only |

**Paid options (only when justified by features):**

| Provider | ~Cost | Live in-match? | When to consider |
|---|---|---|---|
| Football-Data.org Tier One | €20/mo | No | More leagues / higher limits |
| API-Football paid | $20-50/mo | Yes | Adding live ticks |
| Sportmonks Football | $40-200/mo | Yes | Production live experience |
| StatsPerform / Opta | enterprise $1000s/mo | Yes | Not in scope for MVP |

MVP recommendation: free stack. Move to Sportmonks $40 tier only when live in-match price ticks become a roadmap item.

---

## 7. Build phases & task list (agent-sized)

Each task: a single PR-shaped unit. Acceptance criteria are testable.

### Phase 0 — Repo restructure
- **T0.1 Monorepo skeleton** — create `apps/web`, `apps/jobs`, `packages/db`. Move existing `*.py` into `apps/jobs/legacy/` **without modification**. Add `pnpm-workspace.yaml`, root `package.json`, `pyproject.toml` in `apps/jobs`. ✅ when `pnpm install` and `uv pip sync` both clean.
- **T0.2 Lint/format/CI** — ESLint + Prettier + ruff + pre-commit + GH Actions typecheck on PR.

### Phase 1 — DB + seed
- **T1.1 Prisma schema** — author `packages/db/schema.prisma` covering every table in §5. `prisma migrate dev` produces clean DB.
- **T1.2 Seed teams + players** — `packages/db/seed.ts` reads `epl_player_stats_24_25.csv` + `investable_players_pred_202426-26.csv`. Port `canon_name` (predict_investable_players.py:47-58) into TS to compute `player_key`. ≥500 players, 20 teams.
- **T1.3 Seed initial valuations** — run pl_setup-style score over seed; one `valuations` row per player using `value_score_v0`→`B_base`, form=0, demand=1.0. All prices in [5, 500].

### Phase 2 — Python valuation engine
- **T2.1** Port pure logic from `pl_setup.py:49-193` into `apps/jobs/valuation/score.py`. Keep `role_weights` (lines 143-152) verbatim. Unit-test reproduces `value_index_v0` for a known input row.
- **T2.2** `apps/jobs/valuation/match_score.py` — implement §4 per-match `S_perf`.
- **T2.3** `apps/jobs/valuation/fair_value.py` — EWMA form + fair value.
- **T2.4** `apps/jobs/valuation/demand.py` — read 24h transactions, compute `D(p,t)`.
- **T2.5** `apps/jobs/valuation/team_price.py` — team aggregation.
- **T2.6** `apps/jobs/run_valuation.py` orchestrator. CLI `python -m apps.jobs.run_valuation --match-id=X`. Idempotent on `(player_id, match_id)`.

### Phase 3 — Next.js + auth + pages
- **T3.1** Next.js 14 app router scaffold + Tailwind + shadcn/ui + Prisma client.
- **T3.2** NextAuth (Email magic link + Google + Apple). On first login: insert 10,000 coin grant into `transactions`.
- **T3.3** Home: top movers (24h Δ), trending players, portfolio snippet.
- **T3.4** Player detail `/players/[id]`: price chart (recharts) from `valuations`, recent stats, buy/sell widget stub.
- **T3.5** Team detail `/teams/[id]` — same shape as player.
- **T3.6** Portfolio `/portfolio` — holdings mark-to-market vs latest valuations, total PnL.

### Phase 4 — Trading engine
- **T4.1** `POST /api/orders` — validate balance + float, execute at current `P(p,t)`, write `transactions`, upsert `holdings`, decrement `users.coin_balance`. Single Postgres tx with `SELECT … FOR UPDATE` on user and player.
- **T4.2** Fast-path price refresh: after fill, recompute `D(p,t)`, insert new `valuations` row.
- **T4.3** Wire buy/sell widget to T4.1 with optimistic UI.
- **T4.4** Abuse guards: 1s order cooldown per user, max 5% of float per order, per-asset position cap.

### Phase 5 — Fixtures + settlement
- **T5.1** `apps/jobs/ingest/fixtures.py` — Football-Data.org → upsert `matches`. Cron 6h. EPL fixtures present for next 30 days.
- **T5.2** Match-status poller — cron 5 min during match windows; flips `matches.status` `scheduled→live→finished`.
- **T5.3** `apps/jobs/ingest/match_stats.py` — fbref match-detail scrape on `finished` → `player_match_stats`. Polite throttle ≥1 req / 3s.
- **T5.4** Settle hook — T5.3 done → trigger `run_valuation.py --match-id` → set `matches.settled_at`. Also resolves outstanding `predictions` for that match.

### Phase 6 — Social
- **T6.1** Friendships API (`/api/friends/*`) + `/friends` UI.
- **T6.2** Global leaderboard — materialised view `mv_leaderboard_global(user, portfolio_value = balance + Σ holdings·latest_price)`. Refresh every 5 min. Page `/leaderboard`.
- **T6.3** Private leaderboards with join codes.
- **T6.4** Comments on player/team pages — word-list moderation + report button + admin queue.

### Phase 7 — Earning & onboarding
- **T7.1** Onboarding: pick 3 players to follow → +500 bonus coins.
- **T7.2** Daily quests seeded (`login_today`, `place_one_trade`, `comment_on_player`); daily reset cron.
- **T7.3** Match-result predictions: `POST /api/predictions` → resolve in T5.4 → payout to balance.

### Phase 8 — Deploy
- **T8.1** Neon Postgres: provision, migrate, seed.
- **T8.2** Vercel deploy of `apps/web` wired to Neon.
- **T8.3** Modal (or Render Cron) for Python jobs: fixtures 6h, poller 5 min during weekend match windows, stats+valuation chained on settle.
- **T8.4** Sentry + log drains on both apps.

---

## 8. End-to-end verification

After each phase, the full happy path should still pass:

1. `prisma migrate reset && pnpm seed` — populated from existing CSVs.
2. `python -m apps.jobs.run_valuation --bootstrap` — every player has a valuation in [5, 500].
3. `pnpm dev`, sign up via magic link → `coin_balance = 10000`.
4. Buy 50 shares on `/players/[id]` → `transactions` row, `holdings` upsert, balance decremented, new `valuations` row with bumped `demand_multiplier`.
5. Insert synthetic `player_match_stats` + `matches` row with `status='finished'`; run `run_valuation --match-id=<id>` → fresh `valuations` with non-zero `form_component`, price moved.
6. `/portfolio` reflects PnL.
7. `/leaderboard` ranks user above empty users.
8. Friend + private leaderboard scoping works.
9. Comment posts; report/moderation flow works.

---

## 9. Known risks & guardrails

- **fbref ToS** — scrape politely (≥1 req / 3s), cache hard, set a real User-Agent with contact. Move to a paid feed before scaling.
- **Free API limits** — Football-Data.org 10 req/min is fine for fixtures, not live. Migrate to API-Football paid ($20-50/mo) when adding live ticks.
- **Multi-account farming** — mitigations: email-verified or OAuth-only signup, device fingerprint, IP-day caps on quest rewards.
- **Price manipulation on thin floats** — T4.4 caps (5% of float per order + per-user position cap) + the `tanh` in the demand multiplier.
- **Comment moderation** — word-list + reports + admin queue in MVP. LLM moderation post-MVP.
- **Player identity collisions** — `canon_name` can collide; seed should pull `born_year` from fbref where possible and flag duplicates.
- **Cold-start for new signings** — default to position-cohort median `B_base` until ≥3 matches accumulate.
- **Job idempotency** — settle pass idempotent on `(player_id, match_id)`; tick pass uses fresh timestamps. Re-running `run_valuation` for the same match must not duplicate.

---

## 10. Operating instructions for AI agents (read on every new session)

When an agent starts cold (e.g. after credits ran out and a new session begins), follow this protocol:

1. **Read this entire file first.** It is the spec.
2. **Run `git log -20 --oneline`** to see what's already landed.
3. **Scan §11 (Progress log) below.** Find the last completed task ID.
4. **Pick the next un-done task in phase order.** Do not skip phases unless §11 explicitly marks something unblocked.
5. **One task = one branch = one PR.** Task IDs are stable (T1.2, T4.1, etc.).
6. **Never duplicate existing logic.** Before writing z-scoring, name canonicalisation, role weights, or fbref scraping — check the table in §2 and port the existing function.
7. **Update §11 when you finish a task.** One line: `- [x] T1.2 — seeded 612 players, 20 teams (commit abc1234)`. Commit AGENTS.md with the change.
8. **If you change a locked decision in §1, stop and ask the owner.** Do not silently re-architect.
9. **If you discover the spec is wrong** (e.g. a formula needs adjusting, a free API doesn't cover what we claimed), edit the relevant section here in the same PR and note it in §11.
10. **Never commit secrets.** `.env.example` only. Real keys live in Vercel / Modal / Neon dashboards.
11. **Tests:** every Python file in `apps/jobs/valuation/` needs at least one unit test reproducing a known input/output. Every API route needs a Vitest integration test against a test Postgres.
12. **Verification:** before marking a task done, run §8 end-to-end if the task touches schema, valuation, trading, or settlement. UI-only tasks: at least visually verify in `pnpm dev`.
13. **Out of scope for MVP** — anything not in §7: real money, mobile native, live in-match ticks, more leagues, LLM-based moderation, custom limit orders, options/derivatives, lending.

**File you can always trust as canonical:** this one. The fuller historical plan lives at `/Users/ndjaber/.claude/plans/an-app-that-allows-harmonic-creek.md` (owner's machine only). Treat AGENTS.md as the in-repo source of truth.

---

## 11. Progress log

Append one line per completed task. Newest at top. Keep concise.

**v1 MVP shipped end-to-end (2026-05-12)** — see README.md for run instructions. Smoke-tested: signup → 10k coins → buy player → buy team → sell player → simulate-match → prices move → portfolio + leaderboard render. Build is clean, server runs.

- [x] T0.1 — monorepo skeleton (apps/web, apps/jobs/legacy, packages/db)
- [x] T0.2 — basic tooling (TypeScript, Tailwind; CI deferred)
- [x] T1.1 — Prisma schema (SQLite for dev; switch to postgresql for prod)
- [x] T1.2 — seed 562 players + 21 teams from existing CSVs
- [x] T1.3 — seed initial valuations using rudimentary algorithm
- [x] **Replaced Phase 2 Python valuation engine with TypeScript** — see `apps/web/src/lib/pricing.ts`. Per owner direction, v1 uses a rudimentary algorithm in one swappable file. The Python files in apps/jobs/legacy/ are kept untouched for v2 reference.
- [x] T3.1 — Next.js 14 scaffold, Tailwind, app router
- [x] T3.2 — NextAuth (credentials provider; OAuth env-stubbed) + 10k coin grant on signup
- [x] T3.3 — home page (top movers + top scorers)
- [x] T3.4 — player detail (chart, stats, trade widget, comments)
- [x] T3.5 — team detail (chart, roster, trade widget)
- [x] T3.6 — portfolio (holdings, PnL, recent activity)
- [x] T4.1 — `POST /api/orders` with `$transaction`, balance + float + position guards
- [x] T4.2 — tick-path price refresh after every player fill
- [x] T4.3 — buy/sell widget wired with optimistic refresh
- [x] T4.4 — cooldown (1s), max 5% float per order, position cap 2000
- [x] **Phase 5 replaced** — instead of fixtures ingestion + scraping for v1, shipped `POST /api/admin/simulate-match` that synthesises a match between two teams, distributes stats, and runs the full settlement. Real fixtures + fbref ingestion remain Phase 5 work for v1.1.
- [x] T6.1 — friendships (`/friends` page)
- [x] T6.2 — global leaderboard (`/leaderboard`)
- [x] T6.3 — private leaderboards with join codes
- [x] T6.4 — comments + word-list moderation flag
- [ ] T7.1 — onboarding flow (post-v1)
- [ ] T7.2 — daily quests (schema seeded, UI deferred)
- [ ] T7.3 — predictions UI (settlement payouts already wired)
- [ ] T5.1 — fixtures ingestion (real Football-Data.org pull)
- [ ] T5.2 — match-status poller
- [ ] T5.3 — fbref match-detail scraper
- [ ] T5.4 — settle hook from real match data
- [ ] T8.1 — Neon Postgres (dev is SQLite; flip provider for prod)
- [ ] T8.2 — Vercel deploy
- [ ] T8.3 — Modal job host (only needed once real ingestion lands)
- [ ] T8.4 — Sentry + logs

### Next-session priorities
1. **Onboarding + quest UI** — `/onboarding` flow that grants the 500-coin bonus, then a `/quests` page reading `quests` + `userQuests` tables (already seeded).
2. **Predictions UI** — list scheduled `Match`es, allow staking coins on H/D/A, render outstanding stake on `/portfolio`.
3. **Real fixture ingestion** — Football-Data.org free tier polled every 6h into the `Match` table; replace the admin simulate-match with real settlement after FT.
4. **Postgres migration** — flip Prisma provider, run on Neon, redeploy on Vercel.
5. **Top-5 European leagues** — extend seed + ingestion beyond EPL.
