// app/api/players/by-team/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const PLAYERS_TABLE = "player_team_position";

type PlayerRow = {
  player_id: number;
  player_name: string | null;
  team: string | null;
  active_status: number | null;
  position: string | null;
};

async function returnPlayersByTeam(
  teams: string[],
  activeOnly: boolean
): Promise<{ players: PlayerRow[]; error?: string }> {
  if (!teams.length) return { players: [], error: "No teams provided" };

  let query = supabase
    .from(PLAYERS_TABLE)
    .select("*")
    .in("team", teams);

  if (activeOnly) {
    query = query.eq("active_status", 1);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Supabase error in returnPlayersByTeam:", error);
    return { players: [], error: error.message };
  }

  return { players: (data as PlayerRow[]) ?? [] };
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);

    // ?team=CHA&team=LAL  or  ?teams=CHA,LAL
    const multiTeam = searchParams.getAll("team");
    const commaTeams = searchParams.get("teams");

    let teams: string[] = [];
    if (commaTeams) {
      teams = commaTeams
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean);
    } else if (multiTeam.length) {
      teams = multiTeam.map((t) => t.trim()).filter(Boolean);
    }

    const activeOnly = searchParams.get("activeOnly") === "true";

    const { players, error } = await returnPlayersByTeam(teams, activeOnly);

    if (error) {
      return NextResponse.json({ players, error }, { status: 400 });
    }

    return NextResponse.json({ players });
  } catch (err) {
    console.error("Unexpected error in /api/players/by-team:", err);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
