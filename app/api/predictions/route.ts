import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import {
  DEFAULT_MODEL_VERSION,
  PlayerFeatureContext,
  STAT_ORDER,
  RecentForm,
  StatPred,
  StatSource,
  StatType,
} from "@/lib/predictions";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

function toNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "t" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "f" || normalized === "0") {
      return false;
    }
  }
  return null;
}

function mapPredictions(
  rows: any[] | null,
  source: StatSource
): StatPred[] {
  const valueMap = new Map<StatType, { mean: number | null; std: number | null }>();

  (rows ?? []).forEach((row) => {
    const statRaw =
      typeof row?.stat_type === "string" ? row.stat_type.toUpperCase().trim() : "";
    const statType = statRaw as StatType;
    if (!STAT_ORDER.includes(statType)) return;
    const mean = toNumber(row.model_mean ?? row.projected_mean);
    const std = toNumber(row.model_std ?? row.projected_std);
    valueMap.set(statType, { mean, std });
  });

  return STAT_ORDER.map((statType) => {
    const entry = valueMap.get(statType);
    if (!entry) {
      return { statType, mean: null, std: null, source: "none" as const };
    }
    return {
      statType,
      mean: entry.mean,
      std: entry.std,
      source,
    };
  });
}

function normalizeFeatures(row: any): PlayerFeatureContext {
  return {
    game_date: row?.game_date ?? null,
    pts_l5: toNumber(row?.pts_l5),
    pts_l10: toNumber(row?.pts_l10),
    pts_season_avg: toNumber(row?.pts_season_avg),
    reb_l5: toNumber(row?.reb_l5),
    reb_l10: toNumber(row?.reb_l10),
    reb_season_avg: toNumber(row?.reb_season_avg),
    ast_l5: toNumber(row?.ast_l5),
    ast_l10: toNumber(row?.ast_l10),
    ast_season_avg: toNumber(row?.ast_season_avg),
    pra_l5: toNumber(row?.pra_l5),
    pra_l10: toNumber(row?.pra_l10),
    pra_season_avg: toNumber(row?.pra_season_avg),
    min_l5: toNumber(row?.min_l5),
    min_l10: toNumber(row?.min_l10),
    min_season_avg: toNumber(row?.min_season_avg),
    days_rest: toNumber(row?.days_rest),
    is_back_to_back: toBoolean(row?.is_back_to_back),
    is_home: toBoolean(row?.is_home),
    opponent_team_id: toNumber(row?.opponent_team_id),
  };
}

function normalizeRecentForm(row: any | null): RecentForm | null {
  if (!row) return null;
  return {
    pts_l5: toNumber(row.pts_l5),
    pts_l10: toNumber(row.pts_l10),
    pts_season: toNumber(row.pts_season),
    reb_l5: toNumber(row.reb_l5),
    reb_l10: toNumber(row.reb_l10),
    reb_season: toNumber(row.reb_season),
    ast_l5: toNumber(row.ast_l5),
    ast_l10: toNumber(row.ast_l10),
    ast_season: toNumber(row.ast_season),
    pra_l5: toNumber(row.pra_l5),
    pra_l10: toNumber(row.pra_l10),
    pra_season: toNumber(row.pra_season),
    min_l5: toNumber(row.min_l5),
    min_l10: toNumber(row.min_l10),
    min_season: toNumber(row.min_season),
    games_in_season: toNumber(row.games_in_season),
  };
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const gameIdParam = searchParams.get("gameId");
  const playerIdParam = searchParams.get("playerId");
  const requestedModelVersion =
    searchParams.get("modelVersion") ?? DEFAULT_MODEL_VERSION;

  const gameId = Number(String(gameIdParam ?? "").replace(/^0+/, ""));
  const playerId = Number(playerIdParam);

  if (!gameIdParam || Number.isNaN(gameId) || !playerIdParam || Number.isNaN(playerId)) {
    return NextResponse.json(
      { error: "Missing or invalid gameId/playerId" },
      { status: 400 }
    );
  }

  try {
    // Temporary sanity check to verify DB + RLS
    try {
      const { data, error } = await supabase
        .from("ml_predictions")
        .select("stat_type, model_mean, model_std, model_version, generated_at")
        .eq("game_id", 22500001)
        .eq("player_id", 1627827)
        .eq("model_version", "xgb_v1_2026-01-19");
      console.log("ML PRED HARDCODE TEST", { dataLength: data?.length, error });
    } catch (hardErr) {
      console.error("Hardcoded ML prediction test failed:", hardErr);
    }

    console.log("PRED PARAMS", {
      gameId: gameIdParam,
      playerId: playerIdParam,
      modelVersion: requestedModelVersion,
      normalizedGameId: gameId,
      normalizedPlayerId: playerId,
      typeofGameId: typeof gameId,
      typeofPlayerId: typeof playerId,
    });

    const mlPromise = supabase
      .from("ml_predictions")
      .select("stat_type, model_mean, model_std, model_version, generated_at")
      .eq("game_id", gameId)
      .eq("player_id", playerId)
      .eq("model_version", requestedModelVersion);

    const featuresPromise = supabase
      .from("player_game_features")
      .select(
        "game_date, pts_l5, pts_l10, pts_season_avg, reb_l5, reb_l10, reb_season_avg, ast_l5, ast_l10, ast_season_avg, pra_l5, pra_l10, pra_season_avg, min_l5, min_l10, min_season_avg, days_rest, is_back_to_back, is_home, opponent_team_id"
      )
      .eq("game_id", gameId)
      .eq("player_id", playerId)
      .limit(1)
      .maybeSingle();

    const [{ data: mlData, error: mlError }, { data: featuresData, error: featuresError }] =
      await Promise.all([mlPromise, featuresPromise]);

    if (mlError) {
      console.error("Supabase error loading ml_predictions:", mlError);
      return NextResponse.json(
        { error: mlError.message || "Failed to load predictions" },
        { status: 500 }
      );
    }

    if (featuresError) {
      console.warn("Supabase error loading player_game_features:", featuresError);
    }

    const featureContext = featuresData ? normalizeFeatures(featuresData) : null;
    const gameDateForRecentForm = featureContext?.game_date ?? null;
    let recentForm: RecentForm | null = null;

    if (gameDateForRecentForm) {
      const { data: rfData, error: rfError } = await supabase.rpc(
        "get_recent_form",
        {
          p_player_id: playerId,
          p_as_of_date: gameDateForRecentForm,
        }
      );
      if (rfError) {
        console.warn("Supabase error loading recent form:", rfError);
      } else {
        const rfRow = Array.isArray(rfData) ? rfData[0] : rfData;
        recentForm = normalizeRecentForm(rfRow ?? null);
      }
    }

    let predictions: StatPred[] = [];
    let source: StatSource | null = null;
    let resolvedModelVersion: string | null = null;

    const mlRows = Array.isArray(mlData) ? mlData : [];
    if (mlRows.length > 0) {
      predictions = mapPredictions(mlRows, "ml");
      source = "ml";
      resolvedModelVersion = requestedModelVersion;
    } else {
      const { data: latestVersionRows, error: latestError } = await supabase
        .from("ml_predictions")
        .select("model_version, generated_at")
        .eq("game_id", gameId)
        .eq("player_id", playerId)
        .order("generated_at", { ascending: false })
        .limit(1);

      if (latestError) {
        console.warn("Supabase error finding latest model_version:", latestError);
      }

      const latestVersion = Array.isArray(latestVersionRows)
        ? latestVersionRows[0]?.model_version
        : null;

      if (latestVersion && latestVersion !== requestedModelVersion) {
        const { data: mlFallbackData, error: mlFallbackError } = await supabase
          .from("ml_predictions")
          .select("stat_type, model_mean, model_std, model_version, generated_at")
          .eq("game_id", gameId)
          .eq("player_id", playerId)
          .eq("model_version", latestVersion);

        if (mlFallbackError) {
          console.error("Supabase error loading fallback ml_predictions:", mlFallbackError);
        } else if (Array.isArray(mlFallbackData) && mlFallbackData.length > 0) {
          predictions = mapPredictions(mlFallbackData, "ml");
          source = "ml";
          resolvedModelVersion = latestVersion;
        }
      }

      if (!predictions.length) {
        const { data: baselineData, error: baselineError } = await supabase
          .from("player_stat_projections")
          .select("stat_type, projected_mean, projected_std, created_at")
          .eq("game_id", gameId)
          .eq("player_id", playerId);

        if (baselineError) {
          console.error("Supabase error loading player_stat_projections:", baselineError);
          return NextResponse.json(
            { error: baselineError.message || "Failed to load predictions" },
            { status: 500 }
          );
        }

        const baselineRows = Array.isArray(baselineData) ? baselineData : [];
        if (baselineRows.length > 0) {
          predictions = mapPredictions(baselineRows, "baseline");
          source = "baseline";
        }
      }
    }

    if (!predictions.length) {
      predictions = STAT_ORDER.map((statType) => ({
        statType,
        mean: null,
        std: null,
        source: "none" as const,
      }));
      source = "none";
    }

    return NextResponse.json({
      predictions,
      source,
      modelVersion:
        source === "ml"
          ? resolvedModelVersion ?? requestedModelVersion
          : null,
      features: featureContext,
      recentForm,
    });
  } catch (err) {
    console.error("Unexpected error in GET /api/predictions:", err);
    return NextResponse.json(
      { error: "Unexpected error fetching predictions" },
      { status: 500 }
    );
  }
}
