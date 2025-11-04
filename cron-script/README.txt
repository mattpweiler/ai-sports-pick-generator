How to use route.ts
 
Once deployed, you can hit (GET) the route like:

/api/nba-sync?season=2025-26&seasonType=Regular%20Season&dateFrom=2025-10-30&dateTo=2025-11-04&recentDays=7&schema=public&table=pergame_player_base_stats_2025_26&dryRun=true

Flip dryRun=false (or omit) to actually upsert.

Security tip: protect this endpoint with a secret (e.g., require a header like x-cron-key) if you’ll trigger it via Vercel Cron. Keep the Supabase service role only on the server—never call this endpoint from a public browser without protection.


2) What you need to run this on Vercel (dependencies & config)
package.json (key parts)

{
  "name": "nba-supabase-sync",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "@supabase/supabase-js": "^2.45.0",
    "next": "^14.2.5",
    "react": "^18.2.0",
    "react-dom": "^18.2.0"
  }
}


Notes


No extra fetch polyfills needed on Vercel (Node 18+).
We rely on Node’s built-in crypto.
If you prefer JS instead of TS, rename route.ts → route.js and drop type annotations.


Environment Variables (Vercel → Settings → Environment Variables)

SUPABASE_URL — your project URL (e.g., https://xxxxx.supabase.co)
SUPABASE_SERVICE_ROLE — service role key (or an anon key with RLS allowing upsert)
(Optional) SUPABASE_SCHEMA — default public
(Optional) SUPABASE_TABLE — default pergame_player_base_stats_2025_26

If your table doesn’t include row_checksum and updated_at, that’s fine—the code strips them during upsert.

Next.js file layout (minimal)

/app
  /api
    /nba-sync
      route.ts
/package.json
/next.config.js (optional)


Optional: protect & schedule

Protect the route: add a required header check (e.g., x-cron-key === process.env.CRON_KEY) near the top of the handler.
Vercel Cron: add a vercel.json like:


{
  "crons": [
    {
      "path": "/api/nba-sync?season=2025-26&seasonType=Regular%20Season&recentDays=7",
      "schedule": "0 * * * *"
    }
  ]
}

…and set CRON_KEY + enforce it in the handler if you add header auth.


Parity with your Python script
Enumerates via leaguegamelog (team mode) for a date window
Re-syncs last recentDays to capture corrections
Normalizes both ALL_CAPS and camelCase variations from V3
Computes a deterministic row_checksum
Upserts on (game_id, player_id) in batches
Uses NBA request headers and retry/backoff to reduce 403/JSON flake
Defaults to a rolling 10-day window if dateFrom/dateTo not provided (matching your localized default logic, simplified for server)


If you’d like, I can also add:
a POST body (JSON) variant
strict zod validation of query params
stronger rate limiting / 429 handling
per-game sleep controls via query params (to mimic your SLEEP_BETWEEN_GAMES)
Want me to wire in header-based auth + a sample vercel.json cron with a secret next?
