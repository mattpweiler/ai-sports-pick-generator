#!/usr/bin/env python3
"""
Sync NBA player 'base' boxscores (V3) into Supabase.

What it does
------------
1) Enumerates game_ids via LeagueGameLog (team mode) for a given date window.
2) Checks Supabase for which games already exist in your table.
3) Fetches BoxScoreTraditionalV3 for:
     - all games missing from Supabase, and
     - all games within the last RECENT_DAYS (to capture late corrections).
4) Normalizes columns (camelCase and ALL_CAPS), computes a lightweight checksum,
   and UPSERTs on (game_id, player_id).

Environment
-----------
SUPABASE_URL="https://xxxxx.supabase.co"
SUPABASE_SERVICE_ROLE="eyJhbGciOi..."   # service role is best (or ensure RLS allows upsert)
SUPABASE_SCHEMA="public"                  # optional; defaults to 'public' if unset
SUPABASE_TABLE="fact_player_game_base" # destination table name

NBA season window & pacing can be passed on CLI, see --help.

Schema (suggested)
------------------
CREATE TABLE core.fact_player_game_base (
  game_id        text NOT NULL,
  player_id      bigint NOT NULL,
  team_abbr      text,
  player_name    text,
  start_pos      text,
  min            text,
  fgm            numeric, fga numeric, fg_pct numeric,
  fg3m           numeric, fg3a numeric, fg3_pct numeric,
  ftm            numeric, fta numeric, ft_pct numeric,
  oreb           numeric, dreb numeric, reb numeric,
  ast            numeric, stl numeric, blk numeric,
  tov            numeric, pf numeric, pts numeric,
  plus_minus     numeric,
  comment        text,
  game_date      date,
  matchup        text,
  row_checksum   text,                 -- SHA256 of core stat fields
  updated_at     timestamptz DEFAULT now(),
  PRIMARY KEY (game_id, player_id)
);

Optionally add RLS or triggers as needed.
"""

import argparse
import hashlib
import os
import sys
import time
from datetime import datetime, timedelta
from json import JSONDecodeError

import pandas as pd
import requests
from requests.exceptions import HTTPError, ReadTimeout, ConnectTimeout
from nba_api.stats.library.http import NBAStatsHTTP
from nba_api.stats.endpoints import leaguegamelog, boxscoretraditionalv3
from supabase import create_client, Client

# ---------------------- Config defaults ----------------------
DEFAULT_SEASON      = "2025-26"
DEFAULT_SEASON_TYPE = "Regular Season"
DEFAULT_DATE_FROM   = "2025-10-30"
DEFAULT_DATE_TO     = "2026-05-02"
DEFAULT_RECENT_DAYS = 30     # also re-sync games within last N days (stat corrections)
SLEEP_BETWEEN_GAMES = 1.0   # seconds between V3 calls
SLEEP_AFTER_LIST    = 2.0   # small pause after fetching game list
RETRY_BASE_DELAY    = 1.0   # backoff unit for retries

# ---------------------- Supabase config ----------------------
SUPABASE_URL         = os.getenv("SUPABASE_URL", "https://qsarkbzmqjsnyrcackwm.supabase.co")
SUPABASE_SERVICE_ROLE= os.getenv("SUPABASE_SERVICE_ROLE", "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFzYXJrYnptcWpzbnlyY2Fja3dtIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc2MTgzODY3NiwiZXhwIjoyMDc3NDE0Njc2fQ.HAyvVKMLGdJigQ-SrPbtclv_MxxLKoqj54UyUaAjvtM")
SUPABASE_SCHEMA      = os.getenv("SUPABASE_SCHEMA", "public")   # 'public' or 'core'
SUPABASE_TABLE       = os.getenv("SUPABASE_TABLE", "pergame_player_base_stats_2025_26")

def supa() -> Client:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE:
        raise RuntimeError("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars.")
    # You can choose to pin schema here, or keep default and pass .schema in calls:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_ROLE).schema(SUPABASE_SCHEMA)

# ---------------------- NBA headers (important) ----------------------
NBAStatsHTTP.timeout = 30
_session = requests.Session()
_session.headers.update({
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Host": "stats.nba.com",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
    "Connection": "keep-alive",
})
NBAStatsHTTP._session = _session


# ---------------------- Helpers ----------------------
def df_records(df: pd.DataFrame) -> list[dict]:
    import math
    import numpy as np
    from datetime import date, datetime
    import pandas as pd

    def to_json_safe(v):
        # None / NaN
        if v is None or (isinstance(v, float) and math.isnan(v)):
            return None
        # pandas/py datetimes & dates
        if isinstance(v, (pd.Timestamp, datetime)):
            # ISO 8601 string with UTC if tz-aware
            return v.isoformat()
        if isinstance(v, date):
            return v.isoformat()
        # NumPy scalars -> native Python
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            return float(v)
        if isinstance(v, (np.bool_ ,)):
            return bool(v)
        return v

    return [{k: to_json_safe(v) for k, v in row.items()} for row in df.to_dict(orient="records")]

def fetch_games(season: str, season_type: str, date_from: str, date_to: str) -> pd.DataFrame:
    gl = leaguegamelog.LeagueGameLog(
        season=season,
        season_type_all_star=season_type,
        player_or_team_abbreviation="T",
        date_from_nullable=date_from,
        date_to_nullable=date_to,
    )
    df = gl.get_data_frames()[0]
    if df.empty:
        return pd.DataFrame(columns=["game_id","game_date","matchup"])
    df = df.rename(columns={"GAME_ID":"game_id","GAME_DATE":"game_date","MATCHUP":"matchup"}).copy()
    df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")
    games = (df.loc[:, ["game_id","game_date","matchup"]]
               .drop_duplicates("game_id")
               .sort_values("game_date")
               .reset_index(drop=True))
    return games

def fetch_boxscore_frames(game_id: str):
    for attempt in range(1, 6):
        try:
            bs = boxscoretraditionalv3.BoxScoreTraditionalV3(game_id=game_id)
            return bs.get_data_frames() or []
        except (JSONDecodeError, ValueError, HTTPError, ReadTimeout, ConnectTimeout) as e:
            print(f"   ⚠️  {game_id}: retry {attempt} after {e}")
            time.sleep(RETRY_BASE_DELAY * attempt)
    print(f"   ❌ V3 failed after retries for {game_id}")
    return []

def pick_player_frame(frames: list[pd.DataFrame]) -> pd.DataFrame:
    # Works with camelCase or ALL_CAPS
    id_candidates = [
        {"PLAYER_ID","PLAYER_NAME"},             # ALL_CAPS
        {"PERSON_ID","PLAYER_NAME"},             # variant
        {"personId","firstName","familyName"},   # camelCase
    ]
    stat_hints_caps = {"PTS","FGM","FGA","MIN"}
    stat_hints_camel = {"points","fieldGoalsMade","fieldGoalsAttempted","minutes"}
    for f in frames:
        if isinstance(f, pd.DataFrame) and not f.empty:
            cols = set(f.columns)
            if any(req.issubset(cols) for req in id_candidates) and ((stat_hints_caps & cols) or (stat_hints_camel & cols)):
                return f
    return pd.DataFrame()

def normalize_player_base(df: pd.DataFrame, game_id: str) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame()
    df = df.copy()
    cols = set(df.columns)
    camel = "personId" in cols  # detect camelCase payload

    if camel:
        # Build player_name
        df["player_id"] = df.get("personId")
        df["player_name"] = (
            df.get("firstName", "").astype(str).str.strip() + " " +
            df.get("familyName", "").astype(str).str.strip()
        ).str.strip()
        mask_empty = df["player_name"].eq("")
        if "playerSlug" in df.columns:
            df.loc[mask_empty, "player_name"] = df.loc[mask_empty, "playerSlug"].astype(str)

        df["team_abbr"] = df.get("teamTricode")
        df["start_pos"] = df.get("position")    # best available
        df["comment"]   = df.get("comment")
        df["min"]       = df.get("minutes")

        df["fgm"]     = df.get("fieldGoalsMade")
        df["fga"]     = df.get("fieldGoalsAttempted")
        df["fg_pct"]  = df.get("fieldGoalsPercentage")
        df["fg3m"]    = df.get("threePointersMade")
        df["fg3a"]    = df.get("threePointersAttempted")
        df["fg3_pct"] = df.get("threePointersPercentage")
        df["ftm"]     = df.get("freeThrowsMade")
        df["fta"]     = df.get("freeThrowsAttempted")
        df["ft_pct"]  = df.get("freeThrowsPercentage")

        df["oreb"]    = df.get("reboundsOffensive")
        df["dreb"]    = df.get("reboundsDefensive")
        df["reb"]     = df.get("reboundsTotal")
        df["ast"]     = df.get("assists")
        df["stl"]     = df.get("steals") if "steals" in cols else None
        df["blk"]     = df.get("blocks") if "blocks" in cols else None

        if "turnovers" in cols: df["tov"] = df["turnovers"]
        elif "TO" in cols:      df["tov"] = df["TO"]
        elif "TOV" in cols:     df["tov"] = df["TOV"]
        else:                   df["tov"] = None

        df["pf"]         = df.get("personalFouls") if "personalFouls" in cols else df.get("foulsPersonal")
        df["pts"]        = df.get("points")
        df["plus_minus"] = df.get("plusMinusPoints") if "plusMinusPoints" in cols else df.get("plusMinus")

    else:
        # ALL_CAPS style
        if "PLAYER_ID" not in df.columns and "PERSON_ID" in df.columns:
            df["PLAYER_ID"] = df["PERSON_ID"]
        if "TOV" not in df.columns:
            if "TO" in df.columns: df["TOV"] = df["TO"]
            elif "TURNOVERS" in df.columns: df["TOV"] = df["TURNOVERS"]
        df.rename(columns={
            "PLAYER_ID":"player_id",
            "PLAYER_NAME":"player_name",
            "TEAM_ABBREVIATION":"team_abbr",
            "START_POSITION":"start_pos",
            "COMMENT":"comment",
            "MIN":"min",
            "FGM":"fgm","FGA":"fga","FG_PCT":"fg_pct",
            "FG3M":"fg3m","FG3A":"fg3a","FG3_PCT":"fg3_pct",
            "FTM":"ftm","FTA":"fta","FT_PCT":"ft_pct",
            "OREB":"oreb","DREB":"dreb","REB":"reb",
            "AST":"ast","STL":"stl","BLK":"blk",
            "TOV":"tov",
            "PF":"pf","PTS":"pts","PLUS_MINUS":"plus_minus",
        }, inplace=True, errors="ignore")

    # Final order
    needed = [
        "team_abbr","player_id","player_name","start_pos","min",
        "fgm","fga","fg_pct","fg3m","fg3a","fg3_pct",
        "ftm","fta","ft_pct","oreb","dreb","reb",
        "ast","stl","blk","tov","pf","pts","plus_minus","comment"
    ]
    for c in needed:
        if c not in df.columns:
            df[c] = None

    df["game_id"] = game_id
    return df[["game_id"] + needed]

def compute_row_checksum(row: pd.Series) -> str:
    """
    Build a deterministic hash from the core stats for change detection.
    """
    keys = ["team_abbr","player_id","player_name","start_pos","min",
            "fgm","fga","fg_pct","fg3m","fg3a","fg3_pct",
            "ftm","fta","ft_pct","oreb","dreb","reb",
            "ast","stl","blk","tov","pf","pts","plus_minus","comment"]
    s = "|".join([str(row.get(k, "")) for k in keys])
    return hashlib.sha256(s.encode("utf-8")).hexdigest()

def supabase_distinct_game_ids(table: str, game_ids: list[str]) -> set[str]:
    """
    Pull distinct game_ids present in Supabase for the considered window.
    Uses IN filter in chunks to avoid URL length issues.
    """
    present = set()
    sb = supa()
    CHUNK = 200
    for i in range(0, len(game_ids), CHUNK):
        chunk = game_ids[i:i+CHUNK]
        # PostgREST syntax: in.(val1,val2,...)
        flt = "in.(" + ",".join(chunk) + ")"
        data = sb.table(table).select("game_id", count="exact").filter("game_id", "in", f"({','.join(chunk)})").execute()
        for rec in (data.data or []):
            gid = rec.get("game_id")
            if gid: present.add(gid)
        # small breath
        time.sleep(0.1)
    return present

def upsert_rows(records: list[dict], table: str):
    """
    Upsert in small batches on (game_id, player_id).
    Strips fields that may not exist in the table (e.g., row_checksum, updated_at).
    """
    if not records:
        return

    # keys that often aren’t in the DB unless you added them
    strip_keys = {"row_checksum", "updated_at"}

    def cleaned(batch):
        return [{k: v for k, v in r.items() if k not in strip_keys} for r in batch]

    sb = supa()
    BATCH = 500
    for i in range(0, len(records), BATCH):
        batch = cleaned(records[i:i+BATCH])
        sb.table(table).upsert(batch, on_conflict="game_id,player_id").execute()

def main():
    global SUPABASE_SCHEMA  # <-- move global declaration to the top of the function

    ap = argparse.ArgumentParser(description="Sync NBA V3 player base boxscores into Supabase (missing & recent corrections)")
    ap.add_argument("--season", default=DEFAULT_SEASON)
    ap.add_argument("--season-type", default=DEFAULT_SEASON_TYPE,
                    choices=["Regular Season","Playoffs","Pre Season","All Star","PlayIn"])
#    ap.add_argument("--date-from", default=DEFAULT_DATE_FROM, help="YYYY-MM-DD")
#    ap.add_argument("--date-to",   default=DEFAULT_DATE_TO,   help="YYYY-MM-DD")
    from datetime import datetime, timedelta
    from zoneinfo import ZoneInfo
    LOCAL_TZ = ZoneInfo("America/Chicago")
    today_local = datetime.now(LOCAL_TZ).date()
    default_from = (today_local - timedelta(days=10)).isoformat()
    default_to   = today_local.isoformat()

    ap.add_argument("--date-from", default=default_from,
                    help="YYYY-MM-DD (default: 10 days ago)")
    ap.add_argument("--date-to",   default=default_to,
                    help="YYYY-MM-DD (default: today)")
    
    ap.add_argument("--recent-days", type=int, default=DEFAULT_RECENT_DAYS,
                    help="Also re-sync games with game_date within N days of today")
    ap.add_argument("--table", default=SUPABASE_TABLE)
    ap.add_argument("--schema", default=SUPABASE_SCHEMA)
    ap.add_argument("--dry-run", action="store_true", help="Don’t write to Supabase; just show plan counts")
    args = ap.parse_args()

    SUPABASE_SCHEMA = args.schema  # now this assignment is legal


    print(f"→ Enumerating games {args.season} — {args.season_type} between {args.date_from} and {args.date_to} …")
    games_df = fetch_games(args.season, args.season_type, args.date_from, args.date_to)
    if games_df.empty:
        print("No games in range; exiting.")
        return

    # Determine "recent" cutoff for stat corrections
    from datetime import datetime, timezone
    today = datetime.now(timezone.utc).date()

    recent_cutoff = today - timedelta(days=args.recent_days)

    # Which are missing in Supabase?
    game_ids = games_df["game_id"].astype(str).tolist()
    print(f"→ Checking Supabase for existing rows in {args.schema}.{args.table} …")
    # For PostgREST 'in' we chunk manually in helper above
    present = supabase_distinct_game_ids(args.table, game_ids)
    missing_set = set(game_ids) - present

    # Which are recent (to re-sync regardless)?
    recent_set = set(gid for gid, gdate in zip(games_df["game_id"].astype(str), games_df["game_date"])
                     if pd.notna(gdate) and gdate.date() >= recent_cutoff)

    target_ids = sorted(missing_set | recent_set)
    print(f"  Missing games: {len(missing_set)}; Recent for refresh: {len(recent_set)}; Total to fetch: {len(target_ids)}")

    if args.dry_run:
        print("DRY RUN: not fetching or writing. Exiting.")
        return

    time.sleep(SLEEP_AFTER_LIST)

    total_rows = 0
    to_upsert: list[dict] = []

    # Quick lookup for date/matchup enrichment
    gmeta = games_df.set_index("game_id")[["game_date","matchup"]].to_dict(orient="index")

    for i, gid in enumerate(target_ids, start=1):
        try:
            frames = fetch_boxscore_frames(gid)
            player_df = pick_player_frame(frames)
            norm = normalize_player_base(player_df, gid)
            if not norm.empty:
                # enrich with date/matchup
                meta = gmeta.get(gid, {})
                norm["game_date"] = meta.get("game_date")
                norm["matchup"]   = meta.get("matchup")

                # compute checksum
                norm["row_checksum"] = norm.apply(compute_row_checksum, axis=1)
                norm["updated_at"]   = pd.Timestamp.utcnow()
                # ensure game_date is a date string (YYYY-MM-DD) and updated_at is ISO string
                norm["game_date"] = pd.to_datetime(norm["game_date"], errors="coerce").dt.date
                # If you keep updated_at in the DF:
                from datetime import datetime, timezone
                norm["updated_at"] = datetime.now(timezone.utc).isoformat()

                recs = df_records(norm)
                to_upsert.extend(recs)
                total_rows += len(recs)
        except Exception as e:
            print(f"[{i}/{len(target_ids)}] {gid}: {e}", file=sys.stderr)

        if i % 10 == 0:
            print(f"  … {i}/{len(target_ids)} games processed, {total_rows} rows buffered")
        time.sleep(SLEEP_BETWEEN_GAMES)

    if not to_upsert:
        print("Nothing to write.")
        return

    print(f"→ Upserting {len(to_upsert)} rows into {args.schema}.{args.table} …")
    upsert_rows(to_upsert, args.table)
    print(f"✅ Done. Upserted rows: {len(to_upsert)} across {len(target_ids)} games.")

if __name__ == "__main__":
    pd.set_option("display.max_columns", None)
    pd.set_option("display.width", 0)
    main()
