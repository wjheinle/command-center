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
    pickem1: `This is a screenshot of a Yahoo confidence pick'em pool grid for one NFL week. This is a CONFIDENCE pool: each cell shows a team abbreviation with a confidence point value in parentheses directly below it (e.g. "KC" above "(12)"). That parenthesized number is the confidence value for that pick — with N games, values typically run 1 to N with no repeats.

Extract every game, the pick made, and its confidence point value from the parentheses.

CRITICAL: Respond with ONLY the raw JSON object below — no introductory sentence, no explanation of your reasoning, no markdown code fences. Your entire response must start with { and end with }.
{
  "week": <number or null if not visible>,
  "picks": [
    { "awayTeam": "<abbrev or name as shown>", "homeTeam": "<abbrev or name as shown>", "pickedTeam": "<team the user picked>", "confidence": <the number shown in parentheses for this pick — required, look carefully; use null only if truly not visible> }
  ]
}`,

    pickem2: `This is a screenshot of a Yahoo Pick'em pool grid for one NFL week. This is a STRAIGHT pick'em pool — there is no confidence point ranking, just a winner picked for each game.

Extract every game and the pick made.

CRITICAL: Respond with ONLY the raw JSON object below — no introductory sentence, no explanation of your reasoning, no markdown code fences. Your entire response must start with { and end with }.
{
  "week": <number or null if not visible>,
  "picks": [
    { "awayTeam": "<abbrev or name as shown>", "homeTeam": "<abbrev or name as shown>", "pickedTeam": "<team the user picked>", "confidence": null }
  ]
}`,

    survivor: `This is a screenshot showing a Survivor pool pick for one NFL week — the user has selected one team they believe will win.

CRITICAL: Respond with ONLY the raw JSON object below — no introductory sentence, no explanation, no markdown code fences. Your entire response must start with { and end with }.
{
  "week": <number or null if not visible>,
  "pickedTeam": "<team abbrev or name as shown>"
}`,

    yahooRoster: `This is a screenshot of a Yahoo Fantasy Football weekly matchup page. It shows two teams side by side, each with their starting roster listed by position (QB, RB, WR, TE, a flex slot often labeled W/R/T, K, DEF), plus a projection number and a live "Fan Pts" number (which may show "-" if the games haven't started yet) for each player.

Bill's team is named "${YAHOO_TEAM_NAME}" — identify which side of the page is his team by matching that name (it may be truncated or wrapped visually, but match it as closely as shown). Extract BOTH rosters: his own starting lineup, and his opponent's starting lineup (the other team on the page), plus the opponent's team name.

CRITICAL: Respond with ONLY the raw JSON object below — no introductory sentence, no explanation, no markdown code fences. Your entire response must start with { and end with }.
{
  "week": <number or null if not visible>,
  "opponentTeamName": "<the other team's name as shown, or null>",
  "roster": [
    { "playerName": "<name as shown>", "position": "<position slot label as shown, e.g. QB, RB, WR, TE, W/R/T, K, DEF>", "nflTeam": "<team abbrev if visible, else null>", "projection": <number or null>, "livePoints": <number if a real value is shown, null if it shows "-" or is blank> }
  ],
  "opponentRoster": [
    { "playerName": "<name as shown>", "position": "<position slot label as shown, e.g. QB, RB, WR, TE, W/R/T, K, DEF>", "nflTeam": "<team abbrev if visible, else null>", "projection": <number or null>, "livePoints": <number if a real value is shown, null if it shows "-" or is blank> }
  ]
}
"roster" is Bill's own lineup (the side matching his team name). "opponentRoster" is the OTHER side of the page — same fields, same format. Both are required.`,
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

  // The prompt asks for pure JSON with no preamble, but vision responses
  // occasionally add a conversational lead-in anyway ("Here is my careful
  // reading of the grid..."). Rather than fail outright when that happens,
  // pull out just the first {...} block and parse that.
  const extractJsonBlock = (text) => {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end === -1 || end < start) return text;
    return text.slice(start, end + 1);
  };

  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const jsonOnly = extractJsonBlock(cleaned);
    try {
      return JSON.parse(jsonOnly);
    } catch (err2) {
      throw new Error(`Failed to parse vision extraction result: ${err2.message}. Raw: ${cleaned.slice(0, 300)}`);
    }
  }
}

module.exports = { extractFromImage };
