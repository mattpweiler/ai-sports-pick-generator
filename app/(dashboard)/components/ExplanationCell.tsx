"use client";

import { useState } from "react";

type Props = {
  gameId: number;
  playerId: number;
  playerName?: string;
  modelVersion: string;
  finalStats: {
    minutes: number;
    pts: number;
    reb: number;
    ast: number;
    pra: number;
  };
  userNotes: string;
  injuries?: { player_id: number | null; player_name: string | null; team_abbr: string | null; reason?: string | null }[];
};

export function ExplanationCell({
  gameId,
  playerId,
  playerName,
  modelVersion,
  finalStats,
  userNotes,
  injuries,
}: Props) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);

  async function handleGenerate() {
    if (loading) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai/player-explanation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          game_id: gameId,
          player_id: playerId,
          model_version: modelVersion,
          user_notes: userNotes,
          final_stats: finalStats,
          injuries,
        }),
      });
      const json: { explanation?: string[]; error?: string } = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to generate explanation");
      }
      setLines(json.explanation ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate explanation");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return <span className="text-[11px] text-cyan-200">Generating…</span>;
  }

  if (lines && lines.length) {
    return (
      <ul className="list-disc space-y-1 pl-4 text-[11px] text-slate-300">
        {lines.map((line, idx) => (
          <li key={`${playerId}-exp-${idx}`}>{line}</li>
        ))}
      </ul>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      {error && <span className="text-[11px] text-red-300">{error}</span>}
      <button
        type="button"
        onClick={handleGenerate}
        className="rounded-full border border-cyan-500/50 bg-cyan-500/10 px-3 py-1 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/20 transition"
      >
        Generate explanation
      </button>
      <span className="text-[10px] text-slate-500">
        Uses L5/L10/season, ML means, schedule, notes, and injury minutes{playerName ? ` for ${playerName}` : ""}.
      </span>
    </div>
  );
}
