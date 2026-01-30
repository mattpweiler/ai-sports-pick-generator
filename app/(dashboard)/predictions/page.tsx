'use client';

import Link from "next/link";
import { Suspense, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  DEFAULT_MODEL_VERSION,
  PlayerFeatureContext,
  RecentForm,
  STAT_TYPES,
  StatPred,
} from "@/lib/predictions";
import { usePlayerPredictions } from "./usePlayerPredictions";

const STAT_LABELS: Record<(typeof STAT_TYPES)[number], string> = {
  PTS: "Points",
  REB: "Rebounds",
  AST: "Assists",
  PRA: "Points + Rebounds + Assists",
};

function formatProjection(pred: StatPred) {
  if (pred.source === "none" || pred.mean === null || pred.std === null) {
    return "No prediction yet";
  }
  return `${pred.mean.toFixed(1)} ± ${pred.std.toFixed(1)}`;
}

function formatNumber(value: number | null) {
  if (value === null) return "—";
  return value.toFixed(1);
}

function formatBoolean(value: boolean | null) {
  if (value === null) return "—";
  return value ? "Yes" : "No";
}

function ContextTable({
  context,
  recentForm,
}: {
  context: PlayerFeatureContext | null;
  recentForm: RecentForm | null;
}) {
  if (!context) {
    return (
      <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4 text-sm text-slate-300">
        No context features available for this matchup.
      </div>
    );
  }

  const seasonGamesText =
    recentForm?.games_in_season !== null && recentForm?.games_in_season !== undefined
      ? recentForm.games_in_season
      : null;

  const recentRows = [
    {
      stat: "PTS",
      l5: recentForm?.pts_l5 ?? null,
      l10: recentForm?.pts_l10 ?? null,
      season: recentForm?.pts_season ?? null,
    },
    {
      stat: "REB",
      l5: recentForm?.reb_l5 ?? null,
      l10: recentForm?.reb_l10 ?? null,
      season: recentForm?.reb_season ?? null,
    },
    {
      stat: "AST",
      l5: recentForm?.ast_l5 ?? null,
      l10: recentForm?.ast_l10 ?? null,
      season: recentForm?.ast_season ?? null,
    },
    {
      stat: "PRA",
      l5: recentForm?.pra_l5 ?? null,
      l10: recentForm?.pra_l10 ?? null,
      season: recentForm?.pra_season ?? null,
    },
  ];

  const minutesRow = {
    l5: recentForm?.min_l5 ?? null,
    l10: recentForm?.min_l10 ?? null,
    season: recentForm?.min_season ?? null,
  };

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <div className="flex items-center justify-between">
          <p className="text-xs uppercase tracking-wide text-cyan-300">
            Recent Form
          </p>
          {context.game_date && (
            <p className="text-xs text-slate-400">
              Game date: {context.game_date}
            </p>
          )}
        </div>
        {seasonGamesText && (
          <p className="text-[11px] text-slate-400 mt-1">
            Season averages based on {seasonGamesText} games (as of {context.game_date ?? "game date"}).
          </p>
        )}
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-200">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400">
                <th className="px-2 py-2">Stat</th>
                <th className="px-2 py-2">L5</th>
                <th className="px-2 py-2">L10</th>
                <th className="px-2 py-2">Season</th>
              </tr>
            </thead>
            <tbody>
              {recentRows.map((row) => (
                <tr
                  key={row.stat}
                  className="border-t border-slate-800/80 hover:bg-slate-800/40"
                >
                  <td className="px-2 py-2 font-semibold text-slate-100">
                    {row.stat}
                  </td>
                  <td className="px-2 py-2">{formatNumber(row.l5)}</td>
                  <td className="px-2 py-2">{formatNumber(row.l10)}</td>
                  <td className="px-2 py-2">{formatNumber(row.season)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rounded-2xl border border-slate-800 bg-slate-900/40 p-4">
        <p className="text-xs uppercase tracking-wide text-cyan-300">
          Minutes
        </p>
        <div className="mt-3 overflow-x-auto">
          <table className="min-w-full text-left text-sm text-slate-200">
            <thead>
              <tr className="text-xs uppercase tracking-wide text-slate-400">
                <th className="px-2 py-2">Sample</th>
                <th className="px-2 py-2">Minutes</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-slate-800/80 hover:bg-slate-800/40">
                <td className="px-2 py-2 font-semibold text-slate-100">L5</td>
                <td className="px-2 py-2">{formatNumber(minutesRow.l5)}</td>
              </tr>
              <tr className="border-t border-slate-800/80 hover:bg-slate-800/40">
                <td className="px-2 py-2 font-semibold text-slate-100">L10</td>
                <td className="px-2 py-2">{formatNumber(minutesRow.l10)}</td>
              </tr>
              <tr className="border-t border-slate-800/80 hover:bg-slate-800/40">
                <td className="px-2 py-2 font-semibold text-slate-100">
                  Season
                </td>
                <td className="px-2 py-2">{formatNumber(minutesRow.season)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-cyan-300">
            Schedule
          </p>
          <div className="mt-2 space-y-1 text-sm text-slate-200">
            <p>Days rest: {formatNumber(context.days_rest)}</p>
            <p>
              Back-to-back: {formatBoolean(context.is_back_to_back)}
            </p>
          </div>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-cyan-300">
            Home / Away
          </p>
          <p className="mt-2 text-sm text-slate-200">
            {context.is_home === null
              ? "—"
              : context.is_home
                ? "Home"
                : "Away"}
          </p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
          <p className="text-xs uppercase tracking-wide text-cyan-300">
            Opponent
          </p>
          <p className="mt-2 text-sm text-slate-200">
            {context.opponent_team_id ?? "—"}
          </p>
        </div>
      </div>
    </div>
  );
}

function PredictionRowsSkeleton() {
  return (
    <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
      {[0, 1, 2, 3].map((key) => (
        <div key={key} className="flex items-center justify-between px-4 py-3">
          <div className="h-4 w-20 animate-pulse rounded bg-slate-800" />
          <div className="h-4 w-32 animate-pulse rounded bg-slate-800" />
          <div className="h-6 w-14 animate-pulse rounded-full bg-slate-800" />
        </div>
      ))}
    </div>
  );
}

function PredictionsPageContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const playerIdParam = searchParams.get("playerId");
  const gameIdParam = searchParams.get("gameId");
  const season = searchParams.get("season");
  const modelVersionParam = searchParams.get("modelVersion") ?? undefined;

  const parsedPlayerId = useMemo(
    () => (playerIdParam ? Number(playerIdParam) : null),
    [playerIdParam]
  );
  const parsedGameId = useMemo(
    () => (gameIdParam ? Number(gameIdParam) : null),
    [gameIdParam]
  );

  const initialModelVersion = modelVersionParam ?? DEFAULT_MODEL_VERSION;
  const [selectedModelVersion, setSelectedModelVersion] = useState(
    initialModelVersion
  );

  const {
    predictions,
    source,
    modelVersion,
    features,
    recentForm,
    loading,
    error,
  } = usePlayerPredictions({
    playerId: parsedPlayerId,
    gameId: parsedGameId,
    modelVersion: selectedModelVersion,
  });
  const modelVersionFromData = modelVersion ?? null;

  useEffect(() => {
    if (
      modelVersionFromData &&
      modelVersionFromData !== selectedModelVersion
    ) {
      setSelectedModelVersion(modelVersionFromData);
    }
  }, [modelVersionFromData, selectedModelVersion]);

  const modelVersionOptions = useMemo(() => {
    const options = new Set<string>([DEFAULT_MODEL_VERSION]);
    if (initialModelVersion) options.add(initialModelVersion);
    if (modelVersion) options.add(modelVersion);
    if (selectedModelVersion) options.add(selectedModelVersion);
    return Array.from(options);
  }, [initialModelVersion, modelVersion, selectedModelVersion]);

  function handleModelVersionChange(nextValue: string) {
    setSelectedModelVersion(nextValue);
    const params = new URLSearchParams(searchParams);
    params.set("modelVersion", nextValue);
    router.replace(`${pathname}?${params.toString()}`);
  }

  const sourceLabel =
    source === "ml"
      ? "ML"
      : source === "baseline"
        ? "Baseline"
        : source === "none"
          ? "None"
          : null;
  const headerSubtitle =
    parsedPlayerId && parsedGameId
      ? `Player #${parsedPlayerId} · Game #${parsedGameId}${
          season ? ` · Season ${season}` : ""
        }`
      : "Missing player/game context";

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <main className="mx-auto max-w-5xl px-4 py-8 space-y-6">
        <Link
          href="/nba-games"
          className="inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-slate-900/60 px-3 py-1 text-xs font-semibold text-cyan-200 hover:border-cyan-400 hover:bg-slate-900"
        >
          ← Back to NBA Games
        </Link>

        <section className="rounded-2xl border border-cyan-500/30 bg-slate-950/70 p-6 shadow-2xl shadow-black/40">
          <p className="text-xs uppercase tracking-wide text-cyan-300 mb-2">
            Predictions
          </p>
          <h1 className="text-3xl font-bold text-slate-50">
            NBA Player Projections
          </h1>
          <p className="mt-1 text-sm text-cyan-200">{headerSubtitle}</p>
          <p className="mt-3 text-sm text-slate-300">
            Model projections with fallback to baseline projections when ML
            output is unavailable. Values are shown as mean ± std for the core
            stat lines.
          </p>
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wide text-cyan-300">
                Projected lines
              </p>
              <p className="text-sm text-slate-300">
                Model version: {modelVersion ?? DEFAULT_MODEL_VERSION}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <label
                htmlFor="model-version"
                className="text-xs uppercase tracking-wide text-slate-400"
              >
                Model
              </label>
              <select
                id="model-version"
                value={selectedModelVersion}
                onChange={(e) => handleModelVersionChange(e.target.value)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-inner focus:border-cyan-400 focus:outline-none"
              >
                {modelVersionOptions.map((opt) => (
                  <option key={opt} value={opt}>
                    {opt}
                  </option>
                ))}
              </select>
            </div>
            {sourceLabel && (
              <span
                className={`rounded-full px-3 py-1 text-xs font-semibold ${
                  source === "ml"
                    ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : source === "baseline"
                      ? "border border-amber-500/40 bg-amber-500/10 text-amber-200"
                      : "border border-slate-700 bg-slate-800 text-slate-200"
                }`}
              >
                {sourceLabel}
              </span>
            )}
          </div>

          {loading && <PredictionRowsSkeleton />}

          {!loading && error && (
            <div className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-200">
              {error}
            </div>
          )}

          {!loading && !error && predictions.every((p) => p.source === "none") && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 px-4 py-5 text-sm text-slate-300">
              No predictions available yet for this player/game.
            </div>
          )}

          {!loading && !error && (
            <div className="divide-y divide-slate-800 rounded-xl border border-slate-800 bg-slate-900/40">
              {predictions.map((pred) => (
                <div
                  key={pred.statType}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-100">
                      {STAT_LABELS[pred.statType]}
                    </p>
                    <p className="text-xs uppercase tracking-wide text-slate-400">
                      {pred.statType}
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <p className="text-lg font-semibold text-cyan-100">
                      {formatProjection(pred)}
                    </p>
                    <span
                      className={`rounded-full px-3 py-1 text-[11px] font-semibold ${
                        pred.source === "ml"
                          ? "border border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                          : pred.source === "baseline"
                            ? "border border-amber-500/40 bg-amber-500/10 text-amber-200"
                            : "border border-slate-700 bg-slate-800 text-slate-200"
                      }`}
                    >
                      {pred.source === "ml"
                        ? "ML"
                        : pred.source === "baseline"
                          ? "Baseline"
                          : "None"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wide text-cyan-300">
                Context
              </p>
              <p className="text-sm text-slate-300">
                Recent averages, minutes, and schedule flags from the feature
                set.
              </p>
            </div>
          </div>
          {loading && (
            <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-4">
              <div className="h-4 w-40 animate-pulse rounded bg-slate-800" />
              <div className="mt-2 h-4 w-full animate-pulse rounded bg-slate-800" />
              <div className="mt-2 h-4 w-5/6 animate-pulse rounded bg-slate-800" />
            </div>
          )}
          {!loading && <ContextTable context={features} recentForm={recentForm} />}
        </section>
      </main>
    </div>
  );
}

export default function PredictionsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-slate-300">Loading predictions...</div>
      }
    >
      <PredictionsPageContent />
    </Suspense>
  );
}
