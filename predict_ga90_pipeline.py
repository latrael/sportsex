#!/usr/bin/env python3


from pathlib import Path
import numpy as np
import pandas as pd
from unidecode import unidecode
import joblib

from sklearn.compose import ColumnTransformer
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from sklearn.pipeline import Pipeline
from sklearn.ensemble import HistGradientBoostingRegressor
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score

# ---------------------------------------------------------------------------
# 0) CONFIG: Seasons + core parameters
# ---------------------------------------------------------------------------

# Ordered chronologically: "label" -> CSV path
SEASONS = {
    "2022/23": "epl_players_2022_23_fbref_like.csv",
    "2023/24": "epl_players_2023_24_fbref_like.csv",
    "2024/25": "epl_player_stats_24_25.csv",
    # add more if you have them, e.g.:
    # "2021/22": "epl_players_2021_22_fbref_like.csv",
}

# Minimum minute thresholds (to stabilize GA90)
MIN_MINUTES_PREV = 900   # player must play this much in season t
MIN_MINUTES_NEXT = 600   # and this much in season t+1 to be a training label
MIN_MINUTES_PRED = 600   # minimum minutes in latest season to be scored

RANDOM_STATE = 42

# ---------------------------------------------------------------------------
# 1) Utility helpers
# ---------------------------------------------------------------------------

RENAME_CANON = {
    # map common column variants to canonical names used here
    "Player": "Player Name",
    "Team": "Club",
    "Squad": "Club",
    "Nation": "Nationality",
    "Pos": "Position",
    "MP": "Appearances",
    "Min": "Minutes",
    "Gls": "Goals",
    "Ast": "Assists",
    "Shots on Target": "Shots On Target",
    "Shots On Target": "Shots On Target",
    "Passes_Att": "Passes",          # FBref attempt column
    "Cmp": "Successful Passes",
    "Cmp%": "Passes%",
}

# core per-90 / rate features we will use
NUMERIC_FEATS = [
    "G90", "A90", "GA90",
    "Sh90", "SoT90",
    "PassAtt90",
    "Touches90", "Carries90", "PrgC90", "TB90",
    "SOT%", "Passes%", "Age",
]

CAT_FEATS = ["pos_bucket"]   # simple, strong positional signal


def canon_name(x: str) -> str:
    """Normalize player name for matching across seasons."""
    if pd.isna(x):
        return ""
    x = unidecode(str(x)).lower().strip()
    x = " ".join(x.split())
    return x


def build_name_key(df: pd.DataFrame, name_col: str = "Player Name") -> pd.Series:
    """
    Build a key based on normalized player name.
    Using name-only is usually fine for EPL; if you later add Born-year
    you can extend this to name|year safely.
    """
    return df[name_col].map(canon_name)


def safe_div(num, den):
    num = pd.to_numeric(num, errors="coerce")
    den = pd.to_numeric(den, errors="coerce")
    with np.errstate(divide="ignore", invalid="ignore"):
        x = num / den
    x[~np.isfinite(x)] = np.nan
    return x


def map_position_bucket(raw: str) -> str:
    """Map free-form position strings to coarse buckets."""
    if not isinstance(raw, str):
        return "UNK"
    r = raw.upper()
    # FBref often gives "FW,MF" etc: take the first part
    r = r.split(",")[0].strip()

    # Basic buckets
    if r in {"GK", "GOALKEEPER"}:
        return "GK"
    if r in {"CB", "RCB", "LCB", "CBR", "CBL", "DF", "DEF", "CENTER BACK"}:
        return "CB"
    if r in {"RB", "LB", "RWB", "LWB", "FB", "FULLBACK"}:
        return "FB"
    if r in {"DM", "CDM"}:
        return "CM"
    if r in {"CM", "MID", "MF"}:
        return "CM"
    if r in {"AM", "CAM"}:
        return "W"  # treat AM as attacking mid / winger-ish for now
    if r in {"LW", "RW", "RM", "LM", "W", "WINGER"}:
        return "W"
    if r in {"CF", "ST", "STRIKER", "FW"}:
        return "ST"
    return "UNK"


# ---------------------------------------------------------------------------
# 2) Load & standardize each season
# ---------------------------------------------------------------------------

def load_and_normalize(path: str) -> pd.DataFrame:
    """Load a season CSV and normalize to a common schema."""
    df = pd.read_csv(path)

    # Pass 1: rename obvious variants
    rename_map = {k: v for k, v in RENAME_CANON.items() if k in df.columns}
    df = df.rename(columns=rename_map)

    # Ensure core columns exist (fill with NaN if missing)
    needed_cols = [
        "Player Name", "Club", "Nationality", "Position",
        "Appearances", "Minutes", "Goals", "Assists",
        "Shots", "Shots On Target", "Touches", "Carries",
        "Progressive Carries", "Passes", "Through Balls",
        "SOT%", "Passes%", "Age",
    ]
    for c in needed_cols:
        if c not in df.columns:
            df[c] = np.nan

    # strip whitespace from key text columns
    for c in ["Player Name", "Club", "Nationality", "Position"]:
        df[c] = df[c].astype(str).str.strip()

    return df


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    """Create per-90 features, GA90, and position bucket."""
    out = df.copy()
    m = out["Minutes"].replace(0, np.nan)

    out["G90"]   = safe_div(out["Goals"], m) * 90
    out["A90"]   = safe_div(out["Assists"], m) * 90
    out["GA90"]  = out["G90"] + out["A90"]

    out["Sh90"]  = safe_div(out["Shots"], m) * 90
    out["SoT90"] = safe_div(out["Shots On Target"], m) * 90
    out["Touches90"] = safe_div(out["Touches"], m) * 90
    out["Carries90"] = safe_div(out["Carries"], m) * 90
    out["PrgC90"]    = safe_div(out["Progressive Carries"], m) * 90
    out["PassAtt90"] = safe_div(out["Passes"], m) * 90
    out["TB90"]      = safe_div(out["Through Balls"], m) * 90

    for c in ["SOT%", "Passes%", "Age"]:
        out[c] = pd.to_numeric(out[c], errors="coerce")

    # coarse position bucket
    out["pos_bucket"] = out["Position"].apply(map_position_bucket)

    return out


def attach_player_key(df: pd.DataFrame) -> pd.DataFrame:
    """Attach a canonical player_key column for matching across seasons."""
    df = df.copy()
    df["player_key"] = build_name_key(df, "Player Name")
    return df


# ---------------------------------------------------------------------------
# 3) Build training samples from season pairs
# ---------------------------------------------------------------------------

def make_pair_samples(
    prev_df: pd.DataFrame,
    next_df: pd.DataFrame,
    min_prev: int = MIN_MINUTES_PREV,
    min_next: int = MIN_MINUTES_NEXT,
):
    """Build X/y pair samples for one season → next season."""

    # Filter for minutes
    prev_f = prev_df.copy()
    next_f = next_df.copy()

    # Normalize minutes column name in case it's lowercase
    for df in [prev_f, next_f]:
        if "minutes" in df.columns and "Minutes" not in df.columns:
            df.rename(columns={"minutes": "Minutes"}, inplace=True)
        if "min" in df.columns and "Minutes" not in df.columns:
            df.rename(columns={"min": "Minutes"}, inplace=True)

    # Apply minute thresholds
    prev_f = prev_f[prev_f["Minutes"] >= min_prev]
    next_f = next_f[next_f["Minutes"] >= min_next]

    # Make sure Goals/Assists exist
    for col in ["Goals", "Assists"]:
        for df in [prev_f, next_f]:
            if col not in df.columns:
                df[col] = 0

    # Merge on player_key
    merged = prev_f.merge(
        next_f[["player_key", "Minutes", "Goals", "Assists"]],
        on="player_key",
        how="inner",
        suffixes=("_prev", "_next")
    )

    if merged.empty:
        return merged

    # Compute GA90_next
    m_next = merged["Minutes_next"].replace(0, np.nan)
    g_next = safe_div(merged["Goals_next"], m_next) * 90
    a_next = safe_div(merged["Assists_next"], m_next) * 90
    merged["target"] = g_next + a_next

    # Some files may produce "Minutes_prev" OR "Minutes" — handle both:
    if "Minutes_prev" in merged.columns:
        merged["Minutes"] = merged["Minutes_prev"]
    elif "Minutes" in merged.columns:
        merged["Minutes"] = merged["Minutes"]
    else:
        merged["Minutes"] = np.nan  # fallback, should never happen

    cols_keep = (
        ["player_key", "Player Name", "Club", "Position", "Minutes", "target"]
        + NUMERIC_FEATS
        + CAT_FEATS
    )

    # Make sure all columns exist
    for c in cols_keep:
        if c not in merged.columns:
            merged[c] = np.nan

    return merged[cols_keep].copy()



# ---------------------------------------------------------------------------
# 4) Train + evaluate + predict
# ---------------------------------------------------------------------------

def main():


    # ---- Load, normalize, feature-engineer all seasons
    season_labels = list(SEASONS.keys())
    # Ensure chronological order (keys should already be in order, but be safe)
    if season_labels != sorted(season_labels):
        raise ValueError("Please order SEASONS chronologically (e.g., '2022/23', '2023/24', ...).")

    raw = {}
    for s, path in SEASONS.items():
        p = Path(path)
        if not p.exists():
            raise FileNotFoundError(f"Missing season file for {s}: {path}")
        df = load_and_normalize(path)
        df = engineer_features(df)
        df = attach_player_key(df)
        raw[s] = df
        print(f"Loaded season {s}: {len(df)} players")

    # ---- Build pairwise training data from consecutive seasons
    pair_dfs = []
    pair_labels = []

    for i in range(len(season_labels) - 1):
        s_prev = season_labels[i]
        s_next = season_labels[i + 1]
        prev_df = raw[s_prev]
        next_df = raw[s_next]

        pair_data = make_pair_samples(prev_df, next_df)
        if pair_data.empty:
            print(f"[WARN] No overlapping players for pair {s_prev} -> {s_next} after filters.")
            continue

        pair = f"{s_prev}->{s_next}"
        pair_data["pair"] = pair
        pair_dfs.append(pair_data)
        pair_labels.append(pair)
        print(f"Pair {pair}: {len(pair_data)} samples")

    if not pair_dfs:
        raise ValueError("No training pairs were built. Check your CSVs and column mappings.")

    train_data = pd.concat(pair_dfs, ignore_index=True)

    # ---- Define features and target
    X_all = train_data[NUMERIC_FEATS + CAT_FEATS]
    y_all = train_data["target"].astype(float)
    pair_all = train_data["pair"]

    # ---- Preprocessing + model
    numeric_cols = NUMERIC_FEATS
    cat_cols = CAT_FEATS

    preprocessor = ColumnTransformer(
        transformers=[
            ("num", StandardScaler(), numeric_cols),
            ("cat", OneHotEncoder(handle_unknown="ignore"), cat_cols),
        ],
        remainder="drop",
    )

    model = HistGradientBoostingRegressor(
        max_depth=4,
        learning_rate=0.06,
        max_iter=600,
        l2_regularization=1.0,
        early_stopping=True,
        validation_fraction=0.2,
        random_state=RANDOM_STATE,
    )

    pipe = Pipeline(
        steps=[
            ("preprocess", preprocessor),
            ("model", model),
        ]
    )

    # ---- Time-based validation:
    # use all but the last pair(s) as train, last pair as test
    unique_pairs = sorted(train_data["pair"].unique())
    if len(unique_pairs) == 1:
        print("[INFO] Only one season-pair available; using all data for training (no hold-out test).")
        X_train, y_train = X_all, y_all
        X_test, y_test = None, None
    else:
        last_pair = unique_pairs[-1]
        train_mask = pair_all != last_pair
        test_mask = pair_all == last_pair

        X_train, y_train = X_all[train_mask], y_all[train_mask]
        X_test, y_test = X_all[test_mask], y_all[test_mask]

        print(f"Training on pairs: {[p for p in unique_pairs if p != last_pair]}")
        print(f"Testing on pair: {last_pair}")

    # ---- Fit + evaluate
    pipe.fit(X_train, y_train)
    print("Model training complete.")

    if X_test is not None and len(X_test) > 0:
        y_pred = pipe.predict(X_test)
        # manual RMSE to support older/newer sklearn
        mse = mean_squared_error(y_test, y_pred)
        rmse = mse ** 0.5

        mae = mean_absolute_error(y_test, y_pred)
        r2 = r2_score(y_test, y_pred)
        print(f"Time-based hold-out ({last_pair}) — RMSE: {rmse:.4f}  MAE: {mae:.4f}  R^2: {r2:.3f}")
    else:
        print("No separate test pair to evaluate on.")

    # ---- Retrain on ALL data (optional but recommended for final predictions)
    pipe.fit(X_all, y_all)
    print("Refit on all training pairs for final prediction.")

    # -----------------------------------------------------------------------
    # 5) Predict GA90_next for latest season (investable universe)
    # -----------------------------------------------------------------------
    latest = season_labels[-1]  # e.g., "2024/25"
    latest_df = raw[latest].copy()

    # investable universe filter
    latest_df = latest_df[latest_df["Minutes"] >= MIN_MINUTES_PRED].copy()
    latest_df = latest_df.reset_index(drop=True)

    # ensure all feature columns present
    for c in NUMERIC_FEATS + CAT_FEATS:
        if c not in latest_df.columns:
            latest_df[c] = np.nan

    X_latest = latest_df[NUMERIC_FEATS + CAT_FEATS]

    joblib.dump(pipe, "model_pipe.pkl")
    joblib.dump(X_test, "X_test.pkl")
    joblib.dump(y_test, "y_test.pkl")
    joblib.dump(NUMERIC_FEATS, "numeric_feats.pkl")
    joblib.dump(CAT_FEATS, "cat_feats.pkl")

    print("Saved model + evaluation data: model_pipe.pkl, X_test.pkl, y_test.pkl")

    pred_latest = pipe.predict(X_latest)

    # Build output DataFrame
    scored = latest_df[
        ["player_key", "Player Name", "Club", "Position", "Minutes", "Goals", "Assists", "G90", "A90", "GA90"]
    ].copy()

    scored["pred_GA90_next"] = pred_latest
    scored = scored.sort_values("pred_GA90_next", ascending=False).reset_index(drop=True)

    # Cosmetic next-season label: "2024/25" -> "2025-26"
    start, end = latest.split("/")
    start_year = int(start)
    end_year = int(end)
    next_start = end_year
    next_end = end_year + 1
    next_label = f"{next_start}-{str(next_end)[-2:]}"

    out_name = f"investable_players_pred_{next_label}.csv"
    scored.to_csv(out_name, index=False)
    print(f"\nSaved predictions for {latest} -> {next_label}: {out_name}")
    print(scored.head(20))


if __name__ == "__main__":
    main()
