import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

type PlayerPageProps = {
  params: Promise<{ playerId: string }>;
};

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

type PlayerProfile = {
  player_id: number;
  player_name: string | null;
  team: string | null;
  team_abbr: string | null;
  position: string | null;
  availability?: PlayerAvailability | null;
};

type SampledAverages = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pra: number | null;
  stl: number | null;
  blk: number | null;
  tov: number | null;
  sampleSize: number;
};

type PlayerAverages = {
  last5: SampledAverages;
  last10: SampledAverages;
  season: SampledAverages;
};

type GameStat = {
  game_date: string | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  stl: number | null;
  blk: number | null;
  tov: number | null;
  pra: number | null;
  minutes?: string | null;
  matchup?: string | null;
  team_abbr?: string | null;
  opponent?: string | null;
};

type MissedGame = {
  game_date: string | null;
  reason: string;
  minutes?: string | null;
  matchup?: string | null;
  team_abbr?: string | null;
  opponent?: string | null;
};

type PlayerAvailability = {
  status: string;
  minutes_cap: number | null;
  reason: string | null;
  effective_from: string;
};

const EXCLUDED_COMMENTS = new Set(
  [
    "DNP - Coach's Decision",
    "DND - Injury/Illness",
    "NWT - Not With Team",
    "NWT - Injury/Illness",
  ].map((value) => value.toUpperCase())
);

function normalizeComment(comment: unknown): string | null {
  if (typeof comment !== "string") return null;
  const trimmed = comment.trim();
  return trimmed || null;
}

function shouldExcludeByComment(comment: unknown) {
  const normalized = normalizeComment(comment);
  if (!normalized) return false;
  const upper = normalized.toUpperCase();
  return (
    EXCLUDED_COMMENTS.has(upper) ||
    upper.startsWith("DNP") ||
    upper.startsWith("DND") ||
    upper.startsWith("NWT")
  );
}

function isZeroMinutes(minutes: unknown): boolean {
  if (minutes === null || minutes === undefined) return false;

  if (typeof minutes === "number") {
    return Number.isFinite(minutes) && minutes === 0;
  }

  if (typeof minutes !== "string") return false;

  const trimmed = minutes.trim();
  if (!trimmed) return false;

  if (trimmed === "0" || trimmed === "0.0" || trimmed === "0.00") {
    return true;
  }

  if (trimmed.includes(":")) {
    const [mins, secs] = trimmed.split(":");
    const minNum = Number(mins);
    const secNum = Number(secs);
    if (Number.isFinite(minNum) && Number.isFinite(secNum)) {
      return minNum === 0 && secNum === 0;
    }
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function computePra(
  pts: number | null,
  reb: number | null,
  ast: number | null
): number | null {
  if (pts === null && reb === null && ast === null) return null;
  return (pts ?? 0) + (reb ?? 0) + (ast ?? 0);
}

function parseGameDate(value: string | null): Date | null {
  if (!value) return null;
  const raw = value.trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const dt = isoLike ? new Date(`${raw}T12:00:00Z`) : new Date(raw);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatGameDate(value: string | null): string {
  const dt = parseGameDate(value);
  if (!dt) return "Unknown date";
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function getOpponentLabel(matchup: string | null, teamAbbr: string | null) {
  if (!matchup) return null;
  const trimmed = matchup.trim();
  const match = trimmed.match(
    /([A-Z]{2,4})\s*(vs\.?|@)\s*([A-Z]{2,4})/i
  );

  if (!match) return trimmed || null;

  const [, leftRaw, sepRaw, rightRaw] = match;
  const left = leftRaw.toUpperCase();
  const right = rightRaw.toUpperCase();
  const sep = sepRaw.includes("@") ? "@" : "vs";
  const team = teamAbbr ? teamAbbr.toUpperCase() : null;

  if (team === left) {
    return sep === "@" ? `@ ${right}` : `vs ${right}`;
  }
  if (team === right) {
    return sep === "@" ? `vs ${left}` : `@ ${left}`;
  }
  return trimmed || null;
}

function summarizeAverages(rows: any[]): SampledAverages {
  if (!rows.length) {
    return {
      pts: null,
      reb: null,
      ast: null,
      pra: null,
      stl: null,
      blk: null,
      tov: null,
      sampleSize: 0,
    };
  }

  const sums = rows.reduce(
    (acc, row) => {
      const pts = toNumber((row as any).pts);
      const reb = toNumber((row as any).reb);
      const ast = toNumber((row as any).ast);
      const stl = toNumber((row as any).stl);
      const blk = toNumber((row as any).blk);
      const tov = toNumber((row as any).tov);
      if (pts !== null) acc.pts += pts;
      if (reb !== null) acc.reb += reb;
      if (ast !== null) acc.ast += ast;
      if (stl !== null) acc.stl += stl;
      if (blk !== null) acc.blk += blk;
      if (tov !== null) acc.tov += tov;
      return acc;
    },
    { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, tov: 0 }
  );

  const sampleSize = rows.length || 1;

  return {
    pts: sampleSize ? sums.pts / sampleSize : null,
    reb: sampleSize ? sums.reb / sampleSize : null,
    ast: sampleSize ? sums.ast / sampleSize : null,
    pra: sampleSize ? (sums.pts + sums.reb + sums.ast) / sampleSize : null,
    stl: sampleSize ? sums.stl / sampleSize : null,
    blk: sampleSize ? sums.blk / sampleSize : null,
    tov: sampleSize ? sums.tov / sampleSize : null,
    sampleSize,
  };
}

async function fetchPlayerProfile(
  playerId: string
): Promise<PlayerProfile | null> {
  const numericId = Number(playerId);
  if (Number.isNaN(numericId)) return null;

  const availabilityPromise = supabase
    .from("player_availability")
    .select("status, minutes_cap, reason, effective_from")
    .eq("player_id", numericId)
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  const { data, error } = await supabase
    .from("player_team_position")
    .select("player_id, player_name, team, position")
    .eq("player_id", numericId)
    .maybeSingle();

  if (error) {
    console.error("Error fetching player profile:", error);
  } else if (data) {
    const { data: availabilityData } = await availabilityPromise;
    return {
      ...data,
      team_abbr: data.team,
      availability: availabilityData ?? null,
    };
  }

  const { data: statRow, error: statError } = await supabase
    .from("pergame_player_base_stats_2025_26")
    .select("player_id, player_name, team_abbr")
    .eq("player_id", numericId)
    .maybeSingle();

  if (statError) {
    console.error("Error fetching fallback player profile:", statError);
    return null;
  }

  if (!statRow) return null;

  const { data: availabilityData } = await availabilityPromise;

  let fullTeamName: string | null = null;
  if (statRow.team_abbr) {
    const { data: teamRow, error: teamError } = await supabase
      .from("team_id_to_team")
      .select("full_name")
      .eq("abbreviation", statRow.team_abbr)
      .maybeSingle();

    if (teamError) {
      console.error("Error fetching team info:", teamError);
    } else {
      fullTeamName = teamRow?.full_name ?? null;
    }
  }

  return {
    player_id: statRow.player_id,
    player_name: statRow.player_name,
    team: fullTeamName ?? statRow.team_abbr,
    team_abbr: statRow.team_abbr,
    position: null,
    availability: availabilityData ?? null,
  };
}

async function fetchRecentAverages(
  playerId: string
): Promise<{
  averages: PlayerAverages;
  games: GameStat[];
  allGames: GameStat[];
  missedGames: MissedGame[];
}> {
  const numericId = Number(playerId);
  const emptyAverages = (): PlayerAverages => ({
    last5: {
      pts: null,
      reb: null,
      ast: null,
      pra: null,
      stl: null,
      blk: null,
      tov: null,
      sampleSize: 0,
    },
    last10: {
      pts: null,
      reb: null,
      ast: null,
      pra: null,
      stl: null,
      blk: null,
      tov: null,
      sampleSize: 0,
    },
    season: {
      pts: null,
      reb: null,
      ast: null,
      pra: null,
      stl: null,
      blk: null,
      tov: null,
      sampleSize: 0,
    },
  });

  if (Number.isNaN(numericId)) {
    return {
      averages: emptyAverages(),
      games: [],
      allGames: [],
      missedGames: [],
    };
  }

  const { data, error } = await supabase
    .from("pergame_player_base_stats_2025_26")
    .select(
      "pts, reb, ast, stl, blk, tov, game_date, comment, team_abbr, matchup, min"
    )
    .eq("player_id", numericId)
    .order("game_date", { ascending: false })
    .limit(82);

  if (error) {
    console.error("Error fetching recent averages:", error.message ?? error);
    return {
      averages: emptyAverages(),
      games: [],
      allGames: [],
      missedGames: [],
    };
  }

  const stats = (data ?? []).filter((row) => row !== null);
  const isMissedGame = (row: any) =>
    shouldExcludeByComment((row as any).comment) ||
    isZeroMinutes((row as any).min);
  const missedGameRows = stats.filter(isMissedGame);
  const filteredStats = stats.filter((row) => !isMissedGame(row));

  if (!filteredStats.length) {
    return {
      averages: emptyAverages(),
      games: [],
      allGames: [],
      missedGames: missedGameRows.map((row) => ({
        game_date: (row as any).game_date,
        reason:
          normalizeComment((row as any).comment) ??
          (isZeroMinutes((row as any).min) ? "0 minutes played" : "Unavailable"),
        minutes: (row as any).min,
        team_abbr: (row as any).team_abbr,
        matchup: (row as any).matchup,
        opponent: getOpponentLabel(
          (row as any).matchup,
          (row as any).team_abbr
        ),
      })),
    };
  }

  const fiveGameRows = filteredStats.slice(0, 5);
  const tenGameRows = filteredStats.slice(0, 10);
  const seasonRows = filteredStats;

  const mapRowToGame = (row: any): GameStat => {
    const pts = toNumber((row as any).pts);
    const reb = toNumber((row as any).reb);
    const ast = toNumber((row as any).ast);
    const stl = toNumber((row as any).stl);
    const blk = toNumber((row as any).blk);
    const tov = toNumber((row as any).tov);
    const teamAbbr = (row as any).team_abbr as string | null;
    const matchup = (row as any).matchup as string | null;
    return {
      game_date: (row as any).game_date,
      pts,
      reb,
      ast,
      stl,
      blk,
      tov,
      pra: computePra(pts, reb, ast),
      minutes: (row as any).min ?? null,
      team_abbr: teamAbbr,
      matchup,
      opponent: getOpponentLabel(matchup, teamAbbr),
    };
  };

  const recentGames: GameStat[] = fiveGameRows.map(mapRowToGame);
  const allGames: GameStat[] = seasonRows.map(mapRowToGame);
  const missedGames: MissedGame[] = missedGameRows.map((row) => {
    const teamAbbr = (row as any).team_abbr as string | null;
    const matchup = (row as any).matchup as string | null;
    const comment = (row as any).comment;

    return {
      game_date: (row as any).game_date,
      reason:
        normalizeComment(comment) ??
        (isZeroMinutes((row as any).min) ? "0 minutes played" : "Unavailable"),
      minutes: (row as any).min,
      team_abbr: teamAbbr,
      matchup,
      opponent: getOpponentLabel(matchup, teamAbbr),
    };
  });

  return {
    averages: {
      last5: summarizeAverages(fiveGameRows),
      last10: summarizeAverages(tenGameRows),
      season: summarizeAverages(seasonRows),
    },
    games: recentGames,
    allGames,
    missedGames,
  };
}

export default async function PlayerAnalysisPage({
  params,
}: PlayerPageProps) {
  const { playerId } = await params;
  const [profile, statBundle] = await Promise.all([
    fetchPlayerProfile(playerId),
    fetchRecentAverages(playerId),
  ]);

  const { averages, games, allGames, missedGames } = statBundle;
  const displayName =
    profile?.player_name ?? `Player #${playerId}`;
  const displayTeam = profile?.team ?? "Team TBD";
  const buildStatCards = (avg: SampledAverages) => [
    { label: "Points", value: avg.pts },
    { label: "Rebounds", value: avg.reb },
    { label: "Assists", value: avg.ast },
    { label: "PRA", value: avg.pra },
    { label: "Steals", value: avg.stl },
    { label: "Blocks", value: avg.blk },
    { label: "Turnovers", value: avg.tov },
  ];
  const fiveGameCards = buildStatCards(averages.last5);
  const tenGameCards = buildStatCards(averages.last10);
  const seasonCards = buildStatCards(averages.season);
  const formatSampleSize = (sampleSize: number) =>
    sampleSize
      ? `Based on ${sampleSize} game${sampleSize === 1 ? "" : "s"}`
      : "No recent games recorded";

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <main className="mx-auto max-w-4xl px-4 py-8 space-y-6">
        <Link
          href="/nba-games"
          className="inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-slate-900/60 px-3 py-1 text-xs font-semibold text-cyan-200 hover:border-cyan-400 hover:bg-slate-900"
        >
          ← Back to NBA Games
        </Link>

        <section className="rounded-2xl border border-cyan-500/30 bg-slate-950/70 p-6 shadow-2xl shadow-black/40">
          <p className="text-xs uppercase tracking-wide text-cyan-300 mb-2">
            Player Averages
          </p>
          <h1 className="text-3xl font-bold text-slate-50">
            {displayName}
          </h1>
          <p className="text-sm text-cyan-200">
            {displayTeam}
            {profile?.position ? ` · ${profile.position}` : ""}
          </p>
          <p className="mt-3 text-sm text-slate-300">
            This page will showcase deeper scouting insights, trends, and model
            predictions for this player. Stay tuned while we finish training the
            AI to provide high-signal analysis.
          </p>
          {profile?.availability && (
            <div className="mt-4 rounded-xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
              <p className="text-xs uppercase tracking-wide text-red-300">
                Injury / Availability
              </p>
              <p className="mt-1 text-base font-semibold">
                {profile.availability.status}
                {profile.availability.minutes_cap
                  ? ` · Minutes cap: ${profile.availability.minutes_cap}`
                  : ""}
              </p>
              {profile.availability.reason && (
                <p className="text-xs text-red-200/80">
                  {profile.availability.reason}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6">
          <div className="flex flex-col gap-1">
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Last 5 Games (Averages)
            </p>
            <p className="text-[11px] text-slate-400">
              {formatSampleSize(averages.last5.sampleSize)}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {fiveGameCards.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-cyan-500/20 bg-cyan-500/5 p-4 text-center"
              >
                <p className="text-[11px] uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-2 text-2xl font-bold text-cyan-200">
                  {stat.value !== null ? stat.value.toFixed(1) : "—"}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-1">
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Last 10 Games (Averages)
            </p>
            <p className="text-[11px] text-slate-400">
              {formatSampleSize(averages.last10.sampleSize)}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {tenGameCards.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-indigo-400/20 bg-indigo-400/5 p-4 text-center"
              >
                <p className="text-[11px] uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-2 text-2xl font-bold text-indigo-200">
                  {stat.value !== null ? stat.value.toFixed(1) : "—"}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-8 flex flex-col gap-1">
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Season (Averages)
            </p>
            <p className="text-[11px] text-slate-400">
              {formatSampleSize(averages.season.sampleSize)}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
            {seasonCards.map((stat) => (
              <div
                key={stat.label}
                className="rounded-2xl border border-emerald-400/20 bg-emerald-400/5 p-4 text-center"
              >
                <p className="text-[11px] uppercase tracking-wider text-slate-400">
                  {stat.label}
                </p>
                <p className="mt-2 text-2xl font-bold text-emerald-200">
                  {stat.value !== null ? stat.value.toFixed(1) : "—"}
                </p>
              </div>
            ))}
          </div>
          <div className="mt-8 space-y-3">
            {games.length > 0 && (
              <p className="text-xs uppercase tracking-wide text-slate-500">
                Game-by-game breakdown
              </p>
            )}
            <div className="grid grid-cols-1 gap-3">
              {games.map((game, idx) => (
                <div
                  key={`${game.game_date ?? idx}`}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-200"
                >
                  <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                    <span>
                      {formatGameDate(game.game_date)}
                    </span>
                    <span>{games.length - idx === 1 ? "Most recent" : ""}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-center sm:grid-cols-4 md:grid-cols-7">
                    {[
                      { label: "PTS", value: game.pts },
                      { label: "REB", value: game.reb },
                      { label: "AST", value: game.ast },
                      { label: "STL", value: game.stl },
                      { label: "BLK", value: game.blk },
                      { label: "TOV", value: game.tov },
                      { label: "PRA", value: game.pra },
                    ].map((stat) => (
                      <div key={stat.label}>
                        <p className="text-[11px] uppercase tracking-wider text-slate-500">
                          {stat.label}
                        </p>
                        <p className="text-lg font-semibold text-cyan-200">
                          {stat.value ?? "—"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-8 rounded-xl border border-slate-800 bg-slate-900/50 p-4">
            <details className="group">
              <summary className="flex cursor-pointer items-center justify-between text-xs font-semibold uppercase tracking-wide text-cyan-200">
                <span>Full Season Game Log</span>
                <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                  {averages.season.sampleSize} total game
                  {averages.season.sampleSize === 1 ? "" : "s"}
                </span>
              </summary>
              <div className="mt-4 space-y-2 text-xs text-slate-200">
                {allGames.length === 0 && (
                  <p className="text-slate-400">No season games recorded.</p>
                )}
                {allGames.length > 0 && (
                  <div className="grid grid-cols-1 gap-2">
                    {allGames.map((game, idx) => (
                      <div
                        key={`${game.game_date ?? idx}`}
                        className="rounded-lg border border-slate-800 bg-slate-950/60 p-3"
                      >
                        <div className="flex items-center justify-between text-[11px] text-slate-400 mb-2">
                          <span>
                            {formatGameDate(game.game_date)}
                            {game.opponent
                              ? ` · ${game.opponent}`
                              : game.matchup
                              ? ` · ${game.matchup}`
                              : ""}
                          </span>
                          <span className="text-cyan-300">
                            PTS {game.pts ?? "—"} · REB {game.reb ?? "—"} · AST{" "}
                            {game.ast ?? "—"} · STL {game.stl ?? "—"} · BLK{" "}
                            {game.blk ?? "—"} · TOV {game.tov ?? "—"} · PRA{" "}
                            {game.pra ?? "—"}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </details>
          </div>

          <div className="mt-8 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="text-xs uppercase tracking-wide text-amber-300">
              Missed games
            </p>
            {missedGames.length === 0 && (
              <p className="mt-2 text-xs text-amber-200/80">
                No missed games recorded for this season.
              </p>
            )}
            {missedGames.length > 0 && (
              <div className="mt-3 space-y-2 text-xs text-amber-100">
                {missedGames.map((game, idx) => (
                  <div
                    key={`${game.game_date ?? idx}-missed`}
                    className="rounded-lg border border-amber-400/30 bg-amber-400/10 p-3"
                  >
                    <div className="flex items-center justify-between text-[11px] text-amber-200/80 mb-1">
                      <span>
                        {formatGameDate(game.game_date)}
                        {game.opponent
                          ? ` · ${game.opponent}`
                          : game.matchup
                          ? ` · ${game.matchup}`
                          : ""}
                      </span>
                      <span className="rounded-full border border-amber-300/40 bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-amber-200">
                        DNP
                      </span>
                    </div>
                    <p className="text-sm font-semibold text-amber-100">
                      {game.reason}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 text-sm text-slate-300">
          <p className="mb-3 font-semibold text-slate-100">
            What&apos;s coming next?
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>Recent form breakdown and matchup context</li>
            <li>Model-driven stat projections and confidence intervals</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
