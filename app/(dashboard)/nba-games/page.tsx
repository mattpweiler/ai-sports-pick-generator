// app/nba-games/page.tsx
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { AiGameProjectionsResponse } from "@/lib/aiPredictions";
import { ExplanationCell } from "../components/ExplanationCell";
import { DEFAULT_MODEL_VERSION } from "@/lib/predictions";

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

type PlayerSummary = {
  pts: number | null;
  reb: number | null;
  ast: number | null;
  pra: number | null;
  sampleSize: number;
};

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

function isCupFinalDate(key: string) {
  return /-12-16$/.test(key);
}

function getScheduleDateKey(game: Game): string | null {
  const rawDate = game.game_date?.trim();
  if (rawDate && /^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
    // Parse at noon UTC to avoid shifting the calendar day across time zones
    const dt = new Date(`${rawDate}T12:00:00Z`);
    if (!Number.isNaN(dt.getTime())) {
      return dt.toISOString().split("T")[0];
    }
  }

  const dt = getGameDate(game);
  if (!dt) return null;
  return dt.toISOString().split("T")[0];
}

function isFutureGame(game: Game) {
  const statusId = game.game_status_id;
  const statusText = (game.game_status_text ?? "").toLowerCase();

  // Live or final games should use stats mode.
  if (statusId === 2 || statusText.includes("live")) return false;
  if (statusId === 3 || statusText.includes("final")) return false;

  // Fallback to date-based comparison using schedule date to avoid tz skew.
  const gameDayKey = getScheduleDateKey(game);
  if (!gameDayKey) return false;

  const todayKey = new Date().toISOString().split("T")[0];

  // Anything before today is past and should show stats.
  if (gameDayKey < todayKey) return false;

  // Today or future dates should show roster + averages (pregame view).
  return true;
}

function isPastGame(game: Game) {
  const gameDayKey = getScheduleDateKey(game);
  if (!gameDayKey) return false;
  const todayKey = new Date().toISOString().split("T")[0];
  return gameDayKey < todayKey;
}

function isTodayDateKey(key: string) {
  const todayKey = new Date().toISOString().split("T")[0];
  return key === todayKey;
}

function isWithinAiWindow(game: Game) {
  const gameDayKey = getScheduleDateKey(game);
  if (!gameDayKey) return false;
  const gameDate = new Date(`${gameDayKey}T12:00:00Z`);
  if (Number.isNaN(gameDate.getTime())) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diffDays = (gameDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
  return diffDays >= -3 && diffDays <= 3;
}

function getMinutesValue(min: string | number | null | undefined) {
  if (typeof min === "number") return Number.isFinite(min) ? min : 0;
  if (typeof min === "string") {
    const parsed = parseFloat(min);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
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
  onToggle: (key: string, playerId?: number | null) => void;
  buildPlayerKey: (
    gameId: number,
    mode: "stats" | "roster",
    playerId: number | null | undefined,
    teamId?: number | string | null | undefined
  ) => string;
  summaries: Record<string, PlayerSummary>;
  summaryLoading: Record<string, boolean>;
};

function RosterGrid({
  roster,
  gameId,
  expandedPlayers,
  onToggle,
  buildPlayerKey,
  summaries,
  summaryLoading,
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
                              href={`/predictions?playerId=${player.player_id}&gameId=${gameId}`}
                              className="inline-flex items-center justify-center rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 transition"
                            >
                              View Predictions
                            </Link>
                            <Link
                              href={`/nba-games/players/${player.player_id}`}
                              className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                            >
                              Player Deep Dive
                            </Link>
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
  const [playerSummaries, setPlayerSummaries] = useState<
    Record<string, PlayerSummary>
  >({});
  const [playerSummaryLoading, setPlayerSummaryLoading] = useState<
    Record<string, boolean>
  >({});
  const [loadingPlayersFor, setLoadingPlayersFor] = useState<number | null>(
    null
  );
  const [aiModalGameId, setAiModalGameId] = useState<number | null>(null);
  const [aiContext, setAiContext] = useState("");
  const [aiUseMlBaseline, setAiUseMlBaseline] = useState(true);
  const [aiModelVersion, setAiModelVersion] =
    useState<string>(DEFAULT_MODEL_VERSION);
  const [aiModelVersions, setAiModelVersions] = useState<string[]>([]);
  const [aiResults, setAiResults] = useState<
    Record<number, AiGameProjectionsResponse>
  >({});
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

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

    async function loadModelVersions() {
      try {
        const res = await fetch("/api/ml-model-versions");
        const json = await res.json();
        if (!cancelled && res.ok) {
          const versions = Array.isArray(json.versions)
            ? json.versions
            : [];
          setAiModelVersions(versions);
          setAiModelVersion(
            versions[0] ? String(versions[0]) : DEFAULT_MODEL_VERSION
          );
        } else if (!cancelled) {
          throw new Error(json.error || "Failed to load model versions.");
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("Model versions fetch failed:", err);
          setAiModelVersions([DEFAULT_MODEL_VERSION]);
          setAiModelVersion(DEFAULT_MODEL_VERSION);
        }
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
    loadModelVersions();

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
      } else {
        console.error("Failed to load player summary:", json.error);
      }
    } catch (err) {
      console.error("Error loading player summary:", err);
    } finally {
      setPlayerSummaryLoading((prev) => ({ ...prev, [key]: false }));
    }
  }

  async function prefetchRosterSummaries(gameId: number, roster: TeamRoster[]) {
    const requests: Promise<void>[] = [];
    roster.forEach((team) => {
      (team.players ?? []).forEach((player) => {
        const key = buildPlayerKey(gameId, "roster", player.player_id, team.team_id);
        if (player.player_id && !playerSummaries[key] && !playerSummaryLoading[key]) {
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

  function getPlayerNameFromGame(gameId: number, playerId: number) {
    const data = gamePlayerData[gameId];
    if (data?.mode === "stats") {
      const found = data.players.find((p) => p.player_id === playerId);
      if (found?.player_name) return found.player_name;
    }
    if (data?.mode === "roster") {
      for (const team of data.roster) {
        const found = team.players.find((p) => p.player_id === playerId);
        if (found?.player_name) return found.player_name;
      }
    }
    return `Player ${playerId}`;
  }

  function openAiModal(gameId: number) {
    setAiModalGameId(gameId);
    setAiError(null);
  }

  function closeAiModal() {
    if (aiLoading) return;
    setAiModalGameId(null);
    setAiError(null);
  }

  function confidenceClass(confidence: number | null | undefined) {
    if (confidence !== null && confidence !== undefined && confidence >= 0.75) {
      return "bg-emerald-500/15 text-emerald-200 border-emerald-500/50";
    }
    if (confidence !== null && confidence !== undefined && confidence >= 0.55) {
      return "bg-amber-500/15 text-amber-200 border-amber-500/50";
    }
    return "bg-slate-500/20 text-slate-200 border-slate-500/40";
  }

  function confidenceLabel(confidence: number | null | undefined) {
    if (confidence === null || confidence === undefined) return "—";
    if (confidence >= 0.75) return "High";
    if (confidence >= 0.55) return "Medium";
    return "Low";
  }

  async function handleSubmitAiPrediction(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (!aiModalGameId) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/game-projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: aiModalGameId,
          model_version: aiModelVersion,
          user_notes: aiContext,
        }),
      });
      const json: AiGameProjectionsResponse | { error?: string } =
        await res.json();
      if (!res.ok) {
        throw new Error((json as any).error || "Failed to generate AI output.");
      }
      setAiResults((prev) => ({
        ...prev,
        [aiModalGameId]: json as AiGameProjectionsResponse,
      }));
      setAiModalGameId(null);
    } catch (err) {
      console.error("AI prediction error:", err);
      const message =
        err instanceof Error
          ? err.message
          : "Failed to generate AI predictions.";
      setAiError(message);
    } finally {
      setAiLoading(false);
    }
  }

  function renderAiSection(game: Game) {
    if (!isWithinAiWindow(game)) {
      return null;
    }
    const aiResult = aiResults[game.game_id];
    const grouped = aiResult
      ? aiResult.players.reduce<Record<string, typeof aiResult.players>>(
          (acc, player) => {
            const key = player.team_abbr || "UNK";
            if (!acc[key]) acc[key] = [];
            acc[key].push(player);
            return acc;
          },
          {}
        )
      : {};
    const generatedAt =
      aiResult?.generated_at && !Number.isNaN(new Date(aiResult.generated_at).getTime())
        ? new Date(aiResult.generated_at).toLocaleString()
        : null;

    return (
      <div className="my-5 rounded-2xl border border-cyan-500/30 bg-slate-950/60 p-4">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              AI Predictions
            </p>
            <p className="text-sm text-slate-300">
              Suggested lines for every expected active player.
            </p>
            {generatedAt && (
              <p className="text-[11px] text-slate-400">
                Generated {generatedAt} • Model {aiResult?.model_version}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={() => openAiModal(game.game_id)}
            className="inline-flex items-center justify-center rounded-full border border-cyan-500/60 bg-cyan-500/10 px-4 py-2 text-[11px] font-semibold text-cyan-100 shadow-cyan-500/30 transition hover:bg-cyan-500/20"
          >
            Generate AI Predictions
          </button>
        </div>

        {aiResult?.assumptions?.length ? (
          <div className="mt-3 flex flex-wrap gap-2">
            {aiResult.assumptions.map((assumption: string, idx: number) => (
              <span
                key={`${assumption}-${idx}`}
                className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-[11px] text-slate-200"
              >
                {assumption}
              </span>
            ))}
          </div>
        ) : (
          <p className="mt-2 text-[11px] text-slate-500">
            Use the button to generate game-level notes and per-player lines.
          </p>
        )}

        {aiResult ? (
          <div className="mt-4 space-y-4">
            {Object.entries(grouped).map(([team, players]) => (
              <div
                key={team}
                className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
              >
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold text-cyan-200">
                    {team}
                  </p>
                  <span className="text-[11px] text-slate-400">
                    {players.length} player{players.length > 1 ? "s" : ""}
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-left text-xs text-slate-200">
                    <thead>
                      <tr className="text-[11px] uppercase tracking-wide text-slate-400">
                        <th className="px-2 py-2">Player</th>
                        <th className="px-2 py-2 text-right">Min</th>
                        <th className="px-2 py-2 text-right">PTS</th>
                        <th className="px-2 py-2 text-right">REB</th>
                        <th className="px-2 py-2 text-right">AST</th>
                        <th className="px-2 py-2 text-right">PRA</th>
                        <th className="px-2 py-2">Confidence</th>
                        <th className="px-2 py-2">Explanation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {players
                        .slice()
                        .sort((a, b) => b.final.minutes - a.final.minutes)
                        .map((player) => (
                          <tr
                            key={`${player.player_id}-${player.team_abbr}`}
                            className="border-t border-slate-800/70 hover:bg-slate-800/40"
                          >
                            <td className="px-2 py-2 font-semibold text-slate-100">
                              {getPlayerNameFromGame(
                                game.game_id,
                                player.player_id
                              )}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {player.final.minutes.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {player.final.pts.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {player.final.reb.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {player.final.ast.toFixed(1)}
                            </td>
                            <td className="px-2 py-2 text-right">
                              {player.final.pra.toFixed(1)}
                            </td>
                          <td className="px-2 py-2">
                            <span
                              className={[
                                "inline-flex rounded-full border px-2 py-1 text-[11px] font-semibold",
                                confidenceClass(player.final.confidence),
                              ].join(" ")}
                            >
                              {confidenceLabel(player.final.confidence)}
                            </span>
                          </td>
                          <td className="px-2 py-2">
                            <ExplanationCell
                              gameId={game.game_id}
                              playerId={player.player_id}
                              playerName={getPlayerNameFromGame(
                                game.game_id,
                                player.player_id
                              )}
                              modelVersion={aiResult.model_version}
                              finalStats={player.final}
                              userNotes={aiContext}
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
    );
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
      if (resultMode === "roster" && (json.roster?.length ?? 0) > 0) {
        prefetchRosterSummaries(id, json.roster ?? []).catch((err) =>
          console.warn("Prefetch summaries failed", err)
        );
      }
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
      {aiModalGameId !== null && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6">
          <div className="w-full max-w-2xl rounded-2xl border border-cyan-500/40 bg-slate-950 p-6 shadow-2xl shadow-cyan-500/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  AI Predictions
                </p>
                <h2 className="text-lg font-semibold text-slate-50">
                  Generate projections for Game #{aiModalGameId}
                </h2>
                <p className="text-sm text-slate-400">
                  We will cache identical requests (game + context + model version).
                </p>
              </div>
              <button
                type="button"
                onClick={closeAiModal}
                className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-500"
              >
                Close
              </button>
            </div>

            <form className="mt-4 space-y-4" onSubmit={handleSubmitAiPrediction}>
              <div>
                <label className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                  Context (injuries/news/trends)
                </label>
                <textarea
                  value={aiContext}
                  onChange={(e) => setAiContext(e.target.value)}
                  rows={4}
                  className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                  placeholder="Giannis questionable ankle; coach said minutes limit; Bucks on B2B; team playing faster lately; role changes…"
                />
                <p className="mt-1 text-[11px] text-slate-400">
                  These notes are treated as facts (out, questionable, blowout risk, pace up, minutes limit).
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                    Model version
                  </label>
                  <select
                    value={aiModelVersion}
                    onChange={(e) => setAiModelVersion(e.target.value)}
                    className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                  >
                    {(aiModelVersions.length ? aiModelVersions : [aiModelVersion]).map(
                      (version) => (
                        <option key={version} value={version}>
                          {version}
                        </option>
                      )
                    )}
                  </select>
                  <p className="mt-1 text-[11px] text-slate-400">
                    Default is the latest nightly registered version.
                  </p>
                </div>
                <div className="flex flex-col justify-center">
                  <label className="flex items-center gap-3 text-sm font-medium text-slate-100">
                    <input
                      type="checkbox"
                      checked={aiUseMlBaseline}
                      onChange={(e) => setAiUseMlBaseline(e.target.checked)}
                      className="h-4 w-4 rounded border-slate-600 bg-slate-800 text-cyan-500 focus:ring-cyan-400"
                    />
                    Use ML as baseline
                  </label>
                  <p className="text-[11px] text-slate-400">
                    When on, the LLM blends toward ML means; otherwise it leans on recent/season form.
                  </p>
                </div>
              </div>

              {aiError && (
                <div className="rounded-xl border border-red-600/50 bg-red-900/40 px-3 py-2 text-sm text-red-100">
                  {aiError}
                </div>
              )}

              <div className="flex justify-end gap-3">
                <button
                  type="button"
                  onClick={closeAiModal}
                  className="rounded-full border border-slate-700 bg-slate-800/70 px-4 py-2 text-sm font-semibold text-slate-200 hover:border-slate-500"
                  disabled={aiLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={aiLoading}
                  className={[
                    "rounded-full px-4 py-2 text-sm font-semibold text-black transition",
                    aiLoading
                      ? "cursor-not-allowed bg-cyan-900/70 text-cyan-200"
                      : "bg-cyan-400 hover:bg-cyan-300",
                  ].join(" ")}
                >
                  {aiLoading ? "Generating…" : "Generate AI Predictions"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
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
                    "flex flex-col rounded-2xl border px-4 py-3 text-left transition-colors max-w-[180px] cursor-pointer",
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
                const showCupFinalsNote = isCupFinalDate(dateKey);
                const isToday = activeFilter === "thisWeek" && isTodayDateKey(dateKey);
                return (
                  <div key={dateKey} className="border-b border-slate-800/50">
                    <button
                      type="button"
                      onClick={() => toggleDateSection(dateKey)}
                      className={[
                        "flex w-full items-center justify-between px-4 py-2 text-left text-sm font-semibold transition-colors cursor-pointer border",
                        isToday
                          ? "text-emerald-100 bg-emerald-900/60 hover:bg-emerald-900/80 border-emerald-500/60"
                          : "text-cyan-100 bg-slate-900/60 hover:bg-slate-900/80 border-slate-800/60",
                      ].join(" ")}
                    >
                      <div className="flex items-center gap-3">
                        <ArrowIcon expanded={expanded} />
                        <span className="inline-flex items-center gap-2 text-xs uppercase tracking-wider">
                          <span>{getDateLabelFromKey(dateKey)}</span>
                        </span>
                        <span className="rounded-full border border-cyan-500/40 bg-cyan-500/10 px-2 py-0.5 text-[11px] text-cyan-200">
                          {dateGames.length} game
                          {dateGames.length > 1 ? "s" : ""}
                        </span>
                        {activeFilter === "thisWeek" && isTodayDateKey(dateKey) && (
                          <span className="rounded-full border border-emerald-400/60 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold tracking-wide text-emerald-200">
                            Today
                          </span>
                        )}
                      </div>
                      <span className="text-xs text-cyan-300">
                        {expanded ? "Hide" : "Show"}
                      </span>
                    </button>

                    {showCupFinalsNote && (
                      <div className="border-y border-amber-500/30 bg-amber-500/5 px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-amber-200">
                        The NBA Cup Finals did not count towards stats.
                      </div>
                    )}

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
                              className="grid grid-cols-12 items-center px-4 py-3 text-sm w-full text-left transition-colors hover:bg-slate-900/70 cursor-pointer"
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

                                {renderAiSection(game)}

                                {playerData?.mode === "stats" &&
                                  statsPlayers.length === 0 && (
                                    <div className="text-xs text-slate-400">
                                      No players found for this game.
                                    </div>
                                  )}

                                {playerData?.mode === "stats" &&
                                  statsPlayers.length > 0 && (
                                    <>
                                      {isPastGame(game) ? (
                                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                                          {Object.entries(
                                            statsPlayers.reduce<Record<string, Player[]>>(
                                              (acc, player) => {
                                                const key = player.team_abbr ?? "UNK";
                                                if (!acc[key]) acc[key] = [];
                                                acc[key].push(player);
                                                return acc;
                                              },
                                              {}
                                            )
                                          ).map(([teamAbbr, teamPlayers]) => {
                                            const sortedTeamPlayers = teamPlayers
                                              .slice()
                                              .sort(
                                                (a, b) =>
                                                  (b.pts ?? 0) - (a.pts ?? 0)
                                              );
                                            const playedPlayers = sortedTeamPlayers.filter(
                                              (p) => getMinutesValue(p.min) > 0
                                            );
                                            const didNotPlay = sortedTeamPlayers.filter(
                                              (p) => getMinutesValue(p.min) <= 0
                                            );
                                            return (
                                            <div
                                              key={teamAbbr}
                                              className="rounded-2xl border border-slate-800 bg-slate-950/70 p-3"
                                            >
                                              <div className="mb-2 flex items-center justify-between">
                                                <p className="text-sm font-semibold text-slate-100">
                                                  {teamAbbr}
                                                </p>
                                                <span className="text-[11px] text-slate-400">
                                                  {teamPlayers.length} player
                                                  {teamPlayers.length > 1 ? "s" : ""}
                                                </span>
                                              </div>
                                              <div className="space-y-3">
                                                {playedPlayers.map((p) => {
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
                                                          togglePlayerExpansion(
                                                            playerKey,
                                                            p.player_id
                                                          )
                                                        }
                                                        aria-expanded={isExpanded}
                                                      >
                                                        Player Averages
                                                      </button>
                                                      {isExpanded && (
                                                        <div className="mt-2 rounded-xl border border-dashed border-cyan-400/40 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-200">
                                                          <div className="mb-2 rounded-lg border border-slate-800/60 bg-slate-900/40 p-2 text-[10px] uppercase tracking-wide text-slate-400">
                                                            {playerSummaryLoading[playerKey] ? (
                                                              <p className="text-cyan-200">
                                                                Loading averages…
                                                              </p>
                                                            ) : (
                                                              <div className="grid grid-cols-2 gap-2">
                                                                <span>
                                                                  Avg PTS:{" "}
                                                                  <span className="text-cyan-200">
                                                                    {playerSummaries[playerKey]?.pts ??
                                                                      "—"}
                                                                  </span>
                                                                </span>
                                                                <span>
                                                                  Avg REB:{" "}
                                                                  <span className="text-cyan-200">
                                                                    {playerSummaries[playerKey]?.reb ??
                                                                      "—"}
                                                                  </span>
                                                                </span>
                                                                <span>
                                                                  Avg AST:{" "}
                                                                  <span className="text-cyan-200">
                                                                    {playerSummaries[playerKey]?.ast ??
                                                                      "—"}
                                                                  </span>
                                                                </span>
                                                                <span>
                                                                  Avg PRA:{" "}
                                                                  <span className="text-cyan-200">
                                                                    {playerSummaries[playerKey]?.pra ??
                                                                      "—"}
                                                                  </span>
                                                                </span>
                                                              </div>
                                                            )}
                                                          </div>
                                                          <div className="flex flex-wrap gap-2">
                                                            {p.player_id ? (
                                                              <>
                                                                {!isPastGame(game) && (
                                                                  <Link
                                                                    href={`/predictions?playerId=${p.player_id}&gameId=${game.game_id}`}
                                                                    className="inline-flex items-center justify-center rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 transition"
                                                                  >
                                                                    View Predictions
                                                                  </Link>
                                                                )}
                                                                <Link
                                                                  href={`/nba-games/players/${p.player_id}`}
                                                                  className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                                                                >
                                                                  Player Deep Dive
                                                                </Link>
                                                              </>
                                                            ) : (
                                                              <button
                                                                type="button"
                                                                disabled
                                                                className="inline-flex items-center justify-center rounded-full border border-slate-700/60 bg-slate-800/60 px-3 py-1 text-[11px] font-semibold text-slate-400"
                                                              >
                                                                Player links unavailable
                                                              </button>
                                                            )}
                                                          </div>
                                                        </div>
                                                      )}
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                              {didNotPlay.length > 0 && (
                                                <div className="mt-4 rounded-xl border border-slate-800 bg-slate-900/50 p-3">
                                                  <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-300">
                                                    Did Not Play
                                                  </p>
                                                  <div className="mt-2 space-y-2">
                                                    {didNotPlay.map((p) => (
                                                      <div
                                                        key={p.player_id}
                                                        className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-200 flex items-center justify-between"
                                                      >
                                                        <div>
                                                          <p className="font-semibold text-slate-100">
                                                            {p.player_name ?? `Player ${p.player_id}`}
                                                          </p>
                                                          <p className="text-[11px] uppercase tracking-wide text-slate-400">
                                                            {p.start_pos || "Bench"} • {p.team_abbr ?? "UNK"}
                                                          </p>
                                                        </div>
                                                        <span className="text-[11px] text-slate-400">
                                                          0 MIN
                                                        </span>
                                                      </div>
                                                    ))}
                                                  </div>
                                                </div>
                                              )}
                                            </div>
                                            );
                                          })}
                                        </div>
                                      ) : (
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
                                                    togglePlayerExpansion(
                                                      playerKey,
                                                      p.player_id
                                                    )
                                                  }
                                                  aria-expanded={isExpanded}
                                                >
                                                  Player Averages
                                                </button>
                                                {isExpanded && (
                                                  <div className="mt-2 rounded-xl border border-dashed border-cyan-400/40 bg-slate-950/40 px-3 py-2 text-[11px] text-slate-200">
                                                    <div className="mb-2 rounded-lg border border-slate-800/60 bg-slate-900/40 p-2 text-[10px] uppercase tracking-wide text-slate-400">
                                                      {playerSummaryLoading[playerKey] ? (
                                                        <p className="text-cyan-200">
                                                          Loading averages…
                                                        </p>
                                                      ) : (
                                                        <div className="grid grid-cols-2 gap-2">
                                                          <span>
                                                            Avg PTS:{" "}
                                                            <span className="text-cyan-200">
                                                              {playerSummaries[playerKey]?.pts ??
                                                                "—"}
                                                            </span>
                                                          </span>
                                                          <span>
                                                            Avg REB:{" "}
                                                            <span className="text-cyan-200">
                                                              {playerSummaries[playerKey]?.reb ??
                                                                "—"}
                                                            </span>
                                                          </span>
                                                          <span>
                                                            Avg AST:{" "}
                                                            <span className="text-cyan-200">
                                                              {playerSummaries[playerKey]?.ast ??
                                                                "—"}
                                                            </span>
                                                          </span>
                                                          <span>
                                                            Avg PRA:{" "}
                                                            <span className="text-cyan-200">
                                                              {playerSummaries[playerKey]?.pra ??
                                                                "—"}
                                                            </span>
                                                          </span>
                                                        </div>
                                                      )}
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                      {p.player_id ? (
                                                        <>
                                                          {!isPastGame(game) && (
                                                            <Link
                                                              href={`/predictions?playerId=${p.player_id}&gameId=${game.game_id}`}
                                                              className="inline-flex items-center justify-center rounded-full border border-emerald-400/60 bg-emerald-500/10 px-3 py-1 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 transition"
                                                            >
                                                              View Predictions
                                                            </Link>
                                                          )}
                                                          <Link
                                                            href={`/nba-games/players/${p.player_id}`}
                                                            className="inline-flex items-center justify-center rounded-full border border-cyan-400/60 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
                                                          >
                                                            Player Deep Dive
                                                          </Link>
                                                        </>
                                                      ) : (
                                                        <button
                                                          type="button"
                                                          disabled
                                                          className="inline-flex items-center justify-center rounded-full border border-slate-700/60 bg-slate-800/60 px-3 py-1 text-[11px] font-semibold text-slate-400"
                                                        >
                                                          Player links unavailable
                                                        </button>
                                                      )}
                                                    </div>
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })}
                                        </div>
                                      )}
                                    </>
                                  )}

                                {playerData?.mode === "roster" && (
                                  <div className="space-y-3">
                                    <p className="text-[11px] font-semibold uppercase tracking-wide text-cyan-200">
                                      Projected Rosters Preview
                                    </p>
                                    <RosterGrid
                                      roster={rosterTeams}
                                      gameId={game.game_id}
                                      expandedPlayers={expandedPlayers}
                                      onToggle={togglePlayerExpansion}
                                      buildPlayerKey={buildPlayerKey}
                                      summaries={playerSummaries}
                                      summaryLoading={playerSummaryLoading}
                                    />
                                  </div>
                                )}
                                {!isPastGame(game) && (
                                  <div className="mt-4">
                                    <Link
                                      href={`/nba-games/${game.game_id}`}
                                      className="inline-flex items-center justify-center rounded-full border border-emerald-500/60 bg-emerald-500/10 px-4 py-2 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/20 transition"
                                    >
                                      Open Game Page
                                    </Link>
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
