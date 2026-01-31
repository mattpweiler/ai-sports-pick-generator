"use client";

import React, { use, useEffect, useMemo, useState, FormEvent } from "react";
import Link from "next/link";
import {
  RosterGrid,
  TeamBadge,
  type PlayerSummary,
  type TeamRoster,
} from "../../components/RosterGrid";
import { DEFAULT_MODEL_VERSION } from "@/lib/predictions";
import type { AiGameProjectionsResponse } from "@/lib/aiPredictions";
import { ExplanationCell } from "../../../components/ExplanationCell";

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

type PriorInjury = {
  player_id: number | null;
  player_name: string | null;
  team_abbr: string | null;
  game_date: string | null;
  reason: string;
  matchup?: string | null;
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

function getScheduleDateKey(game: Game): string | null {
  const rawDate = game.game_date?.trim();
  if (rawDate) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(rawDate)) {
      const dt = new Date(`${rawDate}T12:00:00Z`);
      if (!Number.isNaN(dt.getTime())) {
        return dt.toISOString().split("T")[0];
      }
    } else {
      const dt = new Date(rawDate);
      if (!Number.isNaN(dt.getTime())) {
        return dt.toISOString().split("T")[0];
      }
    }
  }
  if (game.game_datetime_est) {
    const dt = new Date(game.game_datetime_est);
    if (!Number.isNaN(dt.getTime())) return dt.toISOString().split("T")[0];
  }
  return null;
}

function isFutureGame(game: Game) {
  const statusId = game.game_status_id;
  const statusText = (game.game_status_text ?? "").toLowerCase();

  if (statusId === 2 || statusText.includes("live")) return false;
  if (statusId === 3 || statusText.includes("final")) return false;

  const gameDayKey = getScheduleDateKey(game);
  if (!gameDayKey) return false;
  const todayKey = new Date().toISOString().split("T")[0];
  if (gameDayKey < todayKey) return false;
  return true;
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
  const [priorDnpInjuries, setPriorDnpInjuries] = useState<PriorInjury[]>([]);
  const [loadingInjuries, setLoadingInjuries] = useState(false);
  const [showAiPanel, setShowAiPanel] = useState(false);
  const [aiContext, setAiContext] = useState("");
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<AiGameProjectionsResponse | null>(null);

  const notableInjuries = useMemo(() => {
    const items: { player_name: string; team_abbr: string | null; note?: string }[] = [];
    roster.forEach((team) => {
      team.players.forEach((player) => {
        if (player.active_status === 0) {
          items.push({
            player_name: player.player_name ?? `Player ${player.player_id}`,
            team_abbr: team.team_abbr ?? null,
            note: "Marked inactive on roster",
          });
        }
      });
    });
    const dnpItems = priorDnpInjuries.map((p) => ({
      player_name: p.player_name ?? `Player ${p.player_id ?? "Unknown"}`,
      team_abbr: p.team_abbr ?? null,
      note: `${p.reason || "Did not play last game"}${
        p.game_date ? ` · ${p.game_date}` : ""
      }`,
    }));

    const deduped: Record<
      string,
      { player_name: string; team_abbr: string | null; note?: string }
    > = {};
    [...items, ...dnpItems].forEach((p) => {
      const key = `${p.player_name}-${p.team_abbr ?? "UNK"}`.toLowerCase();
      if (!deduped[key]) deduped[key] = p;
    });
    return Object.values(deduped);
  }, [roster, priorDnpInjuries]);

  const injuriesByTeam = useMemo(() => {
    const homeAbbr = (getTeamAbbr(game?.home_team_id) ?? "HOME").toUpperCase();
    const awayAbbr = (getTeamAbbr(game?.away_team_id) ?? "AWAY").toUpperCase();
    const buckets: Record<string, typeof notableInjuries> = {
      [homeAbbr]: [],
      [awayAbbr]: [],
    };
    notableInjuries.forEach((p) => {
      const abbr = (p.team_abbr ?? "").toUpperCase();
      if (abbr === homeAbbr) buckets[homeAbbr].push(p);
      else if (abbr === awayAbbr) buckets[awayAbbr].push(p);
      else {
        // If team unknown, append to both for visibility.
        buckets[homeAbbr].push(p);
        buckets[awayAbbr].push(p);
      }
    });
    return { homeAbbr, awayAbbr, buckets };
  }, [game, notableInjuries, teams]);

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

  useEffect(() => {
    let cancelled = false;
    async function loadPriorInjuries() {
      if (!game || !isFutureGame(game)) {
        setPriorDnpInjuries([]);
        return;
      }
      setLoadingInjuries(true);
      try {
        const res = await fetch(`/api/nba-games/${game.game_id}/injuries`);
        const json = await res.json();
        if (!cancelled && res.ok) {
          setPriorDnpInjuries(json.injuries ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.warn("Failed to load prior injuries", err);
        }
      } finally {
        if (!cancelled) setLoadingInjuries(false);
      }
    }
    loadPriorInjuries();
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

function getTeamAbbr(teamId: number | null | undefined) {
  if (!teamId) return null;
  const team = teams[teamId];
  return team ? team.abbreviation : null;
}

function getTeamIdByAbbr(roster: TeamRoster[], abbr?: string | null) {
  if (!abbr) return null;
  const target = abbr.toUpperCase();
  for (const team of roster) {
    if ((team.team_abbr ?? "").toUpperCase() === target) return team.team_id;
  }
  return null;
}

function getPlayerNameFromRoster(
  roster: TeamRoster[],
  playerId: number | null | undefined
) {
  if (!playerId) return "Unknown player";
  for (const team of roster) {
    const match = team.players.find((p) => p.player_id === playerId);
    if (match) return match.player_name ?? `Player ${playerId}`;
  }
  return `Player ${playerId}`;
}

  const aiGrouped = useMemo(() => {
    if (!aiResult) return {};
    return aiResult.players.reduce<Record<string, typeof aiResult.players>>(
      (acc, player) => {
        const key = player.team_abbr || "UNK";
        if (!acc[key]) acc[key] = [];
        acc[key].push(player);
        return acc;
      },
      {}
    );
  }, [aiResult]);

  const aiTeamsSplit = useMemo(() => {
    if (!aiResult) return { home: [], away: [], others: [] as typeof aiResult.players };
    const homeAbbr = (getTeamAbbr(game?.home_team_id) ?? "HOME").toUpperCase();
    const awayAbbr = (getTeamAbbr(game?.away_team_id) ?? "AWAY").toUpperCase();
    const home: typeof aiResult.players = [];
    const away: typeof aiResult.players = [];
    const others: typeof aiResult.players = [];
    aiResult.players.forEach((p) => {
      const abbr = (p.team_abbr ?? "").toUpperCase();
      if (abbr === homeAbbr) home.push(p);
      else if (abbr === awayAbbr) away.push(p);
      else others.push(p);
    });
    return { home, away, others };
  }, [aiResult, game, teams]);

  useEffect(() => {
    if (!aiResult || !roster.length) return;
    aiResult.players.forEach((player) => {
      const teamId = getTeamIdByAbbr(roster, player.team_abbr);
      const key = buildPlayerKey(
        numericGameId,
        "stats",
        player.player_id,
        teamId ?? player.team_abbr
      );
      if (!playerSummaries[key] && !playerSummaryLoading[key]) {
        loadPlayerSummary(player.player_id, key);
      }
    });
  }, [aiResult, roster, numericGameId, playerSummaries, playerSummaryLoading]);

  async function handleGenerateAi(evt?: FormEvent<HTMLFormElement>) {
    if (evt) evt.preventDefault();
    if (!game) {
      setAiError("Load game before generating predictions.");
      return;
    }
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/game-projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: game.game_id,
          model_version: DEFAULT_MODEL_VERSION,
          user_notes: aiContext,
        }),
      });
      const json: AiGameProjectionsResponse | { error?: string } = await res.json();
      if (!res.ok) {
        throw new Error((json as any).error || "Failed to generate AI output.");
      }
      setAiResult(json as AiGameProjectionsResponse);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate AI output.";
      setAiError(message);
    } finally {
      setAiLoading(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <header className="border-b border-slate-800 bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Game Summary
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

        <div className="flex">
          <button
            type="button"
            onClick={() => setShowAiPanel(true)}
            className="rounded-full border border-cyan-500/60 bg-cyan-500/10 px-4 py-2 text-[11px] font-semibold text-cyan-100 shadow-cyan-500/30 transition hover:bg-cyan-500/20"
          >
            Generate AI Powered Predictions
          </button>
        </div>

        {showAiPanel && (
          <div className="rounded-2xl border border-cyan-500/40 bg-slate-950/70 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  AI Predictions
                </p>
                <h2 className="text-lg font-semibold text-slate-50">
                  Describe game context for Game #{resolvedParams?.gameId ?? "—"}
                </h2>
                <p className="text-sm text-slate-300">
                  Add plain-english notes about injuries, roles, pace, or matchup context to guide projections.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowAiPanel(false)}
                className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-500"
                disabled={aiLoading}
              >
                Close
              </button>
            </div>
            <form className="mt-4 space-y-3" onSubmit={handleGenerateAi}>
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-300">
                Context (injuries/news/trends) <span className="text-slate-500">(optional)</span>
              </label>
              <textarea
                value={aiContext}
                onChange={(e) => setAiContext(e.target.value)}
                rows={4}
                className="mt-2 w-full rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-sm text-slate-100 focus:border-cyan-400 focus:outline-none"
                placeholder="Giannis questionable ankle; coach said minutes limit; Bucks on B2B; team playing faster lately; role changes…"
              />
              <p className="mt-1 text-[11px] text-slate-400">
                These notes will feed into the AI-generated projections.
              </p>
              {aiError && (
                <div className="rounded-xl border border-red-600/50 bg-red-900/40 px-3 py-2 text-sm text-red-100">
                  {aiError}
                </div>
              )}
              <div className="flex items-center justify-end gap-3">
                {aiLoading && (
                  <span className="text-[11px] text-cyan-200">Generating…</span>
                )}
                <button
                  type="submit"
                  disabled={aiLoading}
                  className={[
                    "rounded-full border border-cyan-500/60 px-4 py-2 text-[11px] font-semibold shadow-cyan-500/30 transition",
                    aiLoading
                      ? "bg-cyan-900/50 text-cyan-200"
                      : "bg-cyan-500/10 text-cyan-100 hover:bg-cyan-500/20",
                  ].join(" ")}
                >
                  {aiLoading ? "Generating…" : "Generate the Predictions"}
                </button>
              </div>
            </form>
          </div>
        )}

        {aiResult && (
          <div className="space-y-3 rounded-2xl border border-cyan-500/30 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  AI Projections vs Form
                </p>
                <p className="text-sm text-slate-300">
                  Model {aiResult.model_version} •{" "}
                  {new Date(aiResult.generated_at).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAiPanel(true);
                }}
                className="text-[11px] font-semibold text-cyan-200 underline-offset-2 hover:underline"
              >
                Regenerate
              </button>
            </div>

            {aiResult.assumptions?.length ? (
              <div className="flex flex-wrap gap-2">
                {aiResult.assumptions.map((a: string, idx: number) => (
                  <span
                    key={`${a}-${idx}`}
                    className="rounded-full border border-slate-700 bg-slate-800/60 px-3 py-1 text-[11px] text-slate-200"
                  >
                    {a}
                  </span>
                ))}
              </div>
            ) : null}

            <div className="overflow-x-auto rounded-xl border border-slate-800 bg-slate-900/60 p-3">
              <div className="mb-2 flex items-center justify-between">
                <p className="text-sm font-semibold text-cyan-200">
                  Compare AI line vs Last 5 and Season
                </p>
                <span className="text-[11px] text-slate-400">
                  AI blends context; L5 shows momentum; season is baseline.
                </span>
              </div>
              <p className="mb-2 text-[12px] text-slate-300">
                Click “Generate explanation” by a player to see a short rationale below their row.
              </p>
              <table className="min-w-full text-left text-[11px] text-slate-200">
                <thead>
                  <tr className="uppercase tracking-wide text-slate-400">
                    <th className="px-2 py-2" />
                    <th className="px-2 py-2 text-center bg-cyan-900/60 text-cyan-100" colSpan={5}>
                      AI Projection (today&apos;s context)
                    </th>
                    <th className="px-2 py-2 text-center bg-amber-900/50 text-amber-100 border-l border-amber-500/30" colSpan={4}>
                      Last 5 Games (momentum)
                    </th>
                    <th className="px-2 py-2 text-center bg-indigo-900/50 text-indigo-100 border-l border-indigo-500/30" colSpan={4}>
                      Season Average (baseline)
                    </th>
                  </tr>
                  <tr className="uppercase tracking-wide text-slate-400">
                    <th className="px-2 py-2">Player</th>
                    <th className="px-2 py-2 text-right bg-cyan-900/30 text-cyan-100">Min</th>
                    <th className="px-2 py-2 text-right bg-cyan-900/30 text-cyan-100">PTS</th>
                    <th className="px-2 py-2 text-right bg-cyan-900/30 text-cyan-100">REB</th>
                    <th className="px-2 py-2 text-right bg-cyan-900/30 text-cyan-100">AST</th>
                    <th className="px-2 py-2 text-right bg-cyan-900/30 text-cyan-100">PRA</th>
                    <th className="px-2 py-2 text-right border-l border-amber-500/30 bg-amber-900/25 text-amber-100">
                      PTS
                    </th>
                    <th className="px-2 py-2 text-right bg-amber-900/25 text-amber-100">REB</th>
                    <th className="px-2 py-2 text-right bg-amber-900/25 text-amber-100">AST</th>
                    <th className="px-2 py-2 text-right bg-amber-900/25 text-amber-100">PRA</th>
                    <th className="px-2 py-2 text-right border-l border-indigo-500/30 bg-indigo-900/25 text-indigo-100">
                      PTS
                    </th>
                    <th className="px-2 py-2 text-right bg-indigo-900/25 text-indigo-100">REB</th>
                    <th className="px-2 py-2 text-right bg-indigo-900/25 text-indigo-100">AST</th>
                    <th className="px-2 py-2 text-right bg-indigo-900/25 text-indigo-100">PRA</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    { label: `Home (${getTeamAbbr(game?.home_team_id) ?? "Home"})`, list: aiTeamsSplit.home },
                    { label: `Away (${getTeamAbbr(game?.away_team_id) ?? "Away"})`, list: aiTeamsSplit.away },
                    { label: "Other", list: aiTeamsSplit.others },
                  ]
                    .filter((group) => group.list.length > 0)
                    .map((group) => (
                      <React.Fragment key={group.label}>
                        <tr className="border-t border-slate-800/70 bg-slate-900/70">
                          <td className="px-2 py-2 text-[11px] font-semibold text-slate-200" colSpan={14}>
                            {group.label}
                          </td>
                        </tr>
                        {group.list
                          .slice()
                          .sort((a, b) => b.final.pra - a.final.pra)
                          .map((player) => {
                            const teamId = getTeamIdByAbbr(roster, player.team_abbr);
                            const key = buildPlayerKey(
                              numericGameId,
                              "stats",
                              player.player_id,
                              teamId ?? player.team_abbr
                            );
                            const summary = playerSummaries[key];
                            const format = (value: number | null | undefined) =>
                              value === null || value === undefined
                                ? "—"
                                : Number(value).toFixed(1);
                            return (
                              <tr
                                key={`form-${player.player_id}-${player.team_abbr}`}
                                className="border-t border-slate-800/70 hover:bg-slate-800/40"
                              >
                                <td className="px-2 py-2 font-semibold text-slate-100">
                                  <div className="flex items-center gap-2">
                                    <span>{getPlayerNameFromRoster(roster, player.player_id)}</span>
                                    <ExplanationCell
                                      gameId={game?.game_id ?? numericGameId}
                                      playerId={player.player_id}
                                      playerName={getPlayerNameFromRoster(roster, player.player_id)}
                                      modelVersion={aiResult.model_version}
                                      finalStats={player.final}
                                      userNotes={aiContext}
                                      injuries={priorDnpInjuries}
                                    />
                                  </div>
                                </td>
                                <td className="px-2 py-2 text-right bg-cyan-900/20">
                                  {player.final.minutes.toFixed(1)}
                                </td>
                                <td className="px-2 py-2 text-right bg-cyan-900/20">
                                  {player.final.pts.toFixed(1)}
                                </td>
                                <td className="px-2 py-2 text-right bg-cyan-900/20">
                                  {player.final.reb.toFixed(1)}
                                </td>
                                <td className="px-2 py-2 text-right bg-cyan-900/20">
                                  {player.final.ast.toFixed(1)}
                                </td>
                                <td className="px-2 py-2 text-right bg-cyan-900/20">
                                  {player.final.pra.toFixed(1)}
                                </td>
                                <td className="px-2 py-2 text-right border-l border-amber-500/30 bg-amber-900/15">
                                  {format(summary?.pts)}
                                </td>
                                <td className="px-2 py-2 text-right bg-amber-900/15">
                                  {format(summary?.reb)}
                                </td>
                                <td className="px-2 py-2 text-right bg-amber-900/15">
                                  {format(summary?.ast)}
                                </td>
                                <td className="px-2 py-2 text-right bg-amber-900/15">
                                  {format(summary?.pra)}
                                </td>
                                <td className="px-2 py-2 text-right border-l border-indigo-500/30 bg-indigo-900/15">
                                  {format(summary?.seasonPts)}
                                </td>
                                <td className="px-2 py-2 text-right bg-indigo-900/15">
                                  {format(summary?.seasonReb)}
                                </td>
                                <td className="px-2 py-2 text-right bg-indigo-900/15">
                                  {format(summary?.seasonAst)}
                                </td>
                                <td className="px-2 py-2 text-right bg-indigo-900/15">
                                  {format(summary?.seasonPra)}
                                </td>
                              </tr>
                            );
                          })}
                      </React.Fragment>
                    ))}
                </tbody>
              </table>
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
                injuries={priorDnpInjuries}
              />
            </div>
          )}
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-amber-300">
                Potential Injuries
              </p>
              <p className="text-sm text-slate-300">
                Players marked inactive or who missed the last game.
              </p>
            </div>
          </div>
          <div className="mt-3 space-y-2">
            {loadingInjuries && (
              <p className="text-xs text-amber-200">Checking prior games…</p>
            )}
            {notableInjuries.length === 0 && (
              <p className="text-xs text-slate-400">
                No inactive players reported for this matchup.
              </p>
            )}
            {notableInjuries.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {([injuriesByTeam.homeAbbr, injuriesByTeam.awayAbbr] as string[]).map(
                  (abbr) => (
                    <div
                      key={`injuries-${abbr}`}
                      className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-3"
                    >
                      <div className="mb-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-amber-200">
                        <span className="font-semibold">
                          {abbr === injuriesByTeam.homeAbbr
                            ? `Home (${abbr})`
                            : `Away (${abbr})`}
                        </span>
                        <span className="rounded-full border border-amber-400/40 bg-amber-500/10 px-2 py-0.5 text-[10px] text-amber-200">
                          {injuriesByTeam.buckets[abbr]?.length ?? 0} player
                          {injuriesByTeam.buckets[abbr]?.length === 1 ? "" : "s"}
                        </span>
                      </div>
                      <div className="space-y-2">
                        {(injuriesByTeam.buckets[abbr] ?? []).length === 0 && (
                          <p className="text-[11px] text-slate-400">
                            None reported.
                          </p>
                        )}
                        {(injuriesByTeam.buckets[abbr] ?? []).map((player, idx) => (
                          <div
                            key={`${abbr}-${player.player_name}-${idx}`}
                            className="flex items-center justify-between rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-100"
                          >
                            <div className="flex flex-col">
                              <span className="font-semibold text-amber-100">
                                {player.player_name}
                              </span>
                              {player.note && (
                                <span className="text-[11px] text-amber-200/90">
                                  {player.note}
                                </span>
                              )}
                            </div>
                            <span className="rounded-full border border-amber-400/60 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-amber-200">
                              {player.team_abbr ?? abbr ?? "UNK"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )
                )}
              </div>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
