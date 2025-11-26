import requests

url = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"

resp = requests.get(url, timeout=10)

print("Status:", resp.status_code)
print("First 300 chars:")
print(resp.text[:300])
