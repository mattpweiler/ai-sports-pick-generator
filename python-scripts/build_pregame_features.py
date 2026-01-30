#!/usr/bin/env python3
"""
build_pregame_features.py

Creates/refreshes *future* rows in public.player_game_features so ML predictions
can exist for upcoming games (not just past games).

Uses:
- public.player_game_roster (future player-game skeleton)
- public.v_nba_games_all    (game_date, home/away team ids)
- public.team_id_to_team    (team_id -> abbreviation)
- public.player_game_features (historical rows to compute rolling averages)

What it does
------------
For each (game_id, player_id) in player_game_roster for upcoming games:
- Determines is_home + opponent_team_id
- Computes rolling L3/L5/L10 and season-to-date averages from *past* games
- Computes rest + schedule flags from prior game dates
- Upserts a future row into public.player_game_features
  (with actual stats fields left NULL for future games)

ENV
---
SUPABASE_URL
SUPABASE_SERVICE_ROLE
SUPABASE_SCHEMA (default "public")
"""

import argparse
import math
import os
from datetime import date, datetime, timedelta, timezone
from typing import List, Optional, Tuple

import numpy as np
import pandas as pd
from supabase import Client, create_client

# ---------------------- Supabase config ----------------------
SUPABASE_URL = os.getenv("SUPABASE_URL", "https://qsarkbzmqjsnyrcackwm.supabase.co")
SUPABASE_SERVICE_ROLE = os.getenv("SUPABASE_SERVICE_ROLE", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzYXJrYnptcWpzbnlyY2Fja3dtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTgzODY3NiwiZXhwIjoyMDc3NDE0Njc2fQ.HAyvVKMLGdJigQ-SrPbtclv_MxxLKoqj54UyUaAjvtM")
SUPABASE_SCHEMA = os.getenv("SUPABASE_SCHEMA", "public")

# ---------------------- Tables / Views (PUBLIC) ----------------------
T_ROSTER = "player_game_roster"
V_GAMES = "v_nba_games_all"
T_TEAMS = "team_id_to_team"
T_FEATURES = "player_game_features"

# Pull "truth" historical stats from raw game logs to compute rolling windows correctly
V_TRUTH_LOGS = "v_player_game_logs_all"


# Match the DB schema you pasted
FEATURE_COLS = [
    "game_id",
    "player_id",
    "season",
    "game_date",
    "team_abbr",
    "opponent_team_id",
    "is_home",
    "minutes",
    "pts",
    "reb",
    "ast",
    "pra",
    "pts_l3",
    "pts_l5",
    "pts_l10",
    "reb_l3",
    "reb_l5",
    "reb_l10",
    "ast_l3",
    "ast_l5",
    "ast_l10",
    "pra_l3",
    "pra_l5",
    "pra_l10",
    "pts_season_avg",
    "reb_season_avg",
    "ast_season_avg",
    "pra_season_avg",
    "min_season_avg",
    "min_l3",
    "min_l5",
    "min_l10",
    "usg_pct",
    "days_rest",
    "is_back_to_back",
    "is_3_in_4",
    "is_4_in_6",
    "computed_at",
]

INT_COLS = ["game_id", "player_id", "opponent_team_id", "days_rest"]
BOOL_COLS = ["is_home", "is_back_to_back", "is_3_in_4", "is_4_in_6"]

CHUNK = 200


# ---------------------- Helpers ----------------------
def supa() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE.")
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE).schema(SUPABASE_SCHEMA)


def iso(d: date) -> str:
    return d.isoformat()


def fetch_all(
    sb,
    table_or_view: str,
    select_cols: str,
    filters: List[Tuple[str, str, str]],
    page_size: int = 1000,
):
    """Paginated fetch from PostgREST."""
    out = []
    offset = 0
    while True:
        q = sb.table(table_or_view).select(select_cols)
        for col, op, val in filters:
            q = q.filter(col, op, val)
        resp = q.range(offset, offset + page_size - 1).execute()
        data = resp.data or []
        out.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
    return out


def chunked(lst: List[dict], n: int):
    for i in range(0, len(lst), n):
        yield lst[i : i + n]


def season_from_game_date_str(s: str) -> Optional[str]:
    """
    NBA season label like '2025-26'.
    Season starts in October (10). Jan 2026 => 2025-26.
    """
    dt = pd.to_datetime(s, errors="coerce")
    if pd.isna(dt):
        return None
    y = int(dt.year)
    m = int(dt.month)
    start_year = y if m >= 10 else y - 1
    return f"{start_year}-{str(start_year + 1)[-2:]}"


def json_sanitize_records(records: List[dict]) -> List[dict]:
    """
    Convert NaN/Inf/-Inf/pd.NA to None and numpy scalars to native Python types
    so PostgREST/JSON serialization never fails.
    """
    out: List[dict] = []
    for r in records:
        clean = {}
        for k, v in r.items():
            # pd.NA / np.nan
            try:
                if pd.isna(v):
                    clean[k] = None
                    continue
            except Exception:
                pass

            if v is None:
                clean[k] = None
                continue

            # inf/-inf for python floats
            if isinstance(v, float) and (v == float("inf") or v == float("-inf")):
                clean[k] = None
                continue

            # numpy -> python
            if isinstance(v, (np.integer,)):
                clean[k] = int(v)
                continue
            if isinstance(v, (np.floating,)):
                fv = float(v)
                if math.isnan(fv) or fv == float("inf") or fv == float("-inf"):
                    clean[k] = None
                else:
                    clean[k] = fv
                continue
            if isinstance(v, (np.bool_,)):
                clean[k] = bool(v)
                continue

            clean[k] = v
        out.append(clean)
    return out


def coerce_int_series(s: pd.Series) -> pd.Series:
    """
    Force a series into pandas nullable Int64 safely:
    - accepts strings like "78.0"
    - accepts floats like 78.0
    - rejects 78.5 (non-integer)
    - preserves missing as <NA>
    """
    s2 = pd.to_numeric(s, errors="coerce")
    mask = s2.notna() & (np.floor(s2) != s2)
    if mask.any():
        bad_vals = s2[mask].unique()[:10]
        raise ValueError(f"Non-integer values found in int column: {bad_vals}")
    return s2.round(0).astype("Int64")


def force_python_ints(records: List[dict], int_keys: set) -> List[dict]:
    """
    Ensure int keys are real Python int or None (never "78.0").
    """
    for r in records:
        for k in int_keys:
            v = r.get(k)
            if v is None:
                continue

            if isinstance(v, str):
                try:
                    fv = float(v)
                    if fv.is_integer():
                        r[k] = int(fv)
                except Exception:
                    pass
                continue

            if isinstance(v, float) and v.is_integer():
                r[k] = int(v)
                continue

            if isinstance(v, (np.integer,)):
                r[k] = int(v)
                continue
    return records


# ---------------------- Feature computation ----------------------
def compute_rolling_features(hist: pd.DataFrame, targets: pd.DataFrame) -> pd.DataFrame:
    """
    hist: past rows from player_game_features with actuals filled
          columns: player_id, game_date, minutes, pts, reb, ast, pra
    targets: future skeleton rows with columns:
             game_id, player_id, game_date, team_abbr, opponent_team_id, is_home
    Returns: targets with rolling/season features added.
    """
    targets = targets.copy()

    if hist.empty:
        # No history at all -> fill with nulls but keep schedule booleans false
        for c in [
            "min_l3",
            "min_l5",
            "min_l10",
            "min_season_avg",
            "pts_l3",
            "pts_l5",
            "pts_l10",
            "pts_season_avg",
            "reb_l3",
            "reb_l5",
            "reb_l10",
            "reb_season_avg",
            "ast_l3",
            "ast_l5",
            "ast_l10",
            "ast_season_avg",
            "pra_l3",
            "pra_l5",
            "pra_l10",
            "pra_season_avg",
        ]:
            targets[c] = None
        targets["days_rest"] = None
        targets["is_back_to_back"] = False
        targets["is_3_in_4"] = False
        targets["is_4_in_6"] = False
        return targets

    hist = hist.copy()
    hist["game_date"] = pd.to_datetime(hist["game_date"], errors="coerce").dt.date
    targets["game_date"] = pd.to_datetime(targets["game_date"], errors="coerce").dt.date

    # Ensure numeric
    for col in ["minutes", "pts", "reb", "ast", "pra"]:
        if col in hist.columns:
            hist[col] = pd.to_numeric(hist[col], errors="coerce")

    # Sort
    hist = hist.sort_values(["player_id", "game_date"])
    grouped = {pid: df.reset_index(drop=True) for pid, df in hist.groupby("player_id")}

    def last_n_avg(df: pd.DataFrame, col: str, n: int) -> Optional[float]:
        s = df[col].dropna()
        if s.empty:
            return None
        return float(s.tail(n).mean())

    def season_avg(df: pd.DataFrame, col: str) -> Optional[float]:
        s = df[col].dropna()
        if s.empty:
            return None
        return float(s.mean())

    rows = []
    for r in targets.itertuples(index=False):
        row = r._asdict()
        pid = int(row["player_id"])
        gdate = row["game_date"]

        h = grouped.get(pid)
        if h is None:
            for c in [
                "min_l3",
                "min_l5",
                "min_l10",
                "min_season_avg",
                "pts_l3",
                "pts_l5",
                "pts_l10",
                "pts_season_avg",
                "reb_l3",
                "reb_l5",
                "reb_l10",
                "reb_season_avg",
                "ast_l3",
                "ast_l5",
                "ast_l10",
                "ast_season_avg",
                "pra_l3",
                "pra_l5",
                "pra_l10",
                "pra_season_avg",
            ]:
                row[c] = None
            row["days_rest"] = None
            row["is_back_to_back"] = False
            row["is_3_in_4"] = False
            row["is_4_in_6"] = False
            rows.append(row)
            continue

        prior = h[h["game_date"] < gdate]

        # rolling mins
        row["min_l3"] = last_n_avg(prior, "minutes", 3)
        row["min_l5"] = last_n_avg(prior, "minutes", 5)
        row["min_l10"] = last_n_avg(prior, "minutes", 10)
        row["min_season_avg"] = season_avg(prior, "minutes")

        # rolling stats
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

        # schedule flags
        if prior.empty:
            row["days_rest"] = None
            row["is_back_to_back"] = False
            row["is_3_in_4"] = False
            row["is_4_in_6"] = False
        else:
            prev_date = prior["game_date"].max()
            dr = (gdate - prev_date).days
            row["days_rest"] = dr
            row["is_back_to_back"] = (dr == 1)

            # IMPORTANT: windows should be based on prior games ONLY (exclude target day)
            w34 = prior[prior["game_date"] >= (gdate - timedelta(days=3))]
            row["is_3_in_4"] = (len(w34) >= 3)

            w46 = prior[prior["game_date"] >= (gdate - timedelta(days=5))]
            row["is_4_in_6"] = (len(w46) >= 4)

        rows.append(row)

    return pd.DataFrame(rows)


# ---------------------- Main ----------------------
def main():
    ap = argparse.ArgumentParser(description="Build pregame (future) player_game_features rows from roster skeleton.")
    ap.add_argument("--start", default=None, help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default: today+7 UTC)")
    ap.add_argument("--lookback-days", type=int, default=240, help="How far back to pull history for rolling stats")
    ap.add_argument("--dry-run", action="store_true", help="Compute but do not upsert")
    ap.add_argument("--batch", type=int, default=500, help="Upsert batch size")
    args = ap.parse_args()

    today = datetime.now(timezone.utc).date()
    start = today if not args.start else datetime.fromisoformat(args.start).date()
    end = (today + timedelta(days=7)) if not args.end else datetime.fromisoformat(args.end).date()
    if end < start:
        raise ValueError("--end must be >= --start")

    print(f"→ Pregame window: {iso(start)} .. {iso(end)}")

    sb = supa()

    # 1) roster skeleton (expected_active=true)
    roster = fetch_all(
        sb,
        T_ROSTER,
        "game_id,player_id,team_abbr,expected_active",
        [("expected_active", "eq", "true")],
    )
    if not roster:
        print("No rows in player_game_roster (expected_active=true). Nothing to do.")
        return

    roster_df = pd.DataFrame(roster)
    roster_df["game_id"] = pd.to_numeric(roster_df["game_id"], errors="coerce").astype("Int64")
    roster_df["player_id"] = pd.to_numeric(roster_df["player_id"], errors="coerce").astype("Int64")
    roster_df = roster_df.dropna(subset=["game_id", "player_id"]).copy()
    roster_df["game_id"] = roster_df["game_id"].astype("int64")
    roster_df["player_id"] = roster_df["player_id"].astype("int64")
    roster_df["team_abbr"] = roster_df["team_abbr"].astype(str).str.upper()

    # 2) games metadata for those game_ids, filter by window
    game_ids = sorted(roster_df["game_id"].unique().tolist())
    games_rows = []
    for i in range(0, len(game_ids), CHUNK):
        chunk = game_ids[i : i + CHUNK]
        resp = (
            sb.table(V_GAMES)
            .select("game_id,game_date,home_team_id,away_team_id")
            .filter("game_id", "in", f"({','.join(map(str, chunk))})")
            .execute()
        )
        games_rows.extend(resp.data or [])

    games_df = pd.DataFrame(games_rows)
    if games_df.empty:
        print("No matching games found in v_nba_games_all for roster game_ids. Check your schedule view.")
        return

    games_df["game_date"] = pd.to_datetime(games_df["game_date"], errors="coerce").dt.date
    games_df = games_df[(games_df["game_date"] >= start) & (games_df["game_date"] <= end)].copy()
    if games_df.empty:
        print("Roster exists, but none of the roster game_ids are within the requested date window.")
        return

    roster_df = roster_df.merge(
        games_df[["game_id", "game_date", "home_team_id", "away_team_id"]],
        on="game_id",
        how="inner",
    )

    # 3) team_id -> abbr lookup for is_home and opponent_team_id
    teams = fetch_all(sb, T_TEAMS, "team_id,abbreviation", [])
    team_map = {int(t["team_id"]): (t.get("abbreviation") or "").upper() for t in teams if t.get("team_id") is not None}

    def compute_is_home(row) -> Optional[bool]:
        home_abbr = team_map.get(int(row["home_team_id"]), "")
        away_abbr = team_map.get(int(row["away_team_id"]), "")
        if row["team_abbr"] == home_abbr:
            return True
        if row["team_abbr"] == away_abbr:
            return False
        return None

    def compute_opp(row) -> Optional[int]:
        home_abbr = team_map.get(int(row["home_team_id"]), "")
        away_abbr = team_map.get(int(row["away_team_id"]), "")
        if row["team_abbr"] == home_abbr:
            return int(row["away_team_id"])
        if row["team_abbr"] == away_abbr:
            return int(row["home_team_id"])
        return None

    roster_df["is_home"] = roster_df.apply(compute_is_home, axis=1)
    roster_df["opponent_team_id"] = roster_df.apply(compute_opp, axis=1)

   # 4) Pull historical TRUTH logs for involved players (lookback)
    # IMPORTANT: compute rolling windows from v_player_game_logs_all (raw per-game stats),
    # not from player_game_features (derived and previously wrong).
    lookback_start = start - timedelta(days=args.lookback_days)
    player_ids = sorted(roster_df["player_id"].unique().tolist())
    print(f"→ Upcoming games in window: {roster_df['game_id'].nunique()} | players: {len(player_ids)}")
    print(f"→ Pulling TRUTH history since {iso(lookback_start)} (lookback-days={args.lookback_days})")

    hist_rows = []
    for i in range(0, len(player_ids), CHUNK):
        chunk = player_ids[i : i + CHUNK]

        q = (
            sb.table(V_TRUTH_LOGS)
            .select("player_id,game_id,game_date,minutes,pts,reb,ast,pra")
            .filter("player_id", "in", f"({','.join(map(str, chunk))})")
            .gte("game_date", iso(lookback_start))
            .lt("game_date", iso(start))
            # critical for stable pagination/consistency
            .order("game_date", desc=False)
            .order("game_id", desc=False)
            .order("player_id", desc=False)
        )

        resp = q.execute()
        hist_rows.extend(resp.data or [])

    hist_df = (
        pd.DataFrame(hist_rows)
        if hist_rows
        else pd.DataFrame(columns=["player_id","game_date","minutes","pts","reb","ast","pra"])
    )


    if not hist_df.empty:
        hist_df["player_id"] = pd.to_numeric(hist_df["player_id"], errors="coerce").astype("Int64")
        hist_df = hist_df.dropna(subset=["player_id"]).copy()
        hist_df["player_id"] = hist_df["player_id"].astype("int64")

    # 5) targets skeleton
    targets = roster_df[["game_id", "player_id", "game_date", "team_abbr", "opponent_team_id", "is_home"]].copy()
    targets["minutes"] = None
    targets["pts"] = None
    targets["reb"] = None
    targets["ast"] = None
    targets["pra"] = None

    # 6) compute rolling + schedule
    enriched = compute_rolling_features(hist=hist_df, targets=targets)

    # 7) add derived fields + align to DB schema
    enriched["computed_at"] = datetime.now(timezone.utc).isoformat()

    payload_df = enriched.copy()

    # DB expects date; PostgREST is fine with 'YYYY-MM-DD'
    payload_df["game_date"] = pd.to_datetime(payload_df["game_date"], errors="coerce").dt.date.astype(str)

    # REQUIRED NOT NULL: season (text)
    payload_df["season"] = payload_df["game_date"].apply(season_from_game_date_str)

    # Schema has usg_pct but we are not computing it here (leave null)
    if "usg_pct" not in payload_df.columns:
        payload_df["usg_pct"] = None

    # Force int / bool dtypes before dict conversion
    for c in INT_COLS:
        if c in payload_df.columns:
            payload_df[c] = coerce_int_series(payload_df[c])

    for c in BOOL_COLS:
        if c in payload_df.columns:
            payload_df[c] = payload_df[c].astype("boolean")

    # Ensure we only send columns that exist in DB schema
    missing = [c for c in FEATURE_COLS if c not in payload_df.columns]
    if missing:
        raise RuntimeError(
            "Payload DF is missing columns required by FEATURE_COLS.\n"
            f"Missing: {missing}\n"
            "Fix: add them to payload_df or remove them from FEATURE_COLS."
        )

    payload_df = payload_df[FEATURE_COLS].copy()

    records = payload_df.to_dict(orient="records")
    records = json_sanitize_records(records)
    records = force_python_ints(records, set(INT_COLS))

    # Guard: season must be present for all rows (NOT NULL)
    bad_season = [i for i, r in enumerate(records) if not r.get("season")]
    if bad_season:
        i = bad_season[0]
        raise RuntimeError(f"season is NULL/empty for record index {i}: {records[i]}")

    print(f"→ Prepared future feature rows: {len(records)}")

    if args.dry_run:
        print("DRY RUN: not upserting. Showing sample:")
        for r in records[:5]:
            print(r)
        return

    sb2 = supa()
    total = 0
    for batch in chunked(records, args.batch):
        batch = json_sanitize_records(batch)
        batch = force_python_ints(batch, set(INT_COLS))
        sb2.table(T_FEATURES).upsert(batch, on_conflict="game_id,player_id").execute()
        total += len(batch)
        print(f"  … upserted {total}/{len(records)}")

    print(f"✅ Done. Upserted future features rows: {total}")


if __name__ == "__main__":
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 0)
    main()
