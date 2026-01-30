import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseLlmExplanationPayload(raw: string): { explanation: string[] } {
  const top = JSON.parse(raw);

  // OpenAI responses wrap the JSON in choices[].message.content as a string.
  const content =
    top?.choices?.[0]?.message?.content ??
    top?.message?.content ??
    top?.content ??
    top;

  let obj: any = content;
  if (typeof content === "string") {
    obj = JSON.parse(content);
  }

  if (!obj || !Array.isArray(obj.explanation)) {
    throw new Error("Invalid explanation schema");
  }

  return obj;
}

export async function POST(req: NextRequest) {
  const debug: any = { steps: [] };
  try {
    const body = await req.json();
    const gameId = Number(body.game_id);
    const playerId = Number(body.player_id);
    const modelVersion = (body.model_version || "xgb_prod").trim();
    const userNotes = (body.user_notes || "").toString();
    const finalStats = body.final_stats || {};

    if (!Number.isFinite(gameId) || !Number.isFinite(playerId)) {
      return NextResponse.json({ error: "game_id and player_id required" }, { status: 400 });
    }

    const tFeat = Date.now();
    const { data: features, error: featError } = await supabase
      .from("player_game_features")
      .select(
        `
        game_id, player_id, game_date, season,
        pts_l5, pts_l10, pts_season_avg,
        reb_l5, reb_l10, reb_season_avg,
        ast_l5, ast_l10, ast_season_avg,
        pra_l5, pra_l10, pra_season_avg,
        min_l5, min_l10, min_season_avg,
        days_rest, is_back_to_back, is_3_in_4, is_4_in_6,
        is_home, opponent_team_id
      `
      )
      .eq("game_id", gameId)
      .eq("player_id", playerId)
      .maybeSingle();
    debug.steps.push({
      step: "features",
      ms: Date.now() - tFeat,
      error: featError?.message,
      sample: features,
    });
    if (featError || !features) {
      return NextResponse.json(
        { error: "Missing features for explanation", debug },
        { status: 400 }
      );
    }

    const tMl = Date.now();
    const { data: mlRows, error: mlError } = await supabase
      .from("ml_predictions")
      .select("stat_type, model_mean, model_std")
      .eq("game_id", gameId)
      .eq("player_id", playerId)
      .eq("model_version", modelVersion);
    debug.steps.push({
      step: "ml",
      ms: Date.now() - tMl,
      error: mlError?.message,
      sample: mlRows?.slice?.(0, 2),
    });

    const tName = Date.now();
    const { data: nameRow, error: nameError } = await supabase
      .from("player_team_position")
      .select("player_name")
      .eq("player_id", playerId)
      .maybeSingle();
    debug.steps.push({
      step: "name",
      ms: Date.now() - tName,
      error: nameError?.message,
      sample: nameRow,
    });

    const mlMap = new Map<string, { mean: number | null; std: number | null }>();
    (mlRows ?? []).forEach((r) => {
      if (typeof r.stat_type === "string") {
        mlMap.set(r.stat_type.toUpperCase(), {
          mean: num(r.model_mean),
          std: num(r.model_std),
        });
      }
    });

    const packet = {
      game_id: gameId,
      player_id: playerId,
      player_name: nameRow?.player_name ?? `Player ${playerId}`,
      model_version: modelVersion,
      user_notes: userNotes,
      final_stats: finalStats,
      recency: {
        min_l5: num(features.min_l5),
        min_l10: num(features.min_l10),
        min_season: num(features.min_season_avg),
        pts_l5: num(features.pts_l5),
        pts_l10: num(features.pts_l10),
        pts_season: num(features.pts_season_avg),
        reb_l5: num(features.reb_l5),
        reb_l10: num(features.reb_l10),
        reb_season: num(features.reb_season_avg),
        ast_l5: num(features.ast_l5),
        ast_l10: num(features.ast_l10),
        ast_season: num(features.ast_season_avg),
        pra_l5: num(features.pra_l5),
        pra_l10: num(features.pra_l10),
        pra_season: num(features.pra_season_avg),
      },
      schedule: {
        days_rest: num(features.days_rest),
        is_back_to_back: !!features.is_back_to_back,
        is_3_in_4: !!features.is_3_in_4,
        is_4_in_6: !!features.is_4_in_6,
        is_home: features.is_home,
        opponent_team_id: num(features.opponent_team_id),
      },
      ml: {
        pts: mlMap.get("PTS")?.mean ?? null,
        reb: mlMap.get("REB")?.mean ?? null,
        ast: mlMap.get("AST")?.mean ?? null,
        pra: mlMap.get("PRA")?.mean ?? null,
      },
    };

    const sys = [
      "You are an NBA explanation assistant.",
      "Explain the projected stat line using recent form (L5/L10/season), ML means, and user notes.",
      "Mention if the player is hot/cold, minutes stability, schedule spots (b2b, 3-in-4, 4-in-6), and any injury/notes effects.",
      "If user notes say the player is out, explain that and confirm zeros.",
      "Keep it concise: 2-4 short bullets.",
      "Output strict JSON: { \"explanation\": string[] }",
    ].join("\n");

    const usr = JSON.stringify(packet);

    const res = await fetch(
      (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1") + "/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: LLM_MODEL,
          temperature: 0.2,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: sys },
            { role: "user", content: usr },
          ],
        }),
      }
    );
    const raw = await res.text();
    if (!res.ok) {
      throw new Error(`LLM status ${res.status}: ${raw?.slice(0, 300)}`);
    }
    const parsed = parseLlmExplanationPayload(raw);

    return NextResponse.json({
      game_id: gameId,
      player_id: playerId,
      explanation: parsed.explanation,
      debug,
    });
  } catch (err) {
    debug.error = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: "Failed to generate explanation", debug }, { status: 500 });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
