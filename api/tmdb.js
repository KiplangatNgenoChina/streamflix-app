// Vercel serverless function to proxy TMDB requests.
// Uses TMDB_API_KEY from environment variables and never exposes the key
// to the browser.

const TMDB_BASE = 'https://api.themoviedb.org/3';

export default async function handler(req, res) {
  const { TMDB_API_KEY } = process.env;
  if (!TMDB_API_KEY) {
    return res.status(500).json({ status_message: 'TMDB_API_KEY is not configured on the server.' });
  }

  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status_message: 'Method not allowed' });
  }

  const { path = '', ...rest } = req.query || {};
  const cleanPath = String(path || '').replace(/^\//, '');
  if (!cleanPath) {
    return res.status(400).json({ status_message: 'Missing TMDB path' });
  }

  const searchParams = new URLSearchParams(rest);
  const url = `${TMDB_BASE}/${cleanPath}?api_key=${encodeURIComponent(TMDB_API_KEY)}&${searchParams.toString()}`;

  try {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      return res.status(response.status).json({
        status_message: data.status_message || `TMDB error: ${response.status}`,
      });
    }
    if (data.success === false) {
      return res.status(400).json({
        status_message: data.status_message || 'TMDB request failed',
      });
    }
    return res.status(200).json(data);
  } catch (err) {
    console.error('Error in /api/tmdb:', err);
    return res.status(500).json({ status_message: 'Internal server error' });
  }
}

