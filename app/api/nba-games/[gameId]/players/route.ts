// app/api/nba-games/[gameId]/players/route.ts
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const PERGAME_TABLE = "pergame_player_base_stats_2025_26";
const GAMES_TABLE = "nba_games-2025-26";
const TEAM_TABLE = "team_id_to_team";
const ROSTER_TABLE = "player_team_position";

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

type TeamRow = {
  team_id: number;
  full_name: string | null;
  abbreviation: string | null;
  nickname: string | null;
  city: string | null;
};

type RosterRow = {
  player_id: number;
  player_name: string | null;
  team: string | null;
  position: string | null;
  active_status: number | null;
};

type TeamRosterPlayer = {
  player_id: number;
  player_name: string | null;
  position: string | null;
  active_status: number | null;
};

type TeamRoster = {
  team_id: number;
  side: "home" | "away";
  team_name: string | null;
  team_abbr: string | null;
  players: TeamRosterPlayer[];
};

function buildTeamVariants(team: TeamRow) {
  const values = new Set<string>();
  const add = (value?: string | null) => {
    if (!value) return;
    const trimmed = value.trim();
    if (trimmed) values.add(trimmed);
  };
  add(team.abbreviation);
  add(team.full_name);
  add(team.nickname);
  if (team.city && team.nickname) {
    add(`${team.city} ${team.nickname}`);
  }
  return values;
}

async function fetchRosterForGame(gameId: number) {
  const { data: gameRow, error: gameError } = await supabase
    .from(GAMES_TABLE)
    .select("home_team_id, away_team_id")
    .eq("game_id", gameId)
    .single();

  if (gameError) {
    console.error("Supabase error loading game metadata:", gameError);
    return { roster: [], error: "Failed to load game metadata." };
  }
  if (!gameRow) {
    return { roster: [], error: "Game not found." };
  }

  const teamOrder: { team_id: number; side: "home" | "away" }[] = [];
  if (gameRow.home_team_id) {
    teamOrder.push({ team_id: gameRow.home_team_id, side: "home" });
  }
  if (gameRow.away_team_id) {
    teamOrder.push({ team_id: gameRow.away_team_id, side: "away" });
  }

  const teamIds = teamOrder.map((t) => t.team_id);

  if (!teamIds.length) {
    return { roster: [], error: "Game is missing team assignments." };
  }

  const { data: teamsData, error: teamsError } = await supabase
    .from(TEAM_TABLE)
    .select("team_id, full_name, abbreviation, nickname, city")
    .in("team_id", teamIds);

  if (teamsError) {
    console.error("Supabase error loading teams for roster:", teamsError);
    return { roster: [], error: "Failed to load teams." };
  }

  const variants = new Map<string, number>();
  const filterValues: string[] = [];
  const filterValueSet = new Set<string>();
  const teamInfoMap = new Map<number, TeamRow>();

  const addFilterValue = (value: string, teamId: number) => {
    const normalized = value.toLowerCase();
    if (!variants.has(normalized)) {
      variants.set(normalized, teamId);
    }
    if (!filterValueSet.has(value)) {
      filterValueSet.add(value);
      filterValues.push(value);
    }
  };

  (teamsData as TeamRow[] | null)?.forEach((team) => {
    teamInfoMap.set(team.team_id, team);
    buildTeamVariants(team).forEach((value) => {
      addFilterValue(value, team.team_id);
      const uppercase = value.toUpperCase();
      if (uppercase !== value) {
        addFilterValue(uppercase, team.team_id);
      }
    });
  });

  if (!filterValues.length) {
    return { roster: teamOrder.map((t) => ({
      team_id: t.team_id,
      side: t.side,
      team_name: teamInfoMap.get(t.team_id)?.full_name ?? null,
      team_abbr: teamInfoMap.get(t.team_id)?.abbreviation ?? null,
      players: [],
    })) };
  }

  const { data: rosterData, error: rosterError } = await supabase
    .from(ROSTER_TABLE)
    .select("player_id, player_name, team, position, active_status")
    .in("team", filterValues);

  if (rosterError) {
    console.error("Supabase error loading roster players:", rosterError);
    return { roster: [], error: "Failed to load roster players." };
  }

  const playersByTeamId: Record<number, TeamRosterPlayer[]> = {};

  (rosterData as RosterRow[] | null)?.forEach((row) => {
    const normalizedTeam = row.team?.trim().toLowerCase();
    if (!normalizedTeam) return;
    const teamId = variants.get(normalizedTeam);
    if (!teamId) return;

    if (!playersByTeamId[teamId]) {
      playersByTeamId[teamId] = [];
    }
    const already = playersByTeamId[teamId].some(
      (player) => player.player_id === row.player_id
    );
    if (already) return;

    playersByTeamId[teamId].push({
      player_id: row.player_id,
      player_name: row.player_name,
      position: row.position,
      active_status: row.active_status,
    });
  });

  Object.values(playersByTeamId).forEach((list) =>
    list.sort((a, b) => {
      const nameA = (a.player_name ?? "").toLowerCase();
      const nameB = (b.player_name ?? "").toLowerCase();
      return nameA.localeCompare(nameB);
    })
  );

  const roster: TeamRoster[] = teamOrder.map((entry) => {
    const info = teamInfoMap.get(entry.team_id);
    return {
      team_id: entry.team_id,
      side: entry.side,
      team_name: info?.full_name ?? null,
      team_abbr: info?.abbreviation ?? null,
      players: playersByTeamId[entry.team_id] ?? [],
    };
  });

  return { roster };
}

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

    if (req.nextUrl.searchParams.get("mode") === "roster") {
      const { roster, error } = await fetchRosterForGame(gameIdNum);
      if (error) {
        return NextResponse.json({ error }, { status: 400 });
      }
      return NextResponse.json({ roster, mode: "roster" });
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

    return NextResponse.json({ players, mode: "stats" });
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
