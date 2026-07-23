# sportsex — 26/27 rebuild plan

Written 2026-07-21, against commit `a139edc`. Assumes 26/27 opening weekend is mid-August, so roughly four weeks of runway.

---

## Verdict

**Don't rebuild from the ground up. Rebuild the engine room and keep the house.**

The app splits cleanly into two halves, and they are in very different states:

- **The product shell** (auth, pages, trading UI, portfolio, leaderboards, friends, comments, quests, predictions UI, Tailwind design system, Vercel deploy) is broadly sound. It works, it's typed, it's coherent. Rewriting it costs two to three weeks and buys nothing except reintroducing bugs that are already fixed.
- **The engine room** (data ingestion, player universe, stats model, valuation algorithm, trading mechanics, economy rules, test infrastructure) is not fixable in place. It is built on a data source that structurally cannot supply what the product needs, and the market design has a free-money bug at its core. This half genuinely deserves a from-scratch rebuild.

The clinching argument for *not* preserving anything in the engine room: production currently holds **1 user and 2 trades**. There is no user data to migrate and no economy to protect. The cost of a clean data-layer rebuild is close to zero risk, and the cost of a full-app rebuild is your entire runway before the season starts.

Rough split of the work: ~75% of the remaining effort is in the engine room either way. Keeping the shell saves you the other 25% and, more importantly, saves the debugging tail on code that is already working.

---

## What I actually found

I read the repo, ran the test suite, and queried the live Neon database. Evidence, grouped by severity.

### 1. The player universe is ~18% of the league, and it is the wrong 18%

`apps/jobs/epl_2526_fbref_scrape.py` is named for FBref but actually calls `football-data.org/competitions/PL/scorers?limit=100`. That endpoint returns **the top 100 scorers**, nothing else. Everything downstream inherits that ceiling.

Live database state:

```
players: 100    teams: 20    valuations: 121    matches: 11
playerMatchStats: 0    users: 1    transactions: 2
```

Squad sizes: Wolverhampton 1, Burnley 3, Brentford 4, Arsenal 8. Position distribution: **0 GK, 8 DEF, 36 MID, 56 FWD**.

So the "market" is a list of forwards. There is no goalkeeper to trade, defenders barely exist, and eight clubs can't field a five-a-side team. `teamPrice()` averages "the top 11 players by minutes" over rosters that mostly contain fewer than five players (`src/lib/pricing.ts:52`).

Minutes are fabricated: `"Minutes": playedMatches * 75` in the scraper, then `patch-minutes.ts` fabricates them a second time with the same formula, then `patch_minutes_api_football.py` (293 lines, plus a JSON cache file sitting untracked in the working tree) exists to patch the fabrication. Nine players still have `minutes = 0` in prod.

Club assignment comes from the scorers payload's *current* team, so historical stats get attached to the wrong club after a transfer. Live data shows Antoine Semenyo listed under Man City.

**This one issue invalidates the seed prices, the team prices, the position filters, the leaderboards, and the entire premise of a market.** No amount of patching fixes a source that only returns 100 rows.

### 2. The market has a free-money exploit

`src/app/api/orders/route.ts:42` snapshots demand *before* the trade, then applies it to the price tick *after* (`:128-130`). The comment claims this prevents round-trip profit. It creates it:

1. Buy 1,000 shares → fills at P₀, tick writes P₀ (pre-trade demand was 0).
2. Buy 1 share → fills at P₀, tick now sees +1,000 net buys → writes **P₀ × 1.5**.
3. Sell 1,001 shares → fills at 1.5 × P₀.

That's a **50% return per round trip**, capped only by the 2,000-share position limit, repeatable indefinitely, with no opposing force. Every price-affecting action happens outside the trade that caused it, so the trader never pays for their own impact. This is a design flaw, not a bug you patch: as long as execution price and price formation are separate steps, some version of this exploit exists.

Related, in the same file:

- **`src/app/api/orders/route.ts:95`** — `coinBalance: user.coinBalance + coinsDelta` is a read-modify-write inside an interactive transaction at READ COMMITTED. Two concurrent orders lose an update. Balances can go negative under trivial concurrency.
- **`src/lib/cooldown.ts`** — the 1-second order cooldown is an in-process `Map`. On Vercel each invocation may get a fresh instance, so the rate limit is decorative in production.
- **`src/app/api/orders/route.ts:128`** — `basePrice` is re-anchored to the post-match price on every settle, so demand multipliers compound permanently into the base instead of decaying. Prices ratchet.
- The `Order` table is never written to. It's dead schema.
- Prices are `Float` and coins are `Int` with `Math.round()` at the boundary. Money should not be a float.

### 3. The valuation algorithm doesn't model football

`src/lib/pricing.ts` in full: `50 + goals×5 + assists×3 + min(minutes/1000,3)×10`, clamped.

- Live price range across the whole market: **65 to 204**, mean 93. Haaland and a bench midfielder are within 2× of each other. There is nothing to invest in.
- A goalkeeper or centre-back can only ever be worth 50–80 coins. Their entire contribution is invisible to the model.
- No xG/xA, no minutes share, no availability, no injury/suspension state, no form decay, no position normalisation, no cold-start handling. `predGA90Next` is specified in AGENTS.md §4 but never implemented.
- Match settlement moves price by `(goals×8 + assists×5 + 1)/100`. A hat-trick is +26%; a clean sheet from a keeper is +1%. A striker who plays 90 minutes in a loss and misses five chances gets **-1%**.

### 4. Settlement has never actually run on real data

Prod has 5 matches at `status: 'finished'` that were never settled, 0 `PlayerMatchStat` rows, and 121 valuations for 120 assets — meaning **essentially every price chart in the app is a single point**. `PriceChart` renders "No price history yet" or a flat line for almost every player.

Four separate code paths write player stats (`cron/sync-stats`, `admin/simulate-match`, `update-player-stats`, `patch-minutes`), and three of them use `increment:`. Season totals are mutable state updated from multiple writers with no reconciliation, which is why `recalc-stats.ts` had to be written to repair the drift. `sync-matches.ts` writes a fake `PlayerMatchStat` with `minutes: 90, goals: 0, assists: 0` for **every player on both squads** regardless of whether they played.

Also: `sync-matches.ts` requires `FOOTBALL_DATA_API_KEY`, which is no longer in `.env`. That job cannot run at all.

The `/api/cron/sync-stats` route matches teams by substring (`t.name.toLowerCase().includes(n)`) and players by surname substring, inside a transaction, with a `player.findMany()` per player. On a full matchday that is thousands of queries in a 60-second transaction on a serverless function. It will time out, and any club whose API name doesn't substring-match the DB name is silently skipped.

### 5. The test suite and CI are dead

81 tests, 0 running. `vitest.config.ts` sets `DATABASE_URL: 'file:./prisma/test.db'` while `schema.prisma` declares `provider = "postgresql"`:

```
Error validating datasource `db`: the URL must start with the protocol `postgresql://`
```

Every test file fails at global setup. This broke at commit `b5e9325` ("switch to postgresql") and CI has been red since. `src/lib/queries.ts` also uses Postgres-only `DISTINCT ON`, so the tests couldn't pass on SQLite even if the URL were fixed.

**Lint is separately broken too.** `pnpm lint` runs `next lint` against `.eslintrc.json`, which ESLint 9 no longer reads (`eslint-config-next@16` ships flat configs only). It exits 1 before linting anything. So two of the three CI steps were dead, not one. Typecheck is the only one that still passes. *(Both fixed in Phase 0 — see TODO_2627.md.)*

### 6. Smaller things worth listing

- **`src/app/api/debug/route.ts`** returns the first 25 characters of `DATABASE_URL` to any unauthenticated caller, in production. Git log calls it "temp debug endpoint". Delete it today.
- **Predictions pay a flat 2×** on any outcome. Betting the favourite in an EPL match is roughly +40% EV per bet. It is a coin printer with no house margin.
- **`src/app/api/onboarding/complete/route.ts`** grants 500 coins for posting any three valid player IDs. It never checks the user bought anything.
- **`login_today` quest** grants 100 coins/day with no verification beyond "you called the endpoint".
- **`src/app/players/page.tsx:17`** — `{ contains: q }` without `mode: 'insensitive'` is case-sensitive on Postgres. Searching "haaland" returns nothing.
- **`src/app/players/page.tsx:30,37`** — "Sort: Price" orders by name, takes 200, then sorts *those* by price. It shows the alphabetically-first 200 players re-sorted, not the most valuable players.
- **`src/lib/queries.ts:22`** orders by `id DESC` while `latestPrice()` (`:10`) orders by `computedAt DESC`. List and detail pages can disagree on a player's price.
- **`topMovers()`** (`:65`) loads every valuation row from the last 24h into memory with no aggregation. Fine at 121 rows, not at 500k.
- **`Comment.teamId`** is a bare `Int` with no relation, so team comments are orphaned.
- `Holding`/`Transaction` use a polymorphic `assetKind`/`assetId` pair with no foreign keys, and `assetKind` doubles as a transaction *type* (`'coin_grant'`, `'prediction_payout'`). No referential integrity on positions.

---

## The single biggest fix: use the FPL API

I verified all three endpoints just now. No API key, no rate limit worth worrying about, no scraping, no ToS grey area.

| Endpoint | Returns | Verified |
|---|---|---|
| `/api/bootstrap-static/` | **841 players**, 20 clubs, 38 gameweeks | 200, 2.0 MB |
| `/api/fixtures/` | all 380 fixtures, kickoff times, scores, `finished`/`started` flags, per-fixture stat breakdowns | 200, 0.97 MB |
| `/api/event/{gw}/live/` | per-player stats for a gameweek, **with per-fixture attribution** via `explain` | 200, 0.59 MB |

Per-player fields available today include: `minutes`, `starts`, `goals_scored`, `assists`, `expected_goals`, `expected_assists`, `expected_goal_involvements`, `expected_goals_conceded`, `clean_sheets`, `saves`, `tackles`, `recoveries`, `clearances_blocks_interceptions`, `defensive_contribution`, `bonus`, `bps`, `influence`/`creativity`/`threat`/`ict_index`, `yellow_cards`, `red_cards`, `own_goals`, `penalties_saved`/`missed`, plus `status` and `chance_of_playing_next_round` (injury/suspension), `now_cost`, `selected_by_percent`, `birth_date`, `squad_number`, `team_join_date`, and stable `id` / `code` / `opta_code` identifiers.

What this fixes at a stroke:

- **8.4× the player universe**, complete squads, every goalkeeper and defender.
- **Real minutes**, not `appearances × 75`.
- **xG/xA**, which is the difference between a valuation model that works and one that chases variance.
- **Defensive and goalkeeping stats**, so the market isn't forwards-only.
- **Availability signals**, so injured players decay instead of holding value.
- **Stable integer IDs.** Player identity by `fplId`/`opta_code` kills the entire class of canonical-name-matching bugs — `canon.ts`, the alias tables in three files, the surname substring matching, the club-name substring matching. All of it goes away.
- **Live in-match data.** `event/{gw}/live/` updates during matches, which makes live price ticks a realistic v2 feature rather than a $40/month Sportmonks line item.
- **A free backtest corpus.** The full 25/26 season is available right now, per gameweek, to tune and validate the algorithm before a single 26/27 ball is kicked.

Keep `football-data.org` as a fixture cross-check if you like. Drop FBref scraping, `api-football`, and the whole `apps/jobs/` Python layer.

One timing note: the FPL dataset flips to the new season roughly two weeks before GW1 (as of today it still holds 25/26 stats with `events[0].deadline_time = 2025-08-15`). Build and backtest against 25/26 now, then point at the new season when it rolls over. Don't leave that switchover for opening weekend.

---

## Keep / rebuild / delete

| Component | Verdict |
|---|---|
| Next.js app shell, layout, Tailwind design system | **Keep** |
| Auth (NextAuth credentials), signup, session handling | **Keep**, add OAuth later |
| Pages: home, players, teams, portfolio, leaderboard, friends, quests, predictions, onboarding, admin | **Keep**, rewire to new data sources |
| `PriceChart`, `TradeWidget`, `ReportButton` | **Keep** |
| Comments + moderation + report queue | **Keep** |
| Friendships, private leaderboards | **Keep** |
| Vercel project, Neon instance | **Keep** |
| Prisma schema | **Rebuild** (see below); nothing in prod to migrate |
| `src/lib/pricing.ts` | **Rebuild from scratch** |
| `src/app/api/orders/route.ts` | **Rebuild from scratch** (AMM) |
| `src/lib/queries.ts` | **Rebuild** |
| `src/jobs/*.ts` (all seven) | **Delete**, replaced by one ingestion module |
| `src/app/api/cron/sync-stats/route.ts` | **Delete**, replaced |
| `src/app/api/admin/simulate-match/route.ts` | **Delete** (it injects synthetic stats into real season totals) |
| `apps/jobs/*.py` + `patch_minutes_cache.json` | **Delete** |
| Root CSVs + `out/` + `*.zip` + `graphs.ipynb` | **Archive** out of the repo root |
| `src/app/api/debug/route.ts` | **Delete today** |
| Test suite | **Rebuild** against a Postgres test database |
| Quests / predictions economy | **Rebuild the rules**, keep the UI |

---

## Target architecture

```
FPL API (bootstrap-static, fixtures, event/{gw}/live)
      │  ingest: idempotent upsert, raw payload retained
      ▼
Postgres (Neon)
  reference:  season · club · player · fixture · gameweek
  events:     player_fixture_stat        ← immutable source of truth
  derived:    player_season_stat · fair_value      ← recomputed, never incremented
  market:     price_tick · trade · position · ledger_entry
  product:    user · comment · friendship · leaderboard · quest · prediction
      ▲
      │  valuation engine (pure functions, unit-tested, backtestable)
      │  AMM trading engine (single writer path, DB-enforced invariants)
      ▼
Next.js app (unchanged shell)
```

Three principles that the current codebase violates and the rebuild should enforce:

1. **Events are immutable; aggregates are derived.** `player_fixture_stat` is written once per (player, fixture) and never mutated. Season totals are recomputed from it. No `increment:` anywhere in the stats path. This alone removes the need for `recalc-stats.ts`, `patch-minutes.ts`, and `reset-for-resync.ts`.
2. **One writer per concern.** Prices are written only by the valuation engine and the AMM. Stats are written only by ingestion. Balances are written only by the ledger.
3. **Money is integers and double-entry.** Coins in minor units as `BigInt`, every movement is a `ledger_entry` row, and a user's balance is provably the sum of their entries. Reconciliation becomes a query instead of an investigation.

---

## The algorithm

Two layers, deliberately separated. Today they're conflated, which is why demand distortions ratchet into the base price permanently.

### Layer 1 — Fair value `V(p, t)`: what the football says

Recomputed after each gameweek is finalised (and nightly for availability changes). Pure function of stored stats, so it is fully backtestable against 25/26.

**a. Per-fixture performance score, role-aware and position-normalised**

```
attack_i   = 1.0·goals + 0.7·assists + 0.9·xG + 0.6·xA
defence_i  = pos_weight · (clean_sheet, saves, tackles, interceptions,
                           clearances, recoveries, xGC)
discipline = -(0.5·yellow + 2·red + 1·own_goal + 1·pen_missed)
S_i        = z_within_position( attack_i + defence_i + discipline + 0.3·bonus )
```

Position weights matter more than any other single choice here. A goalkeeper's clean sheet and save volume must map to roughly the same score distribution as a striker's goals, or you rebuild today's forwards-only market. z-scoring **within** position group (GK/DEF/MID/FWD) guarantees that by construction. FPL's `bps` and `defensive_contribution` give a ready-made, sanity-checked defensive signal to anchor against.

**b. Form** — EWMA over recent fixtures, half-life ≈ 4 matches:

```
F_p = Σ w_i·S_i / Σ w_i,   w_i = 0.5^(matches_ago / 4)
```

Recency matters, but not so much that one hat-trick reprices a player permanently.

**c. Baseline with shrinkage** — solves cold start without special cases:

```
rate_p = season xGI per 90 (and defensive equivalent)
B_p    = (n_90s · rate_p + k · cohort_prior_pos) / (n_90s + k),    k ≈ 6
```

A new signing with 90 minutes played sits near the positional median and moves toward their own rate as evidence accumulates. No "default to cohort median until 3 matches" branch needed; the formula does it continuously.

**d. Availability multiplier** — the term the current model is missing entirely:

```
M_p = expected_minutes_share × availability_factor
      expected_minutes_share: EWMA of minutes/90 over last 6 fixtures, blended with starts rate
      availability_factor:    from FPL `status` and `chance_of_playing_next_round`
                              (a = 1.0, d = chance/100, i/s/u/n → 0.15 floor)
```

A player who stops playing should bleed value over a few gameweeks. Today they hold their price forever, which is both wrong and exploitable.

**e. Fair value**

```
V_p = clamp( P_pos_base · exp( λ · (0.6·B_p + 0.4·F_p) ) · M_p , 10 , 1500 )
```

Exponential rather than linear so the top of the market separates properly. Target distribution: elite ~800–1200, first-choice starters ~150–400, squad players ~40–100, fringe ~10–30. Tune λ and `P_pos_base` by backtest against 25/26 until the spread looks like a market people want to trade. That's a calibration step with a concrete acceptance criterion, not a guess.

### Layer 2 — Market price `P(p, t)`: what the traders say

Replace the "compute a price on the side and fill at the last one" model with an **automated market maker**. Price is a function of outstanding inventory `q`:

```
P(q) = V · exp( (q − q₀) / L )
```

Cost of buying `n` shares is the integral, not `n × P`:

```
cost(q → q+n) = V · L · ( e^((q+n−q₀)/L) − e^((q−q₀)/L) )
```

`L` is per-player liquidity depth, scaled by float. Charge a fee (~0.5%) on each side.

This kills several bug classes simultaneously:

- **No free round trip.** Your own buy moves the price as you buy it. Buy-then-sell loses exactly the fee. The exploit in §2 stops existing rather than being patched.
- **No separate tick step.** Execution price and price formation are the same computation, in the same transaction. `preTradeDemand` and its whole category of ordering bug disappear.
- **Whales pay for impact.** Price impact scales continuously with size, which replaces the "5% of float" and "2,000 share cap" hacks with real economics. Keep a generous cap as a backstop, not as the mechanism.
- **The economy can't be drained.** The AMM is the counterparty. Coins in equal coins out minus fees, and fees are a sink against quest/prediction inflation.
- **Performance PnL stays clean.** When `V` updates after a gameweek, `P` moves by the same ratio for everyone. The demand term `e^((q−q₀)/L)` stays a multiplier and never ratchets into the base, which is the compounding bug in `orders/route.ts:128`.

**Team prices** get their own AMM over a team fair value: minutes-weighted squad value + points-per-game form + FPL `strength_overall_home/away`. Not "mean of the top 11 players by minutes", which is meaningless when a roster has four players.

**Predictions** need real odds. Derive them from a Poisson model on team xG (FPL supplies `strength_attack`/`strength_defence` and historical xGC), apply a 5% house margin, and pay `stake × odds`. Flat 2× on a 70%-likely home win is a money printer, and it's the second-largest inflation leak after the trading exploit.

### Enforced invariants

Write these as tests before writing the engine:

1. Buy `n` then immediately sell `n` loses exactly the fee. For all `n`, all `V`, all starting `q`.
2. Total coins in circulation changes only via explicit mints (grants, quests, prediction payouts) and burns (fees). Assert after every simulated session.
3. Settling the same fixture twice produces identical state. Idempotent on `(player_id, fixture_id)`.
4. Recomputing season aggregates from `player_fixture_stat` reproduces the stored aggregates exactly.
5. No user balance is ever negative, under concurrent order load. Test with parallel writers, not sequentially.
6. Fair value is a pure function of stats. Same inputs, same output, no clock, no randomness.

---

## Phased plan

Effort assumes focused sessions. Dates assume a mid-August GW1.

**Phase 0 — Stop the bleeding (today, ~2 hours)**
Delete `/api/debug`. Fix CI: point tests at a Neon branch or a Docker Postgres so the 81 existing tests can run again, even if most get replaced later. Put the deployed app behind a coming-soon page or leave it; with one user it doesn't matter much, but the debug endpoint should go now.

**Phase 1 — Ingestion (3–4 days)**
One module: `bootstrap-static` → clubs + players + gameweeks; `fixtures` → fixtures; `event/{gw}/live` → `player_fixture_stat` with `explain` used for per-fixture attribution. Store the raw payload alongside parsed columns. Idempotent upserts keyed on FPL IDs. Backfill all 38 gameweeks of 25/26 as history and as backtest fuel. Acceptance: 800+ players, 20 complete squads, 380 fixtures, ~25k player-fixture rows, and a re-run that changes nothing.

**Phase 2 — Schema v2 + derived aggregates (3–4 days)**
New Prisma schema per the architecture above. Coins as `BigInt` minor units, prices as `Decimal`. Real foreign keys on positions and trades. Season aggregates as a recompute job, never incremented. Drop all seven `src/jobs/*.ts` and the Python layer. Acceptance: invariant 4 passes on the full 25/26 backfill.

**Phase 3 — Valuation engine (4–5 days)**
Layer 1 as pure functions with unit tests. Then backtest across all of 25/26: replay every gameweek, dump the price distribution at GW1/GW10/GW20/GW38, and check it against a manual sanity list (does Haaland end up near the top? does a first-choice keeper outprice a fringe forward? does an injured player decay?). Tune λ, position weights, and half-life against that. Acceptance: the four position groups all have players in the top 100 by price, and the 5th–95th percentile price ratio is at least 10×.

**Phase 4 — AMM trading engine (4–5 days)**
Rewrite `POST /api/orders` around the bonding curve, in one transaction, with the ledger. Replace the in-memory cooldown with a DB or Upstash-backed limiter. Invariants 1, 2, 5 as tests. Acceptance: a fuzz test of 10k random trades across 100 users conserves coins to the last unit and never produces a negative balance.

**Phase 5 — Rewire the UI (3–4 days)**
Points at new sources. Fix the price sort, the case-insensitive search, and the `id DESC`/`computedAt DESC` inconsistency. Add position-group views so defenders and keepers are discoverable. Charts get real history for the first time because the backfill gives every player 38 gameweeks of fair-value points.

**Phase 6 — Automation (2 days)**
Vercel cron: `bootstrap-static` daily for prices and availability; `fixtures` hourly; `event/{gw}/live` every 2 minutes inside match windows; settle when a gameweek reports `data_checked: true`. Fix `CRON_SECRET` handling. Acceptance: a full gameweek settles end to end with no manual step.

**Phase 7 — Economy + observability (2 days)**
Real odds on predictions. Verified quests with daily caps. Trading fees as the sink. Sentry. A daily reconciliation job asserting invariants 2 and 4 in production.

**Total: roughly 21–26 working days.** That fits the runway if the shell is left alone, and does not fit if it isn't.

---

## Risks and open decisions

- **The FPL season rollover** wipes and rebuilds the dataset in early August. Build against 25/26, then run the switchover deliberately a week before GW1. Don't discover it on opening Saturday.
- **FPL is an unofficial API.** No SLA, no contract, shape can change. Mitigate by storing raw payloads (replay without refetching) and keeping `football-data.org` wired as a fixture/score cross-check. Realistically it has been stable for a decade and is the backbone of most of the FPL tooling ecosystem.
- **Calibration is the real work in Phase 3.** The engine is easy; making the price distribution feel like a market takes iteration against the backtest. Budget for that explicitly rather than treating it as polish.
- **Decide before Phase 2: single season or multi-season?** Carrying 25/26 as history costs a little schema complexity and buys you charts with real depth on day one, plus a prior for the shrinkage baseline. I'd carry it.
- **Decide before Phase 4: what happens to open positions at season rollover?** Cash out at final price, or carry positions into 26/27 with fair values reset? Carrying is more fun and more like a real market; cashing out is simpler and avoids a weird pre-season where nothing moves. With one user, now is a free moment to choose.
- **Live in-match pricing** is now cheap (`event/{gw}/live` polls at 2-minute granularity) but is a post-launch feature. It changes the AMM's risk profile because fair value moves while people trade against it. Ship post-match settlement first.
- **Position weights are a product decision, not a modelling one.** How much should a clean sheet be worth relative to a goal? It determines whether the market is a fantasy-football clone or something with its own character. Worth deciding deliberately in Phase 3 rather than defaulting to FPL's scoring.

---

## What I'd do first

1. Delete `/api/debug/route.ts`.
2. Get CI green against a Postgres test database.
3. Write the ingestion module and backfill 25/26. Everything downstream depends on having real data to work with, and it's the step that proves the whole approach in a day or two.
