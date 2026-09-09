# Command Center

Live iPad dashboard for tracking fantasy football, pick'em pools, and survivor
leagues during NFL Sundays. Built for iPad Air 11" (M3) landscape use.

## What it does

- **4 fantasy leagues in a 2x2 grid** — Soaring Eagles, Houston League, Soaring
  Eagles Guillotine (all ESPN), and Red Hawk (Yahoo). Tap any box to expand it
  for a bigger, easier-to-read view; tap again to collapse.
- **Pick'em — two pools**, toggled with the Prevent Defense / Sunday Funday
  switch in the panel header. 4x4 grid, all 16 games visible at once, no
  scrolling. Cells color green/red as picks win or lose live.
- **Survivor pick**, graded the same way.
- **TD Tracker** — Morning/Afternoon/Night touchdown counts for Bill's
  DraftKings bet with Mike, built into the same poll cycle as everything
  else. (The standalone "Mike and Billy's TD Tracker" phone app with voice
  announcements is separate and untouched — this is a display-only version
  inside Command Center.)
- **Tracking On/Off toggle** — when off, the dashboard freezes on the last
  known snapshot instead of polling; when on, it polls every ~20s.

## Data sources

- **ESPN Fantasy API** (undocumented, cookie-authenticated) — the 3 ESPN
  leagues' live matchup scores.
- **ESPN public scoreboard/summary API** (no auth) — live NFL game scores,
  per-player box scores, and touchdown scoring plays. Shared across the
  Yahoo scoring engine and the TD tracker in one poll cycle rather than
  fetched twice.
- **Yahoo fantasy scoring** — Yahoo has no public live-scoring API, so this
  is reconstructed: a weekly photo of the Yahoo matchup screen is run
  through Claude's vision API to extract Bill's roster + projections, then
  live points are computed from ESPN's box scores using Yahoo's actual
  scoring rules (captured once in `data/yahooScoringSettings.json`). This is
  a best-effort estimate, not official Yahoo scoring — the UI says so.
  Kicker distance and team defense scoring are known-weak spots with a
  manual override button next to any player Command Center can't score
  confidently.
- **Pick'em picks and survivor pick** — also captured via a weekly photo +
  vision extraction (no API exists for Yahoo Pick'em).

## Environment variables

See `.env.example`. Required: `ESPN_S2`, `ESPN_SWID`, `ESPN_LEAGUE_IDS`,
`ANTHROPIC_API_KEY`. `YAHOO_TEAM_NAME` defaults to Bill's team name but can
be overridden. `DATA_DIR` should point at a Railway volume mount in
production so captured data survives redeploys.

## Known gaps (flagged in the UI, not silently guessed at)

- Kicker scoring uses a flat 30-39 yard rate (ESPN's box score doesn't
  break out field goal distance) — use the manual adjust button if you
  watched the game and know the real number.
- Team defense/special teams scoring isn't computed at all yet — same
  manual override path.
- ESPN fantasy player-level roster detail (not just matchup totals) isn't
  pulled for the 3 ESPN leagues yet — those boxes show team totals only.

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm start
```

Serves on `http://localhost:3000` (or `$PORT`).
