export type StatType = "PTS" | "REB" | "AST" | "PRA";

export type StatSource = "ml" | "baseline" | "none";

export type StatPred = {
  statType: StatType;
  mean: number | null;
  std: number | null;
  source: StatSource;
};

export type PlayerFeatureContext = {
  game_date: string | null;
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
  min_l5: number | null;
  min_l10: number | null;
  min_season_avg: number | null;
  days_rest: number | null;
  is_back_to_back: boolean | null;
  is_home: boolean | null;
  opponent_team_id: number | null;
};

export type RecentForm = {
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

export type PredictionsResponse = {
  predictions: StatPred[];
  source: StatSource | null;
  modelVersion: string | null;
  features: PlayerFeatureContext | null;
  recentForm: RecentForm | null;
  error?: string;
};

export const STAT_TYPES: StatType[] = ["PTS", "REB", "AST", "PRA"];
export const STAT_ORDER: StatType[] = ["PTS", "REB", "AST", "PRA"];

// Temporary default until we add a selector in the UI.
export const DEFAULT_MODEL_VERSION = "v1";
