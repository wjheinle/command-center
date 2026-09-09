// Computes a live estimated fantasy score for Bill's Yahoo league (Red Hawk).
// Yahoo doesn't expose live fantasy points via any public API, so this
// reconstructs scoring from the captured roster (weekly photo) + ESPN's
// live per-player box scores (site.api.espn.com .../summary?event={id}),
// using the league's actual scoring rules (captured via screenshot, stored
// in data/yahooScoringSettings.json — see that file for the full schema).
//
// NOTE: this is a best-effort live estimate, not official Yahoo scoring.
// It will track closely but Yahoo's own site remains the source of truth
// for final/official numbers — the UI should always note this.

const { readJSON, writeJSON } = require('./store');

// Builds the name -> box score lookup from a set of already-fetched game
// summaries (shared with the TD window tracker — see nflScores.fetchAllLiveGameSummaries).
function playerStatIndexFromSummaries(summaries) {
  const index = {};
  summaries.forEach(({ summary }) => {
    Object.assign(index, summary.players);
  });
  return index;
}

function getScoringSettings() {
  return readJSON('yahooScoringSettings', null);
}

// ESPN box score stat keys look like "passing_YDS", "rushing_TD", "receiving_REC", etc.
function extractOffensiveStats(rawStatLine) {
  if (!rawStatLine) return null;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    passingYards: num(rawStatLine['passing_YDS']),
    passingTDs: num(rawStatLine['passing_TD']),
    interceptions: num(rawStatLine['passing_INT']),
    rushingYards: num(rawStatLine['rushing_YDS']),
    rushingTDs: num(rawStatLine['rushing_TD']),
    receivingYards: num(rawStatLine['receiving_YDS']),
    receivingTDs: num(rawStatLine['receiving_TD']),
    receptions: num(rawStatLine['receiving_REC']),
    fumblesLost: num(rawStatLine['fumbles_LOST']),
    // Return TDs and 2pt conversions aren't broken out as clean columns in
    // ESPN's standard boxscore tables; they show up in play-by-play instead.
    // Left at 0 for now — a known gap, noted in the UI rather than guessed at.
    returnTDs: 0,
    twoPointConversions: 0,
  };
}

// Sums a base per-unit rate plus any yardage-threshold bonuses crossed.
function yardageScore(yards, perPoint, bonuses) {
  let pts = yards / perPoint;
  (bonuses || []).forEach(b => {
    if (yards >= b.threshold) pts += b.bonus;
  });
  return pts;
}

function scoreOffensiveStatLine(stats, settings) {
  if (!settings || !stats) return null;
  let pts = 0;

  pts += yardageScore(stats.passingYards, settings.passingYardsPerPoint || 25, settings.passingYardBonuses);
  pts += stats.passingTDs * (settings.passingTD ?? 4);
  pts += stats.interceptions * (settings.interception ?? -1);

  pts += yardageScore(stats.rushingYards, settings.rushingYardsPerPoint || 10, settings.rushingYardBonuses);
  pts += stats.rushingTDs * (settings.rushingTD ?? 6);

  pts += stats.receptions * (settings.reception ?? 1);
  pts += yardageScore(stats.receivingYards, settings.receivingYardsPerPoint || 10, settings.receivingYardBonuses);
  pts += stats.receivingTDs * (settings.receivingTD ?? 6);

  pts += stats.returnTDs * (settings.returnTD ?? 6);
  pts += stats.twoPointConversions * (settings.twoPointConversion ?? 2);
  pts += stats.fumblesLost * (settings.fumbleLost ?? -2);

  return Math.round(pts * 100) / 100;
}

// Kicker stat line: ESPN boxscore kicking table typically gives made FGs by
// distance bucket less directly than a flat FG count + long. Field goal
// distance splits often require the play-by-play or a made/attempted string
// like "3/4" per range. Treating this as a known gap for now: if a clean
// per-distance breakdown isn't present in the box score, we fall back to a
// flat estimate using the 30-39 yard value (the modal NFL kick distance)
// rather than fabricate a precise number.
function extractKickerStats(rawStatLine) {
  if (!rawStatLine) return null;
  const num = (v) => {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  return {
    fgMade: num(rawStatLine['kicking_FG']),
    patMade: num(rawStatLine['kicking_XP']),
  };
}

function scoreKickerStatLine(stats, settings) {
  if (!settings?.kicker || !stats) return null;
  let pts = 0;
  // Known limitation: without distance-by-kick data we can't split FGs into
  // the 0-19/20-29/30-39/40-49/50+ buckets. Use the 30-39 value as the
  // closest single-rate approximation.
  pts += stats.fgMade * (settings.kicker.fg30to39 ?? 3);
  pts += stats.patMade * (settings.kicker.patMade ?? 1);
  return Math.round(pts * 100) / 100;
}

function scorePointsAllowed(pointsAllowed, brackets) {
  if (!brackets) return 0;
  for (const b of brackets) {
    if (b.max == null || pointsAllowed <= b.max) return b.points;
  }
  return 0;
}

// Team defense/special teams stat line — ESPN's boxscore doesn't surface a
// single "team defense" row the way Yahoo scores it; sacks/INTs/fumble
// recoveries/TDs are visible per-player and would need summing across the
// whole defensive unit, and points allowed comes from the scoreboard, not
// the boxscore. This is scaffolded but returns null until that aggregation
// is wired in — flagged clearly rather than guessed at.
function scoreDefenseStatLine(defenseTeamStats, settings) {
  if (!settings?.defenseSpecialTeams || !defenseTeamStats) return null;
  const s = settings.defenseSpecialTeams;
  let pts = 0;
  pts += (defenseTeamStats.sacks || 0) * (s.sack ?? 1);
  pts += (defenseTeamStats.interceptions || 0) * (s.interception ?? 2);
  pts += (defenseTeamStats.fumbleRecoveries || 0) * (s.fumbleRecovery ?? 2);
  pts += (defenseTeamStats.touchdowns || 0) * (s.touchdown ?? 6);
  pts += (defenseTeamStats.safeties || 0) * (s.safety ?? 2);
  pts += (defenseTeamStats.blockedKicks || 0) * (s.blockKick ?? 2);
  pts += (defenseTeamStats.returnTDs || 0) * (s.kickPuntReturnTD ?? 6);
  pts += (defenseTeamStats.extraPointsReturned || 0) * (s.extraPointReturned ?? 2);
  if (defenseTeamStats.pointsAllowed != null) {
    pts += scorePointsAllowed(defenseTeamStats.pointsAllowed, s.pointsAllowedBrackets);
  }
  return Math.round(pts * 100) / 100;
}

function scorePlayer(playerName, position, playerStatIndex, settings, manualAdjustments) {
  // A manual override always wins — for spots where auto-scoring is known
  // weak (kicker FG distance today, defense until that's wired) and Bill
  // has watched the game and knows the real number.
  if (manualAdjustments && manualAdjustments[playerName] != null) {
    return {
      playerName, position,
      points: manualAdjustments[playerName],
      note: 'Manual override',
    };
  }

  const rawLine = playerStatIndex[playerName];
  if (!rawLine) return { playerName, position, points: null, note: null };

  if (position === 'K') {
    const stats = extractKickerStats(rawLine);
    return {
      playerName, position,
      points: scoreKickerStatLine(stats, settings),
      note: 'Kicker scoring uses a flat 30-39 yd rate — box score doesn\'t break out FG distance. Use manual override if you know the real FG mix.',
    };
  }

  if (position === 'DEF' || position === 'D/ST') {
    // Not wired yet — see scoreDefenseStatLine comment. Manual override is
    // the intended path for D/ST scoring until that's built.
    return { playerName, position, points: null, note: 'Team defense scoring not yet wired — use manual override.' };
  }

  const stats = extractOffensiveStats(rawLine);
  return {
    playerName, position,
    points: scoreOffensiveStatLine(stats, settings),
    note: null,
  };
}

function computeRosterScore(roster, playerStatIndex, settings, manualAdjustments) {
  if (!settings) {
    return { total: null, players: [], note: 'Yahoo scoring settings not yet captured.' };
  }

  let total = 0;
  let anyFound = false;

  const players = roster.map(p => {
    const scored = scorePlayer(p.playerName, p.position, playerStatIndex, settings, manualAdjustments);
    if (scored.points != null) {
      anyFound = true;
      total += scored.points;
    }
    return scored;
  });

  return {
    total: anyFound ? Math.round(total * 100) / 100 : null,
    players,
    note: 'Live estimate from ESPN box scores — not official Yahoo scoring. Kicker and D/ST scoring are approximate/unwired unless manually overridden — see per-player notes.',
  };
}

async function computeLiveRosterScore(roster, summaries) {
  const settings = getScoringSettings();
  const playerStatIndex = playerStatIndexFromSummaries(summaries);
  const manualAdjustments = readJSON('yahooManualAdjustments', {});
  return computeRosterScore(roster, playerStatIndex, settings, manualAdjustments);
}

// Scores the opponent's roster the exact same way as Bill's own — same
// scoring rules, same live ESPN stats, same manual-override store (a
// manual adjustment is keyed by player name, so it applies correctly
// whichever roster that player happens to be on).
async function computeLiveOpponentScore(opponentRoster, summaries) {
  return computeLiveRosterScore(opponentRoster, summaries);
}

function setManualAdjustment(playerName, points) {
  const current = readJSON('yahooManualAdjustments', {});
  if (points == null) {
    delete current[playerName];
  } else {
    current[playerName] = points;
  }
  writeJSON('yahooManualAdjustments', current);
  return current;
}

function getManualAdjustments() {
  return readJSON('yahooManualAdjustments', {});
}

module.exports = {
  getScoringSettings,
  computeLiveRosterScore,
  computeLiveOpponentScore,
  computeRosterScore,
  setManualAdjustment,
  getManualAdjustments,
};
