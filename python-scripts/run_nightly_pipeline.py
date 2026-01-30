#!/usr/bin/env python3
import os
import subprocess
from datetime import datetime, timedelta, timezone

def run(cmd: str):
    print(f"\n$ {cmd}")
    subprocess.check_call(cmd, shell=True)

def main():
    # Use UTC dates consistently
    today = datetime.now(timezone.utc).date()
    start = today.isoformat()
    end = (today + timedelta(days=7)).isoformat()

    # Make model_version unique per day (so UI can pick “latest”)
    model_version = "xgb_prod"

    # 1) Ingest new boxscores (if you have this script)
    # run("python3 python-scripts/ingest_boxscores.py")

    # 2) (Optional) rebuild past features for last N days (if you have this script)
    # run("python3 python-scripts/rebuild_recent_features.py --days 30")

    # 3) Build pregame features for upcoming games
    run(f"python3 python-scripts/build_pregame_features.py --start {start} --end {end}")

    # 4) Generate ML predictions for upcoming games
    run(
        "python3 python-scripts/generate_ml_predictions.py "
        f"--start {start} --end {end} "
        f"--season 2025-26 "
        f"--model-version {model_version}"
    )

    print("\n✅ Nightly pipeline complete.")
    print("Window:", start, "to", end)
    print("Model version:", model_version)

if __name__ == "__main__":
    main()
