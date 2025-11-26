from nba_api.stats.endpoints import leaguegamelog
from nba_api.stats.library.http import NBAStatsHTTP

NBAStatsHTTP.USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X)"

print("Requesting LeagueGameLog...")

try:
    gl = leaguegamelog.LeagueGameLog(
        season="2024-25",
        season_type_all_star="Regular Season"
    )
    df = gl.get_data_frames()[0]
    print(df.head())
except Exception as e:
    print("ERROR:", e)
