import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";
import { DEFAULT_MODEL_VERSION } from "@/lib/predictions";
import {
  AiGamePredictionPayload,
  AiGamePredictionRequest,
  AiPlayerSuggestion,
} from "@/lib/aiPredictions";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const CACHE_TABLE = "llm_game_predictions";
const ROSTER_TABLE = "player_game_roster";
const FEATURES_TABLE = "player_game_features";
const ML_TABLE = "ml_predictions";
const GAME_TABLE = "nba_games-2025-26";
const TEAM_TABLE = "team_id_to_team";
const PLAYER_NAME_TABLE = "player_team_position";

type RosterRow = {
  player_id: number;
  team_abbr: string | null;
  expected_active: boolean | null;
};

type FeatureRow = {
  game_id: number;
  player_id: number;
  game_date: string | null;
  team_abbr: string | null;
  opponent_team_id: number | null;
  is_home: boolean | null;
  min_l5: number | null;
  min_l10: number | null;
  min_season_avg: number | null;
  pts_l5: number | null;
  pts_l10: number | null;
  pts_season_avg: number | null;
  reb_l5: number | null;
  reb_l10: number | null;
  reb_season_avg: number | null;
  ast_l5: number | null;
  ast_l10: number | null;
  ast_season_avg: number | null;
  pra_l5: number | null;
  pra_l10: number | null;
  pra_season_avg: number | null;
  days_rest: number | null;
  is_back_to_back: boolean | null;
  is_3_in_4: boolean | null;
  is_4_in_6: boolean | null;
};

type MlRow = {
  player_id: number;
  stat_type: string | null;
  model_mean: number | null;
  model_std: number | null;
};

type GameRow = {
  game_id: number;
  game_date: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
};

type TeamRow = {
  team_id: number;
  abbreviation: string | null;
};

type PlayerNameRow = {
  player_id: number;
  player_name: string | null;
};

function toNumber(value: unknown): number | null {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "t", "1", "yes"].includes(normalized)) return true;
    if (["false", "f", "0", "no"].includes(normalized)) return false;
  }
  return null;
}

function normalizeContextText(value: string) {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function sha256(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function extractJson(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return text.trim();
  return text.slice(start, end + 1);
}

function validatePlayerLine(player: AiPlayerSuggestion | any): string | null {
  if (typeof player !== "object" || player === null) {
    return "Player entry is not an object";
  }
  const requiredNumbers = ["minutes", "pts", "reb", "ast", "pra"];
  const missingNumber = requiredNumbers.find(
    (key) => !Number.isFinite(Number((player as any)[key]))
  );
  if (missingNumber) {
    return `Player ${player.player_id ?? "unknown"} missing numeric ${missingNumber}`;
  }

  if (typeof player.player_id !== "number") {
    return "player_id must be a number";
  }
  if (!player.team_abbr || typeof player.team_abbr !== "string") {
    return "team_abbr missing";
  }

  const minutes = Number(player.minutes);
  if (minutes < 0 || minutes > 42) {
    return `minutes out of range for player ${player.player_id}`;
  }

  const stats = ["pts", "reb", "ast", "pra"] as const;
  for (const key of stats) {
    const value = Number((player as any)[key]);
    if (value < 0) {
      return `${key} cannot be negative for player ${player.player_id}`;
    }
  }

  const sumPra = Number(player.pts) + Number(player.reb) + Number(player.ast);
  if (Math.abs(sumPra - Number(player.pra)) > 1.01) {
    return `PRA mismatch for player ${player.player_id}`;
  }

  if (!["High", "Medium", "Low"].includes(player.confidence)) {
    return `Invalid confidence for player ${player.player_id}`;
  }

  if (!Array.isArray(player.why)) {
    return `Missing why array for player ${player.player_id}`;
  }

  return null;
}

function validateLlmPayload(payload: any, expectedGameId: number) {
  if (typeof payload !== "object" || payload === null) {
    return "Payload is not an object";
  }
  if (payload.game_id !== expectedGameId) {
    return "game_id mismatch";
  }
  if (!payload.model_version || typeof payload.model_version !== "string") {
    return "model_version missing";
  }
  if (!payload.generated_at || typeof payload.generated_at !== "string") {
    return "generated_at missing";
  }
  if (Number.isNaN(new Date(payload.generated_at).getTime())) {
    return "generated_at invalid";
  }
  if (!Array.isArray(payload.assumptions)) {
    return "assumptions must be an array";
  }
  if (payload.assumptions.some((a: any) => typeof a !== "string")) {
    return "assumptions must be strings";
  }
  if (!Array.isArray(payload.players) || payload.players.length === 0) {
    return "players must be a non-empty array";
  }

  for (const player of payload.players) {
    const error = validatePlayerLine(player);
    if (error) return error;
  }

  return null;
}

async function resolveModelVersion(requested?: string | null) {
  const fallback = DEFAULT_MODEL_VERSION;
  const trimmed = requested?.trim();
  try {
    if (trimmed) {
      const { data, error } = await supabase
        .from("ml_model_registry")
        .select("model_version")
        .eq("model_version", trimmed)
        .limit(1);
      if (!error && Array.isArray(data) && data.length > 0) {
        return trimmed;
      }
    }

    const { data } = await supabase
      .from("ml_model_registry")
      .select("model_version, created_at")
      .order("created_at", { ascending: false })
      .limit(1);

    if (Array.isArray(data) && data[0]?.model_version) {
      return data[0].model_version as string;
    }
  } catch (err) {
    console.warn("Model registry lookup failed:", err);
  }
  return trimmed || fallback;
}

async function callLlm(messages: { role: "system" | "user" | "assistant"; content: string }[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }
  const model = process.env.LLM_MODEL || "gpt-4o-mini";
  const baseUrl = process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      response_format: { type: "json_object" },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`LLM request failed: ${res.status} ${text}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") {
    throw new Error("LLM returned empty response");
  }
  return content;
}

function buildSystemPrompt(useMlBaseline: boolean) {
  return [
    "You are an NBA projections assistant that blends recent form, season averages, and ML projections.",
    "Requirements:",
    "- Return STRICT JSON only, no markdown or prose.",
    "- Minutes must be plausible and clamped to [0,42]; bench players 8–28 unless context overrides.",
    "- Base stat = 0.55*season + 0.30*l10 + 0.15*l5.",
    useMlBaseline
      ? "- Then blend toward ML: blended = 0.65*base + 0.35*ml_mean with a max pull of 20% of base if ML is far lower."
      : "- Ignore ML as baseline; start from base_stat and only use ML for sanity if present.",
    "- Adjust for context: pace, injuries, blowout, questionable/probable/doubtful notes, minutes limits.",
    "- Treat user context as facts: 'Player X out' => minutes 0 and stats 0; 'questionable' lower minutes 20-40%; 'probable' small penalty (~10% minutes); 'minutes limit 25' => clamp to 25; 'starting' => add 4-10 minutes; 'pace up/faster' => +3-7% counting stats; 'blowout risk' => stars -5% minutes, bench +5% unless user overrides; 'new coach/rotation' => lower confidence.",
    "- PRA must roughly equal PTS + REB + AST (<=1 gap). No negative stats.",
    "- If a player is OUT in notes: minutes=0 and stats=0.",
    "- Confidence: High if minutes stable (min_l5 within ±15% of min_l10) and no injury; Medium for mild uncertainty; Low when missing recency or injury risk.",
    "- When data is missing, assume minutes=20, stats=ML mean if available else 0, and confidence Low.",
  ].join("\n");
}

function buildUserPrompt(packet: Record<string, unknown>, modelVersion: string) {
  return [
    "Generate AI stat lines for every expected active player in this game.",
    "Follow the schema exactly and include 1–3 short bullets in `why`.",
    "Honor schedule_context (back-to-back / 3-in-4 / 4-in-6) and user notes.",
    `Use model_version: ${modelVersion}.`,
    JSON.stringify(packet),
  ].join("\n");
}

function buildScheduleContext(
  features: FeatureRow[],
  teamAbbr: string | null,
  isHome: boolean
) {
  const match = features.find((f) => {
    if (!f.team_abbr || !teamAbbr) return false;
    const abbrMatches = f.team_abbr.toUpperCase() === teamAbbr.toUpperCase();
    const homeMatches =
      typeof f.is_home === "boolean" ? f.is_home === isHome : true;
    return abbrMatches && homeMatches;
  });

  return {
    is_b2b: Boolean(match?.is_back_to_back),
    is_3_in_4: Boolean(match?.is_3_in_4),
    is_4_in_6: Boolean(match?.is_4_in_6),
  };
}

export async function POST(req: NextRequest) {
  try {
    const body: AiGamePredictionRequest = await req.json();
    const rawGameId = body.game_id;
    const gameId = Number(rawGameId);
    if (!rawGameId || Number.isNaN(gameId)) {
      return NextResponse.json(
        { error: "game_id is required and must be a number" },
        { status: 400 }
      );
    }

    const useMlBaseline = body.use_ml_baseline !== false;
    const modelVersion = await resolveModelVersion(body.model_version);
    const userContextText = (body.user_context_text ?? "").toString();
    const normalizedContext = normalizeContextText(userContextText);
    const contextHash = sha256(
      [modelVersion, gameId, normalizedContext].join("|")
    );

    const { data: cachedRow, error: cacheError } = await supabase
      .from(CACHE_TABLE)
      .select("payload")
      .eq("game_id", gameId)
      .eq("model_version", modelVersion)
      .eq("user_context_hash", contextHash)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (cacheError) {
      console.warn("Cache lookup failed:", cacheError);
    }
    if (cachedRow?.payload) {
      return NextResponse.json(cachedRow.payload);
    }

    const { data: rosterRows, error: rosterError } = await supabase
      .from(ROSTER_TABLE)
      .select("player_id, team_abbr, expected_active")
      .eq("game_id", gameId)
      .eq("expected_active", true);

    if (rosterError) {
      console.error("Error loading roster:", rosterError);
      return NextResponse.json(
        { error: rosterError.message || "Failed to load roster" },
        { status: 500 }
      );
    }

    const activeRoster = (rosterRows as RosterRow[] | null)?.filter(
      (r) => r.expected_active
    );
    if (!activeRoster || activeRoster.length === 0) {
      return NextResponse.json(
        { error: "No expected active players found for this game." },
        { status: 404 }
      );
    }

    const playerIds = activeRoster
      .map((r) => r.player_id)
      .filter((id) => Number.isFinite(id));

    const featurePromise =
      playerIds.length > 0
        ? supabase
            .from(FEATURES_TABLE)
            .select(
              "game_id, player_id, game_date, team_abbr, opponent_team_id, is_home, min_l5, min_l10, min_season_avg, pts_l5, pts_l10, pts_season_avg, reb_l5, reb_l10, reb_season_avg, ast_l5, ast_l10, ast_season_avg, pra_l5, pra_l10, pra_season_avg, days_rest, is_back_to_back, is_3_in_4, is_4_in_6"
            )
            .eq("game_id", gameId)
            .in("player_id", playerIds)
        : Promise.resolve({ data: [], error: null });

    const mlPromise =
      playerIds.length > 0
        ? supabase
            .from(ML_TABLE)
            .select("player_id, stat_type, model_mean, model_std")
            .eq("game_id", gameId)
            .eq("model_version", modelVersion)
            .in("player_id", playerIds)
        : Promise.resolve({ data: [], error: null });

    const gamePromise = supabase
      .from(GAME_TABLE)
      .select("game_id, game_date, home_team_id, away_team_id")
      .eq("game_id", gameId)
      .maybeSingle();

    const namePromise =
      playerIds.length > 0
        ? supabase
            .from(PLAYER_NAME_TABLE)
            .select("player_id, player_name")
            .in("player_id", playerIds)
        : Promise.resolve({ data: [], error: null });

    const [{ data: featureRows, error: featureError }, { data: mlRows, error: mlError }, { data: gameRow, error: gameError }, { data: nameRows, error: nameError }] =
      await Promise.all([featurePromise, mlPromise, gamePromise, namePromise]);

    if (featureError) {
      console.warn("Error loading features:", featureError);
    }
    if (mlError) {
      console.warn("Error loading ml_predictions:", mlError);
    }
    if (nameError) {
      console.warn("Error loading player names:", nameError);
    }
    if (gameError) {
      console.warn("Error loading game row:", gameError);
    }

    const features = (featureRows as FeatureRow[] | null) ?? [];
    const mlPreds = (mlRows as MlRow[] | null) ?? [];
    const featureMap = new Map<number, FeatureRow>();
    features.forEach((f) => featureMap.set(f.player_id, f));

    const mlMap = new Map<string, { mean: number | null; std: number | null }>();
    mlPreds.forEach((row) => {
      const stat =
        typeof row.stat_type === "string"
          ? row.stat_type.trim().toUpperCase()
          : "";
      if (!stat) return;
      mlMap.set(`${row.player_id}:${stat}`, {
        mean: toNumber(row.model_mean),
        std: toNumber(row.model_std),
      });
    });

    const nameMap = new Map<number, string>();
    (nameRows as PlayerNameRow[] | null)?.forEach((row) => {
      if (row.player_id && row.player_name) {
        nameMap.set(row.player_id, row.player_name);
      }
    });

    const gameMeta = gameRow as GameRow | null;
    const teamIds: number[] = [];
    if (gameMeta?.home_team_id) teamIds.push(gameMeta.home_team_id);
    if (gameMeta?.away_team_id) teamIds.push(gameMeta.away_team_id);

    const { data: teamRows, error: teamError } =
      teamIds.length > 0
        ? await supabase
            .from(TEAM_TABLE)
            .select("team_id, abbreviation")
            .in("team_id", teamIds)
        : { data: [], error: null };

    if (teamError) {
      console.warn("Error loading team abbreviations:", teamError);
    }

    const teamMap = new Map<number, string>();
    (teamRows as TeamRow[] | null)?.forEach((row) => {
      if (row.team_id && row.abbreviation) {
        teamMap.set(row.team_id, row.abbreviation);
      }
    });

    const homeTeamAbbr =
      (gameMeta?.home_team_id
        ? teamMap.get(gameMeta.home_team_id)
        : null) ||
      features.find((f) => f.is_home)?.team_abbr ||
      null;
    const awayTeamAbbr =
      (gameMeta?.away_team_id
        ? teamMap.get(gameMeta.away_team_id)
        : null) ||
      features.find((f) => f.is_home === false)?.team_abbr ||
      null;

    const gameDate =
      gameMeta?.game_date ||
      features.find((f) => f.game_date)?.game_date ||
      null;

    const packetPlayers = activeRoster.map((row) => {
      const feature = featureMap.get(row.player_id);
      const teamAbbr =
        row.team_abbr ??
        feature?.team_abbr ??
        (feature?.is_home ? homeTeamAbbr : awayTeamAbbr) ??
        "UNK";
      const ml = ["PTS", "REB", "AST", "PRA"].reduce(
        (acc, stat) => {
          const entry = mlMap.get(`${row.player_id}:${stat}`);
          acc[stat] = {
            mean: entry?.mean ?? null,
            std: entry?.std ?? null,
          };
          return acc;
        },
        {} as Record<string, { mean: number | null; std: number | null }>
      );

      return {
        player_id: row.player_id,
        name: nameMap.get(row.player_id) ?? undefined,
        team_abbr: teamAbbr,
        recent: feature
          ? {
              min_l5: toNumber(feature.min_l5),
              min_l10: toNumber(feature.min_l10),
              min_season: toNumber(feature.min_season_avg),
              pts_l5: toNumber(feature.pts_l5),
              pts_l10: toNumber(feature.pts_l10),
              pts_season: toNumber(feature.pts_season_avg),
              reb_l5: toNumber(feature.reb_l5),
              reb_l10: toNumber(feature.reb_l10),
              reb_season: toNumber(feature.reb_season_avg),
              ast_l5: toNumber(feature.ast_l5),
              ast_l10: toNumber(feature.ast_l10),
              ast_season: toNumber(feature.ast_season_avg),
              pra_l5: toNumber(feature.pra_l5),
              pra_l10: toNumber(feature.pra_l10),
              pra_season: toNumber(feature.pra_season_avg),
            }
          : undefined,
        ml,
        context_flags: {
          is_home:
            typeof feature?.is_home === "boolean"
              ? feature.is_home
              : teamAbbr
                ? teamAbbr === homeTeamAbbr
                : null,
          opponent_team_id: toNumber(feature?.opponent_team_id),
          days_rest: toNumber(feature?.days_rest),
          is_back_to_back: Boolean(toBoolean(feature?.is_back_to_back)),
          is_3_in_4: Boolean(toBoolean(feature?.is_3_in_4)),
          is_4_in_6: Boolean(toBoolean(feature?.is_4_in_6)),
        },
      };
    });

    const packet = {
      game: {
        game_id: gameId,
        game_date: gameDate,
        home_team_abbr: homeTeamAbbr,
        away_team_abbr: awayTeamAbbr,
        notes_from_user: userContextText.trim(),
        schedule_context: {
          home: buildScheduleContext(features, homeTeamAbbr, true),
          away: buildScheduleContext(features, awayTeamAbbr, false),
        },
        use_ml_baseline: useMlBaseline,
      },
      players: packetPlayers,
      model_version: modelVersion,
    };

    const systemPrompt = buildSystemPrompt(useMlBaseline);
    const userPrompt = buildUserPrompt(packet, modelVersion);

    const messages = [
      { role: "system" as const, content: systemPrompt },
      { role: "user" as const, content: userPrompt },
    ];

    const raw = await callLlm(messages);
    const parsedFirst = extractJson(raw);
    let payload: AiGamePredictionPayload | null = null;
    let validationError: string | null = null;
    try {
      const json = JSON.parse(parsedFirst);
      validationError = validateLlmPayload(json, gameId);
      if (!validationError) {
        payload = {
          ...json,
          game_id: gameId,
          model_version: modelVersion,
        };
      }
    } catch (err) {
      validationError =
        err instanceof Error ? err.message : "Failed to parse JSON.";
    }

    if (validationError) {
      const retryMessages = [
        ...messages,
        { role: "assistant" as const, content: raw },
        {
          role: "user" as const,
          content: `You returned invalid JSON (${validationError}). Fix the schema and values, ensure PRA ≈ PTS+REB+AST, minutes in [0,42], non-negative stats. Respond with JSON only.`,
        },
      ];
      const retryRaw = await callLlm(retryMessages);
      const parsedRetry = extractJson(retryRaw);
      try {
        const json = JSON.parse(parsedRetry);
        const retryValidation = validateLlmPayload(json, gameId);
        if (retryValidation) {
          return NextResponse.json(
            { error: `LLM output invalid after retry: ${retryValidation}` },
            { status: 502 }
          );
        }
        payload = {
          ...json,
          game_id: gameId,
          model_version: modelVersion,
        };
      } catch (err) {
        return NextResponse.json(
          {
            error:
              err instanceof Error
                ? `LLM retry parse failed: ${err.message}`
                : "LLM retry parse failed.",
          },
          { status: 502 }
        );
      }
    }

    if (!payload) {
      return NextResponse.json(
        { error: "No payload produced by LLM." },
        { status: 502 }
      );
    }

    await supabase.from(CACHE_TABLE).upsert({
      game_id: gameId,
      model_version: modelVersion,
      user_context_hash: contextHash,
      payload,
    });

    return NextResponse.json(payload);
  } catch (err) {
    console.error("Error in POST /api/ai/predictions/game:", err);
    return NextResponse.json(
      { error: "Failed to generate AI predictions." },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
