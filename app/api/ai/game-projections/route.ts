import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const DEFAULT_MODEL_VERSION = "xgb_prod";
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4o-mini";
const STAT_TYPES = ["PTS", "REB", "AST", "PRA"] as const;

type StatType = (typeof STAT_TYPES)[number];

type QueryLog = {
  step: string;
  ms: number;
  rows?: number;
  error?: string | null;
  sample?: any;
  raw?: any;
};

function num(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toBoolean(value: unknown): boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "t" || normalized === "1") return true;
    if (normalized === "false" || normalized === "f" || normalized === "0") return false;
  }
  return null;
}

function clamp(value: number, minV: number, maxV: number) {
  return Math.min(Math.max(value, minV), maxV);
}

function blendForm(season: number | null, l10: number | null, l5: number | null) {
  if (season === null && l10 === null && l5 === null) return null;
  return (
    (season ?? 0) * 0.55 +
    (l10 ?? season ?? 0) * 0.3 +
    (l5 ?? l10 ?? season ?? 0) * 0.15
  );
}

function blendWithMl(form: number | null, ml: number | null) {
  if (form === null && ml === null) return null;
  if (ml === null) return form;
  if (form === null) return ml;
  return form * 0.7 + ml * 0.3;
}

function confidenceScore(opts: {
  seasonGames?: number | null;
  hasMissingStats: boolean;
  notes: string;
}) {
  let c = 0.75;
  if (opts.seasonGames !== null && opts.seasonGames !== undefined && opts.seasonGames < 5) {
    c -= 0.15;
  }
  if (opts.hasMissingStats) c -= 0.1;
  if (/questionable|minutes limit|restriction|on a limit/i.test(opts.notes)) c -= 0.1;
  return clamp(c, 0.2, 0.9);
}

function findMinutesLimit(notes: string, playerName?: string) {
  const text = notes.toLowerCase();
  const nameHit = playerName ? text.includes(playerName.toLowerCase()) : true;
  const match = text.match(/minutes\s+limit\s+(\d{1,2})/i);
  if (!match || !nameHit) return null;
  const val = Number(match[1]);
  return Number.isFinite(val) ? val : null;
}

function matchesName(notesLower: string, playerName?: string) {
  if (!playerName) return false;
  const full = playerName.toLowerCase();
  if (notesLower.includes(full)) return true;
  const parts = full.split(/\s+/).filter(Boolean);
  return parts.some((p) => p.length > 2 && notesLower.includes(p));
}

function isOut(notes: string, playerName?: string) {
  const text = notes.toLowerCase();
  const outPatterns = [
    "out",
    "will not play",
    "not playing",
    "inactive",
    "dnp",
    "ruled out",
    "sitting",
    "did not travel",
  ];
  const hit = outPatterns.some((p) => text.includes(p));
  if (!hit) return false;
  if (!playerName) return true;
  return matchesName(text, playerName);
}

type RecentForm = {
  pts_l5: number | null;
  pts_l10: number | null;
  pts_season: number | null;
  reb_l5: number | null;
  reb_l10: number | null;
  reb_season: number | null;
  ast_l5: number | null;
  ast_l10: number | null;
  ast_season: number | null;
  pra_l5: number | null;
  pra_l10: number | null;
  pra_season: number | null;
  min_l5: number | null;
  min_l10: number | null;
  min_season: number | null;
  games_in_season: number | null;
};

function normalizeRecentForm(row: any | null): RecentForm | null {
  if (!row) return null;
  return {
    pts_l5: num(row.pts_l5),
    pts_l10: num(row.pts_l10),
    pts_season: num(row.pts_season),
    reb_l5: num(row.reb_l5),
    reb_l10: num(row.reb_l10),
    reb_season: num(row.reb_season),
    ast_l5: num(row.ast_l5),
    ast_l10: num(row.ast_l10),
    ast_season: num(row.ast_season),
    pra_l5: num(row.pra_l5),
    pra_l10: num(row.pra_l10),
    pra_season: num(row.pra_season),
    min_l5: num(row.min_l5),
    min_l10: num(row.min_l10),
    min_season: num(row.min_season),
    games_in_season: num(row.games_in_season),
  };
}

/**
 * A-tier explanation prompt:
 * - Must NOT invent injuries/news.
 * - Must reference the numbers provided.
 * - Must explain minutes driver + scoring driver + risk/upside.
 * - Bettor-style concise.
 * - Still returns STRICT JSON with deltas (same schema).
 */
function systemPrompt() {
  return [
    "You are an NBA projection adjustment + explanation engine for a betting-style UI.",
    "",
    "You receive per-player baselines (minutes_base, pts_blend, reb_blend, ast_blend, pra_blend),",
    "plus supporting context (L5/L10/Season, schedule flags, optional ML means).",
    "",
    "Your job:",
    "1) Apply SMALL, conservative adjustments (deltas) based only on user_notes.",
    "2) Produce A-TIER explanations grounded in the numbers provided.",
    "",
    "Hard constraints:",
    "- Output MUST be STRICT JSON (no markdown, no prose outside JSON).",
    "- Do NOT invent injuries/news/stats. Only use user_notes + the provided numbers.",
    "- If you are unsure, keep deltas near 0 and explain uncertainty.",
    "",
    "Delta rules (MUST obey):",
    "- minutes_delta: integer in [-6, 6].",
    "- pts_delta: number in [-8, 8].",
    "- reb_delta: number in [-4, 4].",
    "- ast_delta: number in [-4, 4].",
    "",
    "OUT rule:",
    "- If user_notes clearly indicate a player is OUT / not playing / inactive / ruled out / DNP,",
    "  set minutes_delta so final minutes becomes 0, and set pts_delta/reb_delta/ast_delta so final stats become 0.",
    "  Add tag 'out'. Infer player identity from first/last name mentions.",
    "",
    "Minutes-limit rule:",
    "- If user_notes mention 'minutes limit XX' for a player, bias minutes_delta downward and tag 'minutes_limit'.",
    "",
    "Teammate redistribution rule:",
    "- If a high-usage player is out, modestly increase minutes and/or pts/ast for primary teammates.",
    "  Keep deltas modest and explain role/usage consolidates.",
    "",
    "EXPLANATIONS (critical):",
    "For EACH player, include 3–5 reason bullets.",
    "Each player's reasons MUST include:",
    "A) Minutes driver (compare minutes_base to L10/Season if available).",
    "B) Production driver (cite L5/L10/Season and/or ML mean).",
    "C) One downside risk and one upside path.",
    "",
    "Style guidelines:",
    "- Bettor/analyst tone, short and sharp.",
    "- Always reference at least ONE of: minutes_base, season, l10, l5, ml_mean, schedule flags.",
    "- If user_notes are used for a player, one bullet must quote/paraphrase the note.",
    "",
    "Top-level output requirements:",
    "- Include game_id and model_version at the TOP LEVEL.",
    "- Include notes_used_summary (1 short sentence).",
    "- Include player_adjustments with ONE entry per player_id provided.",
    "",
    "Do NOT drop players. Do NOT return empty reasons.",
  ].join("\n");
}

function userPrompt(game: any, notes: string, players: any[], modelVersion: string) {
  return JSON.stringify(
    {
      game,
      model_version: modelVersion,
      user_notes: notes,
      players,
      output_schema: {
        game_id: "number (REQUIRED at top-level)",
        model_version: "string (REQUIRED at top-level)",
        notes_used_summary: "string (1 short sentence; mention if no actionable notes)",
        player_adjustments: [
          {
            player_id: "number",
            minutes_delta: "integer [-6..6]",
            pts_delta: "number [-8..8]",
            reb_delta: "number [-4..4]",
            ast_delta: "number [-4..4]",
            tags: "string[]",
            reasons: "string[] (3–5 bullets; MUST mention minutes driver + production driver + risk/upside)",
            confidence_override: "number|null (0.2..0.95) optional",
          },
        ],
      },
      explanation_contract: [
        "Reasons must cite numbers from provided data (minutes_base, L5/L10/Season, ML mean, schedule flags).",
        "No invented injuries/news. Only user_notes may introduce injury/minutes info.",
        "If player is OUT per notes: final minutes/stats must become 0 via deltas; tag 'out'.",
        "If notes are vague/non-actionable: keep deltas ~0 and explain uncertainty.",
      ],
    },
    null,
    0
  );
}

function validateLlmOutput(obj: any, gameId: number, modelVersion: string) {
  const resolvedGameId = obj?.game_id !== undefined ? obj.game_id : obj?.game?.game_id;
  if (resolvedGameId !== gameId) throw new Error("game_id mismatch");
  if (obj.model_version !== modelVersion) throw new Error("model_version mismatch");
  if (!Array.isArray(obj.player_adjustments)) throw new Error("player_adjustments missing");
  obj.player_adjustments.forEach((p: any) => {
    if (typeof p.player_id !== "number") throw new Error("player_id missing");
    ["minutes_delta", "pts_delta", "reb_delta", "ast_delta"].forEach((k) => {
      if (p[k] === undefined || p[k] === null) throw new Error(`${k} missing`);
    });
    if (!Array.isArray(p.reasons) || p.reasons.length < 3) {
      throw new Error("reasons missing/too short");
    }
  });
}

export async function POST(req: NextRequest) {
  const debug: { steps: QueryLog[]; error?: string; trace?: string } = { steps: [] };

  try {
    const body = await req.json();
    const gameId = Number(body.game_id);
    const modelVersion = (body.model_version || DEFAULT_MODEL_VERSION).trim();
    const userNotes = (body.user_notes || "").toString();

    if (!Number.isFinite(gameId)) {
      return NextResponse.json({ error: "game_id required", debug }, { status: 400 });
    }

    // Q1 game info
    const t1 = Date.now();
    const gameRes = await supabase
      .from("nba_games-2025-26")
      .select("game_id, game_date, home_team_id, away_team_id")
      .eq("game_id", gameId)
      .maybeSingle();

    debug.steps.push({
      step: "game_info",
      ms: Date.now() - t1,
      rows: gameRes.data ? 1 : 0,
      error: gameRes.error?.message,
      sample: gameRes.data,
    });

    if (gameRes.error || !gameRes.data) {
      return NextResponse.json({ error: "Game not found", debug }, { status: 404 });
    }
    const game = gameRes.data;

    // Team lookup
    const teamLookupStart = Date.now();
    const teamIds: number[] = [];
    if (game.home_team_id) teamIds.push(game.home_team_id);
    if (game.away_team_id) teamIds.push(game.away_team_id);

    const teamRes =
      teamIds.length > 0
        ? await supabase
            .from("team_id_to_team")
            .select("team_id, abbreviation")
            .in("team_id", teamIds)
        : { data: [], error: null };

    debug.steps.push({
      step: "team_lookup",
      ms: Date.now() - teamLookupStart,
      rows: Array.isArray((teamRes as any).data) ? (teamRes as any).data.length : 0,
      error: (teamRes as any).error?.message,
      sample: (teamRes as any).data?.slice?.(0, 2),
    });

    const abbrMap = new Map<number, string>();
    if (Array.isArray((teamRes as any).data)) {
      (teamRes as any).data.forEach((t: any) => {
        if (t.team_id && t.abbreviation) abbrMap.set(t.team_id, t.abbreviation);
      });
    }

    const homeTeamAbbr = game.home_team_id ? abbrMap.get(game.home_team_id) : undefined;
    const awayTeamAbbr = game.away_team_id ? abbrMap.get(game.away_team_id) : undefined;

    // Q2 roster
    const t2 = Date.now();
    const rosterRes = await supabase
      .from("player_game_roster")
      .select("game_id, player_id, team_abbr, expected_active")
      .eq("game_id", gameId)
      .eq("expected_active", true);

    debug.steps.push({
      step: "roster",
      ms: Date.now() - t2,
      rows: rosterRes.data?.length ?? 0,
      error: rosterRes.error?.message,
      sample: rosterRes.data?.slice(0, 2),
    });

    const roster = (rosterRes.data ?? []).filter((r) => r.expected_active);
    const playerIds = roster.map((r) => r.player_id);

    if (!playerIds.length) {
      return NextResponse.json(
        { error: "No expected active players for this game", debug },
        { status: 400 }
      );
    }

    // Q3 features (schedule/opponent + baseline + (possibly wrong) l5/l10 values)
    const t3 = Date.now();
    const featureRes = await supabase
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
        is_home, opponent_team_id,
        pts_baseline, reb_baseline, ast_baseline, pra_baseline, min_baseline
      `
      )
      .eq("game_id", gameId)
      .in("player_id", playerIds);

    debug.steps.push({
      step: "features",
      ms: Date.now() - t3,
      rows: featureRes.data?.length ?? 0,
      error: featureRes.error?.message,
      sample: featureRes.data?.slice(0, 2),
    });

    const featureRows = featureRes.data ?? [];
    if (!featureRows.length) {
      return NextResponse.json(
        { error: "No features for this game yet. Run nightly pipeline.", debug },
        { status: 400 }
      );
    }

    const featureMap = new Map<number, any>();
    featureRows.forEach((f) => featureMap.set(f.player_id, f));

    // Q3.5 recent form (TRUTH) via RPC get_recent_form (this is the missing piece)
    const t35 = Date.now();
    const gameDateForRecentForm =
      featureRows?.[0]?.game_date ?? game?.game_date ?? null;

    const recentFormMap = new Map<number, RecentForm>();

    if (gameDateForRecentForm) {
      const rfResults = await Promise.all(
        playerIds.map(async (pid) => {
          const { data: rfData, error: rfError } = await supabase.rpc("get_recent_form", {
            p_player_id: pid,
            p_as_of_date: gameDateForRecentForm,
          });

          if (rfError) {
            return { pid, rf: null as RecentForm | null, error: rfError.message };
          }

          const rfRow = Array.isArray(rfData) ? rfData[0] : rfData;
          const rf = normalizeRecentForm(rfRow ?? null);
          return { pid, rf, error: null as string | null };
        })
      );

      rfResults.forEach((r) => {
        if (r.rf) recentFormMap.set(r.pid, r.rf);
      });

      debug.steps.push({
        step: "recent_form_rpc",
        ms: Date.now() - t35,
        rows: recentFormMap.size,
        error: null,
        sample: rfResults.slice(0, 2),
      });
    } else {
      debug.steps.push({
        step: "recent_form_rpc",
        ms: Date.now() - t35,
        rows: 0,
        error: "Missing game_date for recent form",
      });
    }

    // Q4 ml predictions
    const t4 = Date.now();
    const mlRes = await supabase
      .from("ml_predictions")
      .select("game_id, player_id, stat_type, model_mean, model_std, model_version")
      .eq("game_id", gameId)
      .eq("model_version", modelVersion)
      .in("player_id", playerIds)
      .in("stat_type", STAT_TYPES);

    debug.steps.push({
      step: "ml_predictions",
      ms: Date.now() - t4,
      rows: mlRes.data?.length ?? 0,
      error: mlRes.error?.message,
      sample: mlRes.data?.slice(0, 2),
    });

    const mlMap = new Map<string, { mean: number | null; std: number | null }>();
    (mlRes.data ?? []).forEach((row) => {
      mlMap.set(`${row.player_id}:${row.stat_type}`, {
        mean: num(row.model_mean),
        std: num(row.model_std),
      });
    });

    // Q5 names
    const t5 = Date.now();
    const nameRes = await supabase
      .from("player_team_position")
      .select("player_id, player_name, team")
      .in("player_id", playerIds);

    debug.steps.push({
      step: "names",
      ms: Date.now() - t5,
      rows: nameRes.data?.length ?? 0,
      error: nameRes.error?.message,
      sample: nameRes.data?.slice(0, 2),
    });

    const nameMap = new Map<number, string>();
    (nameRes.data ?? []).forEach((r) => {
      if (r.player_name) nameMap.set(r.player_id, r.player_name);
    });

    // Baseline assembly (uses TRUTH recent form if available, falls back to player_game_features)
    const baselineStart = Date.now();
    const playerPackets: any[] = [];

    roster.forEach((r) => {
      const f = featureMap.get(r.player_id) || {};
      const rf = recentFormMap.get(r.player_id) || null;

      const mlMean = (stat: StatType) => mlMap.get(`${r.player_id}:${stat}`)?.mean ?? null;
      const statBaseline = (key: string) => num((f as any)[`${key}_baseline`]);

      const min_l10 = rf?.min_l10 ?? num(f.min_l10);
      const min_season = rf?.min_season ?? num(f.min_season_avg) ?? statBaseline("min");

      let minutes_base: number | null = null;
      if (min_l10 !== null || min_season !== null) {
        minutes_base = clamp((min_l10 ?? 0) * 0.6 + (min_season ?? 0) * 0.4, 0, 42);
      } else {
        minutes_base = statBaseline("min") ?? 20;
      }

      const pts_form_raw = blendForm(
        rf?.pts_season ?? num(f.pts_season_avg),
        rf?.pts_l10 ?? num(f.pts_l10),
        rf?.pts_l5 ?? num(f.pts_l5)
      );
      const reb_form_raw = blendForm(
        rf?.reb_season ?? num(f.reb_season_avg),
        rf?.reb_l10 ?? num(f.reb_l10),
        rf?.reb_l5 ?? num(f.reb_l5)
      );
      const ast_form_raw = blendForm(
        rf?.ast_season ?? num(f.ast_season_avg),
        rf?.ast_l10 ?? num(f.ast_l10),
        rf?.ast_l5 ?? num(f.ast_l5)
      );

      const pts_form = pts_form_raw ?? mlMean("PTS") ?? statBaseline("pts") ?? null;
      const reb_form = reb_form_raw ?? mlMean("REB") ?? statBaseline("reb") ?? null;
      const ast_form = ast_form_raw ?? mlMean("AST") ?? statBaseline("ast") ?? null;

      const pts_blend = blendWithMl(pts_form, mlMean("PTS"));
      const reb_blend = blendWithMl(reb_form, mlMean("REB"));
      const ast_blend = blendWithMl(ast_form, mlMean("AST"));
      const pra_blend = (pts_blend ?? 0) + (reb_blend ?? 0) + (ast_blend ?? 0);

      const hasMissingStats =
        pts_form === null ||
        reb_form === null ||
        ast_form === null ||
        min_l10 === null ||
        min_season === null;

      // NOTE: keeping your original behavior intact (seasonGames not reliable because season is text)
      const confidence = confidenceScore({
        seasonGames: num(f.season),
        hasMissingStats,
        notes: userNotes,
      });

      playerPackets.push({
        player_id: r.player_id,
        name: nameMap.get(r.player_id) || `Player ${r.player_id}`,
        team_abbr: r.team_abbr ?? "",
        baseline: {
          minutes_base,
          pts_blend,
          reb_blend,
          ast_blend,
          pra_blend,
          confidence,
        },
        stats: {
          form: { pts_form, reb_form, ast_form },
          ml: {
            pts: mlMean("PTS"),
            reb: mlMean("REB"),
            ast: mlMean("AST"),
            pra: mlMean("PRA"),
          },
          recency: {
            min_l5: rf?.min_l5 ?? num(f.min_l5),
            min_l10: rf?.min_l10 ?? num(f.min_l10),
            min_season: rf?.min_season ?? num(f.min_season_avg),

            pts_l5: rf?.pts_l5 ?? num(f.pts_l5),
            pts_l10: rf?.pts_l10 ?? num(f.pts_l10),
            pts_season: rf?.pts_season ?? num(f.pts_season_avg),

            reb_l5: rf?.reb_l5 ?? num(f.reb_l5),
            reb_l10: rf?.reb_l10 ?? num(f.reb_l10),
            reb_season: rf?.reb_season ?? num(f.reb_season_avg),

            ast_l5: rf?.ast_l5 ?? num(f.ast_l5),
            ast_l10: rf?.ast_l10 ?? num(f.ast_l10),
            ast_season: rf?.ast_season ?? num(f.ast_season_avg),

            pra_l5: rf?.pra_l5 ?? num(f.pra_l5),
            pra_l10: rf?.pra_l10 ?? num(f.pra_l10),
            pra_season: rf?.pra_season ?? num(f.pra_season_avg),
          },
          schedule: {
            days_rest: num(f.days_rest),
            is_back_to_back: toBoolean(f.is_back_to_back) ?? !!f.is_back_to_back,
            is_3_in_4: toBoolean(f.is_3_in_4) ?? !!f.is_3_in_4,
            is_4_in_6: toBoolean(f.is_4_in_6) ?? !!f.is_4_in_6,
            is_home: toBoolean(f.is_home),
            opponent_team_id: num(f.opponent_team_id),
          },
        },
      });
    });

    debug.steps.push({
      step: "baseline",
      ms: Date.now() - baselineStart,
      rows: playerPackets.length,
      sample: playerPackets.slice(0, 2),
    });

    // LLM call
    const llmStart = Date.now();
    let llmRaw: string | null = null;
    let llmPayload: any = {
      game_id: gameId,
      model_version: modelVersion,
      notes_used_summary: "",
      player_adjustments: [],
    };

    try {
      const sys = systemPrompt();
      const usr = userPrompt(
        {
          game_id: game.game_id,
          game_date: game.game_date,
          home_team_abbr: homeTeamAbbr ?? null,
          away_team_abbr: awayTeamAbbr ?? null,
        },
        userNotes,
        playerPackets,
        modelVersion
      );

      console.log("[AI GAME PROJ] LLM prompt", { system: sys, user: usr });

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
            temperature: 0.15,
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: sys },
              { role: "user", content: usr },
            ],
          }),
        }
      );

      llmRaw = await res.text();
      if (!res.ok) {
        console.error("[AI GAME PROJ] LLM HTTP error", res.status, llmRaw?.slice(0, 500));
        throw new Error(`LLM status ${res.status}: ${llmRaw?.slice(0, 300)}`);
      }

      const parsed = JSON.parse(llmRaw);
      validateLlmOutput(parsed, gameId, modelVersion);
      llmPayload = {
        ...parsed,
        game_id:
          parsed?.game_id !== undefined ? parsed.game_id : parsed?.game?.game_id ?? gameId,
      };
    } catch (err) {
      console.error("[AI GAME PROJ] LLM failure", err instanceof Error ? err.message : err, llmRaw);

      debug.steps.push({
        step: "llm",
        ms: Date.now() - llmStart,
        error: err instanceof Error ? err.message : String(err),
        raw: llmRaw?.slice?.(0, 500),
      });

      // Strong fallback explanations using TRUTH recency if available
      llmPayload.player_adjustments = playerPackets.map((p) => {
        const rec = p.stats?.recency || {};
        const minBase = p.baseline.minutes_base ?? 0;
        const ptsBase = p.baseline.pts_blend ?? 0;

        return {
          player_id: p.player_id,
          minutes_delta: 0,
          pts_delta: 0,
          reb_delta: 0,
          ast_delta: 0,
          tags: ["baseline_only"],
          reasons: [
            `Minutes anchored at ${minBase.toFixed(0)} (L10 ${rec.min_l10 ?? "NA"}, season ${rec.min_season ?? "NA"}).`,
            `Points baseline ${ptsBase.toFixed(1)} (L10 ${rec.pts_l10 ?? "NA"}, season ${rec.pts_season ?? "NA"}); no note-based adjustment applied.`,
            "Downside: rotation/early fouls can cut minutes; upside: tight game can push minutes above baseline.",
          ],
          confidence_override: null,
        };
      });

      llmPayload.notes_used_summary =
        "LLM failed; returned baseline projections with analyst-style fallback explanations.";
    }

    debug.steps.push({
      step: "llm_done",
      ms: Date.now() - llmStart,
      rows: llmPayload.player_adjustments?.length ?? 0,
      sample: llmPayload.player_adjustments?.slice?.(0, 2),
    });

    const adjMap = new Map<number, any>();
    (llmPayload.player_adjustments ?? []).forEach((a: any) => adjMap.set(a.player_id, a));

    const players = playerPackets.map((p) => {
      const adj = adjMap.get(p.player_id) || {};
      const minutes_delta = clamp(adj.minutes_delta ?? 0, -6, 6);
      const pts_delta = clamp(adj.pts_delta ?? 0, -8, 8);
      const reb_delta = clamp(adj.reb_delta ?? 0, -4, 4);
      const ast_delta = clamp(adj.ast_delta ?? 0, -4, 4);

      let minutes_final = clamp(Math.round((p.baseline.minutes_base ?? 0) + minutes_delta), 0, 42);
      let pts_final = Math.max(0, (p.baseline.pts_blend ?? 0) + pts_delta);
      let reb_final = Math.max(0, (p.baseline.reb_blend ?? 0) + reb_delta);
      let ast_final = Math.max(0, (p.baseline.ast_blend ?? 0) + ast_delta);

      const limit = findMinutesLimit(userNotes, p.name);
      if (limit !== null) minutes_final = Math.min(minutes_final, limit);

      if (isOut(userNotes, p.name)) {
        minutes_final = 0;
        pts_final = 0;
        reb_final = 0;
        ast_final = 0;
      }

      const pra_final = pts_final + reb_final + ast_final;
      const confidence =
        adj.confidence_override !== undefined && adj.confidence_override !== null
          ? clamp(adj.confidence_override, 0.2, 0.95)
          : p.baseline.confidence;

      return {
        player_id: p.player_id,
        team_abbr: p.team_abbr,
        name: p.name,
        baseline: p.baseline,
        llm_adjustments: {
          ...adj,
          minutes_delta,
          pts_delta,
          reb_delta,
          ast_delta,
        },
        final: {
          minutes: minutes_final,
          pts: pts_final,
          reb: reb_final,
          ast: ast_final,
          pra: pra_final,
          confidence,
        },
        explanations: Array.isArray(adj.reasons) ? adj.reasons : [],
      };
    });

    return NextResponse.json({
      game_id: gameId,
      model_version: modelVersion,
      generated_at: new Date().toISOString(),
      notes_used_summary: llmPayload.notes_used_summary ?? "",
      players,
      debug,
    });
  } catch (err) {
    debug.error = err instanceof Error ? err.message : String(err);
    debug.trace = err instanceof Error ? err.stack : undefined;
    return NextResponse.json({ error: "Server error", debug }, { status: 500 });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
