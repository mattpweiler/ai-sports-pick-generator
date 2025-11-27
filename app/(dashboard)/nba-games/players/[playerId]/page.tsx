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

type PlayerAverages = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  sampleSize: number;
};

type RecentGameStat = {
  game_date: string | null;
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pra: number | null;
};

type PlayerAvailability = {
  status: string;
  minutes_cap: number | null;
  reason: string | null;
  effective_from: string;
};

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
): Promise<{ averages: PlayerAverages; games: RecentGameStat[] }> {
  const numericId = Number(playerId);
  if (Number.isNaN(numericId)) {
    return {
      averages: { pts: null, reb: null, ast: null, sampleSize: 0 },
      games: [],
    };
  }

  const { data, error } = await supabase
    .from("pergame_player_base_stats_2025_26")
    .select("pts, reb, ast, game_date")
    .eq("player_id", numericId)
    .order("game_date", { ascending: false })
    .limit(5);

  if (error) {
    console.error("Error fetching recent averages:", error.message ?? error);
    return {
      averages: { pts: null, reb: null, ast: null, sampleSize: 0 },
      games: [],
    };
  }

  const stats = (data ?? []).filter((row) => {
    // With null ordering handling above, but keep guard
    return row !== null;
  });

  const sampleSize = stats.length;
  if (!sampleSize) {
    return {
      averages: { pts: null, reb: null, ast: null, sampleSize: 0 },
      games: [],
    };
  }

  const sums = stats.reduce(
    (acc, row) => {
      const pts = toNumber((row as any).pts);
      const reb = toNumber((row as any).reb);
      const ast = toNumber((row as any).ast);
      if (pts !== null) acc.pts += pts;
      if (reb !== null) acc.reb += reb;
      if (ast !== null) acc.ast += ast;
      return acc;
    },
    { pts: 0, reb: 0, ast: 0 }
  );

  const divider = sampleSize || 1;

  const recentGames: RecentGameStat[] = stats.map((row) => {
    const pts = toNumber((row as any).pts);
    const reb = toNumber((row as any).reb);
    const ast = toNumber((row as any).ast);
    return {
      game_date: (row as any).game_date,
      pts,
      reb,
      ast,
      pra: computePra(pts, reb, ast),
    };
  });

  return {
    averages: {
      pts: sampleSize ? sums.pts / divider : null,
      reb: sampleSize ? sums.reb / divider : null,
      ast: sampleSize ? sums.ast / divider : null,
      sampleSize,
    },
    games: recentGames,
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

  const { averages, games } = statBundle;
  const displayName =
    profile?.player_name ?? `Player #${playerId}`;
  const displayTeam = profile?.team ?? "Team TBD";
  const statCards = [
    { label: "Points", value: averages.pts },
    { label: "Rebounds", value: averages.reb },
    { label: "Assists", value: averages.ast },
  ];

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
            Player Overview
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
              {averages.sampleSize
                ? `Based on ${averages.sampleSize} game${
                    averages.sampleSize === 1 ? "" : "s"
                  }`
                : "No recent games recorded"}
            </p>
          </div>
          <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-3">
            {statCards.map((stat) => (
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
          <div className="mt-6 space-y-3">
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
                      {game.game_date
                        ? new Date(game.game_date).toLocaleDateString(undefined, {
                            month: "short",
                            day: "numeric",
                          })
                        : "Unknown date"}
                    </span>
                    <span>{games.length - idx === 1 ? "Most recent" : ""}</span>
                  </div>
                  <div className="grid grid-cols-4 gap-2 text-center">
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        PTS
                      </p>
                      <p className="text-lg font-semibold text-cyan-200">
                        {game.pts ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        REB
                      </p>
                      <p className="text-lg font-semibold text-cyan-200">
                        {game.reb ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        AST
                      </p>
                      <p className="text-lg font-semibold text-cyan-200">
                        {game.ast ?? "—"}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] uppercase tracking-wider text-slate-500">
                        PRA
                      </p>
                      <p className="text-lg font-semibold text-cyan-200">
                        {game.pra ?? "—"}
                      </p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
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
