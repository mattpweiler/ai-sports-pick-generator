export type AiBaseline = {
  minutes_base: number | null;
  pts_blend: number | null;
  reb_blend: number | null;
  ast_blend: number | null;
  pra_blend: number | null;
  confidence: number | null;
};

export type AiFinal = {
  minutes: number;
  pts: number;
  reb: number;
  ast: number;
  pra: number;
  confidence: number | null;
};

export type AiAdjustment = {
  minutes_delta: number;
  pts_delta: number;
  reb_delta: number;
  ast_delta: number;
  tags?: string[];
  reasons?: string[];
  confidence_override?: number | null;
};

export type AiGamePlayer = {
  player_id: number;
  team_abbr: string;
  name?: string;
  baseline: AiBaseline;
  llm_adjustments: AiAdjustment;
  final: AiFinal;
  explanations: string[];
};

export type AiGameProjectionsResponse = {
  game_id: number;
  model_version: string;
  generated_at: string;
  players: AiGamePlayer[];
  debug?: Record<string, unknown>;
  assumptions?: string[];
};

export type AiPlayerSuggestion = {
  player_id: number;
  team_abbr: string;
  minutes: number;
  pts: number;
  reb: number;
  ast: number;
  pra: number;
  confidence: "High" | "Medium" | "Low";
  why: string[];
};

export type AiGamePredictionPayload = {
  game_id: number;
  model_version: string;
  generated_at: string;
  assumptions: string[];
  players: AiPlayerSuggestion[];
};

export type AiGamePredictionRequest = {
  game_id: number;
  user_context_text?: string;
  use_ml_baseline?: boolean;
  model_version?: string;
};
