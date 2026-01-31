import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE!
);

const GAMES_TABLE = "nba_games-2025-26";
const PERGAME_TABLE = "pergame_player_base_stats_2025_26";
const TEAM_TABLE = "team_id_to_team";
const ROSTER_TABLE = "player_team_position";

const EXCLUDED_COMMENTS = new Set(
  [
    "DNP - Coach's Decision",
    "DND - Injury/Illness",
    "NWT - Not With Team",
    "NWT - Injury/Illness",
  ].map((v) => v.toUpperCase())
);

function normalizeComment(comment: unknown): string | null {
  if (typeof comment !== "string") return null;
  const trimmed = comment.trim();
  return trimmed || null;
}

function shouldExcludeByComment(comment: unknown) {
  const normalized = normalizeComment(comment);
  if (!normalized) return false;
  const upper = normalized.toUpperCase();
  return (
    EXCLUDED_COMMENTS.has(upper) ||
    upper.startsWith("DNP") ||
    upper.startsWith("DND") ||
    upper.startsWith("NWT")
  );
}

function isZeroMinutes(minutes: unknown): boolean {
  if (minutes === null || minutes === undefined) return false;

  if (typeof minutes === "number") {
    return Number.isFinite(minutes) && minutes === 0;
  }

  if (typeof minutes !== "string") return false;

  const trimmed = minutes.trim();
  if (!trimmed) return false;

  if (trimmed === "0" || trimmed === "0.0" || trimmed === "0.00") {
    return true;
  }

  if (trimmed.includes(":")) {
    const [mins, secs] = trimmed.split(":");
    const minNum = Number(mins);
    const secNum = Number(secs);
    if (Number.isFinite(minNum) && Number.isFinite(secNum)) {
      return minNum === 0 && secNum === 0;
    }
  }

  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed === 0;
}

type GameRow = {
  game_id: number;
  game_date: string | null;
  home_team_id: number | null;
  away_team_id: number | null;
};

type TeamRow = {
  team_id: number;
  abbreviation: string | null;
  full_name?: string | null;
  nickname?: string | null;
  city?: string | null;
};

type DnpEntry = {
  player_id: number | null;
  player_name: string | null;
  team_abbr: string | null;
  game_date: string | null;
  reason: string;
  matchup?: string | null;
};

type RosterRow = {
  player_id: number;
  player_name: string | null;
  team: string | null;
  position: string | null;
  active_status: number | null;
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
  Array.from(values).forEach((v) => values.add(v.toUpperCase()));
  return Array.from(values);
}

function dedupeInjuries(list: DnpEntry[]): DnpEntry[] {
  const seen = new Set<string>();
  const result: DnpEntry[] = [];
  list.forEach((item) => {
    const key = `${item.player_id ?? item.player_name ?? "unknown"}-${
      item.game_date ?? "na"
    }-${item.team_abbr ?? "na"}`.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  });
  return result;
}

function toDateKey(dateStr: string | null) {
  if (!dateStr) return null;
  const raw = dateStr.trim();
  const isoLike = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const dt = isoLike ? new Date(`${raw}T12:00:00Z`) : new Date(raw);
  if (Number.isNaN(dt.getTime())) return null;
  return dt.toISOString().split("T")[0];
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ gameId: string }> }
) {
  try {
    const { gameId } = await params;
    const numericId = Number(gameId);
    if (!gameId || Number.isNaN(numericId)) {
      return NextResponse.json({ error: "Invalid game id." }, { status: 400 });
    }

    const { data: gameRow, error: gameError } = await supabase
      .from(GAMES_TABLE)
      .select("game_id, game_date, home_team_id, away_team_id")
      .eq("game_id", numericId)
      .maybeSingle();

    if (gameError) {
      console.error("Error fetching game:", gameError);
      return NextResponse.json(
        { error: "Failed to fetch game." },
        { status: 500 }
      );
    }
    if (!gameRow) {
      return NextResponse.json({ error: "Game not found." }, { status: 404 });
    }

    const game = gameRow as GameRow;
    const targetDateKey = toDateKey(game.game_date?.trim() || null);
    const teamIds = [game.home_team_id, game.away_team_id].filter(
      (v): v is number => typeof v === "number" && Number.isFinite(v)
    );

    if (!teamIds.length) {
      return NextResponse.json({ injuries: [] });
    }

    const { data: teamsData, error: teamsError } = await supabase
      .from(TEAM_TABLE)
      .select("team_id, abbreviation, full_name, nickname, city")
      .in("team_id", teamIds);

    if (teamsError) {
      console.error("Error fetching team abbreviations:", teamsError);
      return NextResponse.json(
        { error: "Failed to load teams." },
        { status: 500 }
      );
    }

    const teamAbbrMap = new Map<number, string>();
    const teamVariantsMap = new Map<number, string[]>();
    (teamsData as TeamRow[] | null)?.forEach((row) => {
      if (
        row &&
        typeof row.team_id === "number" &&
        typeof row.abbreviation === "string"
      ) {
        teamAbbrMap.set(row.team_id, row.abbreviation);
        teamVariantsMap.set(row.team_id, buildTeamVariants(row));
      }
    });

    const injuries: DnpEntry[] = [];

    for (const teamId of teamIds) {
      const teamAbbr = teamAbbrMap.get(teamId) ?? null;
      const teamVariants = teamVariantsMap.get(teamId);
      if (!teamAbbr) continue;

      // Find the most recent game before the target game date; if target missing, just take latest.
      const buildBaseQuery = () =>
        supabase
          .from(PERGAME_TABLE)
          .select("game_id, game_date")
          .eq("team_abbr", teamAbbr)
          .order("game_date", { ascending: false })
          .limit(1);

      const filteredQuery = targetDateKey
        ? buildBaseQuery().lt("game_date", targetDateKey)
        : buildBaseQuery();

      const { data: prevFiltered, error: prevFilteredError } = await filteredQuery.maybeSingle();

      if (prevFilteredError) {
        console.error("Error fetching previous game:", prevFilteredError);
        continue;
      }

      let prevGameRow = prevFiltered;

      // Fallback to latest if none before target date.
      if (!prevGameRow) {
        const { data: latestRow, error: latestError } = await buildBaseQuery().maybeSingle();
        if (latestError) {
          console.error("Error fetching latest game:", latestError);
          continue;
        }
        prevGameRow = latestRow;
      }

      if (!prevGameRow || prevGameRow.game_id === undefined) continue;

      const prevGameId =
        typeof prevGameRow.game_id === "number"
          ? prevGameRow.game_id
          : Number(prevGameRow.game_id);
      if (!Number.isFinite(prevGameId)) continue;

      const { data: playerRows, error: playerError } = await supabase
        .from(PERGAME_TABLE)
        .select("player_id, player_name, team_abbr, comment, min, matchup, game_date")
        .eq("team_abbr", teamAbbr)
        .eq("game_id", prevGameId);

      if (playerError) {
        console.error("Error fetching player rows:", playerError);
        continue;
      }

      const loggedPlayerIds = new Set<number>();
      (playerRows as any[] | null)?.forEach((row) => {
        if (typeof row?.player_id === "number") {
          loggedPlayerIds.add(row.player_id);
        }
        const comment = row?.comment;
        if (
          shouldExcludeByComment(comment) ||
          isZeroMinutes(row?.min ?? null)
        ) {
          injuries.push({
            player_id:
              typeof row.player_id === "number" ? row.player_id : null,
            player_name: row.player_name ?? null,
            team_abbr: row.team_abbr ?? teamAbbr,
            game_date: row.game_date ?? prevGameRow.game_date ?? null,
            reason:
              normalizeComment(comment) ??
              (isZeroMinutes(row?.min) ? "0 minutes played" : "Did not play"),
            matchup: row.matchup ?? null,
          });
        }
      });

      // Also check rostered players' most recent appearance (or DNP) to match player page logic.
      const { data: rosterData, error: rosterError } = await supabase
        .from(ROSTER_TABLE)
        .select("player_id, player_name, team, position, active_status")
        .in("team", teamVariants && teamVariants.length ? teamVariants : [teamAbbr]);

      if (rosterError) {
        console.error("Error fetching roster for injuries:", rosterError);
        continue;
      }

      const rosterRows = (rosterData as RosterRow[] | null) ?? [];
      for (const player of rosterRows) {
        if (!player.player_id) continue;

        if (!loggedPlayerIds.has(player.player_id)) {
          injuries.push({
            player_id: player.player_id,
            player_name: player.player_name ?? null,
            team_abbr: teamAbbr,
            game_date: prevGameRow?.game_date ?? null,
            reason: "No box score found for previous game",
            matchup: null,
          });
        }

        const { data: lastRow, error: lastError } = await supabase
          .from(PERGAME_TABLE)
          .select("game_id, game_date, comment, min, matchup, team_abbr")
          .eq("player_id", player.player_id)
          .order("game_date", { ascending: false })
          .limit(1)
          .maybeSingle();

        if (lastError) {
          console.error("Error fetching last game for player", player.player_id, lastError);
          continue;
        }
        if (!lastRow) continue;

        const comment = (lastRow as any).comment;
        if (
          shouldExcludeByComment(comment) ||
          isZeroMinutes((lastRow as any).min ?? null)
        ) {
          injuries.push({
            player_id: player.player_id,
            player_name: player.player_name ?? null,
            team_abbr: (lastRow as any).team_abbr ?? teamAbbr,
            game_date: (lastRow as any).game_date ?? null,
            reason:
              normalizeComment(comment) ??
              (isZeroMinutes((lastRow as any).min)
                ? "0 minutes played"
                : "Did not play"),
            matchup: (lastRow as any).matchup ?? null,
          });
        }
      }
    }

    return NextResponse.json({ injuries: dedupeInjuries(injuries) });
  } catch (err) {
    console.error("Unexpected error in injuries endpoint:", err);
    return NextResponse.json(
      { error: "Failed to load injuries." },
      { status: 500 }
    );
  }
}

export async function OPTIONS() {
  return NextResponse.json({}, { status: 200 });
}
