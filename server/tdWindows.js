// Tracks touchdown counts across Bill's three Sunday betting windows with
// Mike (DraftKings): Morning (11am MT / 1pm ET games), Afternoon (2pm MT /
// 4pm ET games), and Sunday Night Football. This mirrors the counting logic
// from the standalone "Mike and Billy's TD Tracker" phone app — that app
// keeps its own voice-announcement feature separately; this just displays
// the same three running counts inside Command Center.
//
// Window assignment is by kickoff time (ET), not by whichever window is
// "currently airing" — a game that started in the early window still counts
// toward the early window even if it runs long into the early afternoon.

// Kickoff-time boundaries in ET hour-of-day. Early window games kick at 1pm
// ET, afternoon at 4pm/4:05/4:25 ET, SNF at 8:20 ET (also covers TNF/MNF
// stragglers landing in the "night" bucket since those are rooted in the
// same national-window slot conceptually).
function windowForKickoff(isoDate) {
  const d = new Date(isoDate);
  // Convert to ET hour. Using a fixed offset is imprecise around DST changes,
  // but NFL Sundays in September are within EDT (UTC-4), which is the
  // relevant season for this app's use.
  const etHour = (d.getUTCHours() - 4 + 24) % 24;

  if (etHour < 15) return 'morning';   // ~1:00 ET kickoffs
  if (etHour < 19) return 'afternoon'; // ~4:00-4:25 ET kickoffs
  return 'night';                      // SNF/primetime
}

// Takes the shared { games, summaries } batch from
// nflScores.fetchAllLiveGameSummaries — no independent fetching, so this
// rides along on the same poll cycle as everything else in the snapshot.
function computeTdWindowsFromSummaries(games, summaries) {
  const windows = {
    morning: { label: 'Morning', touchdowns: [], count: 0 },
    afternoon: { label: 'Afternoon', touchdowns: [], count: 0 },
    night: { label: 'Night', touchdowns: [], count: 0 },
  };

  summaries.forEach(({ game, summary }) => {
    const win = windowForKickoff(game.date);
    const bucket = windows[win] || windows.afternoon;
    (summary.touchdowns || []).forEach(td => {
      bucket.touchdowns.push({ ...td, game: game.shortName });
    });
  });

  Object.values(windows).forEach(w => { w.count = w.touchdowns.length; });
  const total = windows.morning.count + windows.afternoon.count + windows.night.count;

  return { windows, total, fetchedAt: new Date().toISOString() };
}

module.exports = { computeTdWindowsFromSummaries, windowForKickoff };
