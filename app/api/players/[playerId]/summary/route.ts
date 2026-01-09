import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

type StatRow = {
  pts: number | string | null;
  reb: number | string | null;
  ast: number | string | null;
  stl: number | string | null;
  blk: number | string | null;
  tov: number | string | null;
  game_date: string | null;
  comment: string | null;
};

function toNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function average(value: number, divider: number) {
  return divider ? Number((value / divider).toFixed(1)) : null;
}

const EXCLUDED_COMMENTS = new Set([
  "DNP - Coach's Decision",
  "DND - Injury/Illness",
  "NWT - Not With Team",
  "NWT - Injury/Illness",
]);

function shouldExcludeByComment(comment: unknown) {
  return typeof comment === "string" && EXCLUDED_COMMENTS.has(comment.trim());
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ playerId: string }> }
) {
  try {
    const { playerId } = await params;
    const playerIdNum = Number(playerId);
    if (!playerId || Number.isNaN(playerIdNum)) {
      return NextResponse.json(
        { error: "Invalid playerId" },
        { status: 400 }
      );
    }

    const { data, error } = await supabase
      .from("pergame_player_base_stats_2025_26")
      .select("pts, reb, ast, stl, blk, tov, game_date, comment")
      .eq("player_id", playerIdNum)
      .order("game_date", { ascending: false })
      .limit(20);

    if (error) {
      console.error("Error fetching player summary:", error);
      return NextResponse.json(
        { error: "Failed to load player summary." },
        { status: 500 }
      );
    }

    const rows = (data ?? []) as StatRow[];
    const filteredRows = rows.filter(
      (row) => !shouldExcludeByComment(row.comment)
    );
    const recentRows = filteredRows.slice(0, 5);

    if (!recentRows.length) {
      return NextResponse.json({
        summary: {
          pts: null,
          reb: null,
          ast: null,
          stl: null,
          blk: null,
          tov: null,
          pra: null,
          sampleSize: 0,
        },
      });
    }

    let ptsSum = 0;
    let rebSum = 0;
    let astSum = 0;
    let stlSum = 0;
    let blkSum = 0;
    let tovSum = 0;

    recentRows.forEach((row) => {
      const pts = toNumber(row.pts);
      const reb = toNumber(row.reb);
      const ast = toNumber(row.ast);
      const stl = toNumber(row.stl);
      const blk = toNumber(row.blk);
      const tov = toNumber(row.tov);

      if (pts !== null) ptsSum += pts;
      if (reb !== null) rebSum += reb;
      if (ast !== null) astSum += ast;
      if (stl !== null) stlSum += stl;
      if (blk !== null) blkSum += blk;
      if (tov !== null) tovSum += tov;
    });

    const divider = recentRows.length;

    const summary = {
      pts: average(ptsSum, divider),
      reb: average(rebSum, divider),
      ast: average(astSum, divider),
      stl: average(stlSum, divider),
      blk: average(blkSum, divider),
      tov: average(tovSum, divider),
      pra: average(ptsSum + rebSum + astSum, divider),
      sampleSize: recentRows.length,
    };

    return NextResponse.json({ summary });
  } catch (err) {
    console.error("Unexpected error in player summary endpoint:", err);
    return NextResponse.json(
      { error: "Unexpected server error" },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
