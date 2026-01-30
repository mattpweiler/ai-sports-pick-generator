#!/usr/bin/env python3
"""
train_ml_models.py

Train XGBoost regression models per stat (PTS/REB/AST/PRA) using:
  - public.player_game_features

Outputs:
  - saved model artifacts to ./model-artifacts/
  - writes model_version into public.ml_model_registry

Env:
  SUPABASE_URL
  SUPABASE_SERVICE_ROLE

Usage example:
  python3 python-scripts/train_ml_models.py --model-version xgb_v2_2026-01-19
"""

import argparse
import os
import json
from datetime import datetime
from typing import Dict, List
from _supa import supa

import pandas as pd
from dotenv import load_dotenv
from supabase import create_client
from xgboost import XGBRegressor
from sklearn.model_selection import train_test_split
from sklearn.metrics import mean_absolute_error
import joblib


# ---------------------- Feature set (MUST match generate_ml_predictions.py) ----------------------
FEATURE_COLS = [
    # core rolling + season avg signals (MVP)
    "pts_l3","pts_l5","pts_l10","pts_season_avg",
    "reb_l3","reb_l5","reb_l10","reb_season_avg",
    "ast_l3","ast_l5","ast_l10","ast_season_avg",
    "pra_l3","pra_l5","pra_l10","pra_season_avg",
    "min_l3","min_l5","min_l10","min_season_avg",
    "days_rest",
    "is_back_to_back","is_3_in_4","is_4_in_6",
    "is_home",
    # player prior anchors (v2)
    "pts_baseline","reb_baseline","ast_baseline","pra_baseline","min_baseline",
]

TARGET_MAP = {
    "PTS": "pts",
    "REB": "reb",
    "AST": "ast",
    "PRA": "pra",
}

BOOL_COLS = ["is_back_to_back", "is_3_in_4", "is_4_in_6", "is_home"]


def fetch_all(sb, table, cols, season=None, start=None, end=None, page_size=1000) -> pd.DataFrame:
    out = []
    offset = 0
    while True:
        q = sb.schema("public").table(table).select(cols)
        if season:
            q = q.eq("season", season)
        if start:
            q = q.gte("game_date", start)
        if end:
            q = q.lte("game_date", end)
        resp = q.range(offset, offset + page_size - 1).execute()
        data = resp.data or []
        out.extend(data)
        if len(data) < page_size:
            break
        offset += page_size
    return pd.DataFrame(out)


def prep_df(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    # Parse date
    if "game_date" in df.columns:
        df["game_date"] = pd.to_datetime(df["game_date"], errors="coerce")

    # Convert numeric columns safely
    numeric_cols = list(set(FEATURE_COLS + ["pts","reb","ast","pra","player_id","game_id"]))
    for c in numeric_cols:
        if c in df.columns and c not in BOOL_COLS:
            df[c] = pd.to_numeric(df[c], errors="coerce")

    # Booleans -> 0/1 (robust to True/False, 't'/'f', 'true'/'false')
    for b in BOOL_COLS:
        if b in df.columns:
            # Normalize strings
            s = df[b]
            if s.dtype == object:
                s = s.astype(str).str.lower().map({"true": 1, "false": 0, "t": 1, "f": 0})
            df[b] = s.fillna(0).astype(int)

    return df


def train_one(df: pd.DataFrame, stat_type: str, model_dir: str) -> Dict:
    target_col = TARGET_MAP[stat_type]

    # Drop rows with missing target
    work = df.dropna(subset=[target_col]).copy()

    # Ensure all features exist
    missing = [c for c in FEATURE_COLS if c not in work.columns]
    if missing:
        raise RuntimeError(
            f"Missing expected feature columns in training data: {missing}\n"
            "Fix: ensure these columns exist in public.player_game_features and are included in the SELECT."
        )

    X = work[FEATURE_COLS].fillna(0)
    y = work[target_col]

    X_train, X_val, y_train, y_val = train_test_split(
        X, y, test_size=0.15, random_state=42
    )

    model = XGBRegressor(
        n_estimators=700,
        max_depth=5,
        learning_rate=0.05,
        subsample=0.9,
        colsample_bytree=0.9,
        reg_lambda=1.0,
        objective="reg:squarederror",
        n_jobs=4,
    )

    model.fit(X_train, y_train)

    preds = model.predict(X_val)
    mae = float(mean_absolute_error(y_val, preds))

    residuals = (y_val - preds)
    resid_std = float(residuals.std())

    path = os.path.join(model_dir, f"xgb_{stat_type}.joblib")
    joblib.dump(model, path)

    return {
        "stat_type": stat_type,
        "mae": mae,
        "resid_std": resid_std,
        "artifact": path,
        "n_train": int(len(X_train)),
        "n_val": int(len(X_val)),
        "feature_cols": FEATURE_COLS,
    }


def main():
    load_dotenv(".env.local")

    ap = argparse.ArgumentParser()
    ap.add_argument("--train-season", default="2024-25", help="season to train on")
    ap.add_argument("--train-start", default="2024-10-22")
    ap.add_argument("--train-end", default="2025-04-15")
    ap.add_argument("--model-version", default=None)
    args = ap.parse_args()

    model_version = args.model_version or f"xgb_v1_{datetime.utcnow().date().isoformat()}"
    model_dir = "model-artifacts"
    os.makedirs(model_dir, exist_ok=True)

    sb = supa()

    # IMPORTANT: select ALL columns needed for training (targets + FEATURE_COLS + IDs)
    cols = ",".join(["game_id","player_id","season","game_date","pts","reb","ast","pra"] + FEATURE_COLS)

    print(f"→ Fetching features for training: {args.train-season if hasattr(args,'train-season') else args.train_season} {args.train_start}..{args.train_end}")
    # (above line keeps output stable even if attribute naming changes)
    df = fetch_all(
        sb,
        "player_game_features_truth_snapshot",
        cols,
        season=args.train_season,
        start=args.train_start,
        end=args.train_end,
    )
    df = prep_df(df)

    if df.empty:
        raise RuntimeError("No training rows fetched.")

    print(f"→ Training rows: {len(df)}")

    results: List[Dict] = []
    for stat in ["PTS", "REB", "AST", "PRA"]:
        print(f"→ Training {stat}...")
        results.append(train_one(df, stat, model_dir))

    # Write/Upsert registry entry
    sb.schema("public").table("ml_model_registry").upsert(
        {"model_version": model_version, "notes": json.dumps(results)},
        on_conflict="model_version"
    ).execute()

    print("\n✅ TRAIN COMPLETE")
    print("Model version:", model_version)
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
