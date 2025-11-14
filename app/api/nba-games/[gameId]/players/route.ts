// app/api/nba-games/[gameId]/players/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const PERGAME_TABLE = "pergame_player_base_stats_2025_26";

type RawRow = {
  game_id: number;
  team_abbr: string | null;
  player_id: number;
  player_name: string | null;
  start_pos: string | null;
  min: string | null;
  oreb: string | null;
  dreb: string | null;
  reb: string | null;
  ast: number | null;
  stl: number | null;
  blk: string | null;
  tov: number | null;
  pf: number | null;
  pts: number | null;
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  try {
    const { gameId } = await params;
    if (!gameId) {
      return NextResponse.json(
        { error: "Missing gameId" },
        { status: 400 }
      );
    }
    const gameIdNum = Number(gameId);
    if (Number.isNaN(gameIdNum)) {
      return NextResponse.json({ error: "Invalid gameId" }, { status: 400 });
    }

    const { data, error } = await supabase
      .from(PERGAME_TABLE)
      .select(
        `
        game_id,
        team_abbr,
        player_id,
        player_name,
        start_pos,
        min,
        oreb,
        dreb,
        reb,
        ast,
        stl,
        blk,
        tov,
        pf,
        pts
      `
      )
      .eq("game_id", gameIdNum)
      .order("team_abbr", { ascending: true })
      .order("player_name", { ascending: true });

    if (error) {
      console.error("Supabase error fetching players for game:", error);
      return NextResponse.json(
        { error: "Failed to fetch players." },
        { status: 500 }
      );
    }

    const raw = (data ?? []) as RawRow[];

    const players = raw.map((row) => ({
      game_id: row.game_id,
      team_abbr: row.team_abbr,
      player_id: row.player_id,
      player_name: row.player_name,
      start_pos: row.start_pos,
      min: row.min,
      oreb: row.oreb,
      dreb: row.dreb,
      reb: row.reb,
      ast: row.ast,
      stl: row.stl,
      blk: row.blk,
      tov: row.tov,
      pf: row.pf,
      pts: row.pts,
    }));

    return NextResponse.json({ players });
  } catch (err) {
    console.error(
      "Unexpected error in GET /api/nba-games/[gameId]/players:",
      err
    );
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
