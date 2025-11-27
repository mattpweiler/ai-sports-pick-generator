import Link from "next/link";
import { createClient } from "@supabase/supabase-js";

type PlayerPageProps = {
  params: Promise<{ playerId: string }>;
};

type PlayerProfile = {
  player_id: number;
  player_name: string | null;
  team: string | null;
  team_abbr: string | null;
  position: string | null;
};

async function fetchPlayerProfile(
  playerId: string
): Promise<PlayerProfile | null> {
  const supabase = createClient(
    process.env.SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE!
  );

  const numericId = Number(playerId);
  if (Number.isNaN(numericId)) return null;

  const { data, error } = await supabase
    .from("player_team_position")
    .select("player_id, player_name, team, position")
    .eq("player_id", numericId)
    .maybeSingle();

  if (error) {
    console.error("Error fetching player profile:", error);
  } else if (data) {
    return { ...data, team_abbr: data.team };
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
  };
}

export default async function PlayerAnalysisPage({
  params,
}: PlayerPageProps) {
  const { playerId } = await params;
  const profile = await fetchPlayerProfile(playerId);

  const displayName =
    profile?.player_name ?? `Player #${playerId}`;
  const displayTeam = profile?.team ?? "Team TBD";

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
        </section>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 text-sm text-slate-300">
          <p className="mb-3 font-semibold text-slate-100">
            What&apos;s coming next?
          </p>
          <ul className="list-disc space-y-2 pl-5">
            <li>Recent form breakdown and matchup context</li>
            <li>Model-driven stat projections and confidence intervals</li>
            <li>Historical prop performance vs. closing lines</li>
          </ul>
        </div>
      </main>
    </div>
  );
}
