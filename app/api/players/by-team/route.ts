// app/api/nba-games/[gameId]/players/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const GAMES_TABLE = "nba_games-2025-26";
const PLAYERS_TABLE = "player_team_position";
const TEAMS_TABLE = "team_id_to_team"; // adjust if named differently

type Player = {
  player_id: number;
  player_name: string;
  team: string;
  active_status: number;
  position: string | null;
};

async function returnPlayersByTeam(
  teams: string[]
): Promise<{ players: Player[]; error?: string }> {
  if (!teams.length) return { players: [], error: "No teams supplied" };

  const { data, error } = await supabase
    .from(PLAYERS_TABLE)
    .select("*")
    .in("team", teams)
    .eq("active_status", 1);

  if (error) {
    console.error("returnPlayersByTeam error:", error);
    return { players: [], error: error.message };
  }

  return { players: (data as Player[]) ?? [] };
}

export async function GET(
  req: NextRequest,
  context: { params?: { gameId?: string } }
) {
  try {
    const gameIdStr = context.params?.gameId;
    if (!gameIdStr) {
      return NextResponse.json(
        { error: "Missing gameId in route params" },
        { status: 400 }
      );
    }

    const gameId = Number(gameIdStr);
    if (Number.isNaN(gameId)) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    // 1. Get team IDs for this game
    const { data: game, error: gameError } = await supabase
      .from(GAMES_TABLE)
      .select("home_team_id, away_team_id")
      .eq("game_id", gameId)
      .single();

    if (gameError || !game) {
      console.error("Game fetch error:", gameError);
      return NextResponse.json({ error: "Game not found" }, { status: 404 });
    }

    // 2. Map IDs → team abbreviations via team_id_to_team
    // Adjust column names if your table uses something different
    const { data: homeTeamRow } = await supabase
      .from(TEAMS_TABLE)
      .select("team_abbrev")
      .eq("team_id", game.home_team_id)
      .single();

    const { data: awayTeamRow } = await supabase
      .from(TEAMS_TABLE)
      .select("team_abbrev")
      .eq("team_id", game.away_team_id)
      .single();

    const homeAbbrev = homeTeamRow?.team_abbrev;
    const awayAbbrev = awayTeamRow?.team_abbrev;

    if (!homeAbbrev || !awayAbbrev) {
      return NextResponse.json(
        { error: "Could not resolve team abbreviations" },
        { status: 500 }
      );
    }

    // 3. Look up players by team abbrev
    const { players, error } = await returnPlayersByTeam([
      homeAbbrev,
      awayAbbrev,
    ]);

    if (error) {
      return NextResponse.json({ players: [], error }, { status: 500 });
    }

    return NextResponse.json({ players });
  } catch (err) {
    console.error("Unexpected error in /api/nba-games/[gameId]/players:", err);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
