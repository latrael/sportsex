# epl_2526_fbref_scrape.py — fetch 2025-26 EPL player stats via football-data.org.
# No new account needed — uses the same FOOTBALL_DATA_API_KEY already in .env.
#
# Run from apps/web: python3 ../../apps/jobs/epl_2526_fbref_scrape.py
# Or from repo root: FOOTBALL_DATA_API_KEY=xxx python3 apps/jobs/epl_2526_fbref_scrape.py
# Output: epl_player_stats_25_26.csv  (consumed by update-player-stats.ts)

import csv, json, os, sys
import requests

API_KEY = os.environ.get("FOOTBALL_DATA_API_KEY")
if not API_KEY:
    # Try loading from apps/web/.env
    env_path = os.path.join(os.path.dirname(__file__), "../web/.env")
    if os.path.exists(env_path):
        for line in open(env_path):
            if line.startswith("FOOTBALL_DATA_API_KEY="):
                API_KEY = line.split("=", 1)[1].strip()
                break

if not API_KEY:
    raise SystemExit("Set FOOTBALL_DATA_API_KEY env var (same key used by sync-matches.ts).")

BASE    = "https://api.football-data.org/v4"
HEADERS = {"X-Auth-Token": API_KEY}
OUT     = "epl_player_stats_25_26.csv"
FIELDS  = ["Player Name", "Club", "Nationality", "Position",
           "Appearances", "Minutes", "Goals", "Assists"]


def fetch_scorers(limit: int = 100) -> list[dict]:
    r = requests.get(
        f"{BASE}/competitions/PL/scorers",
        headers=HEADERS,
        params={"season": 2025, "limit": limit},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["scorers"]


def main() -> None:
    print("Fetching 2025-26 EPL scorers from football-data.org…")
    scorers = fetch_scorers(limit=100)
    print(f"{len(scorers)} players returned.")

    rows = []
    for entry in scorers:
        p = entry["player"]
        t = entry["team"]
        rows.append({
            "Player Name": p["name"],
            "Club":        t["shortName"],
            "Nationality": p.get("nationality", ""),
            "Position":    p.get("section", ""),
            "Appearances": entry.get("playedMatches") or 0,
            "Minutes":     (entry.get("playedMatches") or 0) * 75,  # estimated: API doesn't provide minutes
            "Goals":       entry.get("goals") or 0,
            "Assists":     entry.get("assists") or 0,
        })

    with open(OUT, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Saved {OUT} — {len(rows)} players")
    print("Next: cd apps/web && npx tsx --env-file=.env src/jobs/update-player-stats.ts")


if __name__ == "__main__":
    main()
