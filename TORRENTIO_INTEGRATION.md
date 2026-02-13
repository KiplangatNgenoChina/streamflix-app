# Torrentio Integration Guide for StreamFlix

## Overview

Torrentio is a Stremio add-on that provides torrent-based streams. It uses **IMDb IDs** (not TMDB IDs) for movies. Your site uses TMDB, so we map TMDB → IMDb via the external_ids endpoint before fetching streams.

## What's Implemented

- **Watch** button (movie modal + hero) → Opens Torrentio stream picker
- **Trailer** button → Plays YouTube trailer (unchanged)
- IMDb ID lookup from TMDB before calling Torrentio
- Stream picker UI with quality/source info
- Playback: Direct `url` (debrid) → HTML5 video; `infoHash` → WebTorrent or magnet link
- Torrentio proxy in `server.py` (when using `python3 server.py`) to avoid CORS

---

## Key Differences

| Your Site | Torrentio |
|-----------|-----------|
| TMDB IDs (e.g. `27205`) | IMDb IDs (e.g. `tt1375666`) |
| `/stream/movie/27205.json` ❌ | `/stream/movie/tt1375666.json` ✅ |

---

## Integration Steps

### 1. Get IMDb ID from TMDB

Before calling Torrentio, fetch the movie's IMDb ID from TMDB:

```javascript
// TMDB endpoint: GET /movie/{id}/external_ids
const response = await fetch(`https://api.themoviedb.org/3/movie/${tmdbId}/external_ids?api_key=YOUR_KEY`);
const { imdb_id } = await response.json(); // e.g. "tt1375666"
```

### 2. Fetch Streams from Torrentio

```javascript
const TORRENTIO_BASE = 'https://torrentio.strem.fun'; // or your self-hosted URL

async function getTorrentioStreams(imdbId, type = 'movie') {
  const res = await fetch(`${TORRENTIO_BASE}/stream/${type}/${imdbId}.json`);
  const data = await res.json();
  return data.streams || [];
}
```

### 3. Stream Response Format

Each stream object contains:

| Field | Description |
|-------|-------------|
| `name` | Quality label (e.g. "4k HDR", "1080p") |
| `title` | Full torrent name with size, seeders |
| `infoHash` | Torrent info hash (for torrent-based playback) |
| `fileIdx` | Index of video file within torrent |
| `url` | Direct URL (only if debrid service configured) |
| `ytId` | YouTube ID (for trailers, rarely used) |

**Note:** The public instance returns `infoHash` streams. Direct `url` links only appear when users configure RealDebrid/Premiumize/AllDebrid on a **self-hosted** Torrentio instance.

### 4. Playback Options

| Method | Best For | Complexity |
|--------|----------|------------|
| **WebTorrent** | Browser-only, no backend | Medium – use `webtorrent` lib with `infoHash` + `fileIdx` |
| **Torrent-to-HTTP proxy** | Production, reliable | High – run TorrServer, WebTorrent-hybrid, or similar backend |
| **Debrid services** | Best UX, paid | Low – self-host Torrentio with RealDebrid; streams return direct `url` |

### 5. WebTorrent (Browser) Example

```javascript
import WebTorrent from 'webtorrent';

const client = new WebTorrent();
const torrentId = `magnet:?xt=urn:btih:${infoHash}`;

client.add(torrentId, { path: fileIdx }, (torrent) => {
  const file = torrent.files[fileIdx];
  file.renderTo(document.querySelector('video')); // Streams to <video> element
});
```

### 6. CORS Considerations

Torrentio's public instance may allow CORS. If blocked, add a proxy route in `server.py`:

```python
# In server.py - add Torrentio proxy
elif self.path.startswith("/torrentio/"):
    path = self.path.replace("/torrentio/", "")
    url = f"https://torrentio.strem.fun/{path}"
    # ... fetch and return
```

### 7. Self-Hosting Torrentio

Benefits of self-hosting:
- Configure **RealDebrid/Premiumize/AllDebrid** → streams return direct `url` (easier playback)
- Customize providers, quality filters
- No reliance on public instance limits

Deploy via Docker: [Torrentio GitHub](https://github.com/JohnnyDevolved/torrentio)

---

## Recommended Flow

1. User clicks **Play** on a movie
2. If no `imdb_id` cached: fetch from TMDB `external_ids`
3. Fetch streams: `GET /stream/movie/{imdb_id}.json`
4. Show stream picker UI (quality, size, source)
5. If stream has `url` → use `<video src={url}>` or HLS.js
6. If stream has `infoHash` → use WebTorrent or proxy backend

---

## TV Shows / Series

For series, use: `/stream/series/{id}.json`

Torrentio's manifest shows `idPrefixes: ["tt", "kitsu"]` – so it expects IMDb IDs for series too. TMDB provides `external_ids.imdb_id` for TV shows as well.
