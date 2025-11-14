// app/api/nba-games/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const GAMES_TABLE = "nba_games-2025-26";

type GameRow = {
  game_id: number;
  game_date: string | null;
  game_datetime_est: string | null;
  game_status_id: number | null;
  game_status_text: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
  national_tv: string | null;
  arena_name: string | null;
  game_code: string | null;
  game_sequence: number | null;
};

export async function GET(req: NextRequest) {
  try {
    const { data, error } = await supabase
      .from(GAMES_TABLE)
      .select(
        [
          "game_id",
          "game_date",
          "game_datetime_est",
          "game_status_id",
          "game_status_text",
          "home_team_id",
          "away_team_id",
          "national_tv",
          "arena_name",
          "game_code",
          "game_sequence",
        ].join(",")
      )
      .order("game_date", { ascending: true });

    if (error) {
      console.error("Supabase error fetching games:", error);
      return NextResponse.json(
        { error: "Failed to fetch games." },
        { status: 500 }
      );
    }

    return NextResponse.json({ games: (data as any[]) ?? [] });
  } catch (err) {
    console.error("Unexpected error in GET /api/nba-games:", err);
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
