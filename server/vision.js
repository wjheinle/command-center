// Uses the Claude API (vision) to extract structured picks from a photo
// of a screen: Yahoo pick'em grid, survivor pick, or Yahoo fantasy matchup/roster.
//
// Env vars expected:
//   ANTHROPIC_API_KEY
//   YAHOO_TEAM_NAME — Bill's Yahoo fantasy team name, used to identify which
//                     side of a two-team matchup screenshot is his roster.

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const YAHOO_TEAM_NAME = process.env.YAHOO_TEAM_NAME || 'Who Drank All the Bitch Pops';

function buildPrompts() {
  return {
    pickem1: `This is a screenshot of a Yahoo confidence pick'em pool grid for one NFL week. This is a CONFIDENCE pool — each pick has a confidence point value assigned by the user (typically ranking games from most to least confident, e.g. if there are 16 games, confidence values run 1-16 with no repeats), usually shown as a number near or below the picked team.

Extract every game, the pick made, and its confidence point value.
Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "week": <number or null if not visible>,
  "picks": [
    { "awayTeam": "<abbrev or name as shown>", "homeTeam": "<abbrev or name as shown>", "pickedTeam": "<team the user picked>", "confidence": <the confidence point value assigned to this pick, as a number — this is required for a confidence pool, so look carefully; use null only if truly not visible> }
  ]
}
If you cannot read a field confidently, use null for that field rather than guessing.`,

    pickem2: `This is a screenshot of a Yahoo Pick'em pool grid for one NFL week. This is a STRAIGHT pick'em pool — there is no confidence point ranking, just a winner picked for each game.

Extract every game and the pick made.
Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "week": <number or null if not visible>,
  "picks": [
    { "awayTeam": "<abbrev or name as shown>", "homeTeam": "<abbrev or name as shown>", "pickedTeam": "<team the user picked>", "confidence": null }
  ]
}
Always set confidence to null — this pool has no confidence points. If you cannot read a field confidently, use null for that field rather than guessing.`,

    survivor: `This is a screenshot showing a Survivor pool pick for one NFL week — the user has selected one team they believe will win.
Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "week": <number or null if not visible>,
  "pickedTeam": "<team abbrev or name as shown>"
}
If you cannot read the pick confidently, use null.`,

    yahooRoster: `This is a screenshot of a Yahoo Fantasy Football weekly matchup page. It shows two teams side by side, each with their starting roster listed by position (QB, RB, WR, TE, a flex slot often labeled W/R/T, K, DEF), plus a projection number and a live "Fan Pts" number (which may show "-" if the games haven't started yet) for each player.

Bill's team is named "${YAHOO_TEAM_NAME}" — identify which side of the page is his team by matching that name (it may be truncated or wrapped visually, but match it as closely as shown). Extract his starting roster and the opponent's team name.

Return ONLY valid JSON, no markdown fences, no preamble, in this exact shape:
{
  "week": <number or null if not visible>,
  "opponentTeamName": "<the other team's name as shown, or null>",
  "roster": [
    { "playerName": "<name as shown>", "position": "<position slot label as shown, e.g. QB, RB, WR, TE, W/R/T, K, DEF>", "nflTeam": "<team abbrev if visible, else null>", "projection": <number or null>, "livePoints": <number if a real value is shown, null if it shows "-" or is blank> }
  ]
}
Only include Bill's own roster (the side matching his team name), not the opponent's players. If you cannot read a field confidently, use null for that field rather than guessing.`,
  };
}

async function extractFromImage(imageBase64, mediaType, kind) {
  const prompts = buildPrompts();
  const prompt = prompts[kind];
  if (!prompt) throw new Error(`Unknown extraction kind: ${kind}`);

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mediaType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  });

  const textBlock = response.content.find(b => b.type === 'text');
  const raw = textBlock ? textBlock.text : '{}';
  const cleaned = raw.replace(/```json|```/g, '').trim();

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`Failed to parse vision extraction result: ${err.message}. Raw: ${cleaned.slice(0, 300)}`);
  }
}

module.exports = { extractFromImage };
