import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  console.log("[cron] Placeholder job invoked at", new Date().toISOString());
  return NextResponse.json({
    status: "ok",
    message: "Cron endpoint placeholder response.",
    timestamp: new Date().toISOString(),
  });
}

// --- Legacy cron implementation retained for future work ---
// // app/api/nba-sync/route.ts
// import { NextRequest, NextResponse } from "next/server";
// import crypto from "node:crypto";
// import { createClient } from "@supabase/supabase-js";

// // Ensure Node runtime (NBA stats often fail on Edge because of headers/cookies).
// export const runtime = "nodejs";

// // --- ENV ---
// // Set these in Vercel Project Settings → Environment Variables
// const SUPABASE_URL = process.env.SUPABASE_URL!;
// const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE!;
// const DEFAULT_SCHEMA = process.env.SUPABASE_SCHEMA || "public";
// const DEFAULT_TABLE =
//   process.env.SUPABASE_TABLE || "pergame_player_base_stats_2025_26";

// // NBA headers (stats.nba.com rejects default fetch headers)
// const NBA_HEADERS: Record<string, string> = {
//   "User-Agent":
//     "Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
//   Accept: "application/json, text/plain, */*",
//   "Accept-Language": "en-US,en;q=0.9",
//   Referer: "https://www.nba.com/",
//   Origin: "https://www.nba.com",
//   Host: "stats.nba.com",
//   "x-nba-stats-origin": "stats",
//   "x-nba-stats-token": "true",
//   Connection: "keep-alive",
// };

// type GameRow = { game_id: string; game_date: string; matchup: string };

// // -------- Utilities --------
// function sha256(s: string) {
//   return crypto.createHash("sha256").update(s).digest("hex");
// }

// function toIsoDate(d: Date) {
//   return d.toISOString().slice(0, 10);
// }

// // JSON fetch with retries
// async function fetchJSON<T>(
//   url: string,
//   opts: RequestInit = {},
//   retries = 5,
//   backoff = 1000
// ): Promise<T> {
//   let lastErr: any;
//   for (let i = 0; i < retries; i++) {
//     try {
//       const res = await fetch(url, { ...opts, headers: { ...NBA_HEADERS, ...(opts.headers || {}) } });
//       if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
//       return (await res.json()) as T;
//     } catch (e) {
//       lastErr = e;
//       if (i < retries - 1) await new Promise((r) => setTimeout(r, backoff * (i + 1)));
//     }
//   }
//   throw lastErr;
// }

// // --- LeagueGameLog (team) ---
// // Basic shape from stats.nba.com. We only use the fields we need.
// async function fetchGames(season: string, seasonType: string, dateFrom: string, dateTo: string) {
//   // This query mirrors nba_api's LeagueGameLog in "T" mode
//   const params = new URLSearchParams({
//     Counter: "10000",
//     Direction: "ASC",
//     LeagueID: "00",
//     PlayerOrTeam: "T",
//     Season: season,
//     SeasonType: seasonType, // e.g. "Regular Season"
//     Sorter: "DATE",
//     DateFrom: dateFrom,
//     DateTo: dateTo,
//   });

//   type LGLResponse = {
//     resultSets?: Array<{
//       name: string;
//       headers: string[];
//       rowSet: any[][];
//     }>;
//     resultSet?: { // some endpoints return singular resultSet
//       headers: string[];
//       rowSet: any[][];
//     };
//   };

//   const json = await fetchJSON<LGLResponse>(`https://stats.nba.com/stats/leaguegamelog?${params.toString()}`);

//   const rs =
//     (json.resultSets && json.resultSets[0]) ||
//     (json as any).resultSet ||
//     (json as any).resultSets?.find((x: any) => x.name?.toUpperCase().includes("LEAGUEGAMELOG"));

//   if (!rs) return [] as GameRow[];

//   const headers = rs.headers as string[];
//   const rows = rs.rowSet as any[][];
//   const get = (map: Record<string, number>, row: any[], key: string) => row[map[key]];
//   const idx: Record<string, number> = {};
//   headers.forEach((h: string, i: number) => (idx[h] = i));

//   // Normalize
//   const seen = new Set<string>();
//   const out: GameRow[] = [];
//   for (const r of rows) {
//     const gameId = String(get(idx, r, "GAME_ID"));
//     if (seen.has(gameId)) continue;
//     seen.add(gameId);

//     const gameDate = get(idx, r, "GAME_DATE"); // like "OCT 30, 2025"
//     const matchup = get(idx, r, "MATCHUP");
//     // Try to coerce to YYYY-MM-DD (stats returns US format); fallback to unchanged string
//     const d = new Date(gameDate);
//     const iso = isNaN(d.getTime()) ? gameDate : toIsoDate(d);
//     out.push({ game_id: gameId, game_date: iso, matchup });
//   }
//   // Sort by date asc
//   out.sort((a, b) => a.game_date.localeCompare(b.game_date));
//   return out;
// }

// // --- BoxScoreTraditionalV3 ---
// async function fetchBoxScoreTraditionalV3(gameId: string) {
//   type V3 = {
//     boxScoreTraditional?: {
//       headers?: string[];
//       rowSet?: any[][];
//       // Newer payload (camelCase) often at .players or .playerStats in newer APIs
//       players?: any[];
//       playerStats?: any[];
//     };
//   };

//   const params = new URLSearchParams({
//     GameID: gameId,
//     LeagueID: "00",
//   });
//   const json = await fetchJSON<V3>(
//     `https://stats.nba.com/stats/boxscoretraditionalv3?${params.toString()}`,
//     {},
//     5,
//     1000
//   );
//   return json;
// }

// // Try to pick the player frame, supporting both ALL_CAPS and camelCase layouts
// function pickPlayerFrame(v3: any): any[] {
//   // camelCase path
//   const camel = v3?.boxScoreTraditional?.playerStats || v3?.boxScoreTraditional?.players;
//   if (Array.isArray(camel) && camel.length) return camel;

//   // ALL_CAPS path
//   const headers = v3?.boxScoreTraditional?.headers;
//   const rows = v3?.boxScoreTraditional?.rowSet;
//   if (Array.isArray(headers) && Array.isArray(rows)) {
//     const idx: Record<string, number> = {};
//     headers.forEach((h: string, i: number) => (idx[h] = i));
//     return rows.map((r: any[]) => {
//       const pick = (k: string) => r[idx[k]];
//       return {
//         // normalize to camel-ish keys so downstream stays simple
//         personId: pick("PLAYER_ID") ?? pick("PERSON_ID"),
//         playerName: pick("PLAYER_NAME"),
//         teamTricode: pick("TEAM_ABBREVIATION"),
//         position: pick("START_POSITION"),
//         comment: pick("COMMENT"),
//         minutes: pick("MIN"),
//         fieldGoalsMade: pick("FGM"),
//         fieldGoalsAttempted: pick("FGA"),
//         fieldGoalsPercentage: pick("FG_PCT"),
//         threePointersMade: pick("FG3M"),
//         threePointersAttempted: pick("FG3A"),
//         threePointersPercentage: pick("FG3_PCT"),
//         freeThrowsMade: pick("FTM"),
//         freeThrowsAttempted: pick("FTA"),
//         freeThrowsPercentage: pick("FT_PCT"),
//         reboundsOffensive: pick("OREB"),
//         reboundsDefensive: pick("DREB"),
//         reboundsTotal: pick("REB"),
//         assists: pick("AST"),
//         steals: pick("STL"),
//         blocks: pick("BLK"),
//         turnovers: pick("TOV") ?? pick("TO") ?? pick("TURNOVERS"),
//         personalFouls: pick("PF"),
//         points: pick("PTS"),
//         plusMinusPoints: pick("PLUS_MINUS"),
//       };
//     });
//   }
//   return [];
// }

// // Normalize to your final schema keys
// function normalizePlayerBase(rows: any[], gameId: string) {
//   return rows.map((r) => {
//     // Detect camelCase vs already-normalized
//     const camel = "personId" in r || "playerSlug" in r || "firstName" in r;

//     const player_id = camel ? r.personId : r.player_id;
//     const player_name = camel
//       ? ((r.firstName ?? "") + " " + (r.familyName ?? "")).trim() || r.playerSlug || r.playerName
//       : r.player_name;
//     const team_abbr = camel ? r.teamTricode : r.team_abbr;
//     const start_pos = camel ? r.position : r.start_pos;
//     const comment = camel ? r.comment : r.comment;
//     const min = camel ? r.minutes : r.min;

//     const fgm = camel ? r.fieldGoalsMade : r.fgm;
//     const fga = camel ? r.fieldGoalsAttempted : r.fga;
//     const fg_pct = camel ? r.fieldGoalsPercentage : r.fg_pct;

//     const fg3m = camel ? r.threePointersMade : r.fg3m;
//     const fg3a = camel ? r.threePointersAttempted : r.fg3a;
//     const fg3_pct = camel ? r.threePointersPercentage : r.fg3_pct;

//     const ftm = camel ? r.freeThrowsMade : r.ftm;
//     const fta = camel ? r.freeThrowsAttempted : r.fta;
//     const ft_pct = camel ? r.freeThrowsPercentage : r.ft_pct;

//     const oreb = camel ? r.reboundsOffensive : r.oreb;
//     const dreb = camel ? r.reboundsDefensive : r.dreb;
//     const reb = camel ? r.reboundsTotal : r.reb;

//     const ast = camel ? r.assists : r.ast;
//     const stl = camel ? r.steals : r.stl;
//     const blk = camel ? r.blocks : r.blk;

//     const tov = camel ? r.turnovers ?? r.TOV ?? r.TO : r.tov;
//     const pf = camel ? r.personalFouls ?? r.foulsPersonal : r.pf;

//     const pts = camel ? r.points : r.pts;
//     const plus_minus = camel ? (r.plusMinusPoints ?? r.plusMinus) : r.plus_minus;

//     return {
//       game_id: gameId,
//       team_abbr,
//       player_id,
//       player_name,
//       start_pos,
//       min,
//       fgm,
//       fga,
//       fg_pct,
//       fg3m,
//       fg3a,
//       fg3_pct,
//       ftm,
//       fta,
//       ft_pct,
//       oreb,
//       dreb,
//       reb,
//       ast,
//       stl,
//       blk,
//       tov,
//       pf,
//       pts,
//       plus_minus,
//       comment,
//     };
//   });
// }

// function computeRowChecksum(row: any) {
//   const keys = [
//     "team_abbr",
//     "player_id",
//     "player_name",
//     "start_pos",
//     "min",
//     "fgm",
//     "fga",
//     "fg_pct",
//     "fg3m",
//     "fg3a",
//     "fg3_pct",
//     "ftm",
//     "fta",
//     "ft_pct",
//     "oreb",
//     "dreb",
//     "reb",
//     "ast",
//     "stl",
//     "blk",
//     "tov",
//     "pf",
//     "pts",
//     "plus_minus",
//     "comment",
//   ];
//   const s = keys.map((k) => String(row[k] ?? "")).join("|");
//   return sha256(s);
// }

// // Fetch distinct game_ids already present in Supabase for the considered set
// async function supabaseDistinctGameIds(
//   sb: ReturnType<typeof createClient>,
//   schema: string,
//   table: string,
//   gameIds: string[]
// ) {
//   const present = new Set<string>();
//   const CHUNK = 200;
//   const client = sb.from(schema);
//   for (let i = 0; i < gameIds.length; i += CHUNK) {
//     const chunk = gameIds.slice(i, i + CHUNK);
//     // PostgREST: filter("game_id", "in", `(${chunk.join(",")})`) is not available in JS v2,
//     // use .in instead:
//     const { data, error } = await sb.from(table).select("game_id").in("game_id", chunk);
//     if (error) throw error;
//     (data || []).forEach((r: any) => r.game_id && present.add(String(r.game_id)));
//     await new Promise((r) => setTimeout(r, 100));
//   }
//   return present;
// }

// async function upsertRows(
//   sb: ReturnType<typeof createClient>,
//   schema: string,
//   table: string,
//   rows: any[]
// ) {
//   if (!rows.length) return;
//   // Strip optional columns if your table doesn't have them
//   const cleaned = rows.map(({ row_checksum, updated_at, ...rest }) => rest);
//   const BATCH = 500;
//   const client = sb.schema(schema);
//   for (let i = 0; i < cleaned.length; i += BATCH) {
//     const batch = cleaned.slice(i, i + BATCH);
//     const { error } = await client
//       .from(table)
//       .upsert(batch, { onConflict: "game_id,player_id" });
//     if (error) throw error;
//   }
// }

// export async function GET(req: NextRequest) {
//   try {
//     if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
//       return NextResponse.json(
//         { error: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars." },
//         { status: 500 }
//       );
//     }

//     const url = new URL(req.url);
//     const q = url.searchParams;

//     const season = q.get("season") || "2025-26";
//     const seasonType = q.get("seasonType") || "Regular Season";

//     // Defaults: last 10 days → today (America/Chicago)
//     const now = new Date();
//     const todayISO = toIsoDate(now);
//     const tenDaysAgoISO = toIsoDate(new Date(now.getTime() - 10 * 24 * 3600 * 1000));

//     const dateFrom = q.get("dateFrom") || tenDaysAgoISO;
//     const dateTo = q.get("dateTo") || todayISO;

//     const recentDays = Number(q.get("recentDays") || "7");
//     const schema = q.get("schema") || DEFAULT_SCHEMA;
//     const table = q.get("table") || DEFAULT_TABLE;
//     const dryRun = (q.get("dryRun") || "").toLowerCase() === "true";

//     const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
//       auth: { persistSession: false },
//       global: { fetch }, // use Next's global fetch on Vercel
//     });

//     // 1) Enumerate games
//     const games = await fetchGames(season, seasonType, dateFrom, dateTo);
//     if (!games.length) {
//       return NextResponse.json({
//         message: "No games in range; exiting.",
//         season,
//         seasonType,
//         dateFrom,
//         dateTo,
//       });
//     }

//     // 2) Missing + recent sets
//     const gameIds = games.map((g) => g.game_id);
//     const present = await supabaseDistinctGameIds(sb, schema, table, gameIds);

//     const today = new Date();
//     const recentCutoff = new Date(today.getTime() - recentDays * 24 * 3600 * 1000);
//     const recentSet = new Set(
//       games
//         .filter((g) => {
//           const d = new Date(g.game_date);
//           return !isNaN(d.getTime()) && d >= recentCutoff;
//         })
//         .map((g) => g.game_id)
//     );
//     const missing = gameIds.filter((gid) => !present.has(gid));
//     const target = Array.from(new Set([...missing, ...Array.from(recentSet)])).sort();

//     if (dryRun) {
//       return NextResponse.json({
//         season,
//         seasonType,
//         dateFrom,
//         dateTo,
//         recentDays,
//         schema,
//         table,
//         counts: {
//           totalGamesInWindow: games.length,
//           missingGames: missing.length,
//           recentForRefresh: recentSet.size,
//           totalToFetch: target.length,
//         },
//         dryRun: true,
//       });
//     }

//     // Small pacing between list and fetches (a gentle delay)
//     await new Promise((r) => setTimeout(r, 2000));

//     const metaById = new Map(games.map((g) => [g.game_id, g]));
//     const allUpserts: any[] = [];

//     for (let i = 0; i < target.length; i++) {
//       const gid = target[i];

//       // 3) Fetch V3 + normalize
//       const v3 = await fetchBoxScoreTraditionalV3(gid);
//       const playerRows = pickPlayerFrame(v3);
//       if (!playerRows || !playerRows.length) continue;

//       const base = normalizePlayerBase(playerRows, gid);
//       const meta = metaById.get(gid);
//       for (const row of base) {
//         // enrich + checksum + timestamps
//         (row as any).game_date = meta?.game_date ?? null;
//         (row as any).matchup = meta?.matchup ?? null;
//         (row as any).row_checksum = computeRowChecksum(row);
//         (row as any).updated_at = new Date().toISOString();
//         allUpserts.push(row);
//       }

//       // Progress logging in response headers would be noisy; keep pacing light
//       await new Promise((r) => setTimeout(r, 1000)); // ~1s between games
//     }

//     if (!allUpserts.length) {
//       return NextResponse.json({
//         message: "Nothing to write.",
//         toFetch: target.length,
//         windowGames: games.length,
//       });
//     }

//     // 4) Upsert to Supabase
//     await upsertRows(sb as any, schema, table, allUpserts);

//     return NextResponse.json({
//       message: "✅ Done",
//       season,
//       seasonType,
//       dateFrom,
//       dateTo,
//       recentDays,
//       schema,
//       table,
//       stats: {
//         upsertedRows: allUpserts.length,
//         gamesProcessed: target.length,
//         windowGames: games.length,
//       },
//     });
//   } catch (err: any) {
//     return NextResponse.json({ error: String(err?.message || err) }, { status: 500 });
//   }
// }
