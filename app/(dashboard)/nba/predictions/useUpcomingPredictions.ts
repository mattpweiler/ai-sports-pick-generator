'use client';

import { useEffect, useState } from "react";
import { DEFAULT_MODEL_VERSION, StatType } from "@/lib/predictions";

export type StatCell = {
  statType: StatType;
  mean: number | null;
  std: number | null;
  source: "ml" | "baseline" | "none";
  line?: number | null;
  modelProbOver?: number | null;
  marketProbOver?: number | null;
  delta?: number | null;
};

export type PlayerRow = {
  playerId: number;
  teamAbbr: string | null;
  opponentAbbr: string | null;
  opponentTeamId: number | null;
  isHome: boolean | null;
  stats: StatCell[];
};

export type GameRow = {
  gameId: number;
  gameDate: string;
  homeTeam: string | null;
  awayTeam: string | null;
  players: PlayerRow[];
};

export type DateBucket = {
  gameDate: string;
  games: GameRow[];
};

type ApiResponse = {
  modelVersion: string;
  startDate: string;
  endDate: string;
  items: DateBucket[];
  error?: string;
};

type State = {
  data: DateBucket[];
  loading: boolean;
  error: string | null;
  modelVersion: string;
  startDate: string;
  endDate: string;
};

const initialState: State = {
  data: [],
  loading: false,
  error: null,
  modelVersion: DEFAULT_MODEL_VERSION,
  startDate: "",
  endDate: "",
};

function formatDateOnly(date: Date) {
  return date.toISOString().split("T")[0];
}

export function useUpcomingPredictions({
  modelVersion = DEFAULT_MODEL_VERSION,
  start,
  end,
}: {
  modelVersion?: string;
  start?: string | null;
  end?: string | null;
}): State {
  const [state, setState] = useState<State>({
    ...initialState,
    modelVersion: modelVersion ?? DEFAULT_MODEL_VERSION,
  });

  useEffect(() => {
    const today = new Date();
    const defaultStart = formatDateOnly(today);
    const defaultEnd = formatDateOnly(
      new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
    );

    const params = new URLSearchParams({
      modelVersion: modelVersion || DEFAULT_MODEL_VERSION,
      start: start || defaultStart,
      end: end || defaultEnd,
    });

    setState((prev) => ({ ...prev, loading: true, error: null }));

    fetch(`/api/nba/predictions?${params.toString()}`)
      .then(async (res) => {
        const payload: ApiResponse = await res.json();
        if (!res.ok) {
          const message = payload?.error || "Failed to load predictions.";
          throw new Error(message);
        }
        return payload;
      })
      .then((payload) => {
        setState({
          data: payload.items || [],
          loading: false,
          error: null,
          modelVersion: payload.modelVersion,
          startDate: payload.startDate,
          endDate: payload.endDate,
        });
      })
      .catch((err) => {
        console.error("Upcoming predictions fetch error:", err);
        setState((prev) => ({
          ...prev,
          loading: false,
          error: err instanceof Error ? err.message : "Failed to load predictions.",
        }));
      });
  }, [modelVersion, start, end]);

  return state;
}
