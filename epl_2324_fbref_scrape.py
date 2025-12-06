import time, re, numpy as np, pandas as pd, requests
from bs4 import BeautifulSoup, Comment
from io import StringIO

BASE = "https://fbref.com/en/comps/9/2023-2024/"
TABLE_PATHS = {
    "standard": "stats/2023-2024-Premier-League-Stats",
    "shooting": "shooting/2023-2024-Premier-League-Stats",
    "passing": "passing/2023-2024-Premier-League-Stats",
    "pass_types": "passing_types/2023-2024-Premier-League-Stats",
    "possession": "possession/2023-2024-Premier-League-Stats",
    "defense": "defense/2023-2024-Premier-League-Stats",
    "misc": "misc/2023-2024-Premier-League-Stats",
}
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; StatsBot/1.0)"}


def flatten_columns(df: pd.DataFrame) -> pd.DataFrame:
    if isinstance(df.columns, pd.MultiIndex):
        new_cols = []
        for tpl in df.columns:
            parts = [str(x) for x in tpl if x and not str(x).startswith("Unnamed")]
            new_cols.append("_".join(parts) if parts else "col")
        df.columns = [c.strip("_").strip() for c in new_cols]
    else:
        df.columns = [str(c).strip() for c in df.columns]
    return df


def has_player_col(df: pd.DataFrame) -> bool:
    cols = [c.lower() for c in df.columns]
    return any(
        c == "player" or c.endswith("_player") or c.startswith("player_") for c in cols
    )


def parse_all_tables(html: str) -> list[pd.DataFrame]:
    out = []

    out += pd.read_html(StringIO(html), header=1)

    soup = BeautifulSoup(html, "lxml")
    for com in soup.find_all(string=lambda txt: isinstance(txt, Comment)):
        chunk = str(com)
        try:
            out += pd.read_html(StringIO(chunk), header=1)
        except Exception:
            pass
    return out


def fetch_table(url: str) -> pd.DataFrame:
    r = requests.get(url, headers=HEADERS, timeout=30)
    r.raise_for_status()

    dfs = parse_all_tables(r.text)

    candidates = []
    for df in dfs:
        df = flatten_columns(df)
        if "Player" in df.columns or has_player_col(df):
            candidates.append(df)
    if not candidates:

        candidates = [max(dfs, key=lambda d: d.shape[0] * d.shape[1])]

    df = max(candidates, key=lambda d: d.shape[0])

    if "Player" not in df.columns:

        for c in df.columns:
            if "player" in c.lower():
                df.rename(columns={c: "Player"}, inplace=True)
                break

    if "Player" in df.columns:
        df = df[df["Player"].notna()]
        df = df[df["Player"] != "Player"]
    return df


def clean_common(df: pd.DataFrame) -> pd.DataFrame:
    rename = {
        "Squad": "Club",
        "Nation": "Nationality",
        "Pos": "Position",
        "MP": "Appearances",
        "Min": "Minutes",
        "Gls": "Goals",
        "Ast": "Assists",
    }
    df = df.rename(columns={k: v for k, v in rename.items() if k in df.columns})
    for c in ["Player", "Club", "Nationality", "Position"]:
        if c in df.columns:
            df[c] = df[c].astype(str).str.strip()
    return df


def to_numeric(df: pd.DataFrame, cols):
    for c in cols:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def safe_merge(left, right, on=["Player", "Club", "Position"], how="left"):

    right_cols = [c for c in right.columns if c not in on]
    dedup_cols = [c for c in right_cols if c not in left.columns]
    pruned_right = right[on + dedup_cols].copy()

    m = left.merge(pruned_right, on=on, how=how)

    m = m.loc[:, ~m.columns.duplicated()]
    return m


def get_tables():
    dfs = {}
    for key, path in TABLE_PATHS.items():
        url = BASE + path
        print(f"Fetching {key}: {url}")
        df = fetch_table(url)
        df = clean_common(df)
        dfs[key] = df
        time.sleep(1.0)
    return dfs


def build_master(dfs):
    std = dfs["standard"].copy()
    base_cols = [
        "Player",
        "Club",
        "Position",
        "Nationality",
        "Age",
        "Born",
        "Appearances",
        "Starts",
        "Minutes",
        "Goals",
        "Assists",
        "CrdY",
        "CrdR",
    ]
    for c in base_cols:
        if c not in std.columns:
            std[c] = np.nan
    master = std[base_cols].copy()
    for k in ("shooting", "passing", "pass_types", "possession", "defense", "misc"):
        master = safe_merge(master, dfs[k])

    numeric_hint = [
        "Minutes",
        "Goals",
        "Assists",
        "Sh",
        "SoT",
        "SoT%",
        "Off",
        "Touches",
        "Cmp",
        "Att",
        "Cmp%",
        "Crs",
        "TB",
        "Carries",
        "PrgC",
        "1/3",
        "PPA",
        "CrsPA",
        "CPA",
    ]
    master = to_numeric(master, [c for c in numeric_hint if c in master.columns])

    out = pd.DataFrame()
    out["Player Name"] = master["Player"]
    out["Club"] = master["Club"]
    out["Nationality"] = master.get("Nationality")
    out["Position"] = master.get("Position")
    out["Appearances"] = master.get("Appearances")
    out["Minutes"] = master.get("Minutes")
    out["Goals"] = master.get("Goals")
    out["Assists"] = master.get("Assists")
    out["Shots"] = master.get("Sh")
    out["Shots On Target"] = master.get("SoT")
    out["SOT%"] = master.get("SoT%")

    with np.errstate(divide="ignore", invalid="ignore"):
        out["Conversion %"] = (
            (out["Goals"] / out["Shots"] * 100).replace([np.inf], np.nan).round(2)
        )

    out["Big Chances Missed"] = np.nan
    out["Hit Woodwork"] = np.nan
    out["Offsides"] = master.get("Off")
    out["Touches"] = master.get("Touches")
    out["Passes"] = master.get("Att")
    out["Successful Passes"] = master.get("Cmp")
    out["Passes%"] = master.get("Cmp%")
    out["Crosses"] = master.get("Crs")
    out["Successful Crosses"] = np.nan
    out["Crosses %"] = np.nan
    out["fThird Passes"] = master.get("1/3")
    out["Successful fThird Passes"] = np.nan
    out["fThird Passes %"] = np.nan
    out["Through Balls"] = master.get("TB")
    out["Carries"] = master.get("Carries")
    out["Progressive Carries"] = master.get("PrgC")
    out["Carries Final Third"] = (
        master.get("Carries into Final Third")
        if "Carries into Final Third" in master.columns
        else master.get("C1/3")
    )
    out["Carries Pen Area"] = master.get("CPA")
    out["Passes to Pen Area"] = master.get("PPA")
    out["Crosses to Pen Area"] = master.get("CrsPA")

    out = out.sort_values(["Club", "Minutes"], ascending=[True, False]).reset_index(
        drop=True
    )
    return out


def main():
    dfs = get_tables()
    out = build_master(dfs)
    out.to_csv("epl_players_2023_24_fbref_like.csv", index=False)
    print(
        f"Saved: epl_players_2023_24_fbref_like.csv  rows={len(out)}  cols={out.shape[1]}"
    )


if __name__ == "__main__":
    main()
