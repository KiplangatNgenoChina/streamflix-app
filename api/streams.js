// Vercel serverless function to fetch streams from StremThru (ElfHosted) only.
// Set STREMTHRU_STREAM_BASE_URL to your wrapped addon base URL (no /manifest.json).
// Stream URLs in the response point at StremThru so playback stays on your site
// and Real-Debrid only sees one IP. Configure debrid in StremThru, not here.

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { id, type = 'movie' } = req.query || {};
  if (!id) {
    return res.status(400).json({ error: 'Missing id parameter' });
  }

  const stremthruBase = (process.env.STREMTHRU_STREAM_BASE_URL || '').replace(/\/$/, '');
  if (!stremthruBase) {
    return res.status(503).json({
      error: 'StremThru not configured. Set STREMTHRU_STREAM_BASE_URL in Vercel environment variables.',
      streams: [],
    });
  }

  const safeType = typeof type === 'string' && (type === 'movie' || type === 'series' || type === 'tv')
    ? type
    : 'movie';

  const encodedId = encodeURIComponent(String(id));
  const streamPath = `stream/${safeType}/${encodedId}.json`;
  let url = `${stremthruBase}/${streamPath}`;
  const token = process.env.STREMTHRU_TOKEN;
  if (token) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);

  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      return res.status(response.status).json({
        error: `Stream source error: ${response.status}`,
        streams: [],
      });
    }

    const data = await response.json();
    const streams = Array.isArray(data.streams) ? data.streams : [];

    return res.status(200).json({ streams });
  } catch (err) {
    console.error('Error in /api/streams:', err);
    return res.status(500).json({ error: 'Internal server error', streams: [] });
  }
}
