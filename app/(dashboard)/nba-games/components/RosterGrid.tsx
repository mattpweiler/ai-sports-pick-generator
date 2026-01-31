"use client";

import Link from "next/link";

export type TeamRosterPlayer = {
  player_id: number;
  player_name: string | null;
  position: string | null;
  active_status: number | null;
};

export type TeamRoster = {
  team_id: number;
  team_name: string | null;
  team_abbr: string | null;
  side: "home" | "away";
  players: TeamRosterPlayer[];
};

export type PlayerSummary = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pra: number | null;
  sampleSize: number;
};

type RosterGridProps = {
  roster: TeamRoster[];
  gameId: number;
  expandedPlayers: Record<string, boolean>;
  onToggle: (key: string, playerId?: number | null) => void;
  buildPlayerKey: (
    gameId: number,
    mode: "stats" | "roster",
    playerId: number | null | undefined,
    teamId?: number | string | null | undefined
  ) => string;
  summaries: Record<string, PlayerSummary>;
  summaryLoading: Record<string, boolean>;
  injuries: { player_id: number | null; player_name: string | null; team_abbr: string | null }[];
};

export function TeamBadge({ label }: { label: string }) {
  return (
    <span className="text-xs rounded-full bg-cyan-500/10 px-2 py-1 text-cyan-300 border border-cyan-500/40">
      {label}
    </span>
  );
}

export function RosterGrid({
  roster,
  gameId,
  expandedPlayers,
  onToggle,
  buildPlayerKey,
  summaries,
  summaryLoading,
  injuries,
}: RosterGridProps) {
  if (!roster.length) {
    return (
      <div className="text-xs text-slate-400">
        No roster details available for these teams yet.
      </div>
    );
  }

  const injuryIds = new Set<number>();
  const injuryNameKeys = new Set<string>();
  injuries.forEach((p) => {
    if (typeof p.player_id === "number" && Number.isFinite(p.player_id)) {
      injuryIds.add(p.player_id);
    }
    const key = `${(p.player_name ?? "").toLowerCase()}-${(p.team_abbr ?? "").toLowerCase()}`;
    if (key.trim() !== "-") injuryNameKeys.add(key);
  });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {roster.map((team) => {
        const sortedPlayers = team.players
          .slice()
          .sort((a, b) => {
            const keyA = buildPlayerKey(
              gameId,
              "roster",
              a.player_id,
              team.team_id
            );
            const keyB = buildPlayerKey(
              gameId,
              "roster",
              b.player_id,
              team.team_id
            );
            const ppgA = summaries[keyA]?.pts ?? 0;
            const ppgB = summaries[keyB]?.pts ?? 0;
            if (ppgA !== ppgB) return ppgB - ppgA;
            const nameA = (a.player_name ?? "").toLowerCase();
            const nameB = (b.player_name ?? "").toLowerCase();
            return nameA.localeCompare(nameB);
          });
        return (
          <div
            key={`${team.team_id}-${team.side}`}
            className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4"
          >
            <div className="mb-3 flex items-center justify-between">
              <div>
                <p className="text-[11px] uppercase tracking-wide text-slate-500">
                  {team.side === "home" ? "Home Team" : "Away Team"}
                </p>
                <p className="text-sm font-semibold text-slate-50">
                  {team.team_name ?? `Team ${team.team_id}`}
                </p>
              </div>
              <TeamBadge label={team.team_abbr ?? "UNK"} />
            </div>
            <div className="space-y-2">
              {sortedPlayers.length === 0 && (
                <div className="rounded-xl border border-dashed border-slate-700/70 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
                  No active players synced yet.
                </div>
              )}
              {sortedPlayers.map((player) => {
                const playerKey = buildPlayerKey(
                  gameId,
                  "roster",
                  player.player_id,
                  team.team_id
                );
                const summary = summaries[playerKey];
                const summaryLoadingFlag = summaryLoading[playerKey];
                const injuryKey = `${(player.player_name ?? "").toLowerCase()}-${(team.team_abbr ?? "").toLowerCase()}`;
                const isInjured =
                  injuryIds.has(player.player_id) || injuryNameKeys.has(injuryKey);
                return (
                  <div
                    key={`${team.team_id}-${player.player_id}`}
                    className={[
                      "rounded-xl border px-3 py-2 text-xs text-slate-100",
                      "border-slate-800/60 bg-slate-900/60",
                    ].join(" ")}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-100">
                          {player.player_name ?? "Unnamed Player"}
                        </p>
                        <p className="text-[11px] uppercase tracking-wide text-slate-400">
                          {player.position ?? "TBD"}
                        </p>
                      </div>
                      <div className="flex flex-wrap items-center gap-2">
                        {player.player_id ? (
                          <>
                            <Link
                              href={`/nba-games/players/${player.player_id}`}
                              className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                            >
                              Player Deep Dive
                            </Link>
                            {isInjured && (
                              <span className="inline-flex items-center justify-center rounded-full border border-amber-400/60 bg-amber-500/10 px-3 py-1 text-[11px] font-semibold text-amber-200">
                                Potential Injury
                              </span>
                            )}
                          </>
                        ) : (
                          <button
                            type="button"
                            disabled
                            className="inline-flex items-center justify-center rounded-full border border-slate-700/60 bg-slate-800/60 px-3 py-1 text-[11px] font-semibold text-slate-400"
                          >
                            Get Advanced AI Analysis on Player
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-2 rounded-xl border border-dashed border-slate-700/70 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300">
                      {summaryLoadingFlag ? (
                        <p className="text-cyan-200">Loading averages…</p>
                      ) : (
                        <p className="text-[11px] text-slate-200">
                          Last 5 Averages · PTS{" "}
                          <span className="text-cyan-200">
                            {summary?.pts ?? "—"}
                          </span>{" "}
                          · REB{" "}
                          <span className="text-cyan-200">
                            {summary?.reb ?? "—"}
                          </span>{" "}
                          · AST{" "}
                          <span className="text-cyan-200">
                            {summary?.ast ?? "—"}
                          </span>{" "}
                          · PRA{" "}
                          <span className="text-cyan-200">
                            {summary?.pra ?? "—"}
                          </span>
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
