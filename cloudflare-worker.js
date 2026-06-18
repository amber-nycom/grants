/**
 * Cloudflare Worker — Grants.gov API Proxy
 *
 * This Worker acts as a middleman between the NYCOM Grants Dashboard and the
 * Grants.gov search API. It exists because browsers block direct requests to
 * external APIs that don't explicitly allow them (a security rule called CORS).
 *
 * How it works:
 *   1. The dashboard sends a search request to this Worker
 *   2. The Worker forwards it to api.grants.gov
 *   3. Grants.gov responds to the Worker
 *   4. The Worker passes the data back to the dashboard
 *
 * The Worker is deployed at: https://young-base-f33b.amberdlucky.workers.dev
 * It is managed in Cloudflare (cloudflare.com) under Amber's account.
 * No API key is required — Grants.gov's search endpoint is public.
 *
 * To edit or redeploy, log into Cloudflare → Workers & Pages → this Worker.
 */
export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
        }
      });
    }

    const body = await request.text();
    const response = await fetch('https://api.grants.gov/v1/api/search2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });

    const data = await response.text();
    return new Response(data, {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      }
    });
  }
};
