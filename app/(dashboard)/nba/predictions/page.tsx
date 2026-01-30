'use client';

import Link from "next/link";
import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DEFAULT_MODEL_VERSION, STAT_TYPES } from "@/lib/predictions";
import {
  DateBucket,
  PlayerRow,
  StatCell,
  useUpcomingPredictions,
} from "./useUpcomingPredictions";

function formatDateLabel(dateStr: string) {
  const dt = new Date(dateStr + "T12:00:00Z");
  if (Number.isNaN(dt.getTime())) return dateStr;
  return dt.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

function StatBadge({ cell }: { cell: StatCell }) {
  const value =
    cell.mean !== null && cell.std !== null
      ? `${cell.mean.toFixed(1)} ± ${cell.std.toFixed(1)}`
      : "—";

  const badgeClass =
    cell.source === "ml"
      ? "border border-emerald-400/50 bg-emerald-500/10 text-emerald-200"
      : cell.source === "baseline"
        ? "border border-amber-400/50 bg-amber-500/10 text-amber-200"
        : "border border-slate-700 bg-slate-900/70 text-slate-300";

  const hasLineMeta =
    cell.line !== undefined &&
    cell.line !== null &&
    (cell.modelProbOver !== null && cell.modelProbOver !== undefined);

  return (
    <div className="flex flex-col gap-1">
      <div
        className={`inline-flex items-center justify-between gap-2 rounded-lg px-2 py-1 text-xs font-semibold ${badgeClass}`}
      >
        <span>{value}</span>
        <span className="rounded-full bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-wide">
          {cell.statType} {cell.source === "ml" ? "ML" : cell.source === "baseline" ? "BL" : "—"}
        </span>
      </div>
      {hasLineMeta && (
        <div className="text-[11px] text-slate-300">
          {cell.modelProbOver !== null && cell.modelProbOver !== undefined ? (
            <>
              Over% {(cell.modelProbOver * 100).toFixed(0)}%
              {cell.delta !== null && cell.delta !== undefined
                ? ` · Δ ${(cell.delta * 100).toFixed(0)}%`
                : ""}
            </>
          ) : (
            "—"
          )}
        </div>
      )}
    </div>
  );
}

function PlayerRowItem({ player }: { player: PlayerRow }) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-800 bg-slate-950/60 p-3 text-sm md:grid-cols-5">
      <div className="md:col-span-1">
        <div className="font-semibold text-slate-100">
          Player #{player.playerId}
        </div>
        <div className="text-[11px] uppercase tracking-wide text-slate-400">
          {player.teamAbbr ?? "TEAM"}{" "}
          {player.isHome ? "vs" : "@ "}{" "}
          {player.opponentAbbr ?? player.opponentTeamId ?? "OPP"}
        </div>
      </div>
      <div className="md:col-span-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {STAT_TYPES.map((stat) => {
          const cell = player.stats.find((s) => s.statType === stat);
          return (
            <div key={stat} className="text-xs text-slate-100">
              <p className="text-[11px] uppercase tracking-wide text-slate-400">
                {stat}
              </p>
              {cell ? <StatBadge cell={cell} /> : "—"}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GameCard({
  game,
  expanded,
  onToggle,
}: {
  game: DateBucket["games"][number];
  expanded: boolean;
  onToggle: () => void;
}) {
  const matchup =
    game.homeTeam && game.awayTeam
      ? `${game.awayTeam} @ ${game.homeTeam}`
      : `Game #${game.gameId}`;

  return (
    <div className="rounded-2xl border border-slate-800 bg-slate-950/70">
      <button
        type="button"
        className="flex w-full items-center justify-between px-4 py-3 text-left"
        onClick={onToggle}
      >
        <div>
          <p className="text-sm font-semibold text-slate-100">{matchup}</p>
          <p className="text-xs text-slate-400">Game ID: {game.gameId}</p>
        </div>
        <span className="text-xs text-cyan-200">
          {expanded ? "Hide players" : "Show players"}
        </span>
      </button>
      {expanded && (
        <div className="space-y-3 border-t border-slate-800 px-4 py-4">
          {game.players.map((p) => (
            <PlayerRowItem key={p.playerId} player={p} />
          ))}
        </div>
      )}
    </div>
  );
}

function DateSection({
  bucket,
  expandedGames,
  toggleGame,
}: {
  bucket: DateBucket;
  expandedGames: Record<number, boolean>;
  toggleGame: (gameId: number) => void;
}) {
  return (
    <section className="space-y-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold text-slate-50">
          {formatDateLabel(bucket.gameDate)}
        </h3>
        <span className="text-xs text-slate-400">
          {bucket.games.length} game{bucket.games.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="space-y-3">
        {bucket.games.map((game) => (
          <GameCard
            key={game.gameId}
            game={game}
            expanded={!!expandedGames[game.gameId]}
            onToggle={() => toggleGame(game.gameId)}
          />
        ))}
      </div>
    </section>
  );
}

function UpcomingPredictionsContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const modelParam = searchParams.get("modelVersion") ?? DEFAULT_MODEL_VERSION;
  const [modelVersion, setModelVersion] = useState(modelParam);
  const { data, loading, error, startDate, endDate, modelVersion: resolvedModel } =
    useUpcomingPredictions({ modelVersion });

  const [expandedGames, setExpandedGames] = useState<Record<number, boolean>>(
    {}
  );

  const modelOptions = useMemo(() => {
    const set = new Set<string>([DEFAULT_MODEL_VERSION, modelParam, modelVersion, resolvedModel].filter(Boolean) as string[]);
    return Array.from(set);
  }, [modelParam, modelVersion, resolvedModel]);

  const dateRangeLabel =
    startDate && endDate ? `${startDate} → ${endDate}` : "Next 7 days";

  function handleModelChange(next: string) {
    setModelVersion(next);
    const params = new URLSearchParams(searchParams);
    params.set("modelVersion", next);
    router.replace(`${pathname}?${params.toString()}`);
  }

  function toggleGame(gameId: number) {
    setExpandedGames((prev) => ({ ...prev, [gameId]: !prev[gameId] }));
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-black via-slate-900 to-slate-950 text-slate-50">
      <main className="mx-auto max-w-6xl px-4 py-8 space-y-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Predictions
            </p>
            <h1 className="text-3xl font-bold text-slate-50">
              Next 7 Days Slate
            </h1>
            <p className="text-sm text-slate-300">{dateRangeLabel}</p>
          </div>
          <Link
            href="/nba-games"
            className="inline-flex items-center gap-2 rounded-full border border-cyan-500/40 bg-slate-900/60 px-3 py-1 text-xs font-semibold text-cyan-200 hover:border-cyan-400 hover:bg-slate-900"
          >
            ← Back to NBA Games
          </Link>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-800 bg-slate-950/70 p-4">
          <div>
            <p className="text-xs uppercase tracking-wide text-cyan-300">
              Model version
            </p>
            <p className="text-sm text-slate-300">
              {resolvedModel || modelVersion}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label
              htmlFor="modelVersion"
              className="text-xs uppercase tracking-wide text-slate-400"
            >
              Select model
            </label>
            <select
              id="modelVersion"
              value={modelVersion}
              onChange={(e) => handleModelChange(e.target.value)}
              className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 shadow-inner focus:border-cyan-400 focus:outline-none"
            >
              {modelOptions.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>
        </div>

        {loading && (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 text-sm text-slate-300">
            Loading upcoming predictions…
          </div>
        )}

        {!loading && error && (
          <div className="rounded-2xl border border-red-500/40 bg-red-500/10 p-4 text-sm text-red-200">
            {error}
          </div>
        )}

        {!loading && !error && data.length === 0 && (
          <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-6 text-sm text-slate-300">
            No upcoming games with predictions in this window.
          </div>
        )}

        {!loading && !error && data.length > 0 && (
          <div className="space-y-4">
            {data.map((bucket) => (
              <DateSection
                key={bucket.gameDate}
                bucket={bucket}
                expandedGames={expandedGames}
                toggleGame={toggleGame}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

export default function UpcomingPredictionsPage() {
  return (
    <Suspense
      fallback={
        <div className="p-4 text-sm text-slate-300">Loading predictions...</div>
      }
    >
      <UpcomingPredictionsContent />
    </Suspense>
  );
}
