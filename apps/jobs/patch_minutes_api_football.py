"""
patch_minutes_api_football.py — fetch accurate EPL minutes from api-sports and patch the DB.

Only updates the `minutes` column. All other stats (goals, assists, appearances) are untouched.

Run from repo root:
  python3 apps/jobs/patch_minutes_api_football.py

Requires API_FOOTBALL_KEY in apps/web/.env (or as env var).
Free tier: 100 req/day. Results are cached to patch_minutes_cache.json so reruns
don't burn quota — delete the cache file to force a fresh fetch.
"""

import csv, json, os, time, sys
import requests

# ── Config ────────────────────────────────────────────────────────────────────

LEAGUE     = 39    # Premier League
SEASON     = 2025  # 2025-26 season (api-sports uses the start year)
DB_PATH    = os.path.join(os.path.dirname(__file__), "../web/prisma/dev.db")
ENV_PATH   = os.path.join(os.path.dirname(__file__), "../web/.env")
CACHE_PATH = os.path.join(os.path.dirname(__file__), "patch_minutes_cache.json")

# ── Load API key ──────────────────────────────────────────────────────────────

API_KEY = os.environ.get("API_FOOTBALL_KEY")
if not API_KEY:
    for line in open(ENV_PATH):
        line = line.strip()
        if line.startswith("API_FOOTBALL_KEY="):
            API_KEY = line.split("=", 1)[1].strip().strip('"')
            break

if not API_KEY:
    raise SystemExit("API_FOOTBALL_KEY not found in env or apps/web/.env")

HEADERS = {
    "x-apisports-key": API_KEY,
}

# ── Fetch EPL team IDs ────────────────────────────────────────────────────────

def get(url: str, params: dict) -> dict:
    while True:
        r = requests.get(url, headers=HEADERS, params=params, timeout=30)
        if r.status_code == 429:
            print("  Rate limited — waiting 65s…")
            time.sleep(65)
            continue
        r.raise_for_status()
        data = r.json()
        errors = data.get("errors", {})
        if errors:
            raise SystemExit(f"API error: {errors}")
        return data

def fetch_team_ids(league: int, season: int) -> list[int]:
    data = get("https://v3.football.api-sports.io/teams", {"league": league, "season": season})
    return [entry["team"]["id"] for entry in data.get("response", [])]

# ── Fetch all player stats (by team to avoid free-tier page cap) ──────────────

def fetch_players(league: int, season: int) -> list[dict]:
    base = "https://v3.football.api-sports.io/players"
    team_ids = fetch_team_ids(league, season)
    print(f"  Found {len(team_ids)} teams. Fetching players per team…")

    # Load cache — skip already-fetched teams
    if os.path.exists(CACHE_PATH):
        with open(CACHE_PATH) as f:
            cache = json.load(f)
        print(f"  Loaded cache with {len(cache['players'])} players for teams: {cache['fetched_teams']}")
    else:
        cache = {"fetched_teams": [], "players": []}

    fetched_teams = set(cache["fetched_teams"])
    players = list(cache["players"])

    FREE_TIER_PAGE_CAP = 3  # api-sports free plan cannot request page > 3

    for team_id in team_ids:
        if team_id in fetched_teams:
            continue
        page = 1
        team_players = []
        while True:
            try:
                data = get(base, {"team": team_id, "league": league, "season": season, "page": page})
            except SystemExit:
                break  # page cap — move to next team
            results = data.get("response", [])
            if not results:
                break
            team_players.extend(results)
            paging = data.get("paging", {})
            if page >= min(paging.get("total", 1), FREE_TIER_PAGE_CAP):
                break
            page += 1
            time.sleep(1.2)

        players.extend(team_players)
        fetched_teams.add(team_id)
        print(f"  Team {team_id}: {len(team_players)} players ({len(players)} total)")
        # Save progress after each team so a rate-limit abort doesn't lose work
        with open(CACHE_PATH, "w") as f:
            json.dump({"fetched_teams": list(fetched_teams), "players": players}, f)
        time.sleep(1.2)

    return players

# ── Patch DB ──────────────────────────────────────────────────────────────────

def patch_db(minutes_by_exact: dict, api_entries: list, norm_fn, fuzzy_match_fn) -> None:
    import sqlite3

    con = sqlite3.connect(DB_PATH)
    cur = con.cursor()
    cur.execute('SELECT id, fullName, minutes FROM "Player"')
    rows = cur.fetchall()

    # ── Pass 1: exact matches ─────────────────────────────────────────────────
    # Process all DB players, collect exact hits first so their API player_ids
    # are marked consumed before fuzzy matching runs.
    consumed_pids = set()
    exact_results  = {}   # db_id → (mins, api_pid)

    for db_id, full_name, _ in rows:
        key = norm_fn(full_name)
        hit = minutes_by_exact.get(key)
        if hit is not None:
            mins, api_pid = hit
            exact_results[db_id] = (mins, api_pid)
            consumed_pids.add(api_pid)

    # ── Pass 2: fuzzy matches (skip consumed API players, claim sequentially) ──
    fuzzy_results = {}   # db_id → mins

    for db_id, full_name, _ in rows:
        if db_id in exact_results:
            continue
        hit = fuzzy_match_fn(full_name, consumed_pids)
        if hit is not None:
            mins, api_pid = hit
            fuzzy_results[db_id] = mins
            consumed_pids.add(api_pid)  # claim this API player so no one else takes it

    # ── Write all results ────────────────────────────────────────────────────
    patched   = 0
    unmatched = []

    for db_id, full_name, current_minutes in rows:
        if db_id in exact_results:
            mins = exact_results[db_id][0]  # (mins, api_pid) tuple
        elif db_id in fuzzy_results:
            mins = fuzzy_results[db_id]
        else:
            unmatched.append(full_name)
            continue
        if mins == current_minutes:
            continue
        cur.execute('UPDATE "Player" SET minutes = ? WHERE id = ?', (mins, db_id))
        patched += 1
        print(f"  {full_name}: {current_minutes} → {mins} mins")

    con.commit()
    con.close()
    print(f"\nPatched {patched} player(s).")
    if unmatched:
        print(f"No API match for {len(unmatched)} player(s) (name mismatch):")
        for n in unmatched[:20]:
            print(f"  {n}")
        if len(unmatched) > 20:
            print(f"  … and {len(unmatched) - 20} more")

# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    print(f"Fetching EPL {SEASON}/{SEASON + 1} player stats from api-sports…")
    entries = fetch_players(LEAGUE, SEASON)
    print(f"\n{len(entries)} players fetched.")

    import unicodedata
    from collections import defaultdict

    def norm(s):
        s = unicodedata.normalize("NFD", s)
        s = "".join(c for c in s if unicodedata.category(c) != "Mn")
        return s.lower().strip()

    # Common nickname → possible formal name prefixes.
    # Each entry means: if the DB first word is the key, also try matching
    # against API first name words that start with any of the values.
    NICKNAMES = {
        "matty": ["matthew"], "matt": ["matthew"],
        "ollie": ["oliver"],  "olly": ["oliver"],
        "eddi":  ["edward"],  "eddie": ["edward"],
        "ben":   ["benjamin"],
        "charlie": ["charles"],
        "will":  ["william"],
        "jamie": ["james"],
        "danny": ["daniel"],  "dan": ["daniel"],
        "nicky": ["nicholas"],"nick": ["nicholas"],
        "tommy": ["thomas"],  "tom": ["thomas"],
        "robbie":["robert"],  "rob": ["robert"],
        "jonny": ["jonathan"],"jon": ["jonathan"],
        "alex":  ["alexander"],
        "andy":  ["andrew"],
        "stevie":["stephen","steven"], "steve": ["stephen","steven"],
        "mike":  ["michael"],
        "tony":  ["anthony"],
        "sam":   ["samuel"],
        "chris": ["christopher"],
        "gaz":   ["gareth"],
        "jorginho": ["jorge"],
        "emiliano":  ["emiliano"],  # can be a middle name in the API
    }

    # Aggregate minutes by player ID to handle mid-season transfers correctly
    # (player appears for two teams → sum both)
    aggregated = defaultdict(lambda: {"first": "", "last": "", "mins": 0})
    for entry in entries:
        p     = entry.get("player", {})
        pid   = p.get("id")
        stats = entry.get("statistics", [{}])
        mins  = (stats[0].get("games", {}) or {}).get("minutes") or 0
        if not pid:
            continue
        aggregated[pid]["first"] = p.get("firstname", "") or ""
        aggregated[pid]["last"]  = p.get("lastname",  "") or ""
        aggregated[pid]["mins"] += mins

    # Build matching structures. Include ALL players (even 0 minutes) so we can
    # distinguish "found with 0 mins (injured)" from "not in API at all".
    # Each entry carries the API player_id so we can mark it as consumed once matched.
    minutes_by_exact = {}   # norm(full) → (mins, pid)
    api_entries      = []   # (norm_first_words, norm_last_words, mins, pid)

    for pid, data in aggregated.items():
        first = data["first"]
        last  = data["last"]
        mins  = data["mins"]
        exact_key = norm(f"{first} {last}")
        minutes_by_exact[exact_key] = (mins, pid)
        api_entries.append((norm(first).split(), norm(last).split(), mins, pid))

    # Build a set of ALL player names in the EPL API data (for zeroing out
    # players who left the league — they genuinely have 0 EPL minutes)
    api_player_ids_in_epl = set(aggregated.keys())

    def fuzzy_match(db_name, consumed_pids):
        words    = norm(db_name).split()
        db_first = words[0]
        db_last  = words[-1]
        single   = len(words) == 1

        first_candidates = [db_first] + NICKNAMES.get(db_first, [])

        candidates = []
        for api_firsts, api_lasts, mins, api_pid in api_entries:
            if api_pid in consumed_pids:
                continue
            api_all = api_firsts + api_lasts

            if single:
                if db_first in api_all:
                    candidates.append((mins, api_pid))
                continue

            if db_last not in api_lasts:
                continue

            matched_first = any(
                api_fw.startswith(fc)
                for fc in first_candidates
                for api_fw in api_all
            )
            if matched_first:
                candidates.append((mins, api_pid))

        if len(candidates) == 1:
            return candidates[0]
        # If ambiguous, prefer non-zero-minute candidates (more likely to be right)
        nonzero = [(m, p) for m, p in candidates if m > 0]
        if len(nonzero) == 1:
            return nonzero[0]
        return None

    print(f"\nPatching DB at {DB_PATH}…")
    patch_db(minutes_by_exact, api_entries, norm, fuzzy_match)

if __name__ == "__main__":
    main()
