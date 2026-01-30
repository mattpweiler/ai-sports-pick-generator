#!/usr/bin/env python3
"""
Generate ML predictions for a date window (future slate or backtest window).

Reads:
  - public.player_game_features_truth_snapshot  (or player_game_features if you choose)
  - public.v_closing_lines (if present) to attach line + market odds

Writes:
  - public.ml_predictions (upsert)

Artifacts:
  - loads ./model-artifacts/xgb_{STAT}.joblib
  - uses stored residual std from model registry notes as sigma fallback
"""

import argparse
import json
import math
import os
import numpy as np
from datetime import datetime, date
from typing import Any, Dict, List, Optional

import pandas as pd
from dotenv import load_dotenv
from _supa import supa
import joblib
from scipy.stats import norm


FEATURE_COLS = [
    "pts_l3","pts_l5","pts_l10","pts_season_avg",
    "reb_l3","reb_l5","reb_l10","reb_season_avg",
    "ast_l3","ast_l5","ast_l10","ast_season_avg",
    "pra_l3","pra_l5","pra_l10","pra_season_avg",
    "min_l3","min_l5","min_l10","min_season_avg",
    "days_rest",
    "is_back_to_back","is_3_in_4","is_4_in_6",
    "is_home",
    "pts_baseline","reb_baseline","ast_baseline","pra_baseline","min_baseline",
]

TARGETS = ["PTS","REB","AST","PRA"]


def american_to_prob(odds: Optional[int]) -> Optional[float]:
    if odds is None:
        return None
    o = float(odds)
    if o < 0:
        return (-o) / ((-o) + 100.0)
    return 100.0 / (o + 100.0)

def ensure_model_registry_row(sb, model_version: str):
    # Create placeholder row if missing (FK requirement from ml_predictions)
    existing = (
        sb.schema("public")
          .table("ml_model_registry")
          .select("model_version")
          .eq("model_version", model_version)
          .limit(1)
          .execute()
    ).data or []

    if existing:
        return

    sb.schema("public").table("ml_model_registry").insert({
        "model_version": model_version,
        "notes": json.dumps({"kind": "nightly", "created_by": "generate_ml_predictions.py"})
    }).execute()


def df_records(df: pd.DataFrame) -> List[Dict[str, Any]]:
    import numpy as np
    def to_json_safe(v):
        if v is None:
            return None
        # NaN / Inf protection
        if isinstance(v, float):
            if math.isnan(v) or v == float("inf") or v == float("-inf"):
                return None
        if isinstance(v, (pd.Timestamp, datetime)):
            return v.isoformat()
        if isinstance(v, date):
            return v.isoformat()
        if isinstance(v, (np.integer,)):
            return int(v)
        if isinstance(v, (np.floating,)):
            fv = float(v)
            if math.isnan(fv) or fv == float("inf") or fv == float("-inf"):
                return None
            return fv
        if isinstance(v, (np.bool_,)):
            return bool(v)
        return v

    return [{k: to_json_safe(v) for k, v in row.items()} for row in df.to_dict(orient="records")]


def fetch_all(sb, table, cols, season=None, start=None, end=None, date_col="game_date", page_size=1000):
    """
    IMPORTANT FIXES:
    - Add deterministic ordering before using .range pagination (PostgREST can return empty without order)
    - Order by date_col, then game_id, then player_id
    """
    out = []
    offset = 0
    while True:
        q = sb.schema("public").table(table).select(cols)

        # deterministic pagination
        q = q.order(date_col, desc=False).order("game_id", desc=False).order("player_id", desc=False)

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


def get_model_registry_notes(sb, model_version: str) -> Dict:
    resp = (
        sb.schema("public").table("ml_model_registry")
        .select("notes")
        .eq("model_version", model_version)
        .limit(1)
        .execute()
    )
    data = resp.data or []
    if not data:
        return {}
    notes = data[0].get("notes")
    try:
        return json.loads(notes) if notes else {}
    except Exception:
        return {}


def coerce_feature_frame(df: pd.DataFrame) -> pd.DataFrame:
    """
    IMPORTANT FIXES:
    - Do NOT pd.to_numeric() booleans (it can turn true/false into NaN if they're already bool)
    - Convert numeric cols explicitly
    - Convert booleans to 0/1 consistently
    """
    df = df.copy()

    df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")

    # numeric cols only
    NUM_COLS = [
        "game_id","player_id","opponent_team_id","days_rest",
        "pts_l3","pts_l5","pts_l10","pts_season_avg",
        "reb_l3","reb_l5","reb_l10","reb_season_avg",
        "ast_l3","ast_l5","ast_l10","ast_season_avg",
        "pra_l3","pra_l5","pra_l10","pra_season_avg",
        "min_l3","min_l5","min_l10","min_season_avg",
        "pts_baseline","reb_baseline","ast_baseline","pra_baseline","min_baseline",
    ]
    for c in NUM_COLS:
        if c in df.columns:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # booleans -> float(0/1)
    BOOL_COLS = ["is_back_to_back", "is_3_in_4", "is_4_in_6", "is_home"]
    for b in BOOL_COLS:
        if b not in df.columns:
            continue
        if df[b].dtype == bool:
            df[b] = df[b].astype(int).astype(float)
        else:
            df[b] = (
                df[b].astype(str).str.lower()
                .map({"true": 1, "false": 0, "t": 1, "f": 0, "1": 1, "0": 0})
                .fillna(0)
                .astype(float)
            )

    return df


def main():
    load_dotenv(".env.local")

    ap = argparse.ArgumentParser()
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--season", default=None)
    ap.add_argument("--model-version", required=True)
    ap.add_argument("--upsert-batch", type=int, default=500)
    args = ap.parse_args()

    sb = supa()

    # Ensure model_version exists (don't fail hard here; just ensure table is reachable)
    ensure_model_registry_row(sb, args.model_version)

    # Load models
    models = {}
    for stat in TARGETS:
        path = f"model-artifacts/xgb_{stat}.joblib"
        if not os.path.exists(path):
            raise RuntimeError(f"Missing model artifact: {path}. Run train script first.")
        models[stat] = joblib.load(path)

    # Residual std fallbacks from registry notes (if present)
    notes = get_model_registry_notes(sb, args.model_version)
    resid_std_by_stat = {}
    if isinstance(notes, list):
        for r in notes:
            if isinstance(r, dict) and "stat_type" in r:
                try:
                    resid_std_by_stat[r["stat_type"]] = float(r.get("resid_std") or 0) or None
                except Exception:
                    resid_std_by_stat[r["stat_type"]] = None

    cols = ",".join(["game_id","player_id","season","game_date"] + FEATURE_COLS)

    # NOTE: you're scoring from truth_snapshot here (as pasted). That's fine for backtests.
    # If you want to score live future games, point this to "player_game_features".
    df = fetch_all(
        sb,
        "player_game_features",
        cols,
        season=args.season,
        start=args.start,
        end=args.end,
        date_col="game_date",
    )

    if df.empty:
        print("No features in window.")
        return

    df = coerce_feature_frame(df)

    # Build X in the exact column order expected by the model
    X = df[FEATURE_COLS].fillna(0)

    # Pull closing lines (optional)
    lines = fetch_all(
        sb,
        "v_closing_lines",
        "game_id,player_id,stat_type,line,odds_over,odds_under,captured_at",
        start=args.start,
        end=args.end,
        date_col="captured_at",
    )
    if not lines.empty:
        lines["game_id"] = pd.to_numeric(lines["game_id"], errors="coerce")
        lines["player_id"] = pd.to_numeric(lines["player_id"], errors="coerce")

    rows = []
    for stat in TARGETS:
        mu = models[stat].predict(X)
        # ---- Hard anchor to baseline to avoid superstar collapse ----
        blend = 0.35  # 0.25–0.45 is reasonable
        baseline_col = {
            "PTS": "pts_baseline",
            "REB": "reb_baseline",
            "AST": "ast_baseline",
            "PRA": "pra_baseline",
        }[stat]

        if baseline_col in df.columns:
            base = pd.to_numeric(df[baseline_col], errors="coerce").fillna(0).values
            mu = (1.0 - blend) * mu + blend * base


        # --- Safety rails: prevent superstar collapse ---
        # Use L10 / season avg as a minimum floor when available.
        l10_col = {
            "PTS": "pts_l10",
            "REB": "reb_l10",
            "AST": "ast_l10",
            "PRA": "pra_l10",
        }[stat]

        season_col = {
            "PTS": "pts_season_avg",
            "REB": "reb_season_avg",
            "AST": "ast_season_avg",
            "PRA": "pra_season_avg",
        }[stat]

        l10 = pd.to_numeric(df.get(l10_col), errors="coerce").values
        season_avg = pd.to_numeric(df.get(season_col), errors="coerce").values

        # Floor = 85% of max(L10, season_avg)
        floor = 0.85 * np.nanmax(np.vstack([l10, season_avg]), axis=0)

        # Only apply where floor is finite
        mask = np.isfinite(floor)
        mu[mask] = np.maximum(mu[mask], floor[mask])

        # sigma fallback: model residual std or simple constant
        sigma_fallback = resid_std_by_stat.get(stat) or (6.0 if stat == "PTS" else 2.5)
        sigma = pd.Series([sigma_fallback] * len(df))

        out = pd.DataFrame({
            "game_id": df["game_id"].astype("Int64"),
            "player_id": df["player_id"].astype("Int64"),
            "stat_type": stat,
            "model_mean": mu,
            "model_std": sigma,
            "model_version": args.model_version,
            "generated_at": pd.Timestamp.utcnow(),
        })

        # attach closing line + market prob if available
        if not lines.empty:
            lstat = lines[lines["stat_type"] == stat].copy()
            out = out.merge(lstat, on=["game_id","player_id"], how="left")

            # market prob from American odds (over)
            out["market_prob_over"] = out["odds_over"].apply(
                lambda x: american_to_prob(int(x)) if pd.notna(x) else None
            )

            # model prob over if line exists
            def prob_over(row):
                if pd.isna(row.get("line")) or pd.isna(row.get("model_mean")) or pd.isna(row.get("model_std")):
                    return None
                z = (float(row["line"]) - float(row["model_mean"])) / float(row["model_std"])
                return float(1.0 - norm.cdf(z))

            out["model_prob_over"] = out.apply(prob_over, axis=1)
            out["delta"] = out["model_prob_over"] - out["market_prob_over"]

            out = out[[
                "game_id","player_id","stat_type",
                "line",
                "model_mean","model_std",
                "model_prob_over","market_prob_over","delta",
                "model_version","generated_at"
            ]]
        else:
            out = out[[
                "game_id","player_id","stat_type",
                "model_mean","model_std",
                "model_version","generated_at"
            ]]

        rows.append(out)

    out_all = pd.concat(rows, ignore_index=True)
    out_all = out_all.dropna(subset=["game_id","player_id"])

    recs = df_records(out_all)

    total = 0
    for i in range(0, len(recs), args.upsert_batch):
        batch = recs[i:i+args.upsert_batch]
        sb.schema("public").table("ml_predictions").upsert(
            batch,
            on_conflict="game_id,player_id,stat_type,model_version"
        ).execute()
        total += len(batch)

    print(f"✅ Upserted ML predictions: {total}")


if __name__ == "__main__":
    main()
