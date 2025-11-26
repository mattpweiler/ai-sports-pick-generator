import { NextResponse } from "next/server";

type LogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
};

const NBA_SCOREBOARD_URL =
  "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json";

function createLogger() {
  const logs: LogEntry[] = [];
  const push = (level: LogEntry["level"], message: string, meta?: Record<string, unknown>) => {
    const entry: LogEntry = { ts: new Date().toISOString(), level, message };
    if (meta && Object.keys(meta).length) entry.meta = meta;
    logs.push(entry);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`[cron] ${entry.ts} [${level}] ${message}`, meta ?? "");
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
  logger.info("cron invoked", { url: NBA_SCOREBOARD_URL });

  try {
    logger.info("fetching scoreboard", { cache: "no-store" });
    const resp = await fetch(NBA_SCOREBOARD_URL, {
      cache: "no-store",
    });

    logger.info("fetch completed", {
      ok: resp.ok,
      status: resp.status,
      statusText: resp.statusText,
    });

    if (!resp.ok) {
      return NextResponse.json(
        {
          success: false,
          error: "Failed to fetch NBA data",
          status: resp.status,
          durationMs: Date.now() - startedAt,
          logs: logger.logs,
        },
        { status: 500 }
      );
    }

    const data = await resp.json();
    const games = data?.scoreboard?.games ?? [];
    logger.info("payload parsed", {
      gamesCount: Array.isArray(games) ? games.length : 0,
      keys: data ? Object.keys(data) : [],
    });

    return NextResponse.json({
      success: true,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - startedAt,
      games,
      logs: logger.logs,
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    logger.error("cron failed", {
      error: errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json(
      {
        success: false,
        error: errorMessage,
        durationMs: Date.now() - startedAt,
        logs: logger.logs,
      },
      { status: 500 }
    );
  }
}
