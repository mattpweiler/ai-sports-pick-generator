from datetime import date, timedelta

from nba_api.stats.endpoints import leaguegamelog, boxscoretraditionalv3
from nba_api.stats.library.http import NBAStatsHTTP

# Pretend to be a normal browser
NBAStatsHTTP.USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X)"

SEASON = "2025-26"
SEASON_TYPE = "Regular Season"

def main():
    # yesterday in MM/DD/YYYY (what LeagueGameLog expects)
    yesterday = date.today() - timedelta(days=1)
    date_str = yesterday.strftime("%m/%d/%Y")

    print(f"Requesting games on {date_str} for {SEASON} {SEASON_TYPE}...")

    gl = leaguegamelog.LeagueGameLog(
        season=SEASON,
        season_type_all_star=SEASON_TYPE,
        player_or_team_abbreviation="T",
        date_from_nullable=date_str,
        date_to_nullable=date_str,
    )
    games_df = gl.get_data_frames()[0]

    if games_df.empty:
        print("No games found for that date.")
        return

    game_ids = games_df["GAME_ID"].unique().tolist()
    print("Found game_ids:", game_ids)

    # Grab boxscores for each game
    for gid in game_ids:
        print(f"\n=== Boxscore for game {gid} ===")
        bs = boxscoretraditionalv3.BoxScoreTraditionalV3(game_id=gid)
        player_df = bs.get_data_frames()[0]  # player stats table
        print(player_df.head())

if __name__ == "__main__":
    main()
