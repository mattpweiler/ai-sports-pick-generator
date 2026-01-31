"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, FormEvent } from "react";
import { AiGameProjectionsResponse } from "@/lib/aiPredictions";
import { DEFAULT_MODEL_VERSION } from "@/lib/predictions";
import { ExplanationCell } from "../../components/ExplanationCell";

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
  pts: number | null;
  reb: number | null;
  ast: number | null;
};

type PlayersApiResponse = {
  mode?: "stats" | "roster";
  players?: Player[];
  roster?: TeamRoster[];
  error?: string;
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

function formatGameDate(game: Game) {
  if (!game.game_date) return "TBD";
  const raw = game.game_date.trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  if (!isoLike) return raw;
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

function isFutureGame(game: Game) {
  const statusId = game.game_status_id;
  const statusText = (game.game_status_text ?? "").toLowerCase();
  if (statusId === 2 || statusText.includes("live")) return false;
  if (statusId === 3 || statusText.includes("final")) return false;
  const gameDayKey = game.game_date?.trim() ?? null;
  if (!gameDayKey || !/^\d{4}-\d{2}-\d{2}$/.test(gameDayKey)) return false;
  const todayKey = new Date().toISOString().split("T")[0];
  if (gameDayKey < todayKey) return false;
  return true;
}

function isWithinAiWindow(game: Game) {
  const gameDayKey = game.game_date?.trim() ?? null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  let gameDate: Date | null = null;
  if (gameDayKey && /^\d{4}-\d{2}-\d{2}$/.test(gameDayKey)) {
    gameDate = new Date(`${gameDayKey}T12:00:00Z`);
  } else {
    gameDate = getGameDate(game);
  }
  if (!gameDate || Number.isNaN(gameDate.getTime())) return false;
  const diffDays =
    (gameDate.setHours(0, 0, 0, 0) - today.getTime()) /
    (1000 * 60 * 60 * 24);
  return diffDays >= 0 && diffDays <= 3;
}

type PageProps = {
  params: { gameId: string };
};

export default function GamePage({ params }: PageProps) {
  const numericGameId = useMemo(() => Number(params.gameId), [params.gameId]);
  const [game, setGame] = useState<Game | null>(null);
  const [loadingGame, setLoadingGame] = useState(true);
  const [gameError, setGameError] = useState<string | null>(null);

  const [playerData, setPlayerData] = useState<PlayersApiResponse | null>(null);
  const [loadingPlayers, setLoadingPlayers] = useState(false);

  const [aiModalOpen, setAiModalOpen] = useState(false);
  const [aiContext, setAiContext] = useState("");
  const [aiUseMlBaseline, setAiUseMlBaseline] = useState(true);
  const [aiModelVersion, setAiModelVersion] =
    useState<string>(DEFAULT_MODEL_VERSION);
  const [aiModelVersions, setAiModelVersions] = useState<string[]>([]);
  const [aiResult, setAiResult] = useState<AiGameProjectionsResponse | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function loadGame() {
      setLoadingGame(true);
      setGameError(null);
      try {
        const res = await fetch("/api/nba-games");
        const json: GamesApiResponse = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load games.");
        const match = (json.games || []).find(
          (g) => g.game_id === numericGameId
        );
        if (!match) throw new Error("Game not found.");
        if (!cancelled) setGame(match);
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
        }
      } catch {
        if (!cancelled) {
          setAiModelVersions([DEFAULT_MODEL_VERSION]);
          setAiModelVersion(DEFAULT_MODEL_VERSION);
        }
      }
    }

    loadGame();
    loadModelVersions();
    return () => {
      cancelled = true;
    };
  }, [numericGameId]);

  useEffect(() => {
    let cancelled = false;
    async function loadPlayers() {
      if (!game) return;
      setLoadingPlayers(true);
      try {
        const future = isFutureGame(game);
        const res = await fetch(
          `/api/nba-games/${game.game_id}/players${future ? "?mode=roster" : ""}`
        );
        const json: PlayersApiResponse = await res.json();
        if (!res.ok) throw new Error(json.error || "Failed to load players.");
        if (!cancelled) setPlayerData(json);
      } catch (err) {
        if (!cancelled) {
          setPlayerData({
            error:
              err instanceof Error
                ? err.message
                : "Failed to load players.",
          });
        }
      } finally {
        if (!cancelled) setLoadingPlayers(false);
      }
    }
    loadPlayers();
    return () => {
      cancelled = true;
    };
  }, [game]);

  function getPlayerName(playerId: number) {
    if (playerData?.mode === "stats") {
      const found = playerData.players?.find((p) => p.player_id === playerId);
      if (found?.player_name) return found.player_name;
    }
    if (playerData?.mode === "roster") {
      for (const team of playerData.roster || []) {
        const found = team.players.find((p) => p.player_id === playerId);
        if (found?.player_name) return found.player_name;
      }
    }
    return `Player ${playerId}`;
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

  async function handleSubmitAi(evt: FormEvent<HTMLFormElement>) {
    evt.preventDefault();
    if (!game) return;
    setAiLoading(true);
    setAiError(null);
    try {
      const res = await fetch("/api/ai/game-projections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: game.game_id,
          model_version: aiModelVersion,
          user_notes: aiContext,
        }),
      });
      const json: AiGameProjectionsResponse | { error?: string } = await res.json();
      if (!res.ok) {
        throw new Error((json as any).error || "Failed to generate AI output.");
      }
      setAiResult(json as AiGameProjectionsResponse);
      setAiModalOpen(false);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to generate AI output.";
      setAiError(message);
    } finally {
      setAiLoading(false);
    }
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

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <header className="border-b border-slate-800 bg-slate-950/80">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              NBA Game
            </p>
            <h1 className="text-xl font-bold text-slate-50">
              Game #{params.gameId}
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
              {isWithinAiWindow(game) && (
                <div className="flex gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      setAiError(null);
                      setAiModalOpen(true);
                    }}
                    className="rounded-full border border-cyan-500/60 bg-cyan-500/10 px-4 py-2 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/20 transition"
                  >
                    Generate AI Predictions
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        {game && isWithinAiWindow(game) && aiResult && (
          <div className="rounded-2xl border border-cyan-500/30 bg-slate-950/60 p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  AI Predictions
                </p>
                <p className="text-sm text-slate-300">
                  Model {aiResult.model_version} •{" "}
                  {new Date(aiResult.generated_at).toLocaleString()}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setAiModalOpen(true)}
                className="text-[11px] font-semibold text-cyan-200 underline-offset-2 hover:underline"
              >
                Regenerate
              </button>
            </div>
            {aiResult.assumptions?.length ? (
              <div className="mt-3 flex flex-wrap gap-2">
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

            <div className="mt-4 space-y-4">
              {Object.entries(aiGrouped).map(([team, players]) => (
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
                                {getPlayerName(player.player_id)}
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
                                  gameId={game?.game_id ?? 0}
                                  playerId={player.player_id}
                                  playerName={getPlayerName(player.player_id)}
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
          </div>
        )}

        <div className="rounded-2xl border border-slate-800 bg-slate-950/60 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-cyan-300">
                Players
              </p>
              <p className="text-sm text-slate-300">
                {playerData?.mode === "roster"
                  ? "Projected roster"
                  : "Recent box scores"}
              </p>
            </div>
          </div>

          {loadingPlayers && (
            <p className="mt-2 text-xs text-cyan-200">Loading players…</p>
          )}
          {playerData?.error && (
            <p className="mt-2 text-xs text-red-200">{playerData.error}</p>
          )}

          {playerData?.mode === "stats" && (playerData.players?.length ?? 0) > 0 && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {playerData.players?.map((p) => (
                <div
                  key={p.player_id}
                  className="rounded-xl border border-cyan-500/30 bg-cyan-500/5 p-3"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-sm font-semibold text-cyan-200">
                        {p.player_name ?? `Player ${p.player_id}`}
                      </p>
                      <p className="text-[11px] uppercase tracking-wide text-slate-400">
                        {p.team_abbr ?? "UNK"} · {p.start_pos || "Bench"}
                      </p>
                    </div>
                    <span className="rounded-full bg-slate-900 px-3 py-1 text-[11px] text-slate-200">
                      {p.min ?? "0"} MIN
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-slate-300">
                    PTS {p.pts ?? 0} · REB {p.reb ?? 0} · AST {p.ast ?? 0}
                  </p>
                </div>
              ))}
            </div>
          )}

          {playerData?.mode === "roster" && (
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
              {(playerData.roster ?? []).map((team) => (
                <div
                  key={`${team.team_id}-${team.side}`}
                  className="rounded-xl border border-slate-800 bg-slate-900/60 p-3"
                >
                  <div className="mb-2 flex items-center justify-between">
                    <p className="text-sm font-semibold text-slate-100">
                      {team.team_name ?? team.team_abbr ?? "Team"}
                    </p>
                    <span className="text-[11px] uppercase tracking-wide text-slate-400">
                      {team.side}
                    </span>
                  </div>
                  <div className="space-y-2">
                    {team.players.map((p) => (
                      <div
                        key={p.player_id}
                        className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-xs text-slate-200"
                      >
                        <p className="font-semibold text-slate-100">
                          {p.player_name ?? `Player ${p.player_id}`}
                        </p>
                        <p className="text-[11px] uppercase tracking-wide text-slate-400">
                          {p.position ?? "TBD"}
                        </p>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {game && isWithinAiWindow(game) && aiModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4 py-6">
          <div className="w-full max-w-2xl rounded-2xl border border-cyan-500/40 bg-slate-950 p-6 shadow-2xl shadow-cyan-500/20">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-cyan-300">
                  AI Predictions
                </p>
                <h2 className="text-lg font-semibold text-slate-50">
                  Generate projections for Game #{numericGameId}
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setAiModalOpen(false)}
                className="rounded-full border border-slate-700 bg-slate-800/70 px-3 py-1 text-xs font-semibold text-slate-200 hover:border-slate-500"
                disabled={aiLoading}
              >
                Close
              </button>
            </div>

            <form className="mt-4 space-y-4" onSubmit={handleSubmitAi}>
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
                  onClick={() => setAiModalOpen(false)}
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
    </div>
  );
}
