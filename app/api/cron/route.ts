import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const LOG_PREFIX = "[cron]";
const DEFAULT_SEASON = "2025-26";
const DEFAULT_SEASON_TYPE = "Regular Season";
const DEFAULT_RECENT_DAYS = 5;
const DEFAULT_TIMEZONE = "America/Chicago";
const SLEEP_AFTER_LIST_MS = 2000;
const SLEEP_BETWEEN_GAMES_MS = 1000;
const RETRY_BASE_DELAY_MS = 1000;
const MAX_V3_RETRIES = 5;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE;
const DEFAULT_SCHEMA = process.env.SUPABASE_SCHEMA || "public";
const DEFAULT_TABLE =
  process.env.SUPABASE_TABLE || "pergame_player_base_stats_2025_26";

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

type LogEntry = {
  ts: string;
  level: "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
};

type GameRow = {
  game_id: string;
  game_date: string | null;
  matchup: string | null;
  parsedDate: Date | null;
};

type RowValue = string | number | null;
type PlayerRow = Record<string, unknown>;

type BoxScoreResponse = {
  boxScoreTraditional?: {
    headers?: string[];
    rowSet?: RowValue[][];
    playerStats?: PlayerRow[];
    players?: PlayerRow[];
  };
};

type NormalizedPlayerRow = {
  game_id: string;
  team_abbr: string | null;
  player_id: number | null;
  player_name: string | null;
  start_pos: string | null;
  min: string | null;
  fgm: number | null;
  fga: number | null;
  fg_pct: number | null;
  fg3m: number | null;
  fg3a: number | null;
  fg3_pct: number | null;
  ftm: number | null;
  fta: number | null;
  ft_pct: number | null;
  oreb: number | null;
  dreb: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  tov: number | null;
  pf: number | null;
  pts: number | null;
  plus_minus: number | null;
  comment: string | null;
  matchup?: string | null;
  game_date?: string | null;
  row_checksum?: string;
  updated_at?: string;
};

type UpsertPayload = Omit<NormalizedPlayerRow, "row_checksum" | "updated_at">;

type Logger = {
  logs: LogEntry[];
  info: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
  error: (message: string, meta?: Record<string, unknown>) => void;
};

function createLogger(): Logger {
  const logs: LogEntry[] = [];
  const push = (
    level: LogEntry["level"],
    message: string,
    meta?: Record<string, unknown>
  ) => {
    const ts = new Date().toISOString();
    const entry: LogEntry = { ts, level, message };
    if (meta && Object.keys(meta).length) {
      try {
        entry.meta = JSON.parse(JSON.stringify(meta));
      } catch (err) {
        entry.meta = { note: "meta serialization failed", error: String(err) };
      }
    }
    logs.push(entry);
    const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    fn(`${LOG_PREFIX} ${ts} [${level}] ${message}`, meta ?? "");
  };
  return {
    logs,
    info: (message, meta) => push("info", message, meta),
    warn: (message, meta) => push("warn", message, meta),
    error: (message, meta) => push("error", message, meta),
  };
}

const toIsoDate = (date: Date) => date.toISOString().slice(0, 10);

const tzIsoDate = (timeZone: string, offsetDays = 0) => {
  const now = new Date();
  const tzDate = new Date(now.toLocaleString("en-US", { timeZone }));
  tzDate.setDate(tzDate.getDate() + offsetDays);
  return toIsoDate(tzDate);
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.max(ms, 0)));

const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

const safeNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const safeString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === "" ? null : str;
};

const parseDate = (value: string | null): Date | null => {
  if (!value) return null;
  const attempt = new Date(value);
  if (!Number.isNaN(attempt.getTime())) return attempt;
  const fallback = new Date(`${value} UTC`);
  if (!Number.isNaN(fallback.getTime())) return fallback;
  return null;
};

async function fetchJSON<T>(
  url: string,
  logger: Logger,
  opts: RequestInit = {},
  retries = 5
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await fetch(url, {
        ...opts,
        headers: { ...NBA_HEADERS, ...(opts.headers || {}) },
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      return (await response.json()) as T;
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        logger.warn("fetch retry", {
          url,
          attempt,
          retries,
          error: err instanceof Error ? err.message : String(err),
        });
        await sleep(RETRY_BASE_DELAY_MS * attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function fetchGames(
  season: string,
  seasonType: string,
  dateFrom: string,
  dateTo: string,
  logger: Logger
): Promise<GameRow[]> {
  type LeagueGameLogResponse = {
    resultSets?: Array<{ headers: string[]; rowSet: RowValue[][]; name?: string }>;
    resultSet?: { headers: string[]; rowSet: RowValue[][] };
  };

  const params = new URLSearchParams({
    Counter: "10000",
    Direction: "ASC",
    LeagueID: "00",
    PlayerOrTeam: "T",
    Season: season,
    SeasonType: seasonType,
    Sorter: "DATE",
    DateFrom: dateFrom,
    DateTo: dateTo,
  });

  const json = await fetchJSON<LeagueGameLogResponse>(
    `https://stats.nba.com/stats/leaguegamelog?${params.toString()}`,
    logger
  );

  const rs =
    json.resultSets?.find((set) =>
      (set.name || "").toLowerCase().includes("leaguegamelog")
    ) || json.resultSets?.[0] || json.resultSet;

  if (!rs) return [];

  const { headers, rowSet } = rs;
  const idx: Record<string, number> = {};
  headers.forEach((header, i) => {
    idx[header] = i;
  });

  const seen = new Set<string>();
  const games: GameRow[] = [];
  for (const row of rowSet) {
    const gameId = String(row[idx["GAME_ID"]]);
    if (seen.has(gameId)) continue;
    seen.add(gameId);
    const gameDateRaw = row[idx["GAME_DATE"]] as string | null;
    const parsed = parseDate(gameDateRaw);
    const iso = parsed ? toIsoDate(parsed) : gameDateRaw;
    games.push({
      game_id: gameId,
      game_date: iso,
      matchup: row[idx["MATCHUP"]] !== undefined && row[idx["MATCHUP"]] !== null ? String(row[idx["MATCHUP"]]) : null,
      parsedDate: parsed,
    });
  }

  games.sort((a, b) => {
    if (!a.game_date && !b.game_date) return 0;
    if (!a.game_date) return 1;
    if (!b.game_date) return -1;
    return a.game_date.localeCompare(b.game_date);
  });

  logger.info("games enumerated", { count: games.length });
  return games;
}

async function fetchBoxScoreTraditionalV3(
  gameId: string,
  logger: Logger
): Promise<BoxScoreResponse | null> {
  for (let attempt = 1; attempt <= MAX_V3_RETRIES; attempt++) {
    try {
      const params = new URLSearchParams({ GameID: gameId, LeagueID: "00" });
      const data = await fetchJSON<BoxScoreResponse>(
        `https://stats.nba.com/stats/boxscoretraditionalv3?${params.toString()}`,
        logger
      );
      return data;
    } catch (err) {
      logger.warn("boxscore fetch failed", {
        gameId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(RETRY_BASE_DELAY_MS * attempt);
    }
  }

  logger.error("boxscore failed after retries", { gameId });
  return null;
}

function pickPlayerFrame(v3: BoxScoreResponse | null | undefined): PlayerRow[] {
  const camel =
    v3?.boxScoreTraditional?.playerStats || v3?.boxScoreTraditional?.players;
  if (Array.isArray(camel) && camel.length) return camel;

  const headers = v3?.boxScoreTraditional?.headers;
  const rows = v3?.boxScoreTraditional?.rowSet;
  if (!Array.isArray(headers) || !Array.isArray(rows)) return [];

  const idx: Record<string, number> = {};
  headers.forEach((header: string, i: number) => {
    idx[header] = i;
  });

  return rows.map((row: RowValue[]) => {
    const pick = (key: string) => {
      const position = idx[key];
      return position === undefined ? undefined : row[position];
    };
    return {
      personId: pick("PLAYER_ID") ?? pick("PERSON_ID"),
      playerName: pick("PLAYER_NAME"),
      teamTricode: pick("TEAM_ABBREVIATION"),
      position: pick("START_POSITION"),
      comment: pick("COMMENT"),
      minutes: pick("MIN"),
      fieldGoalsMade: pick("FGM"),
      fieldGoalsAttempted: pick("FGA"),
      fieldGoalsPercentage: pick("FG_PCT"),
      threePointersMade: pick("FG3M"),
      threePointersAttempted: pick("FG3A"),
      threePointersPercentage: pick("FG3_PCT"),
      freeThrowsMade: pick("FTM"),
      freeThrowsAttempted: pick("FTA"),
      freeThrowsPercentage: pick("FT_PCT"),
      reboundsOffensive: pick("OREB"),
      reboundsDefensive: pick("DREB"),
      reboundsTotal: pick("REB"),
      assists: pick("AST"),
      steals: pick("STL"),
      blocks: pick("BLK"),
      turnovers: pick("TOV") ?? pick("TO") ?? pick("TURNOVERS"),
      personalFouls: pick("PF"),
      points: pick("PTS"),
      plusMinusPoints: pick("PLUS_MINUS"),
    } as PlayerRow;
  });
}

function normalizePlayerBase(rows: PlayerRow[], gameId: string): NormalizedPlayerRow[] {
  return rows.map((row) => {
    const playerId = row.personId ?? row.player_id ?? row.PLAYER_ID;
    const first = safeString(row.firstName);
    const last = safeString(row.familyName);
    const slug = safeString(row.playerSlug);
    const combined = [first, last].filter(Boolean).join(" ").trim();
    const playerName = safeString(combined || row.playerName || slug || null);

    return {
      game_id: gameId,
      team_abbr: safeString(row.teamTricode ?? row.team_abbr),
      player_id: safeNumber(playerId),
      player_name: playerName,
      start_pos: safeString(row.position ?? row.start_pos),
      min: safeString(row.minutes ?? row.min),
      fgm: safeNumber(row.fieldGoalsMade ?? row.fgm),
      fga: safeNumber(row.fieldGoalsAttempted ?? row.fga),
      fg_pct: safeNumber(row.fieldGoalsPercentage ?? row.fg_pct),
      fg3m: safeNumber(row.threePointersMade ?? row.fg3m),
      fg3a: safeNumber(row.threePointersAttempted ?? row.fg3a),
      fg3_pct: safeNumber(row.threePointersPercentage ?? row.fg3_pct),
      ftm: safeNumber(row.freeThrowsMade ?? row.ftm),
      fta: safeNumber(row.freeThrowsAttempted ?? row.fta),
      ft_pct: safeNumber(row.freeThrowsPercentage ?? row.ft_pct),
      oreb: safeNumber(row.reboundsOffensive ?? row.oreb),
      dreb: safeNumber(row.reboundsDefensive ?? row.dreb),
      reb: safeNumber(row.reboundsTotal ?? row.reb),
      ast: safeNumber(row.assists ?? row.ast),
      stl: safeNumber(row.steals ?? row.stl),
      blk: safeNumber(row.blocks ?? row.blk),
      tov: safeNumber(row.turnovers ?? row.tov ?? row.TOV ?? row.TO),
      pf: safeNumber(row.personalFouls ?? row.foulsPersonal ?? row.pf),
      pts: safeNumber(row.points ?? row.pts),
      plus_minus: safeNumber(row.plusMinusPoints ?? row.plus_minus ?? row.plusMinus),
      comment: safeString(row.comment),
    };
  });
}

const checksumFields: Array<keyof NormalizedPlayerRow> = [
  "team_abbr",
  "player_id",
  "player_name",
  "start_pos",
  "min",
  "fgm",
  "fga",
  "fg_pct",
  "fg3m",
  "fg3a",
  "fg3_pct",
  "ftm",
  "fta",
  "ft_pct",
  "oreb",
  "dreb",
  "reb",
  "ast",
  "stl",
  "blk",
  "tov",
  "pf",
  "pts",
  "plus_minus",
  "comment",
];

function computeRowChecksum(row: NormalizedPlayerRow) {
  const joined = checksumFields.map((key) => String(row[key] ?? "")).join("|");
  return sha256(joined);
}

async function supabaseDistinctGameIds(
  client: SupabaseClient,
  table: string,
  gameIds: string[],
  logger: Logger
) {
  const present = new Set<string>();
  const chunkSize = 200;
  for (let i = 0; i < gameIds.length; i += chunkSize) {
    const chunk = gameIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const { data, error } = await client
      .from(table)
      .select("game_id")
      .in("game_id", chunk);
    if (error) {
      logger.error("supabase game_id scan failed", {
        chunkStart: i,
        chunkSize: chunk.length,
        error: error.message,
      });
      throw error;
    }
    (data ?? []).forEach((row: { game_id?: string }) => {
      if (row.game_id) present.add(String(row.game_id));
    });
    logger.info("supabase chunk processed", {
      chunkStart: i,
      chunkSize: chunk.length,
      cumulative: present.size,
    });
    await sleep(100);
  }
  return present;
}

async function upsertRows(
  client: SupabaseClient,
  table: string,
  rows: NormalizedPlayerRow[],
  logger: Logger
) {
  if (!rows.length) return;
  const stripped: UpsertPayload[] = rows.map((row) => {
    const { row_checksum, updated_at, ...rest } = row;
    void row_checksum;
    void updated_at;
    return rest;
  });
  const batchSize = 500;
  for (let i = 0; i < stripped.length; i += batchSize) {
    const batch = stripped.slice(i, i + batchSize);
    const { error } = await client
      .from(table)
      .upsert(batch, { onConflict: "game_id,player_id" });
    if (error) {
      logger.error("supabase upsert failed", {
        error: error.message,
        batchStart: i,
      });
      throw error;
    }
    logger.info("upsert batch committed", {
      batchStart: i,
      batchSize: batch.length,
    });
  }
}

export async function GET(req: NextRequest) {
  const logger = createLogger();
  const startedAt = Date.now();

  try {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
      logger.error("missing Supabase env vars");
      return NextResponse.json(
        { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE", logs: logger.logs },
        { status: 500 }
      );
    }

    const url = new URL(req.url);
    const params = url.searchParams;

    const season = params.get("season") || DEFAULT_SEASON;
    const seasonType = params.get("seasonType") || DEFAULT_SEASON_TYPE;
    const dateFrom = params.get("dateFrom") || tzIsoDate(DEFAULT_TIMEZONE, DEFAULT_RECENT_DAYS * -1);
    const dateTo = params.get("dateTo") || tzIsoDate(DEFAULT_TIMEZONE, 0);
    const recentDays = Number(params.get("recentDays") || DEFAULT_RECENT_DAYS);
    const schema = params.get("schema") || DEFAULT_SCHEMA;
    const table = params.get("table") || DEFAULT_TABLE;
    const dryRun = (params.get("dryRun") || "").toLowerCase() === "true";
    const connectivityTest = (params.get("connectivityTest") || "").toLowerCase() === "true";

    logger.info("cron invoked", {
      season,
      seasonType,
      dateFrom,
      dateTo,
      recentDays,
      schema,
      table,
      dryRun,
      connectivityTest,
    });

    if (true) {
      const testUrl =
        "https://stats.nba.com/stats/leaguegamelog?Counter=1&Direction=ASC&LeagueID=00&PlayerOrTeam=T&Season=2025-26&SeasonType=Regular+Season&Sorter=DATE";
      logger.info("running connectivity test", { testUrl });
      try {
        const res = await fetch(testUrl, {
          headers: NBA_HEADERS,
          cache: "no-store",
        });
        const text = await res.text();
        const payload = {
          ok: res.ok,
          status: res.status,
          statusText: res.statusText,
          sample: text.slice(0, 300),
        };
        logger.info("connectivity test response", payload);
        return NextResponse.json({ testUrl, ...payload, logs: logger.logs });
      } catch (err) {
        logger.error("connectivity test failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        return NextResponse.json(
          {
            error: err instanceof Error ? err.message : String(err),
            testUrl,
            logs: logger.logs,
          },
          { status: 502 }
        );
      }
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
      auth: { persistSession: false },
      global: { fetch },
      db: { schema },
    });

    const games = await fetchGames(season, seasonType, dateFrom, dateTo, logger);
    if (!games.length) {
      logger.info("no games in range");
      return NextResponse.json(
        {
          message: "No games in window",
          params: { season, seasonType, dateFrom, dateTo },
          logs: logger.logs,
          durationMs: Date.now() - startedAt,
        },
        { status: 200 }
      );
    }

    const gameIds = games.map((g) => g.game_id);
    logger.info("checking Supabase for existing game_ids", { total: gameIds.length });
    const present = await supabaseDistinctGameIds(supabase as any, table, gameIds, logger);

    const recentCutoff = new Date(Date.now() - recentDays * 24 * 60 * 60 * 1000);
    const recentSet = new Set(
      games
        .filter((g) => g.parsedDate && g.parsedDate >= recentCutoff)
        .map((g) => g.game_id)
    );
    const missing = gameIds.filter((gid) => !present.has(gid));
    const targets = Array.from(new Set([...missing, ...Array.from(recentSet)])).sort();

    logger.info("target set computed", {
      missing: missing.length,
      recent: recentSet.size,
      toFetch: targets.length,
    });

    if (!targets.length) {
      return NextResponse.json(
        {
          message: "Nothing to fetch",
          stats: {
            gamesInWindow: games.length,
            missing: missing.length,
            recent: recentSet.size,
            targets: 0,
          },
          logs: logger.logs,
          durationMs: Date.now() - startedAt,
        },
        { status: 200 }
      );
    }

    if (dryRun) {
      logger.info("dry run requested; skipping network calls beyond plan");
      return NextResponse.json(
        {
          message: "Dry run",
          stats: {
            gamesInWindow: games.length,
            missing: missing.length,
            recent: recentSet.size,
            targets: targets.length,
          },
          logs: logger.logs,
          durationMs: Date.now() - startedAt,
        },
        { status: 200 }
      );
    }

    logger.info("pausing before V3 requests", { delayMs: SLEEP_AFTER_LIST_MS });
    await sleep(SLEEP_AFTER_LIST_MS);

    const metaById = new Map(
      games.map((g) => [g.game_id, { game_date: g.game_date, matchup: g.matchup }])
    );

    const rowsToUpsert: NormalizedPlayerRow[] = [];

    for (let i = 0; i < targets.length; i++) {
      const gameId = targets[i];
      logger.info("fetching game", { index: i + 1, total: targets.length, gameId });

      try {
        const v3 = await fetchBoxScoreTraditionalV3(gameId, logger);
        if (!v3) continue;
        const players = pickPlayerFrame(v3);
        if (!players.length) {
          logger.warn("no player frame", { gameId });
          continue;
        }

        const normalized = normalizePlayerBase(players, gameId);
        const meta = metaById.get(gameId);
        normalized.forEach((row) => {
          row.game_date = meta?.game_date ?? null;
          row.matchup = meta?.matchup ?? null;
          row.row_checksum = computeRowChecksum(row);
          row.updated_at = new Date().toISOString();
        });

        rowsToUpsert.push(...normalized);
        logger.info("game normalized", {
          gameId,
          rows: normalized.length,
          buffered: rowsToUpsert.length,
        });
      } catch (err) {
        logger.error("game processing failed", {
          gameId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      if ((i + 1) % 10 === 0) {
        logger.info("progress", { processedGames: i + 1, totalGames: targets.length });
      }

      await sleep(SLEEP_BETWEEN_GAMES_MS);
    }

    if (!rowsToUpsert.length) {
      logger.warn("no rows to upsert after processing");
      return NextResponse.json(
        {
          message: "Nothing to write",
          stats: {
            gamesProcessed: targets.length,
            rowsBuffered: 0,
          },
          logs: logger.logs,
          durationMs: Date.now() - startedAt,
        },
        { status: 200 }
      );
    }

    logger.info("upserting rows", { count: rowsToUpsert.length });
    await upsertRows(supabase as any, table, rowsToUpsert, logger);

    const durationMs = Date.now() - startedAt;
    logger.info("cron completed", {
      durationMs,
      gamesProcessed: targets.length,
      rowsUpserted: rowsToUpsert.length,
    });

    return NextResponse.json(
      {
        message: "Sync complete",
        stats: {
          gamesInWindow: games.length,
          gamesProcessed: targets.length,
          rowsUpserted: rowsToUpsert.length,
          missingGames: missing.length,
          recentGames: recentSet.size,
        },
        params: { season, seasonType, dateFrom, dateTo, recentDays, schema, table },
        durationMs,
        logs: logger.logs,
      },
      { status: 200 }
    );
  } catch (err) {
    logger.error("cron crashed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      {
        error: err instanceof Error ? err.message : String(err),
        logs: logger.logs,
        durationMs: Date.now() - startedAt,
      },
      { status: 500 }
    );
  }
}
