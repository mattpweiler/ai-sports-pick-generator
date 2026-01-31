"use client";

import Link from "next/link";
import { use, useEffect, useMemo, useState } from "react";
import {
  RosterGrid,
  TeamBadge,
  type PlayerSummary,
  type TeamRoster,
} from "../../components/RosterGrid";

type Game = {
  game_id: number;
  game_date: string | null;
  game_datetime_est: string | null;
  game_status_id: number | null;
  game_status_text: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
  national_tv: string | null;
  arena_name: string | null;
  game_code: string | null;
  game_sequence: number | null;
};

type GamesApiResponse = {
  games: Game[];
  error?: string;
};

type TeamMap = Record<
  number,
  {
    team_id: number;
    full_name: string;
    abbreviation: string;
    nickname: string;
    city: string;
  }
>;

type PlayersApiResponse = {
  mode?: "stats" | "roster";
  roster?: TeamRoster[];
  error?: string;
};

type PageProps = {
  params: Promise<{ gameId: string }>;
};

function formatGameDate(game: Game) {
  if (!game.game_date) return "TBD";
  const raw = game.game_date.trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (!isoLike) return raw;
  const dt = new Date(`${raw}T12:00:00Z`);
  if (Number.isNaN(dt.getTime())) return raw;
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function formatTime(dateStr: string | null) {
  if (!dateStr) return "TBD";
  const dt = new Date(dateStr);
  if (Number.isNaN(dt.getTime())) return "TBD";
  return dt.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });
}

function buildPlayerKey(
  gameId: number,
  mode: "stats" | "roster",
  playerId: number | null | undefined,
  teamIdentifier?: string | number | null | undefined
) {
  const playerPart =
    typeof playerId === "number" && !Number.isNaN(playerId)
      ? playerId
      : `unknown-${String(playerId ?? "na")}`;
  const teamPart =
    teamIdentifier !== null && teamIdentifier !== undefined
      ? String(teamIdentifier)
      : "team-na";
  return `${gameId}:${mode}:${playerPart}:${teamPart}`;
}

export default function GameSummaryPage({ params }: PageProps) {
  const resolvedParams = use(params);
  const numericGameId = useMemo(
    () => Number(resolvedParams?.gameId),
    [resolvedParams?.gameId]
  );
  const [game, setGame] = useState<Game | null>(null);
  const [gameError, setGameError] = useState<string | null>(null);
  const [loadingGame, setLoadingGame] = useState(true);

  const [teams, setTeams] = useState<TeamMap>({});

  const [roster, setRoster] = useState<TeamRoster[]>([]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  const [loadingRoster, setLoadingRoster] = useState(true);

  const [expandedPlayers, setExpandedPlayers] = useState<
    Record<string, boolean>
  >({});
  const [playerSummaries, setPlayerSummaries] = useState<
    Record<string, PlayerSummary>
  >({});
  const [playerSummaryLoading, setPlayerSummaryLoading] = useState<
    Record<string, boolean>
  >({});
  const notableInjuries = useMemo(() => {
    const items: { player_name: string; team_abbr: string | null }[] = [];
    roster.forEach((team) => {
      team.players.forEach((player) => {
        if (player.active_status === 0) {
          items.push({
            player_name: player.player_name ?? `Player ${player.player_id}`,
            team_abbr: team.team_abbr ?? null,
          });
        }
      });
    });
    return items;
  }, [roster]);

  useEffect(() => {
    let cancelled = false;

    if (!Number.isFinite(numericGameId)) {
      setGameError("Invalid game id.");
      setLoadingGame(false);
      return;
    }

    async function loadTeams() {
      try {
        const res = await fetch("/api/teams");
        const json = await res.json();
        if (!cancelled && res.ok) {
          const map: TeamMap = {};
          (json.teams ?? []).forEach((t: any) => {
            map[t.team_id] = t;
          });
          setTeams(map);
        }
      } catch {
        // Fallback to IDs only.
      }
    }

    async function loadGame() {
      setLoadingGame(true);
      setGameError(null);
      try {
        const res = await fetch("/api/nba-games");
        const json: GamesApiResponse = await res.json();
        if (!res.ok) {
          throw new Error(json.error || "Failed to load game.");
        }
        const found = (json.games ?? []).find(
          (g) => g.game_id === numericGameId
        );
        if (!found) throw new Error("Game not found.");
        if (!cancelled) setGame(found);
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Failed to load game.";
          setGameError(message);
        }
      } finally {
        if (!cancelled) setLoadingGame(false);
      }
    }

    loadGame();
    loadTeams();
    return () => {
      cancelled = true;
    };
  }, [numericGameId]);

  useEffect(() => {
    let cancelled = false;
    async function loadRoster() {
      if (!game) return;
      setLoadingRoster(true);
      setRosterError(null);
      try {
        const res = await fetch(
          `/api/nba-games/${game.game_id}/players?mode=roster`
        );
        const json: PlayersApiResponse = await res.json();
        if (!res.ok) {
          throw new Error(json.error || "Failed to load roster.");
        }
        const rosterData = json.roster ?? [];
        if (!cancelled) {
          setRoster(rosterData);
          prefetchRosterSummaries(game.game_id, rosterData).catch((err) =>
            console.warn("Prefetch summaries failed", err)
          );
        }
      } catch (err) {
        if (!cancelled) {
          const message =
            err instanceof Error ? err.message : "Failed to load roster.";
          setRosterError(message);
        }
      } finally {
        if (!cancelled) setLoadingRoster(false);
      }
    }
    loadRoster();
    return () => {
      cancelled = true;
    };
  }, [game]);

  async function loadPlayerSummary(playerId: number, key: string) {
    if (!playerId || playerSummaries[key]) return;
    setPlayerSummaryLoading((prev) => ({ ...prev, [key]: true }));
    try {
      const res = await fetch(`/api/players/${playerId}/summary`);
      const json = await res.json();
      if (res.ok && json.summary) {
        setPlayerSummaries((prev) => ({
          ...prev,
          [key]: json.summary,
        }));
      }
    } catch (err) {
      console.error("Error loading player summary:", err);
    } finally {
      setPlayerSummaryLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function prefetchRosterSummaries(gameId: number, data: TeamRoster[]) {
    const requests: Promise<void>[] = [];
    data.forEach((team) => {
      (team.players ?? []).forEach((player) => {
        const key = buildPlayerKey(gameId, "roster", player.player_id, team.team_id);
        if (
          player.player_id &&
          !playerSummaries[key] &&
          !playerSummaryLoading[key]
        ) {
          requests.push(loadPlayerSummary(player.player_id, key));
        }
      });
    });
    if (requests.length) {
      await Promise.all(requests);
    }
  }

  function togglePlayerExpansion(key: string, playerId?: number | null) {
    setExpandedPlayers((prev) => {
      const nextState = { ...prev, [key]: !prev[key] };
      const nextExpanded = nextState[key];
      if (nextExpanded && playerId) {
        loadPlayerSummary(playerId, key);
      }
      return nextState;
    });
  }

  function getTeamName(teamId: number | null | undefined) {
    if (!teamId) return "TBD";
    const team = teams[teamId];
    return team ? team.abbreviation : String(teamId);
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <header className="border-b border-slate-800 bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Game Summary / Predictions
            </p>
            <h1 className="text-xl font-bold text-slate-50">
              Game #{resolvedParams?.gameId ?? "—"}
            </h1>
          </div>
          <Link
            href="/nba-games"
            className="text-sm text-cyan-200 underline-offset-4 hover:underline"
          >
            Back to games
          </Link>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 space-y-6">
        {loadingGame && (
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-4 py-3 text-sm">
            Loading game…
          </div>
        )}
        {gameError && (
          <div className="rounded-xl border border-red-700/60 bg-red-900/40 px-4 py-3 text-sm text-red-100">
            {gameError}
          </div>
        )}

        {game && (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  {formatGameDate(game)} · {formatTime(game.game_datetime_est)}
                </p>
                <p className="text-sm text-slate-300">
                  {game.game_code || "Scheduled"} • {game.game_status_text}
                </p>
              </div>
              <div className="flex items-center gap-2 text-xs text-slate-200">
                <TeamBadge label={getTeamName(game.away_team_id)} />
                <span className="text-slate-400">at</span>
                <TeamBadge label={getTeamName(game.home_team_id)} />
              </div>
            </div>
          </div>
        )}

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-cyan-300">
                Projected Rosters Preview
              </p>
              <p className="text-sm text-slate-300">
                View expected players for both sides.
              </p>
            </div>
          </div>

          {loadingRoster && (
            <p className="mt-2 text-xs text-cyan-200">Loading rosters…</p>
          )}
          {rosterError && (
            <p className="mt-2 text-xs text-red-200">{rosterError}</p>
          )}

          {!loadingRoster && !rosterError && (
            <div className="mt-3">
              <RosterGrid
                roster={roster}
                gameId={numericGameId}
                expandedPlayers={expandedPlayers}
                onToggle={togglePlayerExpansion}
                buildPlayerKey={buildPlayerKey}
                summaries={playerSummaries}
                summaryLoading={playerSummaryLoading}
              />
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-amber-300">
                Notable Injuries
              </p>
              <p className="text-sm text-slate-300">
                Players marked inactive on the latest roster sync.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {notableInjuries.length === 0 && (
              <p className="text-xs text-slate-400">
                No inactive players reported for this matchup.
              </p>
            )}
            {notableInjuries.map((player, idx) => (
              <div
                key={`${player.player_name}-${player.team_abbr}-${idx}`}
                className="flex items-center justify-between rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-100"
              >
                <span className="font-semibold text-amber-100">
                  {player.player_name}
                </span>
                <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                  {player.team_abbr ?? "UNK"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
