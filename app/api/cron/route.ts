import { NextResponse } from "next/server";

export const runtime = "nodejs";

const NBA_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.nba.com/",
  Origin: "https://www.nba.com",
  Host: "stats.nba.com",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  Connection: "keep-alive",
};

const TEST_URL =
  "https://stats.nba.com/stats/leaguegamelog?Counter=1&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=2025-26&SeasonType=Regular+Season&Sorter=DATE";

export async function GET() {
  try {
    const response = await fetch(TEST_URL, {
      headers: NBA_HEADERS,
      cache: "no-store",
    });
    const sample = await response.text();

    return NextResponse.json(
      {
        testUrl: TEST_URL,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        sample: sample.slice(0, 400),
      },
      { status: response.ok ? 200 : response.status }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        testUrl: TEST_URL,
        error: message,
      },
      { status: 502 }
    );
  }
}
