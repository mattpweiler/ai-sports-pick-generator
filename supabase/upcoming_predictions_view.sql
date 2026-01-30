-- View to power the "Next 7 Days" predictions UI.
-- Filters in the client with date range + model_version.
create or replace view public.v_upcoming_player_predictions as
with base as (
  select
    f.game_date,
    f.game_id,
    f.player_id,
    f.team_abbr,
    f.opponent_team_id,
    f.is_home
  from public.player_game_features f
),
pred as (
  select
    p.game_id,
    p.player_id,
    p.stat_type,
    p.model_mean,
    p.model_std,
    p.model_version,
    p.generated_at,
    p.line,
    p.model_prob_over,
    p.market_prob_over,
    p.delta
  from public.ml_predictions p
)
select
  b.game_date,
  b.game_id,
  b.player_id,
  b.team_abbr,
  b.opponent_team_id,
  b.is_home,
  pr.stat_type,
  pr.model_mean,
  pr.model_std,
  pr.model_version,
  pr.generated_at,
  pr.line,
  pr.model_prob_over,
  pr.market_prob_over,
  pr.delta
from base b
join pred pr
  on pr.game_id = b.game_id
 and pr.player_id = b.player_id;
