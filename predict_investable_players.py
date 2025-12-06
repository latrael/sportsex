import pandas as pd
import numpy as np
from unidecode import unidecode
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_squared_error, r2_score
from sklearn.ensemble import HistGradientBoostingRegressor
from pathlib import Path


SEASONS = {
    "2022/23": "epl_players_2022_23_fbref_like.csv",
    "2023/24": "epl_players_2023_24_fbref_like.csv",
    "2024/25": "epl_player_stats_24_25.csv",
}


RENAME_CANON = {
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
    "Passes_Att": "Passes",
    "Cmp": "Successful Passes",
    "Cmp%": "Passes%",
}

FEATS = [
    "G90",
    "A90",
    "GA90",
    "Sh90",
    "SoT90",
    "Touches90",
    "Carries90",
    "PrgC90",
    "PassAtt90",
    "TB90",
    "SOT%",
    "Passes%",
    "Age",
]


def canon_name(x: str) -> str:
    if pd.isna(x):
        return ""
    x = unidecode(str(x)).lower().strip()
    x = " ".join(x.split())
    return x


def build_key(df, name_col="Player Name", born_col="Born"):
    key = df[name_col].map(canon_name)
    if born_col in df.columns:
        year = (
            pd.to_numeric(df[born_col], errors="coerce")
            .fillna(-1)
            .astype(int)
            .astype(str)
        )
        key = key + "|" + year
    return key


def safe_div(num, den):
    num = pd.to_numeric(num, errors="coerce")
    den = pd.to_numeric(den, errors="coerce")
    with np.errstate(divide="ignore", invalid="ignore"):
        x = num / den
        x[~np.isfinite(x)] = np.nan
    return x


def load_and_normalize(path: str) -> pd.DataFrame:
    df = pd.read_csv(path)

    rename_map = {k: v for k, v in RENAME_CANON.items() if k in df.columns}
    df = df.rename(columns=rename_map)

    for c in [
        "Player Name",
        "Club",
        "Nationality",
        "Position",
        "Appearances",
        "Minutes",
        "Goals",
        "Assists",
        "Shots",
        "Shots On Target",
        "Touches",
        "Carries",
        "Progressive Carries",
        "Passes",
        "Through Balls",
        "SOT%",
        "Passes%",
        "Age",
        "Born",
    ]:
        if c not in df.columns:
            df[c] = np.nan

    for c in ["Player Name", "Club", "Nationality", "Position"]:
        df[c] = df[c].astype(str).str.strip()
    return df


def engineer_features(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    m = out["Minutes"].replace(0, np.nan)
    out["G90"] = safe_div(out["Goals"], m) * 90
    out["A90"] = safe_div(out["Assists"], m) * 90
    out["GA90"] = out["G90"] + out["A90"]
    out["Sh90"] = safe_div(out["Shots"], m) * 90
    out["SoT90"] = safe_div(out["Shots On Target"], m) * 90
    out["Touches90"] = safe_div(out["Touches"], m) * 90
    out["Carries90"] = safe_div(out["Carries"], m) * 90
    out["PrgC90"] = safe_div(out["Progressive Carries"], m) * 90
    out["PassAtt90"] = safe_div(out["Passes"], m) * 90
    out["TB90"] = safe_div(out["Through Balls"], m) * 90
    for c in ["SOT%", "Passes%", "Age"]:
        out[c] = pd.to_numeric(out[c], errors="coerce")
    return out


def attach_key(df: pd.DataFrame) -> pd.DataFrame:

    if "Born" in df.columns:
        df["player_key"] = build_key(df, "Player Name", "Born")
        if df["player_key"].str.endswith("|-1").all():
            df["player_key"] = df["Player Name"].map(canon_name)
    else:
        df["player_key"] = df["Player Name"].map(canon_name)
    return df


def make_pair_samples(prev_df, next_df):
    keys = set(prev_df["player_key"]).intersection(set(next_df["player_key"]))
    prev_i = prev_df[prev_df["player_key"].isin(keys)].copy()
    next_i = next_df[next_df["player_key"].isin(keys)].copy()

    m = next_i["Minutes"].replace(0, np.nan)
    next_i["G90_next"] = safe_div(next_i["Goals"], m) * 90
    next_i["A90_next"] = safe_div(next_i["Assists"], m) * 90
    next_i["GA90_next"] = next_i["G90_next"] + next_i["A90_next"]

    y = next_i[["player_key", "GA90_next"]].rename(columns={"GA90_next": "target"})
    X = prev_i[["player_key"] + [c for c in FEATS if c in prev_i.columns]].copy()

    data = X.merge(y, on="player_key", how="inner").dropna(subset=["target"])
    return data, prev_i, next_i


season_labels = list(SEASONS.keys())
assert season_labels == sorted(season_labels), "Please order SEASONS chronologically."

raw = {}
for s, path in SEASONS.items():
    if not Path(path).exists():
        raise FileNotFoundError(f"{s} file missing: {path}")
    df = load_and_normalize(path)
    df = attach_key(df)
    df = engineer_features(df)
    raw[s] = df


pairs = []
aligned_prev = {}
aligned_next = {}

for i in range(len(season_labels) - 1):
    s_prev, s_next = season_labels[i], season_labels[i + 1]
    data, prev_i, next_i = make_pair_samples(raw[s_prev], raw[s_next])
    if not data.empty:
        data["pair"] = f"{s_prev}→{s_next}"
        pairs.append(data)
        aligned_prev[s_next] = prev_i
        aligned_next[s_next] = next_i
        print(f"Pair ready: {s_prev} -> {s_next}  (samples={len(data)})")
    else:
        print(f"Skipped pair (no labeled overlap): {s_prev} -> {s_next}")

if not pairs:
    raise ValueError(
        "No trainable season pairs found. Check column names and minutes/goals/assists in 'next' seasons."
    )

train_data = pd.concat(pairs, ignore_index=True)


X = train_data.drop(columns=["player_key", "target", "pair"]).apply(
    pd.to_numeric, errors="coerce"
)
X = X.replace([np.inf, -np.inf], np.nan)
y = train_data["target"]

X_tr, X_te, y_tr, y_te = train_test_split(X, y, test_size=0.25, random_state=42)
model = HistGradientBoostingRegressor(
    max_depth=4,
    learning_rate=0.07,
    max_iter=800,
    l2_regularization=1.0,
    early_stopping=True,
    validation_fraction=0.2,
    random_state=42,
)
model.fit(X_tr, y_tr)
pred_te = model.predict(X_te)
print(
    f"Validation — RMSE: {mean_squared_error(y_te, pred_te, squared=False):.4f}  R^2: {r2_score(y_te, pred_te):.3f}"
)


latest = season_labels[-1]
predict_for = (
    f"{latest.split('/')[0]}{int(latest.split('/')[1]) + 1}/"
    f"{int(latest.split('/')[1]) + 1:02d}"
)


prev_latest = raw[latest]

X_latest = prev_latest[[c for c in FEATS if c in prev_latest.columns]].apply(
    pd.to_numeric, errors="coerce"
)
X_latest = X_latest.replace([np.inf, -np.inf], np.nan)
pred_latest = model.predict(X_latest)

scored = prev_latest[
    ["player_key", "Player Name", "Club", "Position", "Minutes", "Goals", "Assists"]
].copy()
scored["pred_GA90_next"] = pred_latest
scored["investable"] = True


scored = scored.sort_values("pred_GA90_next", ascending=False).reset_index(drop=True)

out_name = f"investable_players_pred_{predict_for.replace('/','-')}.csv"
scored.to_csv(out_name, index=False)
print(f"Saved: {out_name}")
print(scored.head(20))
