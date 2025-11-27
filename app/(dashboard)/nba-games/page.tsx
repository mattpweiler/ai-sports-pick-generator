// app/nba-games/page.tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

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

type TeamMap = Record<number, {
  team_id: number;
  full_name: string;
  abbreviation: string;
  nickname: string;
  city: string;
}>;


type GamesApiResponse = {
  games: Game[];
  error?: string;
};

type Player = {
  game_id: number;
  team_abbr: string | null;
  player_id: number;
  player_name: string | null;
  start_pos: string | null;
  min: string | null;
  oreb: string | null;
  dreb: string | null;
  reb: string | null;
  ast: number | null;
  stl: number | null;
  blk: string | null;
  tov: number | null;
  pf: number | null;
  pts: number | null;
};

type TeamRosterPlayer = {
  player_id: number;
  player_name: string | null;
  position: string | null;
  active_status: number | null;
};

type TeamRoster = {
  team_id: number;
  team_name: string | null;
  team_abbr: string | null;
  side: "home" | "away";
  players: TeamRosterPlayer[];
};

type GamePlayerData =
  | { mode: "stats"; players: Player[] }
  | { mode: "roster"; roster: TeamRoster[] };

type PlayersApiResponse = {
  mode?: "stats" | "roster";
  players?: Player[];
  roster?: TeamRoster[];
  error?: string;
};

type GamesFilter = "previous" | "thisWeek" | "future";

const FILTER_TABS: { key: GamesFilter; label: string; description: string }[] =
  [
    { key: "previous", label: "Previous", description: "Before this week" },
    { key: "thisWeek", label: "This Week", description: "Current week slate" },
    { key: "future", label: "Upcoming", description: "After this week" },
  ];

  function formatGameDate(game: Game) {
    // Prefer the game_date text field (schedule date)
    if (!game.game_date) return "TBD";
  
    const raw = game.game_date.trim();
  
    // If it's already a human string like "THU, NOV 14", just show it
    const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);
    if (!isoLike) return raw;
  
    // If it's an ISO-like date (YYYY-MM-DD), parse at NOON UTC to avoid TZ shifting the day
    const dt = new Date(raw + "T12:00:00Z");
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

function getGameDate(game: Game): Date | null {
  const value = game.game_datetime_est ?? game.game_date;
  if (!value) return null;
  const dt = new Date(value);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function getDateKey(game: Game) {
  const dt = getGameDate(game);
  if (!dt) return "unknown";
  return dt.toISOString().split("T")[0];
}

function formatGameDateFromString(dateStr: string) {
  if (!dateStr) return "Date TBD";

  const raw = dateStr.trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);

  if (!isoLike) return raw;

  // Parse at noon UTC to avoid timezone shift
  const dt = new Date(raw + "T12:00:00Z");
  if (Number.isNaN(dt.getTime())) return raw;

  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function getDateLabelFromKey(key: string) {
  if (key === "unknown") return "Date TBD";
  return formatGameDateFromString(key);
}

function isFutureGame(game: Game) {
  const date = getGameDate(game);
  if (!date) return false;
  return date.getTime() > Date.now();
}


function TeamBadge({ label }: { label: string }) {
  return (
    <span className="text-xs rounded-full bg-cyan-500/10 px-2 py-1 text-cyan-300 border border-cyan-500/40">
      {label}
    </span>
  );
}

type RosterGridProps = {
  roster: TeamRoster[];
  gameId: number;
  expandedPlayers: Record<string, boolean>;
  onToggle: (key: string) => void;
  buildPlayerKey: (
    gameId: number,
    mode: "stats" | "roster",
    playerId: number | null | undefined,
    teamId?: number | string | null | undefined
  ) => string;
};

function RosterGrid({
  roster,
  gameId,
  expandedPlayers,
  onToggle,
  buildPlayerKey,
}: RosterGridProps) {
  if (!roster.length) {
    return (
      <div className="text-xs text-slate-400">
        No roster details available for these teams yet.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {roster.map((team) => (
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
            {team.players.length === 0 && (
              <div className="rounded-xl border border-dashed border-slate-700/70 bg-slate-900/40 px-3 py-2 text-xs text-slate-400">
                No active players synced yet.
              </div>
            )}
            {team.players.map((player) => {
              const playerKey = buildPlayerKey(
                gameId,
                "roster",
                player.player_id,
                team.team_id
              );
              const isExpanded = expandedPlayers[playerKey] ?? false;
              return (
                <div
                  key={`${team.team_id}-${player.player_id}`}
                  className="rounded-xl border border-slate-800/60 bg-slate-900/60 px-3 py-2 text-xs text-slate-100"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <p className="font-medium text-slate-100">
                        {player.player_name ?? "Unnamed Player"}
                      </p>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">
                        {player.position ?? "TBD"}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => onToggle(playerKey)}
                      className="text-[11px] font-semibold text-cyan-300 underline-offset-2 hover:underline"
                      aria-expanded={isExpanded}
                    >
                      Player Overview
                    </button>
                  </div>
                  {isExpanded && (
                    <div className="mt-2 rounded-xl border border-dashed border-slate-700/70 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-300">
                      <p className="mb-2">Player scouting card coming soon.</p>
                      {player.player_id ? (
                        <Link
                          href={`/nba-games/players/${player.player_id}`}
                          className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                        >
                          Get Advanced AI Analysis on Player
                        </Link>
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
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

export default function NbaGamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState<TeamMap>({});
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<GamesFilter>("thisWeek");
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>(
    {}
  );

  const [expandedGameId, setExpandedGameId] = useState<number | null>(null);
  const [gamePlayerData, setGamePlayerData] = useState<
    Record<number, GamePlayerData>
  >({});
  const [expandedPlayers, setExpandedPlayers] = useState<
    Record<string, boolean>
  >({});
  const [loadingPlayersFor, setLoadingPlayersFor] = useState<number | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;

    async function loadTeams() {
      const res = await fetch("/api/teams");
      const json = await res.json();
  
      if (!cancelled && res.ok) {
        const map: TeamMap = {};
        json.teams.forEach((t: any) => {
          map[t.team_id] = t;
        });
        setTeams(map);
      }
    }
    
    async function loadGames() {
      try {
        const res = await fetch("/api/nba-games");
        const json: GamesApiResponse = await res.json();

        if (!res.ok) {
          throw new Error(json.error || "Failed to load games.");
        }

        if (!cancelled) {
          setGames(json.games || []);
          setError(null);
        }
      } catch (err: any) {
        if (!cancelled) {
          console.error(err);
          setError(err.message ?? "Something went wrong.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadGames();
    loadTeams();

    return () => {
      cancelled = true;
    };
  }, []);

  function getTeamName(teamId: number | null | undefined) {
    if (!teamId) return "TBD";
    const team = teams[teamId];
    return team ? team.abbreviation : String(teamId); // fallback
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

  function togglePlayerExpansion(key: string) {
    setExpandedPlayers((prev) => ({
      ...prev,
      [key]: !prev[key],
    }));
  }
  
  async function handleToggleExpand(game: Game) {
    const id = game.game_id;

    if (expandedGameId === id) {
      setExpandedGameId(null);
      return;
    }

    setExpandedGameId(id);

    if (gamePlayerData[id]) return; // already cached

    setLoadingPlayersFor(id);
    try {
      const futureGame = isFutureGame(game);
      const res = await fetch(
        `/api/nba-games/${id}/players${futureGame ? "?mode=roster" : ""}`
      );
      const json: PlayersApiResponse = await res.json();

      if (!res.ok) {
        throw new Error(json.error || "Failed to load players.");
      }

      const resultMode =
        json.mode ?? (futureGame ? "roster" : "stats");

      setGamePlayerData((prev) => ({
        ...prev,
        [id]:
          resultMode === "roster"
            ? { mode: "roster", roster: json.roster ?? [] }
            : { mode: "stats", players: json.players ?? [] },
      }));
    } catch (err) {
      console.error("Error loading players:", err);
    } finally {
      setLoadingPlayersFor(null);
    }
  }

  const now = new Date();
  const startOfWeek = new Date(now);
  startOfWeek.setHours(0, 0, 0, 0);
  startOfWeek.setDate(startOfWeek.getDate() - startOfWeek.getDay());

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  endOfWeek.setHours(23, 59, 59, 999);

  const filteredGames = games.filter((game) => {
    const date = getGameDate(game);
    if (!date) {
      return activeFilter === "future"; // unknown dates treated as upcoming
    }
    if (activeFilter === "previous") {
      return date < startOfWeek;
    }
    if (activeFilter === "thisWeek") {
      return date >= startOfWeek && date <= endOfWeek;
    }
    return date > endOfWeek;
  });

  const gamesByDate = filteredGames.reduce<Record<string, Game[]>>(
    (acc, game) => {
      const key = getDateKey(game);
      if (!acc[key]) acc[key] = [];
      acc[key].push(game);
      return acc;
    },
    {}
  );

  const dateSections = Object.entries(gamesByDate).sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return a.localeCompare(b);
  });

  function toggleDateSection(key: string) {
    setExpandedDates((prev) => ({
      ...prev,
      [key]: !(prev[key] ?? false),
    }));
  }

  function isDateExpanded(key: string) {
    return expandedDates[key] ?? false;
  }

  const ArrowIcon = ({ expanded }: { expanded: boolean }) => (
    <svg
      className={[
        "h-4 w-4 text-cyan-200 transition-transform",
        expanded ? "rotate-90" : "",
      ].join(" ")}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={2}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9 5l7 7-7 7"
      />
    </svg>
  );

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      {/* Header */}
      <header className="border-b border-slate-700 bg-gradient-to-r from-black via-slate-900 to-black sticky top-0 z-10">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div className="flex items-center gap-3">
            {/* Panthers-ish faux logo */}
            <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-cyan-500/20 ring-2 ring-cyan-400/60">
              <span className="text-l font-black text-cyan-300">Picks</span>
            </div>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-cyan-300">
                2025–26 NBA Games
              </h1>
              <p className="text-xs text-slate-400">Game tracker 🐾</p>
            </div>
          </div>

          <div className="hidden items-center gap-2 rounded-full bg-slate-900/80 px-4 py-2 text-xs font-medium text-slate-300 shadow-lg shadow-cyan-500/20 md:flex">
            <span className="mr-1 inline-block h-2 w-2 rounded-full bg-cyan-400" />
            Live data from Supabase
          </div>
        </div>
      </header>

      {/* Content */}
      <main className="mx-auto max-w-6xl px-4 py-6">
        {loading && (
          <div className="mb-4 rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-3 text-sm text-slate-100">
            Loading games…
          </div>
        )}

        {error && (
          <div className="mb-4 rounded-xl border border-red-700/60 bg-red-900/40 px-4 py-3 text-sm text-red-100">
            {error}
          </div>
        )}

        {!loading && !error && games.length === 0 && (
          <div className="rounded-xl border border-slate-700 bg-slate-900/70 px-4 py-6 text-center text-sm text-slate-300">
            No games found for this season yet.
          </div>
        )}

        {!loading && !error && games.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-3">
            {FILTER_TABS.map((tab) => {
              const isActive = tab.key === activeFilter;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => {
                    setActiveFilter(tab.key);
                    setExpandedGameId(null);
                    setExpandedDates({});
                  }}
                  aria-pressed={isActive}
                  className={[
                    "flex flex-col rounded-2xl border px-4 py-3 text-left transition-colors max-w-[180px]",
                    isActive
                      ? "border-cyan-400 bg-cyan-500/10 text-cyan-100 shadow-lg shadow-cyan-500/20"
                      : "border-slate-800 bg-slate-900/50 text-slate-300 hover:border-cyan-500/50",
                  ].join(" ")}
                >
                  <span className="text-sm font-semibold">{tab.label}</span>
                  <span className="text-[11px] text-slate-400">
                    {tab.description}
                  </span>
                </button>
              );
            })}
          </div>
        )}

        {!loading && !error && filteredGames.length === 0 && games.length > 0 && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 px-4 py-6 text-center text-sm text-slate-300">
            No games in this range. Try another tab.
          </div>
        )}

        {!loading && !error && filteredGames.length > 0 && (
          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-slate-950/70 shadow-xl shadow-black/40">
            {/* Table header */}
            <div className="grid grid-cols-12 items-center border-b border-slate-800 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 px-4 py-3 text-xs font-semibold uppercase tracking-wide text-slate-400">
              <div className="col-span-3">Game</div>
              <div className="col-span-3">Tip-off</div>
              <div className="col-span-2">Teams</div>
              <div className="col-span-2">Arena</div>
              <div className="col-span-2">TV</div>
            </div>

            <div className="divide-y divide-slate-800">
              {dateSections.map(([dateKey, dateGames]) => {
                const expanded = isDateExpanded(dateKey);
                return (
                  <div key={dateKey} className="border-b border-slate-800/50">
                    <button
                      type="button"
                      onClick={() => toggleDateSection(dateKey)}
                      className="flex w-full items-center justify-between px-4 py-2 text-left text-sm font-semibold text-cyan-100 bg-slate-900/60 hover:bg-slate-900/80 transition-colors cursor-pointer"
                    >
                      <div className="flex items-center gap-3">
                        <ArrowIcon expanded={expanded} />
                        <span className="text-xs uppercase tracking-wider">
                          {getDateLabelFromKey(dateKey)}
                        </span>
                        <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                          {dateGames.length} game
                          {dateGames.length > 1 ? "s" : ""}
                        </span>
                      </div>
                      <span className="text-xs text-cyan-300">
                        {expanded ? "Hide" : "Show"}
                      </span>
                    </button>

                    {expanded &&
                      dateGames.map((game) => {
                        const isExpanded = expandedGameId === game.game_id;
                        const playerData = gamePlayerData[game.game_id];
                        const statsPlayers =
                          playerData?.mode === "stats"
                            ? playerData.players
                            : [];
                        const rosterTeams =
                          playerData?.mode === "roster"
                            ? playerData.roster ?? []
                            : [];
                        const tipoffTime = formatTime(game.game_datetime_est);

                        return (
                          <div
                            key={game.game_id}
                            className="border-t border-slate-800/60"
                          >
                            <button
                              onClick={() => handleToggleExpand(game)}
                              className="grid grid-cols-12 items-center px-4 py-3 text-sm w-full text-left transition-colors hover:bg-slate-900/70"
                            >
                              <div className="col-span-3 flex flex-col gap-0.5">
                                <span className="text-xs font-semibold uppercase tracking-wider text-cyan-300">
                                {formatGameDate(game)}

                                </span>
                                <span className="text-xs text-slate-400">
                                  {game.game_code ||
                                    `Game #${game.game_sequence ?? "–"}`}
                                </span>
                              </div>

                              <div className="col-span-3 text-sm text-slate-100">
                                <span
                                  className={[
                                    "inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wide",
                                    tipoffTime === "TBD"
                                      ? "bg-slate-700/40 text-slate-200 ring-1 ring-slate-500/60"
                                      : "bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-500/60",
                                  ].join(" ")}
                                >
                                 {game.game_status_text}
                                </span>
                              </div>

                              <div className="col-span-2">
                                <div className="flex flex-col text-xs">
                                  <div className="flex items-center gap-1">
                                    <span className="inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                                    <span className="font-medium text-slate-100">
                                    Home: {getTeamName(game.home_team_id)}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="inline-flex h-2 w-2 rounded-full bg-slate-500" />
                                    <span className="text-slate-300">
                                    Away: {getTeamName(game.away_team_id)}
                                    </span>
                                  </div>
                                </div>
                              </div>

                              <div className="col-span-2 text-xs text-slate-300">
                                {game.arena_name || "TBD"}
                              </div>

                              <div className="col-span-2 text-xs text-slate-300">
                                {game.national_tv || "—"}
                              </div>
                            </button>

                            {isExpanded && (
                              <div className="bg-slate-900/60 px-6 py-4 text-sm">
                                {loadingPlayersFor === game.game_id && (
                                  <div className="text-cyan-300 text-xs mb-2">
                                    Loading players…
                                  </div>
                                )}

                                {loadingPlayersFor !== game.game_id &&
                                  !playerData && (
                                    <div className="text-xs text-slate-400">
                                      Select a game to load its players.
                                    </div>
                                  )}

                                {playerData?.mode === "stats" &&
                                  statsPlayers.length === 0 && (
                                    <div className="text-xs text-slate-400">
                                      No players found for this game.
                                    </div>
                                  )}

                                {playerData?.mode === "stats" &&
                                  statsPlayers.length > 0 && (
                                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                      {statsPlayers.map((p) => {
                                        const playerKey = buildPlayerKey(
                                          game.game_id,
                                          "stats",
                                          p.player_id,
                                          p.team_abbr ?? "UNK"
                                        );
                                        const isExpanded =
                                          expandedPlayers[playerKey] ?? false;
                                        return (
                                          <div
                                            key={p.player_id}
                                            className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3"
                                          >
                                            <div className="flex justify-between items-center mb-1">
                                              <span className="font-medium text-cyan-200">
                                                {p.player_name}
                                              </span>
                                              <TeamBadge
                                                label={p.team_abbr ?? "UNK"}
                                              />
                                            </div>
                                            <div className="text-xs text-slate-300 mb-1">
                                              {p.start_pos || "Bench"} •{" "}
                                              {p.min ?? "0"} MIN
                                            </div>
                                            <div className="text-xs text-slate-400">
                                              PTS:{" "}
                                              <span className="text-cyan-200">
                                                {p.pts ?? 0}
                                              </span>{" "}
                                              · REB:{" "}
                                              <span className="text-cyan-200">
                                                {p.reb ?? "0"}
                                              </span>{" "}
                                              · AST:{" "}
                                              <span className="text-cyan-200">
                                                {p.ast ?? 0}
                                              </span>
                                            </div>
                                            <button
                                              type="button"
                                              className="mt-3 text-[11px] font-semibold text-cyan-200 underline-offset-2 hover:underline"
                                              onClick={() =>
                                                togglePlayerExpansion(playerKey)
                                              }
                                              aria-expanded={isExpanded}
                                            >
                                              Player Overview
                                            </button>
                                            {isExpanded && (
                                              <div className="mt-2 rounded-xl border border-dashed border-cyan-400/40 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-200">
                                                <p className="mb-2">
                                                  Player scouting card coming
                                                  soon.
                                                </p>
                                                {p.player_id ? (
                                                  <Link
                                                    href={`/nba-games/players/${p.player_id}`}
                                                    className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                                                  >
                                                    Get Advanced AI Analysis on
                                                    Player
                                                  </Link>
                                                ) : (
                                                  <button
                                                    type="button"
                                                    disabled
                                                    className="inline-flex items-center justify-center rounded-full border border-slate-700/60 bg-slate-800/60 px-3 py-1 text-[11px] font-semibold text-slate-400"
                                                  >
                                                    Get Advanced AI Analysis on
                                                    Player
                                                  </button>
                                                )}
                                              </div>
                                            )}
                                          </div>
                                        );
                                      })}
                                    </div>
                                  )}

                                {playerData?.mode === "roster" && (
                                  <div className="space-y-3">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                                      Projected Rosters
                                    </p>
                                    <RosterGrid
                                      roster={rosterTeams}
                                      gameId={game.game_id}
                                      expandedPlayers={expandedPlayers}
                                      onToggle={togglePlayerExpansion}
                                      buildPlayerKey={buildPlayerKey}
                                    />
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Footer badge */}
        <div className="mt-6 flex justify-end">
          <div className="inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-cyan-500/10 px-3 py-1 text-[11px] font-medium text-cyan-200 shadow-lg shadow-cyan-500/20">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-cyan-400" />
            Built with Next.js · Supabase
          </div>
        </div>
      </main>
    </div>
  );
}
