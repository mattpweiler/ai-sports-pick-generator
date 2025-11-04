// app/api/cron/route.ts
export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ---------------------- Config defaults ----------------------
const DEFAULT_SEASON = process.env.NBA_SEASON || "2025-26";
const DEFAULT_SEASON_TYPE =
  process.env.NBA_SEASON_TYPE || "Regular Season"; // "Regular Season" | "Playoffs" | "Pre Season" | "All Star" | "PlayIn"
const DEFAULT_RECENT_DAYS = Number(process.env.RECENT_DAYS || 7);
const SLEEP_BETWEEN_GAMES_MS = 1000;
const SLEEP_AFTER_LIST_MS = 2000;
const BATCH_SIZE = 500;

// ---------------------- Supabase config ----------------------
const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
const SUPABASE_SCHEMA = process.env.SUPABASE_SCHEMA || "public";
const SUPABASE_TABLE =
  process.env.SUPABASE_TABLE || "pergame_player_base_stats_2025_26";

// ---------------------- NBA request headers ----------------------
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

// ---------------------- Logger ----------------------
type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";
const logs: string[] = [];
function log(level: LogLevel, msg: string, meta?: any) {
  const line =
    `[${new Date().toISOString()}] [${level}] ${msg}` +
    (meta ? ` | ${safeJson(meta)}` : "");
  logs.push(line);
  if (level === "ERROR") console.error(line);
  else if (level === "WARN") console.warn(line);
  else console.log(line);
}
function safeJson(v: any) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function mask(str?: string, visible = 4) {
  if (!str) return "";
  if (str.length <= visible) return "****";
  return `${str.slice(0, visible)}***`;
}

// ---------------------- Supabase helper ----------------------
function supa() {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  // @ts-ignore: schema() is available in supabase-js v2
  return client.schema(SUPABASE_SCHEMA);
}

// ---------------------- Utils ----------------------
function toISODate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  const dt = typeof d === "string" ? new Date(d) : d;
  if (isNaN(dt.getTime())) return null;
  return dt.toISOString().slice(0, 10);
}
function sha256(text: string) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
function rowChecksum(row: any): string {
  const keys = [
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
  const s = keys.map((k) => String(row?.[k] ?? "")).join("|");
  return sha256(s);
}
function todayIsoLocalChicago(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(new Date())
    .reduce((acc: any, p) => ((acc[p.type] = p.value), acc), {});
  return `${parts.year}-${parts.month}-${parts.day}`; // YYYY-MM-DD
}
function addDaysISO(iso: string, delta: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// ---------------------- Fetch wrapper with timeout ----------------------
async function fetchJson(
  url: string,
  opts: RequestInit & { timeoutMs?: number } = {}
) {
  const { timeoutMs = 15000, ...rest } = opts; // 15s default
  const controller = new AbortController();
  const t0 = Date.now();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  log("INFO", "HTTP fetch start", { url, timeoutMs });

  try {
    const res = await fetch(url, { ...rest, signal: controller.signal });
    const took = Date.now() - t0;
    log("INFO", "HTTP response", { url, status: res.status, ok: res.ok, took_ms: took });

    if (!res.ok) {
      const bodySnippet = await res.text().then(t => t.slice(0, 400)).catch(() => "");
      log("WARN", "HTTP non-OK", { url, status: res.status, body_snippet: bodySnippet });
      if (res.status === 403 || res.status === 429) {
        log("WARN", "Likely blocked/throttled by NBA Stats. Check headers/runtime and pacing.");
      }
      throw new Error(`HTTP ${res.status}`);
    }

    const json = await res.json();
    return json;
  } catch (err: any) {
    const took = Date.now() - t0;
    log("ERROR", "HTTP fetch error", { url, took_ms: took, err: String(err?.message ?? err) });
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------- NBA fetchers (stats.nba.com only) ----------------------
async function fetchLeagueGameLog(
  season: string,
  seasonType: string,
  dateFrom: string,
  dateTo: string
): Promise<Array<{ game_id: string; game_date: string; matchup: string }>> {
  const params = new URLSearchParams({
    Season: season,
    SeasonType: seasonType,
    PlayerOrTeam: "T",
    DateFrom: dateFrom,
    DateTo: dateTo,
  });
  const url = `https://stats.nba.com/stats/leaguegamelog?${params.toString()}`;
  const json = await fetchJson(url, {
    headers: NBA_HEADERS,
    cache: "no-store",
    timeoutMs: 15000,
  });

  const rs =
    json?.resultSets?.[0] ||
    json?.resultSet ||
    json?.resultSets ||
    json?.ResultSets?.[0];

  let headers: string[] = [];
  let rows: any[] = [];

  if (rs?.headers && rs?.rowSet) {
    headers = rs.headers;
    rows = rs.rowSet;
  } else if (Array.isArray(json?.resultSets)) {
    const set = json.resultSets.find((s: any) => s.name === "LeagueGameLog");
    headers = set?.headers ?? [];
    rows = set?.rowSet ?? [];
  }

  log("DEBUG", "LeagueGameLog parsed", {
    headers_len: headers.length,
    rows_len: rows.length,
  });

  if (!headers.length || !rows.length) return [];

  const H = (name: string) => headers.indexOf(name);
  const out = rows.map((r: any[]) => ({
    game_id: String(r[H("GAME_ID")]),
    game_date: toISODate(r[H("GAME_DATE")])!,
    matchup: String(r[H("MATCHUP")]),
  }));

  const seen = new Set<string>();
  const unique = out.filter((g) => {
    if (seen.has(g.game_id)) return false;
    seen.add(g.game_id);
    return true;
  });
  unique.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));
  log("INFO", "LeagueGameLog done", {
    unique_games: unique.length,
    sample: unique.slice(0, 3),
  });
  return unique;
}

type BoxRow = Record<string, any>;

async function fetchBoxscoreTraditionalV3(gameId: string): Promise<BoxRow[]> {
  const params = new URLSearchParams({ GameID: gameId });
  const url = `https://stats.nba.com/stats/boxscoretraditionalv3?${params.toString()}`;

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      log("INFO", "BoxV3 fetch start", { gameId, attempt, url });
      const json = await fetchJson(url, {
        headers: NBA_HEADERS,
        cache: "no-store",
        timeoutMs: 15000,
      });

      const sets: any[] =
        json?.boxScoreTraditional?.playerStats ??
        json?.resultSets ??
        json?.ResultSets ??
        [];

      if (Array.isArray(json?.boxScoreTraditional?.playerStats)) {
        const rows = json.boxScoreTraditional.playerStats as BoxRow[];
        log("DEBUG", "BoxV3 playerStats array", {
          gameId,
          rows_len: rows.length,
        });
        return rows;
      }

      const candidate =
        sets.find((s: any) => s.name?.toLowerCase?.().includes("player")) ||
        sets[0];

      if (candidate?.headers && candidate?.rowSet) {
        const { headers, rowSet } = candidate;
        log("DEBUG", "BoxV3 resultSets", {
          gameId,
          headers_len: headers?.length ?? 0,
          rows_len: rowSet?.length ?? 0,
        });
        return rowSet.map((row: any[]) =>
          headers.reduce((acc: any, h: string, idx: number) => {
            acc[h] = row[idx];
            return acc;
          }, {})
        );
      }

      log("WARN", "BoxV3 unknown shape", { gameId });
      return [];
    } catch (err) {
      if (attempt === 5) {
        log("ERROR", "BoxV3 failed after retries", { gameId, err: String(err) });
        return [];
      }
      log("WARN", "BoxV3 retrying", { gameId, attempt, err: String(err) });
      await sleep(1000 * attempt);
    }
  }
  return [];
}

// ---------------------- Normalizer ----------------------
function normalizePlayerBase(dfRows: BoxRow[], gameId: string): BoxRow[] {
  if (!dfRows?.length) return [];

  const cols = new Set(Object.keys(dfRows[0] || {}));
  const camel =
    cols.has("personId") || cols.has("firstName") || cols.has("playerSlug");

  const normalized = dfRows.map((row) => {
    if (camel) {
      const player_id = row.personId;
      const first = (row.firstName ?? "").toString().trim();
      const last = (row.familyName ?? "").toString().trim();
      const player_name =
        first || last
          ? `${first} ${last}`.trim()
          : (row.playerSlug ?? "").toString();

      const rec: BoxRow = {
        game_id: gameId,
        team_abbr: row.teamTricode,
        player_id,
        player_name,
        start_pos: row.position ?? null,
        min: row.minutes ?? null,
        fgm: row.fieldGoalsMade,
        fga: row.fieldGoalsAttempted,
        fg_pct: row.fieldGoalsPercentage,
        fg3m: row.threePointersMade,
        fg3a: row.threePointersAttempted,
        fg3_pct: row.threePointersPercentage,
        ftm: row.freeThrowsMade,
        fta: row.freeThrowsAttempted,
        ft_pct: row.freeThrowsPercentage,
        oreb: row.reboundsOffensive,
        dreb: row.reboundsDefensive,
        reb: row.reboundsTotal,
        ast: row.assists,
        stl: row.steals ?? null,
        blk: row.blocks ?? null,
        tov: row.turnovers ?? row.TOV ?? row.TO ?? null,
        pf: row.personalFouls ?? row.foulsPersonal ?? null,
        pts: row.points,
        plus_minus: row.plusMinusPoints ?? row.plusMinus ?? null,
        comment: row.comment ?? null,
      };
      return rec;
    } else {
      const PLAYER_ID =
        row.PLAYER_ID ?? row.PERSON_ID ?? row.personId ?? row.playerId;
      const TOV =
        row.TOV ?? row.TURNOVERS ?? row.TO ?? row.turnovers ?? null;

      const rec: BoxRow = {
        game_id: gameId,
        team_abbr: row.TEAM_ABBREVIATION,
        player_id: PLAYER_ID,
        player_name: row.PLAYER_NAME,
        start_pos: row.START_POSITION ?? null,
        min: row.MIN ?? null,
        fgm: row.FGM,
        fga: row.FGA,
        fg_pct: row.FG_PCT,
        fg3m: row.FG3M,
        fg3a: row.FG3A,
        fg3_pct: row.FG3_PCT,
        ftm: row.FTM,
        fta: row.FTA,
        ft_pct: row.FT_PCT,
        oreb: row.OREB,
        dreb: row.DREB,
        reb: row.REB,
        ast: row.AST,
        stl: row.STL,
        blk: row.BLK,
        tov: TOV,
        pf: row.PF,
        pts: row.PTS,
        plus_minus: row.PLUS_MINUS,
        comment: row.COMMENT ?? null,
      };
      return rec;
    }
  });

  const needed = [
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
  return normalized.map((r) => {
    needed.forEach((k) => {
      if (!(k in r)) (r as any)[k] = null;
    });
    return r;
  });
}

// ---------------------- Supabase ops ----------------------
async function supabaseDistinctGameIds(
  table: string,
  gameIds: string[]
): Promise<Set<string>> {
  const sb = supa();
  const present = new Set<string>();
  const CHUNK = 200;

  log("INFO", "Supabase IN check start", {
    table,
    gameIds_len: gameIds.length,
    chunk_size: CHUNK,
  });

  for (let i = 0; i < gameIds.length; i += CHUNK) {
    const chunk = gameIds.slice(i, i + CHUNK);
    const inList = `(${chunk.map((g) => `"${g}"`).join(",")})`;
    const t0 = Date.now();
    const { data, error } = await sb
      .from(table)
      .select("game_id")
      .filter("game_id", "in", inList);

    log("DEBUG", "Supabase IN chunk result", {
      i,
      chunk_len: chunk.length,
      took_ms: Date.now() - t0,
      error: error ? String(error.message || error) : null,
      data_len: data?.length ?? 0,
    });

    if (error) {
      log("ERROR", "Supabase select error", { error: String(error.message || error) });
      throw error;
    }
    (data || []).forEach((r: any) => {
      if (r?.game_id) present.add(String(r.game_id));
    });
    await sleep(100);
  }

  log("INFO", "Supabase IN check done", { present_len: present.size });
  return present;
}

async function upsertRows(table: string, rows: any[]) {
  if (!rows.length) return;
  const sb = supa();
  const totalBatches = Math.ceil(rows.length / BATCH_SIZE);
  log("INFO", "Upsert start", {
    rows_len: rows.length,
    batch_size: BATCH_SIZE,
    totalBatches,
  });

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batchIndex = i / BATCH_SIZE + 1;
    const batch = rows.slice(i, i + BATCH_SIZE).map((r) => {
      const allowed = {
        game_id: r.game_id,
        player_id: r.player_id,
        team_abbr: r.team_abbr,
        player_name: r.player_name,
        start_pos: r.start_pos,
        min: r.min,
        fgm: r.fgm,
        fga: r.fga,
        fg_pct: r.fg_pct,
        fg3m: r.fg3m,
        fg3a: r.fg3a,
        fg3_pct: r.fg3_pct,
        ftm: r.ftm,
        fta: r.fta,
        ft_pct: r.ft_pct,
        oreb: r.oreb,
        dreb: r.dreb,
        reb: r.reb,
        ast: r.ast,
        stl: r.stl,
        blk: r.blk,
        tov: r.tov,
        pf: r.pf,
        pts: r.pts,
        plus_minus: r.plus_minus,
        comment: r.comment,
        game_date: r.game_date ?? null,
        matchup: r.matchup ?? null,
        row_checksum: r.row_checksum ?? null,
        updated_at: r.updated_at ?? null,
      };
      return allowed;
    });

    const t0 = Date.now();
    const { error } = await sb
      .from(table)
      .upsert(batch, {
        onConflict: "game_id,player_id",
        ignoreDuplicates: false,
      });

    log("INFO", "Upsert batch result", {
      batchIndex,
      batch_len: batch.length,
      took_ms: Date.now() - t0,
      error: error ? String(error.message || error) : null,
    });

    if (error) {
      log("ERROR", "Supabase upsert error", {
        batchIndex,
        error: String(error.message || error),
      });
      throw error;
    }
  }

  log("INFO", "Upsert done");
}

// ---------------------- GET (Cron) ----------------------
export async function GET() {
  const startedAt = new Date().toISOString();

  // Log env summary (masked secret)
  log("INFO", "Env summary", {
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE: mask(SUPABASE_SERVICE_ROLE),
    SUPABASE_SCHEMA,
    SUPABASE_TABLE,
    DEFAULT_SEASON,
    DEFAULT_SEASON_TYPE,
    DEFAULT_RECENT_DAYS,
  });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return NextResponse.json(
      { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE", logs },
      { status: 500 }
    );
  }

  try {
    // Rolling 10-day window in America/Chicago
    const todayLocal = todayIsoLocalChicago();
    const dateFrom = addDaysISO(todayLocal, -10);
    const dateTo = todayLocal;
    log("INFO", "Date window (Chicago)", { todayLocal, dateFrom, dateTo });

    log("INFO", "LeagueGameLog enumerate start", {
      season: DEFAULT_SEASON,
      seasonType: DEFAULT_SEASON_TYPE,
    });
    const games = await fetchLeagueGameLog(
      DEFAULT_SEASON,
      DEFAULT_SEASON_TYPE,
      dateFrom,
      dateTo
    );

    if (!games.length) {
      log("INFO", "No games in range; exit.");
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "No games in range; exiting.",
        logs,
      });
    }

    // recent cutoff (UTC today - N days)
    const todayUtc = new Date();
    const recentCutoff = new Date(
      Date.UTC(
        todayUtc.getUTCFullYear(),
        todayUtc.getUTCMonth(),
        todayUtc.getUTCDate()
      )
    );
    recentCutoff.setUTCDate(recentCutoff.getUTCDate() - DEFAULT_RECENT_DAYS);
    log("INFO", "Recent cutoff (UTC)", { iso: recentCutoff.toISOString() });

    const gameIds = games.map((g) => g.game_id);
    log("INFO", "Supabase existing rows check …", {
      schema: SUPABASE_SCHEMA,
      table: SUPABASE_TABLE,
      total_gameIds: gameIds.length,
      sample: gameIds.slice(0, 5),
    });
    const present = await supabaseDistinctGameIds(SUPABASE_TABLE, gameIds);

    const missing = new Set(gameIds.filter((g) => !present.has(g)));
    const recent = new Set(
      games
        .filter((g) => {
          const d = new Date(g.game_date + "T00:00:00Z");
          return d >= recentCutoff;
        })
        .map((g) => g.game_id)
    );
    const targets = Array.from(new Set([...missing, ...recent])).sort();

    log("INFO", "Target sets computed", {
      missing: missing.size,
      recent: recent.size,
      targets: targets.length,
      sample_targets: targets.slice(0, 10),
    });

    if (!targets.length) {
      log("INFO", "Nothing to fetch; exit.");
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "Nothing to fetch.",
        logs,
      });
    }

    await sleep(SLEEP_AFTER_LIST_MS);

    let totalRows = 0;
    const toUpsert: any[] = [];

    // quick lookup of date/matchup
    const metaById = games.reduce<Record<string, { game_date: string; matchup: string }>>(
      (acc, g) => {
        acc[g.game_id] = { game_date: g.game_date, matchup: g.matchup };
        return acc;
      },
      {}
    );

    for (let i = 0; i < targets.length; i++) {
      const gid = targets[i];
      try {
        log("INFO", "Fetch boxscore start", {
          index: i + 1,
          of: targets.length,
          gid,
        });
        const raw = await fetchBoxscoreTraditionalV3(gid);
        log("INFO", "Fetch boxscore done", { gid, raw_len: raw.length });

        const norm = normalizePlayerBase(raw, gid);
        log("INFO", "Normalize done", { gid, norm_len: norm.length });

        if (norm.length) {
          const meta = metaById[gid] || {};
          const game_date = meta.game_date ?? null;
          const matchup = meta.matchup ?? null;

          const nowIso = new Date().toISOString();

          for (const r of norm) {
            r.game_date = game_date;
            r.matchup = matchup;
            r.row_checksum = rowChecksum(r);
            r.updated_at = nowIso;
            toUpsert.push(r);
          }
          totalRows += norm.length;
        }
      } catch (e: any) {
        log("ERROR", "Per-game error", { gid, err: String(e?.message ?? e) });
      }

      if ((i + 1) % 5 === 0) {
        log("INFO", "Progress", {
          processed: i + 1,
          total: targets.length,
          buffered_rows: totalRows,
        });
      }
      await sleep(SLEEP_BETWEEN_GAMES_MS);
    }

    if (!toUpsert.length) {
      log("INFO", "No rows to upsert; exit.");
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "No rows to upsert.",
        logs,
      });
    }

    log("INFO", "Upserting rows …", {
      schema: SUPABASE_SCHEMA,
      table: SUPABASE_TABLE,
      rows: toUpsert.length,
      gamesProcessed: targets.length,
    });
    await upsertRows(SUPABASE_TABLE, toUpsert);

    const tail = logs.slice(-200);
    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      upserted: toUpsert.length,
      gamesProcessed: targets.length,
      logs: tail,
    });
  } catch (err: any) {
    const tail = logs.slice(-200);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err), logs: tail },
      { status: 500 }
    );
  }
}
