#!/usr/bin/env python3
"""
pl_setup.py — Starter pipeline for Premier League player "stock exchange"
Usage:
    python pl_setup.py --input path/to/pl_2425.csv --outdir ./out

What it does:
1) Loads the 24/25 CSV with the columns you described.
2) Cleans column names and types.
3) Adds per90 features for counting stats (e.g., Goals/90).
4) Buckets positions (ST, W, AM, CM, FB, CB, GK).
5) Computes cohort (position) z-scores & percentiles for key metrics.
6) Produces a simple baseline value_v0 using role-specific weights.
7) Writes cleaned parquet + a CSV with value_v0.

You can rerun safely; nonexistent columns are skipped gracefully.
"""
import argparse
from pathlib import Path
import sys
import math
import pandas as pd
import numpy as np

def norm_col(c: str) -> str:
    c = c.strip()
    c = c.replace('%','pct')
    c = c.replace(' ', '_').replace('-', '_')
    return c.lower()

def map_position(raw: str) -> str:
    if not isinstance(raw, str):
        return 'UNK'
    r = raw.upper()
    if r in {'GK', 'GOALKEEPER'}:
        return 'GK'
    if r in {'CB', 'RCB','LCB','DEF','DF','CBR','CBL','CENTER_BACK'}:
        return 'CB'
    if r in {'RB','LB','RWB','LWB','FB','FULLBACK'}:
        return 'FB'
    if r in {'DM','CDM','CM','MID','MF'}:
        return 'CM'
    if r in {'AM','CAM','RM','LM','LW','RW','W','WINGER'}:
        return 'W'  # group wide/attacking mids
    if r in {'CF','ST','STRIKER','FW'}:
        return 'ST'
    return 'UNK'

def safe_per90(numer, minutes):
    return np.where(minutes>0, 90.0 * numer / minutes, 0.0)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--input', required=True, help='Path to 24/25 CSV')
    ap.add_argument('--outdir', default='./out', help='Directory to write outputs')
    args = ap.parse_args()

    outdir = Path(args.outdir)
    outdir.mkdir(parents=True, exist_ok=True)

    # Load
    df = pd.read_csv(args.input)
    # Normalize column names
    df.columns = [norm_col(c) for c in df.columns]

    # Expected core columns (case-insensitive already)
    rename_map = {
        'player_name':'player',
        'club':'club',
        'nationality':'nationality',
        'position':'position',
        'appearances':'appearances',
        'minutes':'minutes',
        'shots_on_target':'shots_on_target',
        'successful_passes':'passes_completed',
        'passes%':'pass_pct',
        'passes_pct':'pass_pct',
        'crosses%':'crosses_pct',
        'gduels_%':'gduels_pct',
        'aduels_%':'aduels_pct',
        'saves%':'saves_pct',
    }
    for src, dst in list(rename_map.items()):
        if src in df.columns and dst not in df.columns:
            df.rename(columns={src: dst}, inplace=True)

    # Ensure required minimal columns
    required = ['player','club','position','appearances','minutes']
    for r in required:
        if r not in df.columns:
            print(f"[WARN] Missing column: {r}. Creating default zeros.", file=sys.stderr)
            df[r] = 0

    # Clean numeric columns that might be strings with %
    def to_num(series):
        if series.dtype.kind in 'biufc':
            return series
        s = series.astype(str).str.replace('%','', regex=False).str.replace(',','', regex=False)
        return pd.to_numeric(s, errors='coerce')

    numeric_candidates = [c for c in df.columns if c not in ['player','club','nationality','position']]
    for c in numeric_candidates:
        df[c] = to_num(df[c])
    df.fillna(0.0, inplace=True)

    # Position buckets
    df['pos_bucket'] = df['position'].apply(map_position)

    # Per90 for counting stats (skip minutes/appearances and obvious rate columns)
    count_like = [
        'goals','assists','shots','shots_on_target','big_chances_missed','hit_woodwork','offsides',
        'touches','passes','passes_completed','crosses','successful_crosses','fouls',
        'through_balls','carries','progressive_carries','carries_ended_with_goal','carries_ended_with_assist',
        'carries_ended_with_shot','carries_ended_with_chance','possession_won','dispossessed',
        'clearances','interceptions','blocks','tackles','ground_duels','gduels_won','aerial_duels',
        'aduels_won','goals_conceded','xgot_conceded','own_goals','yellow_cards','red_cards','saves',
        'penalties_saved','clearances_off_line','punches','high_claims','goals_prevented'
    ]
    for c in count_like:
        if c in df.columns:
            df[f'{c}_per90'] = safe_per90(df[c].values, df['minutes'].values)

    # Minutes availability features
    df['mins_per_app'] = np.where(df['appearances']>0, df['minutes']/df['appearances'], 0.0)
    df['availability'] = df['minutes']  # simple proxy for now

    # Key metrics per role (only include if present)
    role_metrics = {
        'ST': ['goals_per90','shots_on_target_per90','shots_per90','carries_ended_with_shot_per90','gduels_won','gduels_pct'],
        'W' : ['assists_per90','carries_per90','progressive_carries_per90','successful_crosses_per90','crosses_pct','dispossessed_per90'],
        'AM': ['assists_per90','through_balls_per90','progressive_carries_per90','passes_completed','pass_pct'],
        'CM': ['progressive_carries_per90','passes_per90','pass_pct','interceptions_per90','tackles_per90','dispossessed_per90'],
        'FB': ['progressive_carries_per90','successful_crosses_per90','tackles_per90','interceptions_per90','assists_per90'],
        'CB': ['aerial_duels','aduels_won','interceptions_per90','clearances_per90','blocks_per90','goals_conceded_per90'],
        'GK': ['saves_pct','goals_prevented','goals_conceded_per90','xgot_conceded_per90','high_claims_per90','punches_per90'],
        'UNK': ['goals_per90','assists_per90','passes_per90']
    }
    # Filter to only existing columns
    for k,v in role_metrics.items():
        role_metrics[k] = [m for m in v if m in df.columns]

    # Weights per role (sum to ~1; negatives allowed for "bad" stats)
    role_weights = {
        'ST': {'goals_per90':0.35,'shots_on_target_per90':0.20,'shots_per90':0.10,'carries_ended_with_shot_per90':0.15,'gduels_won':0.10,'gduels_pct':0.10},
        'W' : {'assists_per90':0.25,'carries_per90':0.15,'progressive_carries_per90':0.20,'successful_crosses_per90':0.20,'crosses_pct':0.10,'dispossessed_per90':-0.10},
        'AM': {'assists_per90':0.30,'through_balls_per90':0.20,'progressive_carries_per90':0.20,'passes_completed':0.10,'pass_pct':0.20},
        'CM': {'progressive_carries_per90':0.20,'passes_per90':0.15,'pass_pct':0.20,'interceptions_per90':0.20,'tackles_per90':0.20,'dispossessed_per90':-0.15},
        'FB': {'progressive_carries_per90':0.25,'successful_crosses_per90':0.20,'tackles_per90':0.25,'interceptions_per90':0.20,'assists_per90':0.10},
        'CB': {'aduels_won':0.25,'aerial_duels':0.15,'interceptions_per90':0.20,'clearances_per90':0.20,'blocks_per90':0.20,'goals_conceded_per90':-0.20},
        'GK': {'saves_pct':0.35,'goals_prevented':0.30,'goals_conceded_per90':-0.25,'xgot_conceded_per90':-0.10,'high_claims_per90':0.10,'punches_per90':0.05},
        'UNK': {'goals_per90':0.4,'assists_per90':0.4,'passes_per90':0.2}
    }
    # Keep only weights for available metrics
    for k,w in role_weights.items():
        role_weights[k] = {m:wt for m,wt in w.items() if m in df.columns}

    # Compute cohort z-scores (by pos_bucket) for each metric used
    used_metrics = sorted({m for v in role_metrics.values() for m in v})
    for m in used_metrics:
        g = df.groupby('pos_bucket')[m]
        mu = g.transform('mean')
        sd = g.transform('std').replace(0, np.nan)
        z = (df[m] - mu) / sd
        df[f'{m}_z'] = z.fillna(0.0)
        # also percentiles
        df[f'{m}_pctile'] = g.rank(pct=True)

    # Simple baseline value_v0 = weighted sum of z-scores + availability term
    values = []
    for idx, row in df.iterrows():
        role = row['pos_bucket']
        metrics = role_weights.get(role, role_weights['UNK'])
        score = 0.0
        total_w = 0.0
        for m, wt in metrics.items():
            zcol = f'{m}_z'
            if zcol in df.columns:
                score += wt * row[zcol]
                total_w += abs(wt)
        # normalize by sum of |weights| to keep scale reasonable
        if total_w > 0:
            score = score / total_w
        # availability bonus (scaled)
        avail = row.get('minutes', 0.0)
        # scale availability roughly to season length (ex: 3000 mins ~ full season)
        score += 0.2 * min(avail/3000.0, 1.0)
        values.append(score)
    df['value_score_v0'] = values

    # Rescale to a 0..100 index (robust to outliers)
    low, high = np.percentile(df['value_score_v0'], [2, 98])
    rng = max(high - low, 1e-6)
    df['value_index_v0'] = 100.0 * np.clip((df['value_score_v0'] - low) / rng, 0, 1)

    # Outputs
    parquet_path = outdir / 'pl2425_clean.parquet'
    value_csv = outdir / 'pl2425_value_v0.csv'
    cols_out = ['player','club','position','pos_bucket','appearances','minutes','mins_per_app','availability','value_index_v0','value_score_v0']
    cols_out += [c for c in df.columns if c.endswith('_per90') or c.endswith('_z') or c.endswith('_pctile')]
    df.to_parquet(parquet_path, index=False)
    df[cols_out].to_csv(value_csv, index=False)

    print(f'Wrote: {parquet_path}')
    print(f'Wrote: {value_csv}')
    print('Done.')

if __name__ == "__main__":
    main()
