// ESPN Fantasy Football API client.
// Undocumented but well-known endpoint pattern. Private leagues require
// the espn_s2 and SWID cookies from an authenticated ESPN session.
//
// Env vars expected:
//   ESPN_S2       — value of the espn_s2 cookie
//   ESPN_SWID     — value of the SWID cookie (include the curly braces)
//   ESPN_LEAGUE_IDS — comma-separated list, e.g. "111111,222222,333333"
//   ESPN_SEASON   — e.g. "2026"
//   ESPN_TEAM_NAMES — comma-separated list of Bill's team name in EACH
//                     league (names can differ per league), e.g.
//                     "Spit on That Thang,Bud Light is Gross,..." — used
//                     to pick out his specific matchup from the several
//                     that exist in a league each week.

const fetch = require('node-fetch');

const SEASON = process.env.ESPN_SEASON || '2026';
const LEAGUE_IDS = (process.env.ESPN_LEAGUE_IDS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
};

// ESPN's defaultPositionId numeric codes -> the position label Command
// Center displays elsewhere (matches the labels used in Yahoo capture too).
// This is the player's NATURAL position, independent of where they're
// slotted in the lineup this week.
const POSITION_ID_MAP = {
  1: 'QB',
  2: 'RB',
  3: 'WR',
  4: 'TE',
  5: 'K',
  16: 'DEF',
};

// ESPN's lineupSlotId — where a player is SLOTTED in the lineup this week
// (distinct from defaultPositionId above). Verified against multiple
// independent ESPN API client projects (cwendt94/espn-api, ffscrapr, others).
const LINEUP_SLOT_MAP = {
  0: 'QB',
  2: 'RB',
  4: 'WR',
  6: 'TE',
  16: 'DEF',
  17: 'K',
  20: 'BENCH',
  21: 'IR',
  23: 'FLEX',
};

// Standard fantasy lineup display order — QB, RBs, WRs, TE, FLEX, DEF, K.
// Used to sort starters into the order Bill actually expects to see them,
// rather than whatever order ESPN's roster array happens to list them in.
const LINEUP_SLOT_SORT_ORDER = [0, 2, 4, 6, 23, 16, 17];

const BENCH_SLOT_IDS = new Set([20, 21]);

function cookieHeader() {
  const s2 = process.env.ESPN_S2;
  const swid = process.env.ESPN_SWID;
  if (!s2 || !swid) return null;
  return `espn_s2=${s2}; SWID=${swid};`;
}

// mMatchupScore + mScoreboard gives live scoring for the current matchup period.
// NOTE: the read endpoint lives on lm-api-reads.fantasy.espn.com, not plain
// fantasy.espn.com — hitting the old domain gets silently redirected to
// ESPN's marketing homepage instead of returning API JSON (which then fails
// to parse with a confusing "Unexpected end of JSON input" error).
async function fetchLeague(leagueId) {
  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${SEASON}/segments/0/leagues/${leagueId}?view=mMatchupScore&view=mScoreboard&view=mTeam&view=mRoster&view=mSettings&view=mBoxscore&view=mLiveScoring`;
  const cookie = cookieHeader();

  const headers = { ...BROWSER_HEADERS };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    throw new Error(`ESPN league ${leagueId} fetch failed: ${res.status} ${res.statusText}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('application/json')) {
    // ESPN sometimes returns a 200 with an HTML page instead of a real API
    // error — catch that here with a clear message instead of letting
    // res.json() throw a confusing parse error.
    const preview = (await res.text()).slice(0, 200);
    throw new Error(`ESPN league ${leagueId}: expected JSON but got ${contentType || 'unknown content-type'}. Response starts: ${preview}`);
  }

  const data = await res.json();
  return normalizeLeague(leagueId, data);
}

// Extracts Bill's starting-lineup players (excludes bench/IR) with their
// live fantasy points from one side of a matchup object (m.home or m.away),
// when that side is Bill's team. mBoxscore/mLiveScoring views put the
// roster snapshot at rosterForCurrentScoringPeriod.entries.
//
// Sorted into standard lineup display order (QB, RB, RB, WR, WR, WR, TE,
// FLEX, DEF, K) using lineupSlotId — NOT the order ESPN's array happens to
// list players in, which has no guaranteed ordering.
function extractRosterPlayers(teamSide) {
  const entries = teamSide?.rosterForCurrentScoringPeriod?.entries || [];
  const scoringPeriodId = teamSide.rosterForCurrentScoringPeriod?.scoringPeriodId;

  const starters = entries.filter(e => !BENCH_SLOT_IDS.has(e.lineupSlotId));

  starters.sort((a, b) => {
    const orderA = LINEUP_SLOT_SORT_ORDER.indexOf(a.lineupSlotId);
    const orderB = LINEUP_SLOT_SORT_ORDER.indexOf(b.lineupSlotId);
    // Unknown slot IDs (not in our sort list) sink to the bottom rather
    // than accidentally sorting to the top via indexOf's -1.
    return (orderA === -1 ? 999 : orderA) - (orderB === -1 ? 999 : orderB);
  });

  return starters.map(e => {
    const player = e.playerPoolEntry?.player || {};
    // Prefer the lineup SLOT label (so a RB started at FLEX shows "FLEX",
    // matching what Bill sees on ESPN's own site) and fall back to the
    // player's natural position if the slot ID is somehow unrecognized.
    const positionLabel = LINEUP_SLOT_MAP[e.lineupSlotId] || POSITION_ID_MAP[player.defaultPositionId] || null;

    // appliedTotal on the live stats entry is the player's current live
    // fantasy points for this scoring period; appliedTotal on the
    // projection entry (statSourceId 1) is the pre-game projection.
    const stats = player.stats || [];
    const liveStat = stats.find(s => s.statSourceId === 0 && s.scoringPeriodId === scoringPeriodId);
    const projStat = stats.find(s => s.statSourceId === 1 && s.scoringPeriodId === scoringPeriodId);

    return {
      playerName: player.fullName || 'Unknown Player',
      position: positionLabel,
      points: liveStat?.appliedTotal ?? null,
      projection: projStat?.appliedTotal ?? null,
    };
  });
}

function normalizeLeague(leagueId, data) {
  const teamsById = {};
  (data.teams || []).forEach(t => {
    teamsById[t.id] = {
      id: t.id,
      name: (t.location && t.nickname) ? `${t.location} ${t.nickname}`.trim() : (t.name || `Team ${t.id}`),
      abbrev: t.abbrev,
    };
  });

  const currentPeriod = data.scoringPeriodId;

  // A league has one matchup PER PAIR OF TEAMS in a given period (a 12-team
  // league has 6 simultaneous matchups) — filtering by period alone returns
  // all of them, not just Bill's. Find his team by name, then pick only the
  // matchup he's actually in, rather than defaulting to whichever happens
  // to be first in ESPN's array.
  //
  // Only case and surrounding whitespace are normalized — a genuine typo
  // (a missing apostrophe, a misspelled word) should NOT silently match;
  // that's what the myTeamFound flag and "name not matched" UI tag are for.
  const normalizeTeamName = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');

  // ESPN_TEAM_NAMES holds one name PER LEAGUE, in the same order as
  // ESPN_LEAGUE_IDS. Look up only the name meant for THIS league by
  // position — never check against the full combined list, which risked
  // one league's fetch accidentally matching a team name meant for a
  // different league.
  const leagueIndex = LEAGUE_IDS.indexOf(String(leagueId));
  const allTeamNames = (process.env.ESPN_TEAM_NAMES || '').split(',').map(s => s.trim());
  const myTeamNameForThisLeague = leagueIndex >= 0 ? allTeamNames[leagueIndex] : null;

  const myTeam = myTeamNameForThisLeague
    ? Object.values(teamsById).find(t => normalizeTeamName(t.name) === normalizeTeamName(myTeamNameForThisLeague))
    : undefined;

  const periodMatchups = (data.schedule || [])
    .filter(m => m.matchupPeriodId === data.status?.currentMatchupPeriod);

  const myMatchup = myTeam
    ? periodMatchups.find(m => m.home?.teamId === myTeam.id || m.away?.teamId === myTeam.id)
    : periodMatchups[0]; // fallback if we don't know Bill's team name in this league

  // ESPN assigns home/away arbitrarily per matchup — Bill might be the
  // "home" side in one league and "away" in another. The totals need to
  // consistently show HIS side first regardless, matching the player-roster
  // ordering below (which was already built to always be his-side-first).
  // Field names are "mine"/"opponent" rather than "home"/"away" specifically
  // so this orientation can't silently drift back to ESPN's raw labeling.
  const matchups = myMatchup ? [myMatchup].map(m => {
    const home = m.home || {};
    const away = m.away || {};
    const homeIsMine = myTeam ? home.teamId === myTeam.id : true; // default orientation if we don't know Bill's team

    const homeSide = {
      teamId: home.teamId,
      teamName: teamsById[home.teamId]?.name || `Team ${home.teamId}`,
      score: home.totalPoints ?? home.pointsByScoringPeriod?.[currentPeriod] ?? null,
    };
    const awaySide = away.teamId != null ? {
      teamId: away.teamId,
      teamName: teamsById[away.teamId]?.name || `Team ${away.teamId}`,
      score: away.totalPoints ?? away.pointsByScoringPeriod?.[currentPeriod] ?? null,
    } : null;

    return {
      matchupId: m.id,
      mine: homeIsMine ? homeSide : awaySide,
      opponent: homeIsMine ? awaySide : homeSide,
    };
  }) : [];

  // Bill's own starting-lineup player detail, AND his opponent's — pulled
  // from whichever side of the matchup matches his team ID (his side) vs
  // the other side (opponent). Wrapped in a try/catch: this is built
  // against ESPN's documented-but-unofficial mBoxscore/mLiveScoring shape,
  // which hasn't been verified against a real live response yet. If the
  // shape is even slightly different than expected, this should degrade to
  // an empty roster with a note rather than taking down the whole league fetch.
  let myRoster = [];
  let opponentRoster = [];
  let myRosterError = null;
  if (myMatchup && myTeam) {
    try {
      const isHome = myMatchup.home?.teamId === myTeam.id;
      const mySide = isHome ? myMatchup.home : myMatchup.away;
      const oppSide = isHome ? myMatchup.away : myMatchup.home;
      myRoster = extractRosterPlayers(mySide);
      opponentRoster = extractRosterPlayers(oppSide);
    } catch (err) {
      myRosterError = `Player roster extraction failed: ${err.message}`;
    }
  }

  return {
    leagueId,
    leagueName: data.settings?.name || `League ${leagueId}`,
    scoringPeriodId: currentPeriod,
    matchups,
    myRoster,
    opponentRoster,
    myRosterError,
    myTeamFound: !!myTeam,
    fetchedAt: new Date().toISOString(),
  };
}

async function fetchAllLeagues() {
  if (!LEAGUE_IDS.length) {
    console.warn('[espn] ESPN_LEAGUE_IDS is empty — no leagues to fetch.');
    return [];
  }

  const results = [];
  for (const id of LEAGUE_IDS) {
    try {
      const league = await fetchLeague(id);
      console.log(`[espn] Fetched league ${id}: ${league.leagueName} (${league.matchups?.length || 0} matchups)`);
      results.push(league);
    } catch (err) {
      console.error(`[espn] League ${id} fetch failed: ${err.message}`);
      results.push({ leagueId: id, error: err.message });
    }
  }
  return results;
}

module.exports = { fetchAllLeagues, fetchLeague, LEAGUE_IDS };
