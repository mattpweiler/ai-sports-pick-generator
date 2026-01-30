import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_MODEL_VERSION, STAT_ORDER, StatType } from "@/lib/predictions";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

type FeatureRow = {
  game_date: string;
  game_id: number;
  player_id: number;
  team_abbr: string | null;
  opponent_team_id: number | null;
  is_home: boolean | null;
};

type MlRow = {
  game_id: number;
  player_id: number;
  stat_type: StatType;
  model_mean: number | null;
  model_std: number | null;
  model_version: string | null;
  generated_at: string | null;
  line?: number | null;
  model_prob_over?: number | null;
  market_prob_over?: number | null;
  delta?: number | null;
};

type BaselineRow = {
  game_id: number;
  player_id: number;
  stat_type: StatType;
  baseline_mean: number | null;
  baseline_std: number | null;
};

type TeamRow = {
  team_id: number;
  abbreviation: string | null;
};

function normalizeId(value: string | number | null | undefined) {
  if (value === null || value === undefined) return null;
  const num = Number(String(value).replace(/^0+/, ""));
  return Number.isFinite(num) ? num : null;
}

function dateOnly(value: Date | string) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().split("T")[0];
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const requestedModelVersion =
    searchParams.get("modelVersion") ?? DEFAULT_MODEL_VERSION;
  const startParam = searchParams.get("start");
  const endParam = searchParams.get("end");

  const today = new Date();
  const defaultStart = dateOnly(today)!;
  const defaultEnd = dateOnly(
    new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000)
  )!;

  const startDate = dateOnly(startParam ?? defaultStart);
  const endDate = dateOnly(endParam ?? defaultEnd);

  if (!startDate || !endDate) {
    return NextResponse.json(
      { error: "Invalid date range." },
      { status: 400 }
    );
  }

  try {
    const { data: featureRows, error: featureError } = await supabase
      .from("player_game_features")
      .select(
        "game_date, game_id, player_id, team_abbr, opponent_team_id, is_home"
      )
      .gte("game_date", startDate)
      .lte("game_date", endDate)
      .order("game_date", { ascending: true });

    if (featureError) {
      console.error("Supabase error loading player_game_features:", featureError);
      return NextResponse.json(
        { error: featureError.message || "Failed to load upcoming features." },
        { status: 500 }
      );
    }

    if (!featureRows?.length) {
      return NextResponse.json({
        modelVersion: requestedModelVersion,
        startDate,
        endDate,
        items: [],
      });
    }

    const gameIds = Array.from(
      new Set(featureRows.map((r) => normalizeId(r.game_id)).filter(Boolean))
    ) as number[];
    const playerIds = Array.from(
      new Set(featureRows.map((r) => normalizeId(r.player_id)).filter(Boolean))
    ) as number[];
    const opponentIds = Array.from(
      new Set(
        featureRows
          .map((r) => normalizeId(r.opponent_team_id))
          .filter(Boolean)
      )
    ) as number[];

    const [mlRes, baselineRes, teamRes] = await Promise.all([
      supabase
        .from("ml_predictions")
        .select(
          "game_id, player_id, stat_type, model_mean, model_std, model_version, generated_at, line, model_prob_over, market_prob_over, delta"
        )
        .eq("model_version", requestedModelVersion)
        .in("game_id", gameIds)
        .in("player_id", playerIds),
      supabase
        .from("stat_baseline_predictions")
        .select(
          "game_id, player_id, stat_type, baseline_mean, baseline_std"
        )
        .in("game_id", gameIds)
        .in("player_id", playerIds),
      opponentIds.length
        ? supabase
            .from("team_id_to_team")
            .select("team_id, abbreviation")
            .in("team_id", opponentIds)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (mlRes.error) {
      console.error("Supabase error loading ml_predictions:", mlRes.error);
      return NextResponse.json(
        { error: mlRes.error.message || "Failed to load predictions." },
        { status: 500 }
      );
    }

    if (baselineRes.error) {
      console.warn("Supabase error loading stat_baseline_predictions:", baselineRes.error);
    }

    if (teamRes && "error" in teamRes && teamRes.error) {
      console.warn("Supabase error loading team_id_to_team:", teamRes.error);
    }

    const mlRows = (mlRes.data as MlRow[]) ?? [];
    const baselineRows = (baselineRes.data as BaselineRow[]) ?? [];
    const teamRows = (teamRes && "data" in teamRes
      ? ((teamRes.data as TeamRow[]) ?? [])
      : []) as TeamRow[];

    const opponentMap = new Map<number, string>();
    teamRows.forEach((t) => {
      if (t.team_id && t.abbreviation) {
        opponentMap.set(t.team_id, t.abbreviation);
      }
    });

    type StatPayload = {
      statType: StatType;
      mean: number | null;
      std: number | null;
      source: "ml" | "baseline" | "none";
      line?: number | null;
      modelProbOver?: number | null;
      marketProbOver?: number | null;
      delta?: number | null;
    };

    const statMap = new Map<string, StatPayload>();
    const keyFor = (g: number, p: number, s: StatType) => `${g}:${p}:${s}`;

    mlRows.forEach((row) => {
      const g = normalizeId(row.game_id);
      const p = normalizeId(row.player_id);
      if (g === null || p === null) return;
      const key = keyFor(g, p, row.stat_type);
      statMap.set(key, {
        statType: row.stat_type,
        mean: row.model_mean ?? null,
        std: row.model_std ?? null,
        source: "ml",
        line: row.line ?? null,
        modelProbOver: row.model_prob_over ?? null,
        marketProbOver: row.market_prob_over ?? null,
        delta: row.delta ?? null,
      });
    });

    baselineRows.forEach((row) => {
      const g = normalizeId(row.game_id);
      const p = normalizeId(row.player_id);
      if (g === null || p === null) return;
      const key = keyFor(g, p, row.stat_type);
      if (statMap.has(key)) return; // prefer ML
      statMap.set(key, {
        statType: row.stat_type,
        mean: row.baseline_mean ?? null,
        std: row.baseline_std ?? null,
        source: "baseline",
      });
    });

    type PlayerPayload = {
      playerId: number;
      teamAbbr: string | null;
      opponentTeamId: number | null;
      opponentAbbr: string | null;
      isHome: boolean | null;
      stats: StatPayload[];
    };

    type GamePayload = {
      gameId: number;
      gameDate: string;
      homeTeam: string | null;
      awayTeam: string | null;
      players: PlayerPayload[];
    };

    const gamesById = new Map<number, GamePayload>();

    featureRows.forEach((row) => {
      const gameId = normalizeId(row.game_id);
      const playerId = normalizeId(row.player_id);
      if (gameId === null || playerId === null) return;
      const gameDate = row.game_date;
      let game = gamesById.get(gameId);
      if (!game) {
        // try to infer matchup
        const opponentAbbr =
          row.opponent_team_id && opponentMap.get(row.opponent_team_id);
        const homeTeam =
          row.is_home && row.team_abbr
            ? row.team_abbr
            : !row.is_home && opponentAbbr
              ? opponentAbbr
              : null;
        const awayTeam =
          row.is_home && opponentAbbr
            ? opponentAbbr
            : !row.is_home && row.team_abbr
              ? row.team_abbr
              : null;

        game = {
          gameId,
          gameDate,
          homeTeam: homeTeam ?? null,
          awayTeam: awayTeam ?? null,
          players: [],
        };
        gamesById.set(gameId, game);
      }

      const stats: StatPayload[] = STAT_ORDER.map((statType) => {
        const key = keyFor(gameId, playerId, statType);
        const found = statMap.get(key);
        if (!found) {
          return {
            statType,
            mean: null,
            std: null,
            source: "none",
          };
        }
        return found;
      });

      const opponentAbbr =
        (row.opponent_team_id && opponentMap.get(row.opponent_team_id)) || null;

      game.players.push({
        playerId,
        teamAbbr: row.team_abbr,
        opponentTeamId: row.opponent_team_id ?? null,
        opponentAbbr,
        isHome: row.is_home,
        stats,
      });
    });

    const byDate = Array.from(gamesById.values()).reduce(
      (acc, game) => {
        const dateKey = game.gameDate;
        if (!acc[dateKey]) acc[dateKey] = [];
        acc[dateKey].push(game);
        return acc;
      },
      {} as Record<string, GamePayload[]>
    );

    const items = Object.keys(byDate)
      .sort()
      .map((date) => ({
        gameDate: date,
        games: byDate[date],
      }));

    return NextResponse.json({
      modelVersion: requestedModelVersion,
      startDate,
      endDate,
      items,
    });
  } catch (err) {
    console.error("Unexpected error in GET /api/nba/predictions:", err);
    return NextResponse.json(
      { error: "Unexpected error fetching predictions." },
      { status: 500 }
    );
  }
}
