#!/usr/bin/env python3
"""
Backfill public.player_game_features using ONLY Supabase client (PostgREST).
PUBLIC-only setup assumed.

Reads:
  - public.v_player_game_logs_all
  - public.v_nba_games_all
  - public.team_id_to_team

Writes:
  - public.player_game_features (upsert on game_id,player_id)

Env (exactly like your working scripts):
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE
  (optional) SUPABASE_SCHEMA  # unused; we explicitly use public

Install:
  python3 -m pip install --user pandas python-dotenv supabase

Run examples:
  python3 python-scripts/backfill_features.py --start 2025-10-01 --end 2025-10-07
  python3 python-scripts/backfill_features.py --start 2024-10-01 --end 2025-04-15
"""

import argparse
import math
import os
from datetime import datetime, timedelta, timezone, date
from typing import Any, Dict, List, Optional

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client, Client


# ---------------------- Supabase config ----------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", "")


def supa() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE)


# ---------------------- CLI ----------------------
def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Backfill public.player_game_features (Supabase client only)")
    ap.add_argument("--start", type=str, default=None, help="YYYY-MM-DD (optional)")
    ap.add_argument("--end", type=str, default=None, help="YYYY-MM-DD (optional)")
    ap.add_argument("--chunk-days", type=int, default=60, help="Process in date chunks (default 60)")
    ap.add_argument("--dry-run", action="store_true", help="Compute features but do not write")
    ap.add_argument("--upsert-batch", type=int, default=500, help="Upsert batch size (default 500)")
    ap.add_argument("--page-size", type=int, default=1000, help="Fetch page size (default 1000)")
    return ap.parse_args()


def parse_date_opt(s: Optional[str]) -> Optional[date]:
    if not s:
        return None
    return datetime.strptime(s, "%Y-%m-%d").date()


def daterange_chunks(start: Optional[date], end: Optional[date], chunk_days: int):
    if start is None or end is None:
        yield (None, None)
        return
    cur = start
    while cur <= end:
        nxt = min(end, cur + timedelta(days=chunk_days - 1))
        yield (cur, nxt)
        cur = nxt + timedelta(days=1)


# ---------------------- JSON-safe conversion ----------------------
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
        if isinstance(v, pd._libs.missing.NAType):
            return None
        return v

    return [{k: to_json_safe(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


# ---------------------- Fetch helpers (pagination) ----------------------
def fetch_all(
    sb: Client,
    table_or_view: str,
    select_cols: str,
    start_date: Optional[date],
    end_date: Optional[date],
    date_col: str = "game_date",
    page_size: int = 1000,
) -> List[Dict[str, Any]]:
    """
    Fetch all rows from a PUBLIC table/view with optional date filters using pagination.
    """
    out: List[Dict[str, Any]] = []
    offset = 0

    while True:
        q = sb.schema("public").table(table_or_view).select(select_cols)

        if start_date is not None:
            q = q.gte(date_col, start_date.isoformat())
        if end_date is not None:
            q = q.lte(date_col, end_date.isoformat())

        resp = q.range(offset, offset + page_size - 1).execute()
        data = resp.data or []
        out.extend(data)

        if len(data) < page_size:
            break

        offset += page_size

    return out


def fetch_team_map(sb: Client, page_size: int = 1000) -> pd.DataFrame:
    out: List[Dict[str, Any]] = []
    offset = 0
    while True:
        resp = (
            sb.schema("public")
              .table("team_id_to_team")
              .select("team_id,abbreviation")
              .range(offset, offset + page_size - 1)
              .execute()
        )
        data = resp.data or []
        out.extend(data)
        if len(data) < page_size:
            break
        offset += page_size

    df = pd.DataFrame(out)
    if df.empty:
        return pd.DataFrame(columns=["team_id", "abbreviation"])
    df["abbreviation"] = df["abbreviation"].astype(str).str.upper()
    df["team_id"] = pd.to_numeric(df["team_id"], errors="coerce")
    return df


# ---------------------- Feature engineering ----------------------
def add_home_away(df_logs: pd.DataFrame, df_games: pd.DataFrame, df_teammap: pd.DataFrame) -> pd.DataFrame:
    """
    Adds is_home and opponent_team_id using games + team_id->abbreviation mapping.
    """
    teammap = df_teammap.copy()
    teammap = teammap.dropna(subset=["team_id"])
    teammap["team_id"] = teammap["team_id"].astype("int64")

    games = df_games.merge(
        teammap.rename(columns={"team_id": "home_team_id", "abbreviation": "home_abbr"}),
        on="home_team_id",
        how="left",
    ).merge(
        teammap.rename(columns={"team_id": "away_team_id", "abbreviation": "away_abbr"}),
        on="away_team_id",
        how="left",
    )

    merged = df_logs.merge(
        games[["game_id", "season", "home_team_id", "away_team_id", "home_abbr", "away_abbr"]],
        on=["game_id", "season"],
        how="left",
    )

    merged["team_abbr_u"] = merged["team_abbr"].astype(str).str.upper()

    merged["is_home"] = pd.NA
    merged.loc[merged["team_abbr_u"] == merged["home_abbr"], "is_home"] = True
    merged.loc[merged["team_abbr_u"] == merged["away_abbr"], "is_home"] = False

    merged["opponent_team_id"] = pd.NA
    merged.loc[merged["team_abbr_u"] == merged["home_abbr"], "opponent_team_id"] = merged["away_team_id"]
    merged.loc[merged["team_abbr_u"] == merged["away_abbr"], "opponent_team_id"] = merged["home_team_id"]

    merged.drop(columns=["team_abbr_u"], inplace=True)
    return merged


def rolling_prior_mean(s: pd.Series, window: int) -> pd.Series:
    return s.shift(1).rolling(window=window, min_periods=1).mean()


def season_to_date_prior_mean(s: pd.Series) -> pd.Series:
    return s.shift(1).expanding(min_periods=1).mean()


def compute_schedule_flags(df: pd.DataFrame) -> pd.DataFrame:
    """
    Adds days_rest, is_back_to_back, is_3_in_4, is_4_in_6 per (season, player_id).
    """
    df = df.sort_values(["season", "player_id", "game_date"]).copy()
    df["prev_game_date"] = df.groupby(["season", "player_id"])["game_date"].shift(1)
    df["days_rest"] = (df["game_date"] - df["prev_game_date"]).dt.days
    df.loc[df["prev_game_date"].isna(), "days_rest"] = pd.NA

    df["is_back_to_back"] = df["days_rest"] == 1
    df.loc[df["days_rest"].isna(), "is_back_to_back"] = False

    def flags_for_group(g: pd.DataFrame) -> pd.DataFrame:
        idx = pd.DatetimeIndex(g["game_date"])
        ones = pd.Series(1, index=idx)

        c_4day = ones.rolling("4D").sum().reindex(idx).values
        c_6day = ones.rolling("6D").sum().reindex(idx).values

        g = g.copy()
        g["is_3_in_4"] = c_4day >= 3
        g["is_4_in_6"] = c_6day >= 4
        return g

    return df.groupby(["season", "player_id"], group_keys=False).apply(flags_for_group)


def compute_features(df_joined: pd.DataFrame) -> pd.DataFrame:
    df = df_joined.sort_values(["season", "player_id", "game_date"]).copy()

    # Ensure numeric
    for col in ["minutes", "pts", "reb", "ast", "pra"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")

    g = df.groupby(["season", "player_id"], group_keys=False)

    # rolling stats (prior games only)
    for stat in ["pts", "reb", "ast", "pra", "minutes"]:
        df[f"{stat}_l3"] = g[stat].apply(lambda s: rolling_prior_mean(s, 3))
        df[f"{stat}_l5"] = g[stat].apply(lambda s: rolling_prior_mean(s, 5))
        df[f"{stat}_l10"] = g[stat].apply(lambda s: rolling_prior_mean(s, 10))

    # season-to-date (prior games only)
    df["pts_season_avg"] = g["pts"].apply(season_to_date_prior_mean)
    df["reb_season_avg"] = g["reb"].apply(season_to_date_prior_mean)
    df["ast_season_avg"] = g["ast"].apply(season_to_date_prior_mean)
    df["pra_season_avg"] = g["pra"].apply(season_to_date_prior_mean)
    df["min_season_avg"] = g["minutes"].apply(season_to_date_prior_mean)

    # rename minutes rolling columns to match schema
    df.rename(columns={"minutes_l3": "min_l3", "minutes_l5": "min_l5", "minutes_l10": "min_l10"}, inplace=True)

    # schedule flags
    df = compute_schedule_flags(df)

    # usg_pct optional later; keep null for now
    df["usg_pct"] = None

    df["computed_at"] = pd.Timestamp.utcnow()

    out = df[[
        "game_id", "player_id", "season", "game_date",
        "team_abbr", "opponent_team_id", "is_home",
        "minutes", "pts", "reb", "ast", "pra",

        "pts_l3", "pts_l5", "pts_l10",
        "reb_l3", "reb_l5", "reb_l10",
        "ast_l3", "ast_l5", "ast_l10",
        "pra_l3", "pra_l5", "pra_l10",

        "pts_season_avg", "reb_season_avg", "ast_season_avg", "pra_season_avg", "min_season_avg",
        "min_l3", "min_l5", "min_l10",

        "usg_pct",
        "days_rest", "is_back_to_back", "is_3_in_4", "is_4_in_6",
        "computed_at",
    ]].copy()

    # cast types
    out["game_id"] = pd.to_numeric(out["game_id"], errors="coerce").astype("Int64")
    out["player_id"] = pd.to_numeric(out["player_id"], errors="coerce").astype("Int64")
    out["opponent_team_id"] = pd.to_numeric(out["opponent_team_id"], errors="coerce").astype("Int64")
    out["days_rest"] = pd.to_numeric(out["days_rest"], errors="coerce").astype("Int64")

    for b in ["is_home", "is_back_to_back", "is_3_in_4", "is_4_in_6"]:
        out[b] = out[b].astype("boolean")

    # game_date to date (not timestamp)
    out["game_date"] = pd.to_datetime(out["game_date"], errors="coerce").dt.date

    return out


# ---------------------- Upsert ----------------------
def upsert_batches(sb: Client, df: pd.DataFrame, batch_size: int = 500) -> int:
    if df.empty:
        return 0

    records = df_records(df)
    written = 0

    for i in range(0, len(records), batch_size):
        batch = records[i:i + batch_size]
        sb.schema("public").table("player_game_features").upsert(
            batch,
            on_conflict="game_id,player_id"
        ).execute()
        written += len(batch)

    return written


# ---------------------- Main ----------------------
def main():
    load_dotenv(".env.local")  # optional

    global SUPABASE_URL, SUPABASE_SERVICE_ROLE
    SUPABASE_URL = os.getenv("SUPABASE_URL", SUPABASE_URL)
    SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", SUPABASE_SERVICE_ROLE)

    args = parse_args()
    start = parse_date_opt(args.start)
    end = parse_date_opt(args.end)

    sb = supa()

    # team map once
    df_teammap = fetch_team_map(sb, page_size=args.page_size)
    if df_teammap.empty:
        raise RuntimeError("public.team_id_to_team returned 0 rows; cannot compute home/away.")

    total_written = 0

    for (cstart, cend) in daterange_chunks(start, end, args.chunk_days):
        print(f"\n→ Range: {cstart} .. {cend}")

        logs = fetch_all(
            sb,
            table_or_view="v_player_game_logs_all",
            select_cols="game_id,player_id,season,game_date,team_abbr,player_name,minutes,pts,reb,ast,pra",
            start_date=cstart,
            end_date=cend,
            date_col="game_date",
            page_size=args.page_size,
        )
        games = fetch_all(
            sb,
            table_or_view="v_nba_games_all",
            select_cols="game_id,season,game_date,home_team_id,away_team_id",
            start_date=cstart,
            end_date=cend,
            date_col="game_date",
            page_size=args.page_size,
        )

        df_logs = pd.DataFrame(logs)
        df_games = pd.DataFrame(games)

        print(f"  logs rows:  {len(df_logs)}")
        print(f"  games rows: {len(df_games)}")

        if df_logs.empty:
            print("  (no logs) skip")
            continue

        # Normalize dates
        df_logs["game_date"] = pd.to_datetime(df_logs["game_date"], errors="coerce")
        df_games["game_date"] = pd.to_datetime(df_games["game_date"], errors="coerce")

        # Ensure ids numeric
        for c in ["game_id", "player_id"]:
            df_logs[c] = pd.to_numeric(df_logs[c], errors="coerce")
        for c in ["game_id", "home_team_id", "away_team_id"]:
            df_games[c] = pd.to_numeric(df_games[c], errors="coerce")

        # Join + features
        df_joined = add_home_away(df_logs, df_games, df_teammap)
        df_feat = compute_features(df_joined)

        print(f"  feature rows: {len(df_feat)}")

        if args.dry_run:
            continue

        written = upsert_batches(sb, df_feat, batch_size=args.upsert_batch)
        total_written += written
        print(f"  ✅ upserted: {written}")

    print(f"\n✅ DONE. Total upserted rows: {total_written}")


if __name__ == "__main__":
    main()
