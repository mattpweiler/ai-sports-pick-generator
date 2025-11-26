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

type LogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
};

const logPrefix = "[cron-connectivity]";

function createLogger() {
  const logs: LogEntry[] = [];
  const push = (level: LogEntry["level"], message: string, meta?: Record<string, unknown>) => {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message };
    if (meta && Object.keys(meta).length) entry.meta = meta;
    logs.push(entry);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`${logPrefix} ${entry.ts} [${level}] ${message}`, meta ?? "");
  };
  return {
    logs,
    info: (message: string, meta?: Record<string, unknown>) => push("info", message, meta),
    warn: (message: string, meta?: Record<string, unknown>) => push("warn", message, meta),
    error: (message: string, meta?: Record<string, unknown>) => push("error", message, meta),
  };
}

export async function GET() {
  const logger = createLogger();
  const startedAt = Date.now();
  logger.info("connectivity test invoked", { testUrl: TEST_URL });

  try {
    const response = await fetch(TEST_URL, {
      headers: NBA_HEADERS,
      cache: "no-store",
    });
    const sample = await response.text();
    const summary = {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
    };

    logger.info("fetch completed", { ...summary });

    return NextResponse.json(
      {
        testUrl: TEST_URL,
        ...summary,
        durationMs: Date.now() - startedAt,
        sample: sample.slice(0, 400),
        logs: logger.logs,
      },
      { status: response.ok ? 200 : response.status }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("fetch threw", {
      error: message,
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      {
        testUrl: TEST_URL,
        error: message,
        durationMs: Date.now() - startedAt,
        logs: logger.logs,
      },
      { status: 502 }
    );
  }
}
