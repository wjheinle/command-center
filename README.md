# Command Center

Live iPad dashboard for tracking fantasy football, pick'em pools, and survivor
leagues during NFL Sundays. Built for iPad Air 11" (M3) landscape use.

## What it does

- **4 fantasy leagues in a 2x2 grid** — Soaring Eagles, Houston League, Soaring
  Eagles Guillotine (all ESPN), and Red Hawk (Yahoo). Tap any box to expand it
  for a bigger, easier-to-read view; tap again to collapse.
- **Each ESPN box shows Bill's full starting lineup** (QB/RB/RB/WR/WR/TE/
  FLEX/DEF/K, correctly ordered) **side by side with his opponent's lineup**
  in the same slot — score | my player | position | opponent player | score.
  Live points and totals always show on Bill's side regardless of which side
  ESPN's own API happens to label "home" vs "away" for that particular league.
- **Red Hawk (Yahoo) box** shows the same side-by-side layout once an
  opponent roster has been captured (see Data sources below) — including a
  matching manual-adjust option on the opponent's K/DEF, not just Bill's.
- **Pick'em — two pools**, toggled with the Prevent Defense (confidence
  pool — shows each pick's confidence value) / Sunday Funday (straight
  pick'em, no confidence) switch in the panel header. 4x4 grid, all 16 games
  visible at once, no scrolling. Cells color green/red as picks win or lose
  live.
- **Survivor pick**, graded the same way.
- **TD Tracker** — Morning/Afternoon/Night touchdown counts for Bill's
  DraftKings bet with Mike, built into the same poll cycle as everything
  else. (The standalone "Mike and Billy's TD Tracker" phone app with voice
  announcements is separate and untouched — this is a display-only version
  inside Command Center.)
- **Tracking On/Off toggle** — when off, the dashboard freezes on the last
  known snapshot instead of polling; when on, it polls every ~20s.
- **Automatic weekly reset** — captured picks, roster, and manual overrides
  are compared against the current NFL week (read from ESPN's own data) and
  treated as "not captured yet" once a new week starts, without deleting
  anything. Conservative by design: if the current week can't be determined,
  existing data is left alone rather than risking a wrong wipe.
- **Reset All** — a button in the Yahoo box header clears every manual K/DEF
  override for the current week in one tap.

## Data sources

- **ESPN Fantasy API** (undocumented, cookie-authenticated, lives on
  `lm-api-reads.fantasy.espn.com` — NOT plain `fantasy.espn.com`, which
  redirects to ESPN's marketing site instead of returning JSON) — the 3 ESPN
  leagues' live matchup scores AND full starting-lineup player detail (via
  the `mBoxscore`/`mLiveScoring` views), for both Bill's team and his
  opponent's.
- **ESPN public scoreboard/summary API** (no auth) — live NFL game scores,
  per-player box scores, and touchdown scoring plays. Shared across the
  Yahoo scoring engine and the TD tracker in one poll cycle rather than
  fetched twice.
- **Yahoo fantasy scoring** — Yahoo has no public live-scoring API, so this
  is reconstructed: a weekly photo of the Yahoo matchup screen is run
  through Claude's vision API to extract BOTH rosters (Bill's and his
  opponent's), then live points are computed from ESPN's box scores using
  Yahoo's actual scoring rules (captured once in
  `data/yahooScoringSettings.json`). This is a best-effort estimate, not
  official Yahoo scoring — the UI says so. No projection fallback is shown —
  players read as a dash until real live stats exist.
- **Pick'em picks and survivor pick** — also captured via a weekly photo +
  vision extraction (no API exists for Yahoo Pick'em). Pool 1 (Prevent
  Defense) and Pool 2 (Sunday Funday) use separate extraction prompts since
  one is a confidence pool and the other isn't.

## Environment variables

See `.env.example`. Required: `ESPN_S2`, `ESPN_SWID`, `ESPN_LEAGUE_IDS`,
`ESPN_TEAM_NAMES` (one name per league, same order as `ESPN_LEAGUE_IDS` —
used to pick out Bill's specific matchup and orient the totals row
correctly), `ANTHROPIC_API_KEY`. `YAHOO_TEAM_NAME` defaults to Bill's team
name but can be overridden. `DATA_DIR` should point at a Railway volume
mount in production so captured data survives redeploys.

## Known gaps (flagged in the UI, not silently guessed at)

- Kicker scoring uses a flat 30-39 yard rate for the Yahoo box only (ESPN's
  box score doesn't break out field goal distance) — use the manual adjust
  button if you watched the game and know the real number. ESPN's own boxes
  use ESPN's own correctly-computed K/DEF scoring and never need this.
- Yahoo team defense/special teams scoring isn't computed at all yet — same
  manual override path. ESPN's own boxes are unaffected.
- The ESPN player-roster extraction (`mBoxscore`/`mLiveScoring` shape) was
  built from documentation and community API client projects, not verified
  against a live ESPN response during development — confirmed working
  against real data as of the first live test, but the shape assumptions
  haven't been stress-tested against every possible roster configuration
  (e.g. IR slots, bye weeks, multiple FLEX-eligible slots in unusual league
  settings).

## Local development

```bash
npm install
cp .env.example .env   # fill in real values
npm start
```

Serves on `http://localhost:3000` (or `$PORT`).
