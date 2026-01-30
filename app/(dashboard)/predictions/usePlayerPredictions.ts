'use client';

import { useEffect, useState } from "react";
import {
  DEFAULT_MODEL_VERSION,
  PlayerFeatureContext,
  PredictionsResponse,
  StatPred,
  StatSource,
} from "@/lib/predictions";

type UsePlayerPredictionsArgs = {
  gameId?: number | string | null;
  playerId?: number | string | null;
  modelVersion?: string;
};

type HookState = {
  predictions: StatPred[];
  source: StatSource | null;
  modelVersion: string | null;
  features: PlayerFeatureContext | null;
  recentForm: import("@/lib/predictions").RecentForm | null;
  loading: boolean;
  error: string | null;
};

const initialState: HookState = {
  predictions: [],
  source: null,
  modelVersion: null,
  features: null,
  recentForm: null,
  loading: false,
  error: null,
};

export function usePlayerPredictions({
  gameId,
  playerId,
  modelVersion = DEFAULT_MODEL_VERSION,
}: UsePlayerPredictionsArgs): HookState {
  const [state, setState] = useState<HookState>(initialState);

  useEffect(() => {
    const numericGameIdRaw =
      typeof gameId === "string" ? Number(gameId) : gameId ?? null;
    const numericPlayerId =
      typeof playerId === "string" ? Number(playerId) : playerId ?? null;

    const numericGameId =
      numericGameIdRaw === null || Number.isNaN(numericGameIdRaw)
        ? null
        : Number(String(numericGameIdRaw).replace(/^0+/, ""));

    if (
      numericGameId === null ||
      Number.isNaN(numericGameId) ||
      numericPlayerId === null ||
      Number.isNaN(numericPlayerId)
    ) {
      setState({
        ...initialState,
        error: "Missing playerId or gameId.",
      });
      return;
    }

    let cancelled = false;
    setState((prev) => ({
      ...prev,
      loading: true,
      error: null,
    }));

    console.log("PRED PARAMS", {
      gameId,
      playerId,
      modelVersion,
      numericGameId,
      numericPlayerId,
      typeofGameId: typeof gameId,
      typeofPlayerId: typeof playerId,
    });

    const params = new URLSearchParams({
      gameId: String(numericGameId),
      playerId: String(numericPlayerId),
      modelVersion: modelVersion || DEFAULT_MODEL_VERSION,
    });

    fetch(`/api/predictions?${params.toString()}`)
      .then(async (res) => {
        const payload: PredictionsResponse = await res.json();
        if (!res.ok) {
          const message = payload?.error || "Failed to load predictions.";
          throw new Error(message);
        }
        return payload;
      })
      .then((payload) => {
        if (cancelled) return;
        setState({
          predictions: payload.predictions ?? [],
          source: payload.source ?? null,
          modelVersion: payload.modelVersion ?? modelVersion ?? null,
          features: payload.features ?? null,
          recentForm: payload.recentForm ?? null,
          loading: false,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message =
          err instanceof Error ? err.message : "Failed to load predictions.";
        console.error("Predictions fetch error:", err);
        setState({
          ...initialState,
          error: message,
        });
      });

    return () => {
      cancelled = true;
    };
  }, [gameId, playerId, modelVersion]);

  return state;
}
