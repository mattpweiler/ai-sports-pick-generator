// app/api/cron/route.ts
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

// ---------------------- Config defaults ----------------------
const DEFAULT_SEASON = process.env.NBA_SEASON || "2025-26";
const DEFAULT_SEASON_TYPE =
  process.env.NBA_SEASON_TYPE || "Regular Season"; // "Regular Season" | "Playoffs" | "Pre Season" | "All Star" | "PlayIn"
const DEFAULT_RECENT_DAYS = Number(process.env.RECENT_DAYS || 7); // re-sync last N days for stat corrections
const SLEEP_BETWEEN_GAMES_MS = 1000; // 1s between boxscore calls
const SLEEP_AFTER_LIST_MS = 2000;    // small pause after fetching game list
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

// ---------------------- Helpers ----------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function supa() {
  const client = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
    auth: { persistSession: false },
  });
  // @ts-ignore: .schema exists in supabase-js v2
  return client.schema(SUPABASE_SCHEMA);
}

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
  // If your deployment has TZ=America/Chicago set, new Date() is fine.
  // Otherwise, this uses Intl to get the local date in Chicago.
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

// ---------------------- NBA fetchers ----------------------
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

  const res = await fetch(url, { headers: NBA_HEADERS, cache: "no-store" });
  if (!res.ok) throw new Error(`LeagueGameLog HTTP ${res.status}`);
  const json = await res.json();

  // Old-style "resultSets" or newer "resultSet" shapes exist.
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

  if (!headers.length || !rows.length) return [];

  const H = (name: string) => headers.indexOf(name);
  const out = rows.map((r: any[]) => ({
    game_id: String(r[H("GAME_ID")]),
    game_date: toISODate(r[H("GAME_DATE")])!,
    matchup: String(r[H("MATCHUP")]),
  }));

  // Deduplicate by game_id and sort by date
  const seen = new Set<string>();
  const unique = out.filter((g) => {
    if (seen.has(g.game_id)) return false;
    seen.add(g.game_id);
    return true;
  });
  unique.sort((a, b) => (a.game_date < b.game_date ? -1 : 1));
  return unique;
}

type BoxRow = Record<string, any>;

function normalizePlayerBase(dfRows: BoxRow[], gameId: string): BoxRow[] {
  if (!dfRows?.length) return [];

  // Try to detect camelCase vs ALL_CAPS structures
  const cols = new Set(Object.keys(dfRows[0] || {}));
  const camel = cols.has("personId") || cols.has("firstName") || cols.has("playerSlug");

  const normalized = dfRows.map((row) => {
    if (camel) {
      const player_id = row.personId;
      const first = (row.firstName ?? "").toString().trim();
      const last = (row.familyName ?? "").toString().trim();
      const player_name = (first || last) ? `${first} ${last}`.trim() : (row.playerSlug ?? "").toString();

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
      // ALL_CAPS variant
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

  // Ensure all expected fields exist
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

async function fetchBoxscoreTraditionalV3(gameId: string): Promise<BoxRow[]> {
  const params = new URLSearchParams({ GameID: gameId });
  const url = `https://stats.nba.com/stats/boxscoretraditionalv3?${params.toString()}`;

  // retry up to 5x with linear backoff
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: NBA_HEADERS, cache: "no-store" });
      if (!res.ok) throw new Error(`BoxV3 HTTP ${res.status}`);
      const json = await res.json();

      // Try to locate the "player stats" table
      const sets: any[] =
        json?.boxScoreTraditional?.playerStats ??
        json?.resultSets ??
        json?.ResultSets ??
        [];

      // Newer v3 provides a direct array of playerStats objects
      if (Array.isArray(json?.boxScoreTraditional?.playerStats)) {
        return json.boxScoreTraditional.playerStats as BoxRow[];
      }

      // Fallback to classic resultSets with headers/rowSet
      const candidate =
        sets.find((s: any) => s.name?.toLowerCase?.().includes("player")) ||
        sets[0];

      if (candidate?.headers && candidate?.rowSet) {
        const { headers, rowSet } = candidate;
        return rowSet.map((row: any[]) =>
          headers.reduce((acc: any, h: string, idx: number) => {
            acc[h] = row[idx];
            return acc;
          }, {})
        );
      }

      // Last resort: if shape unknown, return empty
      return [];
    } catch (err) {
      if (attempt === 5) {
        console.error(`❌ V3 failed for ${gameId} after retries:`, err);
        return [];
      }
      console.warn(`⚠️ ${gameId}: retry ${attempt}...`, err);
      await sleep(1000 * attempt);
    }
  }
  return [];
}

async function supabaseDistinctGameIds(
  table: string,
  gameIds: string[]
): Promise<Set<string>> {
  const sb = supa();
  const present = new Set<string>();
  const CHUNK = 200;

  for (let i = 0; i < gameIds.length; i += CHUNK) {
    const chunk = gameIds.slice(i, i + CHUNK);
    const inList = `(${chunk.map((g) => `"${g}"`).join(",")})`;
    const { data, error } = await sb
      .from(table)
      .select("game_id", { count: "exact", head: false })
      .filter("game_id", "in", inList);

    if (error) {
      console.error("Supabase select error:", error);
      throw error;
    }
    (data || []).forEach((r: any) => {
      if (r?.game_id) present.add(String(r.game_id));
    });
    await sleep(100);
  }
  return present;
}

async function upsertRows(table: string, rows: any[]) {
  if (!rows.length) return;
  const sb = supa();

  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE).map((r) => {
      // Strip fields your table might not have; keep only columns you know exist
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

    const { error } = await sb
      .from(table)
      .upsert(batch, { onConflict: "game_id,player_id", ignoreDuplicates: false });

    if (error) {
      console.error("Supabase upsert error:", error);
      throw error;
    }
  }
}

// ---------------------- GET (Cron) ----------------------
export async function GET() {
  const startedAt = new Date().toISOString();

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
    return NextResponse.json(
      { ok: false, error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE" },
      { status: 500 }
    );
  }

  try {
    // Default rolling 10-day window in America/Chicago
    const todayLocal = todayIsoLocalChicago();
    const dateFrom = addDaysISO(todayLocal, -10);
    const dateTo = todayLocal;

    console.log(
      `→ Enumerating games ${DEFAULT_SEASON} — ${DEFAULT_SEASON_TYPE} between ${dateFrom} and ${dateTo} …`
    );
    const games = await fetchLeagueGameLog(
      DEFAULT_SEASON,
      DEFAULT_SEASON_TYPE,
      dateFrom,
      dateTo
    );

    if (!games.length) {
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "No games in range; exiting.",
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

    const gameIds = games.map((g) => g.game_id);
    console.log(`→ Checking Supabase for existing rows in ${SUPABASE_SCHEMA}.${SUPABASE_TABLE} …`);
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

    console.log(
      `  Missing games: ${missing.size}; Recent for refresh: ${recent.size}; Total to fetch: ${targets.length}`
    );

    if (!targets.length) {
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "Nothing to fetch.",
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
        const raw = await fetchBoxscoreTraditionalV3(gid);
        const norm = normalizePlayerBase(raw, gid);

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
      } catch (e) {
        console.error(`[${i + 1}/${targets.length}] ${gid}:`, e);
      }

      if ((i + 1) % 10 === 0) {
        console.log(
          `  … ${i + 1}/${targets.length} games processed, ${totalRows} rows buffered`
        );
      }
      await sleep(SLEEP_BETWEEN_GAMES_MS);
    }

    if (!toUpsert.length) {
      return NextResponse.json({
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
        message: "No rows to upsert.",
      });
    }

    console.log(
      `→ Upserting ${toUpsert.length} rows into ${SUPABASE_SCHEMA}.${SUPABASE_TABLE} …`
    );
    await upsertRows(SUPABASE_TABLE, toUpsert);

    return NextResponse.json({
      ok: true,
      startedAt,
      finishedAt: new Date().toISOString(),
      upserted: toUpsert.length,
      gamesProcessed: targets.length,
    });
  } catch (err: any) {
    console.error("Cron error:", err);
    return NextResponse.json(
      { ok: false, error: String(err?.message ?? err) },
      { status: 500 }
    );
  }
}
