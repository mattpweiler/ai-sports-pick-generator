#!/usr/bin/env python3
"""
build_truth_training_snapshot.py

Builds truth-aligned rolling features for training by computing L3/L5/L10/Season
directly from v_player_game_logs_all (boxscores), and materializes them into
public.player_game_features_truth_snapshot for fast ML training.
"""

import os
import math
import argparse
from datetime import datetime, date
from typing import Any, Dict, List

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client


BOOL_COLS = ["is_back_to_back","is_3_in_4","is_4_in_6","is_home"]

def supa():
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE")
    if not url or not key:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE")
    return create_client(url, key)

def fetch_all(sb, table, cols, season=None, start=None, end=None, page_size=1000, date_col="game_date"):
    out = []
    offset = 0
    while True:
        q = sb.schema("public").table(table).select(cols)
        if season:
            q = q.eq("season", season)
        if start:
            q = q.gte(date_col, start)
        if end:
            q = q.lte(date_col, end)
        resp = q.range(offset, offset + page_size - 1).execute()
        data = resp.data or []
        out.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
    return pd.DataFrame(out)

def json_safe_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    import numpy as np

    def to_safe(v):
        if v is None:
            return None
        if isinstance(v, float) and (math.isnan(v) or v == float("inf") or v == float("-inf")):
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

    return [{k: to_safe(v) for k, v in r.items()} for r in df.to_dict(orient="records")]

def main():
    load_dotenv(".env.local")
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", default="2024-25")
    ap.add_argument("--start", default="2024-10-22")
    ap.add_argument("--end", default="2025-04-15")
    ap.add_argument("--batch", type=int, default=500)
    args = ap.parse_args()

    sb = supa()

    # Base rows
    base_cols = [
        "game_id","player_id","season","game_date",
        "opponent_team_id","is_home",
        "days_rest","is_back_to_back","is_3_in_4","is_4_in_6",
        "minutes","pts","reb","ast","pra",
        "pts_baseline","reb_baseline","ast_baseline","pra_baseline","min_baseline",
    ]

    print(f"→ Fetch base rows from player_game_features: {args.season} {args.start}..{args.end}")
    base = fetch_all(sb, "player_game_features", ",".join(base_cols), season=args.season, start=args.start, end=args.end)
    base["game_date"] = pd.to_datetime(base["game_date"], errors="coerce").dt.date

    for b in BOOL_COLS:
        if b in base.columns:
            s = base[b]
            if s.dtype == object:
                s = s.astype(str).str.lower().map({"true": 1, "false": 0, "t": 1, "f": 0})
            base[b] = s.fillna(0).astype(int)

    pids = sorted(base["player_id"].dropna().unique().tolist())
    print(f"→ Base rows: {len(base)} | players: {len(pids)}")
    print("→ Fetch truth logs from v_player_game_logs_all...")

    # Pull logs
    logs_parts = []
    CHUNK = 200
    for i in range(0, len(pids), CHUNK):
        chunk = pids[i:i+CHUNK]
        resp = (
            sb.schema("public").table("v_player_game_logs_all")
            .select("player_id,game_date,season,minutes,pts,reb,ast")
            .eq("season", args.season)
            .in_("player_id", chunk)
            .execute()
        )
        logs_parts.extend(resp.data or [])

    logs = pd.DataFrame(logs_parts)

    rename = {}
    if "pts" not in logs.columns and "points" in logs.columns:
      rename["points"] = "pts"
    if "reb" not in logs.columns and "rebounds" in logs.columns:
      rename["rebounds"] = "reb"
    if "ast" not in logs.columns and "assists" in logs.columns:
      rename["assists"] = "ast"
    if rename:
      logs = logs.rename(columns=rename)

    required = ["player_id","game_date","season","minutes","pts","reb","ast"]
    missing = [c for c in required if c not in logs.columns]
    if missing:
      raise RuntimeError(f"v_player_game_logs_all missing required columns: {missing}. Found: {list(logs.columns)}")
    logs["game_date"] = pd.to_datetime(logs["game_date"], errors="coerce").dt.date
    for c in ["minutes","pts","reb","ast"]:
        logs[c] = pd.to_numeric(logs[c], errors="coerce")

    logs["pra"] = logs["pts"] + logs["reb"] + logs["ast"]
    logs = logs.sort_values(["player_id","game_date"])
    grouped = {pid: df.reset_index(drop=True) for pid, df in logs.groupby("player_id")}

    def last_n_avg(df, col, n):
        s = df[col].dropna()
        if s.empty:
            return None
        return float(s.tail(n).mean())

    def season_avg(df, col):
        s = df[col].dropna()
        if s.empty:
            return None
        return float(s.mean())

    rows = []
    for r in base.itertuples(index=False):
        pid = int(r.player_id)
        gdate = r.game_date
        hist = grouped.get(pid)
        if hist is None:
          # empty but with the columns we will reference
          hist = pd.DataFrame(columns=["game_date", "minutes", "pts", "reb", "ast", "pra"])

        prior = hist[hist["game_date"] < gdate]

        row = r._asdict()

        row["pts_l3"] = last_n_avg(prior, "pts", 3)
        row["pts_l5"] = last_n_avg(prior, "pts", 5)
        row["pts_l10"] = last_n_avg(prior, "pts", 10)
        row["pts_season_avg"] = season_avg(prior, "pts")

        row["reb_l3"] = last_n_avg(prior, "reb", 3)
        row["reb_l5"] = last_n_avg(prior, "reb", 5)
        row["reb_l10"] = last_n_avg(prior, "reb", 10)
        row["reb_season_avg"] = season_avg(prior, "reb")

        row["ast_l3"] = last_n_avg(prior, "ast", 3)
        row["ast_l5"] = last_n_avg(prior, "ast", 5)
        row["ast_l10"] = last_n_avg(prior, "ast", 10)
        row["ast_season_avg"] = season_avg(prior, "ast")

        row["pra_l3"] = last_n_avg(prior, "pra", 3)
        row["pra_l5"] = last_n_avg(prior, "pra", 5)
        row["pra_l10"] = last_n_avg(prior, "pra", 10)
        row["pra_season_avg"] = season_avg(prior, "pra")

        row["min_l3"] = last_n_avg(prior, "minutes", 3)
        row["min_l5"] = last_n_avg(prior, "minutes", 5)
        row["min_l10"] = last_n_avg(prior, "minutes", 10)
        row["min_season_avg"] = season_avg(prior, "minutes")

        row["computed_at"] = datetime.utcnow().isoformat()
        for b in BOOL_COLS:
            row[b] = bool(row[b])

        rows.append(row)

    out = pd.DataFrame(rows)

    snapshot_cols = [
        "game_id","player_id","season","game_date",
        "opponent_team_id","is_home",
        "days_rest","is_back_to_back","is_3_in_4","is_4_in_6",
        "minutes","pts","reb","ast","pra",
        "pts_l3","pts_l5","pts_l10","pts_season_avg",
        "reb_l3","reb_l5","reb_l10","reb_season_avg",
        "ast_l3","ast_l5","ast_l10","ast_season_avg",
        "pra_l3","pra_l5","pra_l10","pra_season_avg",
        "min_l3","min_l5","min_l10","min_season_avg",
        "pts_baseline","reb_baseline","ast_baseline","pra_baseline","min_baseline",
        "computed_at",
    ]

    out = out[snapshot_cols]

    # --- Force integer columns to real ints (or None) so Postgres doesn't see "2.0" ---
    INT_COLS = ["game_id", "player_id", "opponent_team_id", "days_rest"]

    for c in INT_COLS:
        if c in out.columns:
            out[c] = pd.to_numeric(out[c], errors="coerce")
            # convert 2.0 -> 2, NaN -> <NA>
            out[c] = out[c].round(0).astype("Int64")

    # Ensure game_date is ISO date string (PostgREST-safe)
    out["game_date"] = pd.to_datetime(out["game_date"], errors="coerce").dt.date.astype(str)

    # Ensure computed_at is ISO string
    out["computed_at"] = pd.to_datetime(out["computed_at"], errors="coerce").dt.tz_localize(None).astype(str)

    # Ensure booleans are actual bool (or None)
    for b in ["is_home", "is_back_to_back", "is_3_in_4", "is_4_in_6"]:
        if b in out.columns:
            out[b] = out[b].apply(lambda x: None if pd.isna(x) else bool(x))

    recs = json_safe_records(out)

    print(f"→ Upserting snapshot rows: {len(recs)}")

    total = 0
    for i in range(0, len(recs), args.batch):
        batch = recs[i:i+args.batch]
        sb.schema("public").table("player_game_features_truth_snapshot").upsert(
            batch, on_conflict="game_id,player_id"
        ).execute()
        total += len(batch)
        print(f"  … upserted {total}/{len(recs)}")

    print("✅ Truth snapshot built successfully.")

if __name__ == "__main__":
    main()
