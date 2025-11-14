// app/nba-games/page.tsx
"use client";

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

type PlayersApiResponse = {
  players: Player[];
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


function TeamBadge({ label }: { label: string }) {
  return (
    <span className="text-xs rounded-full bg-cyan-500/10 px-2 py-1 text-cyan-300 border border-cyan-500/40">
      {label}
    </span>
  );
}

export default function NbaGamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<GamesFilter>("thisWeek");
  const [expandedDates, setExpandedDates] = useState<Record<string, boolean>>(
    {}
  );

  const [expandedGameId, setExpandedGameId] = useState<number | null>(null);
  const [playersByGameId, setPlayersByGameId] = useState<
    Record<number, Player[]>
  >({});
  const [loadingPlayersFor, setLoadingPlayersFor] = useState<number | null>(
    null
  );

  useEffect(() => {
    let cancelled = false;

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

    return () => {
      cancelled = true;
    };
  }, []);

  async function handleToggleExpand(game: Game) {
    const id = game.game_id;

    if (expandedGameId === id) {
      setExpandedGameId(null);
      return;
    }

    setExpandedGameId(id);

    if (playersByGameId[id]) return; // already cached

    setLoadingPlayersFor(id);
    try {
      const res = await fetch(`/api/nba-games/${id}/players`);
      const json: PlayersApiResponse = await res.json();

      if (!res.ok) {
        throw new Error(json.error || "Failed to load players.");
      }

      setPlayersByGameId((prev) => ({
        ...prev,
        [id]: json.players || [],
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
              <div className="col-span-2">Tip-off</div>
              <div className="col-span-2">Teams</div>
              <div className="col-span-2">Arena</div>
              <div className="col-span-2">TV</div>
              <div className="col-span-1 text-right">Status</div>
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
                        const players = playersByGameId[game.game_id] || [];

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

                              <div className="col-span-2 text-sm text-slate-100">
                                {formatTime(game.game_datetime_est)}
                              </div>

                              <div className="col-span-2">
                                <div className="flex flex-col text-xs">
                                  <div className="flex items-center gap-1">
                                    <span className="inline-flex h-2 w-2 rounded-full bg-cyan-400" />
                                    <span className="font-medium text-slate-100">
                                      Home: {game.home_team_id ?? "TBD"}
                                    </span>
                                  </div>
                                  <div className="flex items-center gap-1">
                                    <span className="inline-flex h-2 w-2 rounded-full bg-slate-500" />
                                    <span className="text-slate-300">
                                      Away: {game.away_team_id ?? "TBD"}
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

                              <div className="col-span-1 flex justify-end">
                                <span
                                  className={[
                                    "inline-flex items-center rounded-full px-3 py-1 text-[10px] font-semibold uppercase tracking-wide",
                                    game.game_status_text === "Final"
                                      ? "bg-emerald-500/10 text-emerald-300 ring-1 ring-emerald-500/60"
                                      : "bg-cyan-500/10 text-cyan-300 ring-1 ring-cyan-500/60",
                                  ].join(" ")}
                                >
                                  {game.game_status_text || "Scheduled"}
                                </span>
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
                                  players.length === 0 && (
                                    <div className="text-xs text-slate-400">
                                      No players found for this game.
                                    </div>
                                  )}

                                {players.length > 0 && (
                                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                                    {players.map((p) => (
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
                                      </div>
                                    ))}
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
            Built with Next.js · Supabase · Panthers vibes
          </div>
        </div>
      </main>
    </div>
  );
}
