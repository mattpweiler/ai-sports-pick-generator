-- Extensions
create extension if not exists pgcrypto;

-- Enums
do $$
begin
  if not exists (select 1 from pg_type where typname = 'season_type') then
    create type season_type as enum ('pre','reg','post','play-in');
  end if;

  if not exists (select 1 from pg_type where typname = 'avail_status') then
    create type avail_status as enum ('out','doubtful','questionable','probable','active','rest','minutes_limit');
  end if;
end$$;

-- Reference tables
create table if not exists stat_categories (
  stat_cat_id smallserial primary key,
  code text unique not null,          -- 'PTS','AST','REB','PRA'
  description text
);

create table if not exists bookmakers (
  book_id smallserial primary key,
  name text unique not null           -- 'ConsensusBook' or your chosen book
);

-- Core dimensions
create table if not exists seasons (
  season_id int primary key,          -- e.g. 2025
  start_date date not null,
  end_date date not null,
  type season_type not null
);

create table if not exists teams (
  team_id uuid primary key default gen_random_uuid(),
  abbr text not null,
  name text not null
);

create table if not exists players (
  player_id uuid primary key default gen_random_uuid(),
  first_name text not null,
  last_name text not null,
  pos text
);

-- Games
create table if not exists games (
  game_id uuid primary key default gen_random_uuid(),
  season_id int not null references seasons(season_id),
  game_date date not null,
  tipoff_utc timestamptz,
  home_team_id uuid not null references teams(team_id),
  away_team_id uuid not null references teams(team_id),
  status text not null check (status in ('scheduled','in_progress','final')),
  home_score int,
  away_score int
);
create index if not exists idx_games_season_date on games (season_id, game_date);
create index if not exists idx_games_date on games (game_date);

-- Boxscores (training labels / evaluation)
create table if not exists player_boxscores (
  game_id uuid not null references games(game_id),
  team_id uuid not null references teams(team_id),
  player_id uuid not null references players(player_id),
  minutes numeric(5,2),
  pts int, ast int,
  reb_off int, reb_def int,
  blk int, stl int, tov int, pf int,
  fga int, fgm int, fta int, ftm int, tpa int, tpm int,
  starter boolean,
  primary key (game_id, player_id)
);
create index if not exists idx_pbx_player_game on player_boxscores (player_id, game_id);

-- Clean availability (effective status for modeling/UI)
create table if not exists player_availability (
  availability_id uuid primary key default gen_random_uuid(),
  player_id uuid not null references players(player_id),
  game_id uuid references games(game_id),  -- nullable for general status
  effective_from timestamptz not null,
  effective_to timestamptz,
  status avail_status not null,
  minutes_cap int,
  reason text
);
create index if not exists idx_avail_player_from on player_availability (player_id, effective_from);
create index if not exists idx_avail_game_status on player_availability (game_id, status);

-- Minimal props (take 1 near-close snapshot per player/stat/game)
create table if not exists odds_prop_snapshots (
  snapshot_id bigserial primary key,
  game_id uuid not null references games(game_id),
  player_id uuid not null references players(player_id),
  book_id smallint not null references bookmakers(book_id),
  stat_cat_id smallint not null references stat_categories(stat_cat_id),
  fetched_at timestamptz not null,
  line numeric(6,2) not null,     -- e.g., 24.5
  over_price int not null,        -- American odds
  under_price int not null
);
create index if not exists idx_ops_key_time on odds_prop_snapshots (game_id, player_id, stat_cat_id, fetched_at desc);

-- Features (wide jsonb; optionally include stat_cat_id per-row)
create table if not exists features_player_game (
  player_id uuid not null references players(player_id),
  game_id uuid not null references games(game_id),
  stat_cat_id smallint null references stat_categories(stat_cat_id),
  as_of timestamptz not null,
  features jsonb not null,
  primary key (player_id, game_id, stat_cat_id, as_of)
);
create index if not exists idx_fpg_game on features_player_game (game_id);
create index if not exists idx_fpg_player_game on features_player_game (player_id, game_id);
create index if not exists idx_fpg_features_gin on features_player_game using gin (features jsonb_path_ops);

-- Predictions (model output)
create table if not exists predictions_player_game (
  prediction_id bigserial primary key,
  player_id uuid not null references players(player_id),
  game_id uuid not null references games(game_id),
  stat_cat_id smallint not null references stat_categories(stat_cat_id),
  model_name text not null,
  as_of timestamptz not null,
  point_estimate numeric(7,3),    -- mean prediction for stat
  stdev numeric(7,3),
  prob_over_at_line numeric(6,4), -- optional if you reference a prop line
  unique (player_id, game_id, stat_cat_id, model_name, as_of)
);
create index if not exists idx_pred_latest on predictions_player_game (game_id, player_id, stat_cat_id, as_of desc);

-- Convenience view: latest prop per (game,player,stat)
drop view if exists v_current_market_props;
create view v_current_market_props as
select distinct on (game_id, player_id, stat_cat_id)
  game_id, player_id, stat_cat_id, book_id, fetched_at, line, over_price, under_price
from odds_prop_snapshots
order by game_id, player_id, stat_cat_id, fetched_at desc;

-- Seeds
insert into stat_categories (code, description) values
  ('PTS','Points'), ('AST','Assists'), ('REB','Rebounds'), ('PRA','Points+Rebounds+Assists')
on conflict (code) do nothing;

insert into bookmakers (name) values ('ConsensusBook')
on conflict (name) do nothing;
