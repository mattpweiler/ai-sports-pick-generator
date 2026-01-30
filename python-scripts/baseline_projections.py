#!/usr/bin/env python3
"""
Baseline projections (fast ship) using public.player_game_features.

Reads:
  - public.player_game_features

Writes:
  - public.player_stat_projections (upsert)

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE

Install:
  python3 -m pip install --user pandas python-dotenv supabase scipy
"""

import argparse
import os
import math
from datetime import datetime, date
from typing import Any, Dict, List, Optional

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client
from scipy.stats import norm


SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", "")


def supa() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=str, required=True, help="YYYY-MM-DD")
    ap.add_argument("--end", type=str, required=True, help="YYYY-MM-DD")
    ap.add_argument("--season", type=str, default=None, help="Optional filter, e.g. 2025-26")
    ap.add_argument("--upsert-batch", type=int, default=500)
    return ap.parse_args()


def df_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    import numpy as np

    def to_json_safe(v):
        if v is None:
            return None
        if isinstance(v, float) and math.isnan(v):
            return None
        if isinstance(v, (pd.Timestamp, datetime)):
            return v.isoformat()
        if isinstance(v, date):
            return v.isoformat()
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            return float(v)
        if isinstance(v, (np.bool_,)):
            return bool(v)
        return v

    return [{k: to_json_safe(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def fetch_features(sb: Client, start: str, end: str, season: Optional[str]) -> pd.DataFrame:
    # Pull only what we need for baseline
    cols = ",".join([
        "game_id","player_id","season","game_date",
        "minutes","pts","reb","ast","pra",
        "pts_l5","pts_l10","pts_season_avg",
        "reb_l5","reb_l10","reb_season_avg",
        "ast_l5","ast_l10","ast_season_avg",
        "pra_l5","pra_l10","pra_season_avg",
        "min_l5","min_l10","min_season_avg"
    ])

    # pagination
    out = []
    offset = 0
    page = 1000
    while True:
        q = (sb.schema("public")
               .table("player_game_features")
               .select(cols)
               .gte("game_date", start)
               .lte("game_date", end))
        if season:
            q = q.eq("season", season)

        resp = q.range(offset, offset + page - 1).execute()
        data = resp.data or []
        out.extend(data)
        if len(data) < page:
            break
        offset += page

    df = pd.DataFrame(out)
    if df.empty:
        return df

    df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")
    for c in ["minutes","pts","reb","ast","pra",
              "pts_l5","pts_l10","pts_season_avg",
              "reb_l5","reb_l10","reb_season_avg",
              "ast_l5","ast_l10","ast_season_avg",
              "pra_l5","pra_l10","pra_season_avg",
              "min_l5","min_l10","min_season_avg"]:
        df[c] = pd.to_numeric(df[c], errors="coerce")
    return df


def baseline_mean(l5, l10, season_avg):
    # weighted blend; missing values gracefully handled
    weights = []
    vals = []
    if pd.notna(l5):
        vals.append(l5); weights.append(0.5)
    if pd.notna(l10):
        vals.append(l10); weights.append(0.3)
    if pd.notna(season_avg):
        vals.append(season_avg); weights.append(0.2)

    if not vals:
        return None

    # renormalize weights if some missing
    wsum = sum(weights)
    return sum(v * (w/wsum) for v, w in zip(vals, weights))


def baseline_std(row: pd.Series, stat: str) -> float:
    """
    MVP std: use abs(diff between l10 and season_avg) as a fallback if true std not available.
    This avoids shipping "std = null".
    """
    l10 = row.get(f"{stat}_l10")
    savg = row.get(f"{stat}_season_avg")
    if pd.notna(l10) and pd.notna(savg):
        return max(1.0, float(abs(l10 - savg)))  # crude, but works as MVP
    return 5.0 if stat == "pts" else 2.5  # generic fallback


def run():
    load_dotenv(".env.local")

    global SUPABASE_URL, SUPABASE_SERVICE_ROLE
    SUPABASE_URL = os.getenv("SUPABASE_URL", SUPABASE_URL)
    SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", SUPABASE_SERVICE_ROLE)

    args = parse_args()
    sb = supa()

    df = fetch_features(sb, args.start, args.end, args.season)
    if df.empty:
        print("No feature rows found in that window.")
        return

    rows = []

    for _, r in df.iterrows():
        # projected minutes: use recent l5 if present, else season
        proj_min = r.get("min_l5")
        if pd.isna(proj_min):
            proj_min = r.get("min_season_avg")

        season_min = r.get("min_season_avg")
        min_multiplier = 1.0
        if pd.notna(proj_min) and pd.notna(season_min) and season_min > 0:
            min_multiplier = float(proj_min / season_min)

        # ---- PTS ----
        pts_mu = baseline_mean(r.get("pts_l5"), r.get("pts_l10"), r.get("pts_season_avg"))
        if pts_mu is not None:
            pts_mu *= min_multiplier
        pts_sd = baseline_std(r, "pts")

        # ---- REB ----
        reb_mu = baseline_mean(r.get("reb_l5"), r.get("reb_l10"), r.get("reb_season_avg"))
        if reb_mu is not None:
            reb_mu *= min_multiplier
        reb_sd = baseline_std(r, "reb")

        # ---- AST ----
        ast_mu = baseline_mean(r.get("ast_l5"), r.get("ast_l10"), r.get("ast_season_avg"))
        if ast_mu is not None:
            ast_mu *= min_multiplier
        ast_sd = baseline_std(r, "ast")

        # ---- PRA ---- (sum for MVP)
        pra_mu = None
        pra_sd = None
        if pts_mu is not None and reb_mu is not None and ast_mu is not None:
            pra_mu = float(pts_mu + reb_mu + ast_mu)
            # crude variance add (assume low correlation)
            pra_sd = float(math.sqrt(pts_sd**2 + reb_sd**2 + ast_sd**2))
        else:
            pra_mu = baseline_mean(r.get("pra_l5"), r.get("pra_l10"), r.get("pra_season_avg"))
            pra_sd = baseline_std(r, "pra")

        base = {
            "game_id": int(r["game_id"]) if pd.notna(r["game_id"]) else None,
            "player_id": int(r["player_id"]) if pd.notna(r["player_id"]) else None,
            "season": r.get("season"),
            "game_date": r["game_date"].date() if pd.notna(r["game_date"]) else None,
        }

        rows.append({**base, "stat_type": "PTS", "projected_mean": pts_mu, "projected_std": pts_sd})
        rows.append({**base, "stat_type": "REB", "projected_mean": reb_mu, "projected_std": reb_sd})
        rows.append({**base, "stat_type": "AST", "projected_mean": ast_mu, "projected_std": ast_sd})
        rows.append({**base, "stat_type": "PRA", "projected_mean": pra_mu, "projected_std": pra_sd})

    out_df = pd.DataFrame(rows).dropna(subset=["game_id", "player_id", "stat_type"])

    # upsert
    recs = df_records(out_df)
    batch = args.upsert_batch
    total = 0
    for i in range(0, len(recs), batch):
        sb.schema("public").table("player_stat_projections").upsert(
            recs[i:i+batch],
            on_conflict="game_id,player_id,stat_type"
        ).execute()
        total += len(recs[i:i+batch])

    print(f"✅ Upserted projections: {total}")


if __name__ == "__main__":
    run()
