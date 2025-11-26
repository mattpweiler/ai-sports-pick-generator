#!/usr/bin/env python3
"""Minimal connectivity test for stats.nba.com.

Run locally to confirm the NBA endpoint is reachable from your network.
"""

from __future__ import annotations

import sys
import textwrap
from datetime import datetime

import requests

TEST_URL = (
    "https://stats.nba.com/stats/leaguegamelog"
    "?Counter=1&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=2025-26"
    "&SeasonType=Regular+Season&Sorter=DATE"
)

NBA_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/120 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Host": "stats.nba.com",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
    "Connection": "keep-alive",
}


def main() -> int:
    print(f"[{datetime.utcnow().isoformat()}Z] Connectivity test hitting:\n  {TEST_URL}")

    try:
        resp = requests.get(TEST_URL, headers=NBA_HEADERS, timeout=30)
        sample = resp.text[:400]
        print("--- Response metadata ---")
        print(f"HTTP {resp.status_code} {resp.reason}")
        print(f"Content-Length: {resp.headers.get('content-length', 'unknown')}")
        print(f"Content-Type: {resp.headers.get('content-type', 'unknown')}")
        print("--- Body sample (first 400 chars) ---")
        print(textwrap.indent(sample, prefix="    "))
        if resp.ok:
            print("Result: SUCCESS")
            return 0
        print("Result: NON-200 RESPONSE")
        return 1
    except requests.RequestException as exc:
        print("Result: REQUEST FAILED")
        print(f"Error: {exc}")
        return 2


if __name__ == "__main__":
    sys.exit(main())
