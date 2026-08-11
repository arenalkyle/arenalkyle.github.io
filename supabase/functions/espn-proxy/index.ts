// Edge Function: espn-proxy
//
// my-teams.html needs to read ESPN fantasy leagues, but ESPN's
// (unofficial, undocumented) fantasy API authenticates private
// leagues via two cookies -- espn_s2 and SWID. A browser's fetch()
// refuses to let JS set a Cookie header (it's on the forbidden
// header list), so a private league can't be fetched directly from
// the client no matter what. This function exists only to do that
// one thing server-side, where Deno's fetch has no such restriction.
//
// Public leagues don't strictly need this (ESPN's API is CORS-open
// for those), but routing everything through here keeps js/
// fantasy-platforms.js's ESPN path to one code path instead of two.
//
// Deploy with: supabase functions deploy espn-proxy --no-verify-jwt
// (--no-verify-jwt because this doesn't touch our own database or
// auth at all -- it's a pure passthrough to ESPN's public API.)

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let leagueId: string, season: string, espnS2: string | undefined, swid: string | undefined;
  try {
    const body = await req.json();
    leagueId = String(body.leagueId || '').trim();
    season = String(body.season || '').trim();
    espnS2 = body.espnS2 ? String(body.espnS2).trim() : undefined;
    swid = body.swid ? String(body.swid).trim() : undefined;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }
  if (!leagueId || !season) return json({ error: 'bad_request' }, 400);

  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
    `?view=mRoster&view=mTeam&view=mStandings&view=mSettings`;

  const headers: Record<string, string> = {};
  if (espnS2 && swid) {
    headers['Cookie'] = `espn_s2=${espnS2}; SWID=${swid}`;
  }

  let espnRes: Response;
  try {
    espnRes = await fetch(url, { headers });
  } catch {
    return json({ error: 'espn_unreachable' }, 502);
  }

  if (espnRes.status === 401 || espnRes.status === 403) {
    return json({ error: 'private_league' }, 403);
  }
  if (!espnRes.ok) {
    return json({ error: 'not_found' }, 404);
  }

  const data = await espnRes.json();
  return json(data);
});
