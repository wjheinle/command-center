// Grades pick'em and survivor picks against live NFL scores.
// Status values: 'pending' (game not started), 'winning', 'losing', 'won', 'lost'

function findGameForTeam(games, teamName) {
  const norm = (s) => (s || '').toLowerCase().trim();
  const target = norm(teamName);
  return games.find(g => {
    const home = norm(g.home?.team);
    const away = norm(g.away?.team);
    // allow partial match since captured team names may be full names ("Chiefs")
    // while ESPN scoreboard uses abbreviations ("KC") — matched upstream by
    // resolving to abbreviation before calling this, but keep a loose fallback.
    return home === target || away === target || target.includes(home) || target.includes(away);
  });
}

function gradeStraightPick(pickedTeamAbbrev, games) {
  const game = findGameForTeam(games, pickedTeamAbbrev);
  if (!game) return { status: 'pending', game: null };

  const norm = (s) => (s || '').toLowerCase().trim();
  const pickedIsHome = norm(game.home?.team) === norm(pickedTeamAbbrev);
  const pickedScore = pickedIsHome ? game.home?.score : game.away?.score;
  const oppScore = pickedIsHome ? game.away?.score : game.home?.score;

  if (game.state === 'pre') return { status: 'pending', game };

  if (game.state === 'in') {
    if (pickedScore > oppScore) return { status: 'winning', game };
    if (pickedScore < oppScore) return { status: 'losing', game };
    return { status: 'tied', game };
  }

  // post-game
  if (pickedScore > oppScore) return { status: 'won', game };
  if (pickedScore < oppScore) return { status: 'lost', game };
  return { status: 'tied', game };
}

function gradePickemWeek(picks, games) {
  return picks.map(p => ({
    ...p,
    ...gradeStraightPick(p.pickedTeam, games),
  }));
}

function gradeSurvivorPick(pickedTeam, games) {
  return { pickedTeam, ...gradeStraightPick(pickedTeam, games) };
}

module.exports = { gradePickemWeek, gradeSurvivorPick, gradeStraightPick };
