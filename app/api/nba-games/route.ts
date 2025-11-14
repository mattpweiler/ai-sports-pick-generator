// app/api/nba-games/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

console.log(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE! // server-only key
);

// keep table name in one place
const GAMES_TABLE = "nba_games-2025-26";

/**
 * This function retrieves from the NBA games database
 * @param req 
 * @returns 
 */
export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const limitParam = searchParams.get("limit");

    const limit =
      limitParam && !Number.isNaN(Number(limitParam))
        ? Math.min(parseInt(limitParam, 10), 500)
        : undefined;

    let query = supabase
      .from(GAMES_TABLE)
      .select("*")
      .order("game_datetime_est", { ascending: true });

    if (limit) {
      query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
      console.error("Supabase error fetching games:", error);
      return NextResponse.json(
        { error: "Failed to fetch games." },
        { status: 500 }
      );
    }

    return NextResponse.json({ games: data ?? [] });
  } catch (err) {
    console.error("Unexpected error in GET /api/nba-games:", err);
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
}

export async function OPTIONS() {
  // CORS preflight (if you ever need it)
  return NextResponse.json({}, { status: 200 });
}
