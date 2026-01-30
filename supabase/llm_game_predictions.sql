-- Cache table for AI-generated game predictions.
create table if not exists llm_game_predictions (
  game_id bigint not null,
  model_version text not null,
  user_context_hash text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  primary key (game_id, model_version, user_context_hash)
);

create index if not exists idx_llm_game_predictions_lookup
  on llm_game_predictions (game_id, model_version, created_at desc);
