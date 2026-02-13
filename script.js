// TMDB API configuration
const API_KEY = '53197e900dd0dfceb105a636a0d1aa6a';
const IMAGE_BASE = 'https://image.tmdb.org/t/p/w342'; // 342px for cards (220px display) - smaller than w500
const IMAGE_BASE_HERO = 'https://image.tmdb.org/t/p/w780'; // Larger for hero backdrop
const STILL_BASE = 'https://image.tmdb.org/t/p/w300';
const API_BASE = 'https://api.themoviedb.org/3';

// Auth0 configuration (public values, safe to expose in frontend)
const AUTH0_DOMAIN = 'dev-gfbbfod3imrzw1sz.us.auth0.com';
const AUTH0_CLIENT_ID = '1zFRwNNhIoNeNNT0kYwTAFAb2el3EOpS';
const AUTH0_AUDIENCE = 'https://streamflix-api';
const ADMIN_EMAIL = 'dickiejohns08@gmail.com'; // Only this account is treated as admin

let auth0Client = null;
let authUser = null;
let authInitPromise = null;

function createAuth0ClientWrapper(options) {
  if (window.auth0 && typeof window.auth0.createAuth0Client === 'function') {
    return window.auth0.createAuth0Client(options);
  }
  if (typeof window.createAuth0Client === 'function') {
    return window.createAuth0Client(options);
  }
  return Promise.reject(new Error('Auth0 SPA SDK not loaded'));
}

// Use local proxy when available (run server.py), else Vercel API proxy
const USE_LOCAL_PROXY = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';

// Torrentio (use /torrentio proxy when on localhost, else direct)
const TORRENTIO_BASE = USE_LOCAL_PROXY ? `${window.location.origin}/torrentio` : 'https://torrentio.strem.fun';

// Wyzie Subs (free subtitle API; use /subs proxy when on localhost)
const SUBS_BASE = USE_LOCAL_PROXY ? `${window.location.origin}/subs` : 'https://sub.wyzie.ru';

// Current media context for auto subtitle lookup (set when opening stream picker)
let currentMediaContext = null;

// Category config: endpoint, params, isTV, sortByRating (for top rated)
const categories = {
  trending_movies: { url: `${API_BASE}/trending/movie/day`, params: {}, isTV: false },
  top_rated_movies: { url: `${API_BASE}/movie/top_rated`, params: {}, isTV: false, sortByRating: true },
  popular_movies: { url: `${API_BASE}/movie/popular`, params: {}, isTV: false },
  action_movies: { url: `${API_BASE}/discover/movie`, params: { with_genres: 28 }, isTV: false },
  scifi_movies: { url: `${API_BASE}/discover/movie`, params: { with_genres: 878 }, isTV: false },
  comedy_movies: { url: `${API_BASE}/discover/movie`, params: { with_genres: 35 }, isTV: false },
  trending_tv: { url: `${API_BASE}/trending/tv/day`, params: {}, isTV: true },
  top_rated_tv: { url: `${API_BASE}/tv/top_rated`, params: {}, isTV: true, sortByRating: true },
  popular_tv: { url: `${API_BASE}/tv/popular`, params: {}, isTV: true },
  drama_tv: { url: `${API_BASE}/discover/tv`, params: { with_genres: 18 }, isTV: true },
  comedy_tv: { url: `${API_BASE}/discover/tv`, params: { with_genres: 35 }, isTV: true },
  anime_movies: { url: `${API_BASE}/discover/movie`, params: { with_genres: 16 }, isTV: false },
  anime_tv: { url: `${API_BASE}/discover/tv`, params: { with_genres: 16 }, isTV: true },
};

// Pagination state per category: { page, totalPages, loading }
const categoryState = {};

// Priority rows (above fold) - load first for fast initial paint
const PRIORITY_ROWS = ['trending_movies', 'top_rated_movies', 'popular_movies', 'action_movies'];

// API cache (5 min TTL) - reduces repeat requests on filter/search
const apiCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

function getCacheKey(url, params) {
  return url + '?' + new URLSearchParams(params).toString();
}

// Fetch from TMDB API (local proxy or Vercel API proxy)
async function fetchFromTMDB(url, params = {}, skipCache = false) {
  const searchParams = new URLSearchParams(params);
  const cacheKey = getCacheKey(url, params);
  if (!skipCache && apiCache.has(cacheKey)) {
    const { data, expires } = apiCache.get(cacheKey);
    if (Date.now() < expires) return data;
    apiCache.delete(cacheKey);
  }

  const path = url.replace(API_BASE, '');

  // Try local proxy first (when using server.py - adds api_key server-side)
  if (USE_LOCAL_PROXY) {
    try {
      const proxyUrl = `/api${path}${searchParams.toString() ? '?' + searchParams : ''}`;
      const res = await fetch(proxyUrl);
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success !== false) {
        if (!skipCache) apiCache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL });
        return data;
      }
      if (data.status_message) throw new Error(data.status_message);
    } catch (e) {
      if (e.message) throw e;
    }
  }

  // Vercel API proxy (no CORS issues, key lives in env)
  const apiUrl = `/api/tmdb?path=${encodeURIComponent(path.replace(/^\//, ''))}${searchParams.toString() ? '&' + searchParams.toString() : ''}`;
  const res = await fetch(apiUrl);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.status_message || data.message || `API error: ${res.status}`);
  }
  if (data.success === false) throw new Error(data.status_message || 'API request failed');
  if (!skipCache) apiCache.set(cacheKey, { data, expires: Date.now() + CACHE_TTL });
  return data;
}

// Transform TMDB result to our movie format
function toMovie(item) {
  return {
    id: item.id,
    title: item.title,
    year: item.release_date ? item.release_date.slice(0, 4) : 'N/A',
    rating: item.vote_average ? item.vote_average.toFixed(1) : 'N/A',
    img: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : 'https://via.placeholder.com/220x330/1f1f1f/666?text=No+Image',
    imgHero: item.poster_path ? `${IMAGE_BASE_HERO}${item.poster_path}` : null,
    desc: item.overview || 'No description available.',
    type: 'movie',
  };
}

// Transform TMDB TV result
function toTVShow(item) {
  return {
    id: item.id,
    title: item.name,
    year: item.first_air_date ? item.first_air_date.slice(0, 4) : 'N/A',
    rating: item.vote_average ? item.vote_average.toFixed(1) : 'N/A',
    img: item.poster_path ? `${IMAGE_BASE}${item.poster_path}` : 'https://via.placeholder.com/220x330/1f1f1f/666?text=No+Image',
    imgHero: item.poster_path ? `${IMAGE_BASE_HERO}${item.poster_path}` : null,
    desc: item.overview || 'No description available.',
    type: 'tv',
  };
}

// Create a single movie/TV card element
function createCard(item) {
  const card = document.createElement('div');
  card.className = 'movie-card';
  card.dataset.id = item.id;
  card.dataset.title = item.title;
  card.dataset.year = item.year;
  card.dataset.rating = item.rating;
  card.dataset.img = item.img;
  card.dataset.desc = item.desc;
  card.dataset.type = item.type || 'movie';
  card.innerHTML = `
    <img src="${item.img}" alt="${item.title}" loading="lazy" width="220" height="330" decoding="async">
    <div class="card-overlay">
      <span class="card-title">${item.title}</span>
      <span class="card-meta">${item.year} • ${item.rating}⭐</span>
    </div>
  `;
  card.addEventListener('click', () => openDetailModal(item));
  return card;
}

// Append cards to a row (before the More button if present)
function appendCardsToRow(rowId, items) {
  const row = document.querySelector(`[data-row="${rowId}"]`);
  if (!row) return;
  const moreBtn = row.querySelector('.row-more-btn');
  items.forEach((item) => {
    const card = createCard(item);
    row.insertBefore(card, moreBtn);
  });
}

// Create the "More" button element for a row
function createMoreButton(rowId) {
  const btn = document.createElement('button');
  btn.className = 'row-more-btn';
  btn.innerHTML = '<span class="row-more-text">More</span><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8.59 16.59L10 18l6-6-6-6-1.41 1.41L13.17 12z"/></svg>';
  btn.setAttribute('aria-label', 'Load more');
  btn.addEventListener('click', () => loadMoreForRow(rowId));
  return btn;
}

// Load more items for a category (dynamic pagination)
async function loadMoreForRow(rowId) {
  const config = categories[rowId];
  if (!config) return;
  const state = categoryState[rowId];
  if (!state?.hasMore || state.loading) return;

  state.loading = true;
  const moreBtn = document.querySelector(`[data-row="${rowId}"]`)?.querySelector('.row-more-btn');
  if (moreBtn) moreBtn.classList.add('loading');

  try {
    const nextPage = (state.page || 1) + 1;
    const params = { ...config.params, page: nextPage };
    const data = await fetchFromTMDB(config.url, params);
    let items = data.results || [];
    if (config.sortByRating) {
      items = [...items].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
    }
    const mapped = items.map(config.isTV ? toTVShow : toMovie);
    appendCardsToRow(rowId, mapped);

    state.page = nextPage;
    state.totalPages = Math.min(data.total_pages || 500, 500);
    state.hasMore = nextPage < state.totalPages;
    if (!state.hasMore && moreBtn) moreBtn.style.display = 'none';
  } catch (err) {
    console.error('Load more failed:', err);
  } finally {
    state.loading = false;
    if (moreBtn) moreBtn.classList.remove('loading');
  }
}

// Render movie/TV cards (initial load)
function renderMovies(data) {
  Object.keys(data).forEach((rowId) => {
    const row = document.querySelector(`[data-row="${rowId}"]`);
    if (!row) return;

    row.innerHTML = '';
    (data[rowId] || []).forEach((item) => row.appendChild(createCard(item)));
    row.appendChild(createMoreButton(rowId));
  });
}

// Update hero with featured movie
function updateHero(movie) {
  const hero = document.querySelector('.hero');
  if (!hero || !movie) return;

  hero.querySelector('.hero-backdrop').style.backgroundImage = `url(${movie.imgHero || movie.img})`;
  hero.querySelector('.hero-title').textContent = movie.title;
  hero.querySelector('.hero-description').textContent =
    (movie.desc || '').slice(0, 180) + (movie.desc && movie.desc.length > 180 ? '...' : '');
  const heroPlay = document.getElementById('hero-play-btn');
  const heroMore = document.getElementById('hero-more-btn');
  if (heroPlay) {
    heroPlay.dataset.movieId = movie.id;
    heroPlay.style.display = '';
  }
  if (heroMore) heroMore.style.display = '';
  hero.dataset.heroMovie = JSON.stringify(movie);
}

// Load a single category and render its row
async function loadCategory(key, results) {
  const config = categories[key];
  if (!config) return;
  const data = await fetchFromTMDB(config.url, { ...config.params, page: 1 });
  let items = data.results || [];
  if (config.sortByRating) {
    items = [...items].sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
  }
  const mapped = items.map(config.isTV ? toTVShow : toMovie);
  results[key] = mapped;
  categoryState[key] = { page: 1, totalPages: Math.min(data.total_pages || 500, 500), hasMore: (data.total_pages || 1) > 1, loading: false };
  renderMovies({ [key]: mapped });
}

// Phased load: priority rows first (fast paint), then rest in background
async function loadMovies(showLoadingScreen = false) {
  const contentSection = document.querySelector('.content-section');
  let loadingEl = null;
  if (showLoadingScreen) {
    loadingEl = document.createElement('div');
    loadingEl.className = 'loading-screen';
    loadingEl.innerHTML = `
      <div class="loading-content">
        <div class="loading-logo">StreamFlix</div>
        <div class="loading-bar"><div class="loading-progress"></div></div>
        <p class="loading-text">Loading your favorites...</p>
      </div>
    `;
    contentSection?.prepend(loadingEl);
  }

  const results = {};
  const allKeys = Object.keys(categories);
  const priorityKeys = PRIORITY_ROWS.filter((k) => allKeys.includes(k));
  const restKeys = allKeys.filter((k) => !priorityKeys.includes(k));

  try {
    // Phase 1: Load priority rows (above fold) - 4 parallel requests
    await Promise.all(priorityKeys.map((key) => loadCategory(key, results)));
    setupInfiniteScroll();
    if (results.trending_movies?.length) updateHero(results.trending_movies[0]);
  } catch (err) {
    console.error('Failed to load movies:', err);
    contentSection?.querySelectorAll('.error-message').forEach((el) => el.remove());
    contentSection?.prepend(
      Object.assign(document.createElement('div'), {
        className: 'error-message',
        textContent: err.message || 'Failed to load movies. Check your API key and network.',
      })
    );
  } finally {
    if (loadingEl) {
      loadingEl.classList.add('loading-done');
      setTimeout(() => loadingEl.remove(), 300);
    }
    resetSearchUI();
    applyBrowseFilter();
  }

  // Phase 2: Load remaining rows in background (3 at a time to avoid overwhelming)
  restKeys.forEach((key) => {
    const row = document.querySelector(`[data-row="${key}"]`);
    if (row) row.innerHTML = '<div class="row-loading">Loading...</div>';
  });
  const BATCH_SIZE = 3;
  for (let i = 0; i < restKeys.length; i += BATCH_SIZE) {
    const batch = restKeys.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map((key) => loadCategory(key, results)));
    setupInfiniteScroll();
  }
}

// Get IMDb ID from TMDB (Torrentio uses IMDb IDs, not TMDB)
async function getImdbId(tmdbId, type = 'movie') {
  const path = (type === 'tv' || type === 'series') ? `tv/${tmdbId}/external_ids` : `movie/${tmdbId}/external_ids`;
  const data = await fetchFromTMDB(`${API_BASE}/${path}`);
  return data.imdb_id || null;
}

// Fetch streams from StremThru (via /api/streams or local /torrentio proxy).
async function getTorrentioStreams(streamId, type = 'movie') {
  const streamPath = `stream/${type}/${streamId}.json`;

  // Local development: Python server.py proxies to StremThru when STREMTHRU_STREAM_BASE_URL is set in .env
  if (USE_LOCAL_PROXY) {
    const url = `${TORRENTIO_BASE}/${streamPath}`;
    try {
      const res = await fetch(url);
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Stream fetch failed');
      }
      const data = await res.json();
      const streams = data.streams || [];
      if (streams.length) return streams;
    } catch (e) {
      throw e instanceof Error ? e : new Error('No streams found for this title.');
    }
    throw new Error('No streams found for this title.');
  }

  // Deployed: Vercel /api/streams fetches from StremThru (STREMTHRU_STREAM_BASE_URL in env)
  const params = new URLSearchParams({ id: String(streamId), type });

  const res = await fetch(`/api/streams?${params.toString()}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to load streams.');
  const streams = data.streams || [];
  if (!streams.length) throw new Error('No streams found for this title.');
  return streams;
}

// Row carousel navigation
document.querySelectorAll('.row-nav-left').forEach((btn) => {
  btn.addEventListener('click', () => {
    const row = btn.closest('.row-container')?.querySelector('.movie-row');
    row?.scrollBy({ left: -400, behavior: 'smooth' });
  });
});

document.querySelectorAll('.row-nav-right').forEach((btn) => {
  btn.addEventListener('click', () => {
    const row = btn.closest('.row-container')?.querySelector('.movie-row');
    row?.scrollBy({ left: 400, behavior: 'smooth' });
  });
});

// Infinite scroll: load more when user scrolls near end of row
function setupInfiniteScroll() {
  document.querySelectorAll('.movie-row').forEach((row) => {
    if (row.dataset.scrollSetup) return;
    row.dataset.scrollSetup = '1';
    const rowId = row.dataset.row;
    if (!rowId) return;
    row.addEventListener('scroll', () => {
      if (!categoryState[rowId]?.hasMore || categoryState[rowId]?.loading) return;
      const { scrollLeft, scrollWidth, clientWidth } = row;
      const threshold = scrollWidth - clientWidth - 300;
      if (scrollLeft >= threshold) loadMoreForRow(rowId);
    });
  });
}

// Movie/Detail modal
const movieModal = document.getElementById('movie-modal');
const videoModal = document.getElementById('video-modal');

function openDetailModal(item) {
  if (item.type === 'tv') {
    openEpisodePicker(item);
  } else {
    openMovieModal(item);
  }
}

function openMovieModal(movie) {
  movieModal.querySelector('.modal-poster').style.backgroundImage = `url(${movie.img})`;
  movieModal.querySelector('.modal-title').textContent = movie.title;
  movieModal.querySelector('.modal-description').textContent = movie.desc;
  movieModal.querySelector('.modal-rating').textContent = `${movie.rating} Rating`;
  movieModal.querySelector('.modal-year').textContent = movie.year;
  movieModal.querySelector('.modal-duration').textContent = '';
  movieModal.dataset.movieId = movie.id;
  movieModal.dataset.type = movie.type || 'movie';
  movieModal.classList.add('active');
}

function closeMovieModal() {
  movieModal.classList.remove('active');
}

movieModal.querySelector('.modal-close').addEventListener('click', closeMovieModal);
movieModal.querySelector('.modal-backdrop').addEventListener('click', closeMovieModal);

// Play button in modal - open Torrentio stream picker
movieModal.querySelector('.modal-play').addEventListener('click', () => {
  const movieId = movieModal.dataset.movieId;
  const type = movieModal.dataset.type || 'movie';
  if (movieId) openStreamPicker(movieId, type);
});

// Hero Play - open Torrentio stream picker
document.getElementById('hero-play-btn')?.addEventListener('click', () => {
  const movieId = document.getElementById('hero-play-btn')?.dataset.movieId;
  if (movieId) openStreamPicker(movieId, 'movie');
});

// Hero More Info - open movie modal
document.getElementById('hero-more-btn')?.addEventListener('click', () => {
  const hero = document.querySelector('.hero');
  const data = hero?.dataset.heroMovie;
  if (data) {
    try {
      openMovieModal(JSON.parse(data));
    } catch {}
  }
});

// Video modal close
function closeVideoModal() {
  videoModal.classList.remove('active');
  const wrapper = videoModal.querySelector('.video-wrapper');
  wrapper.innerHTML = `
    <video id="demo-video" controls>
      <source src="https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4" type="video/mp4">
    </video>
    <div class="custom-volume-control"><button class="volume-btn" aria-label="Volume"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg></button><input type="range" class="volume-slider" min="0" max="1" step="0.05" value="1"><button class="cc-btn" aria-label="Subtitles" title="Subtitles"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H6v-2h12v2z"/></svg></button><div class="subtitle-panel"><input type="text" class="subtitle-url-input" placeholder="Paste .vtt URL"><small>Find subs at opensubtitles.org</small><button class="btn btn-play load-subtitle-btn">Load</button></div></div>
  `;
  attachVolumeControl(wrapper);
}

videoModal.querySelector('.video-close').addEventListener('click', closeVideoModal);
videoModal.querySelector('.modal-backdrop').addEventListener('click', closeVideoModal);

// Navbar scroll effect
window.addEventListener('scroll', () => {
  document.querySelector('.navbar').classList.toggle('scrolled', window.scrollY > 50);
});

// Search functionality
const searchBtn = document.querySelector('.search-btn');
const searchInput = document.querySelector('.search-input');
const searchContainer = document.querySelector('.search-container');

searchBtn.addEventListener('click', () => {
  searchContainer.classList.toggle('active');
  if (searchContainer.classList.contains('active')) searchInput.focus();
});

// Search filter: movie | tv
let searchFilter = 'movie';

// Browse filter: 'movie' | 'tv' | 'all' - which content rows to show
let browseFilter = 'all';

function applyBrowseFilter() {
  const hero = document.querySelector('.hero');
  document.querySelectorAll('.content-row').forEach((row) => {
    const type = row.dataset.type;
    const show = browseFilter === 'all' || type === browseFilter;
    row.style.display = show ? 'block' : 'none';
  });
  if (hero) hero.style.display = browseFilter === 'tv' || browseFilter === 'anime' ? 'none' : 'block';
}

document.querySelectorAll('[data-filter]').forEach((el) => {
  el.addEventListener('click', (e) => {
    e.preventDefault();
    searchFilter = el.dataset.filter === 'all' ? 'movie' : el.dataset.filter;
    browseFilter = el.dataset.filter;
    document.querySelectorAll('.nav-links [data-filter]').forEach((x) => x.classList.toggle('active', x === el && el.dataset.filter !== 'all'));
    applyBrowseFilter();
    if (searchInput.value.trim().length >= 2) searchInput.dispatchEvent(new Event('input'));
  });
});

let searchTimeout;

function setSearchingState(searching) {
  const contentSection = document.querySelector('.content-section');
  const hero = document.querySelector('.hero');
  if (searching) {
    contentSection?.classList.add('searching');
    hero?.classList.add('searching');
  } else {
    contentSection?.classList.remove('searching');
    hero?.classList.remove('searching');
  }
}

searchInput.addEventListener('input', async (e) => {
  const query = e.target.value.trim();
  clearTimeout(searchTimeout);

  if (query.length < 2) {
    setSearchingState(false);
    document.getElementById('search-results-section').style.display = 'none';
    document.querySelector('.content-section').style.display = 'block';
    loadMovies();
    return;
  }

  // Immediately show visual feedback: animate existing movie cards
  setSearchingState(true);

  searchTimeout = setTimeout(async () => {
    const queryAtFetch = searchInput.value.trim();
    try {
      const data = await fetchFromTMDB(`${API_BASE}/search/multi`, { query: queryAtFetch });
      if (searchInput.value.trim() !== queryAtFetch) return;
      setSearchingState(false);
      const raw = (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
      const items = raw.map((r) => (r.media_type === 'movie' ? toMovie(r) : toTVShow(r)));
      items.sort((a, b) => {
        const rA = parseFloat(a.rating);
        const rB = parseFloat(b.rating);
        if (isNaN(rA) && isNaN(rB)) return 0;
        if (isNaN(rA)) return 1;
        if (isNaN(rB)) return -1;
        return rB - rA;
      });
      renderSearchResults(items.slice(0, 24), queryAtFetch);
      const section = document.getElementById('search-results-section');
      section.style.display = 'block';
      document.querySelector('.content-section').style.display = 'none';
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      if (searchInput.value.trim() === queryAtFetch) {
        setSearchingState(false);
        document.getElementById('search-results-section').style.display = 'none';
        document.querySelector('.content-section').style.display = 'block';
        loadMovies();
      }
    }
  }, 220);
});

searchInput.addEventListener('blur', () => {
  setTimeout(() => {
    setSearchingState(false);
    if (!searchInput.value.trim()) {
      document.getElementById('search-results-section').style.display = 'none';
      document.querySelector('.content-section').style.display = 'block';
      resetSearchUI();
      loadMovies();
    }
  }, 200);
});


// Render search results grid
function renderSearchResults(items, query = '') {
  const section = document.getElementById('search-results-section');
  const grid = document.getElementById('search-results-grid');
  const titleEl = document.getElementById('search-results-title');
  if (!grid) return;

  titleEl.textContent = query ? `Search results for "${query}"` : 'Search results';
  grid.innerHTML = '';

  items.forEach((item) => {
    const card = document.createElement('div');
    card.className = 'search-result-card';
    card.innerHTML = `
      <img src="${item.img}" alt="${item.title}" loading="lazy">
      <div class="search-result-card-info">
        <div class="search-result-card-title">${item.title}</div>
        <div class="search-result-card-meta">${item.year} • ${item.rating}⭐</div>
        <div class="search-result-card-desc">${item.desc}</div>
        <button class="btn btn-play">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
          Play
        </button>
      </div>
    `;
    card.querySelector('img').addEventListener('click', () => openDetailModal(item));
    card.querySelector('.btn-play').addEventListener('click', (e) => {
      e.stopPropagation();
      if (item.type === 'tv') openEpisodePicker(item);
      else openStreamPicker(item.id, 'movie');
    });
    card.querySelector('.search-result-card-info').addEventListener('click', (e) => {
      if (!e.target.closest('.btn')) openDetailModal(item);
    });
    grid.appendChild(card);
  });
}

// Episode Picker Modal (for TV series)
const episodeModal = document.getElementById('episode-modal');
const episodeList = document.getElementById('episode-list');
const episodePickerTitle = document.getElementById('episode-picker-title');

async function openEpisodePicker(show) {
  episodeModal.classList.add('active');
  episodePickerTitle.textContent = show.title;
  episodeList.innerHTML = '<div class="stream-loading">Loading...</div>';
  const seasonSelector = document.getElementById('season-selector');
  seasonSelector.innerHTML = '';

  try {
    const showData = await fetchFromTMDB(`${API_BASE}/tv/${show.id}`);
    const numSeasons = Math.min(showData.number_of_seasons || 1, 20);

    for (let s = 1; s <= numSeasons; s++) {
      const btn = document.createElement('button');
      btn.className = 'episode-btn' + (s === 1 ? ' active' : '');
      btn.textContent = `S${s}`;
      btn.dataset.season = s;
      btn.addEventListener('click', () => loadEpisodes(show.id, s));
      seasonSelector.appendChild(btn);
    }

    await loadEpisodes(show.id, 1);
  } catch (err) {
    episodeList.innerHTML = '<p class="settings-status error">Failed to load.</p>';
  }

  async function loadEpisodes(showId, season) {
    episodeList.innerHTML = '<div class="stream-loading">Loading...</div>';
    document.querySelectorAll('#season-selector .episode-btn').forEach((b) => b.classList.toggle('active', +b.dataset.season === season));
    try {
      const data = await fetchFromTMDB(`${API_BASE}/tv/${showId}/season/${season}`);
      const episodes = data.episodes || [];
      episodeList.innerHTML = '';
      episodes.forEach((ep) => {
        const stillUrl = ep.still_path ? `${STILL_BASE}${ep.still_path}` : 'https://via.placeholder.com/300x169/1f1f1f/666?text=E' + ep.episode_number;
        const card = document.createElement('button');
        card.className = 'episode-thumb';
        card.title = ep.name || `Episode ${ep.episode_number}`;
        card.innerHTML = `
          <img src="${stillUrl}" alt="${ep.name || 'Episode ' + ep.episode_number}" loading="lazy">
          <span class="episode-num">${ep.episode_number}</span>
          <span class="episode-name">${(ep.name || `Episode ${ep.episode_number}`).slice(0, 30)}${(ep.name && ep.name.length > 30) ? '…' : ''}</span>
        `;
        card.addEventListener('click', () => {
          closeEpisodeModal();
          openStreamPicker(showId, 'series', season, ep.episode_number);
        });
        episodeList.appendChild(card);
      });
    } catch {
      episodeList.innerHTML = '<p class="settings-status error">Failed to load episodes.</p>';
    }
  }
}

function closeEpisodeModal() {
  episodeModal?.classList.remove('active');
}

episodeModal?.querySelector('.episode-modal-close')?.addEventListener('click', closeEpisodeModal);
episodeModal?.querySelector('.modal-backdrop')?.addEventListener('click', closeEpisodeModal);

// Stream Picker Modal
const streamModal = document.getElementById('stream-modal');
const streamList = document.getElementById('stream-list');
const streamLoading = document.getElementById('stream-loading');
const streamError = document.getElementById('stream-error');

async function openStreamPicker(tmdbId, type = 'movie', season = 1, episode = 1) {
  closeMovieModal();
  closeEpisodeModal();
  streamModal.classList.add('active');
  streamList.innerHTML = '';
  streamLoading.classList.remove('hidden');
  streamError.classList.add('hidden');
  streamError.textContent = '';
  const pickerTitle = streamModal.querySelector('.stream-picker-title');
  pickerTitle.textContent = 'Choose a stream';

  try {
    const imdbId = (await getImdbId(tmdbId, type))?.trim();
    if (!imdbId) {
      throw new Error(type === 'series' ? 'No IMDb ID for this show. Try a different series.' : 'No IMDb ID found.');
    }
    currentMediaContext = { imdbId, type, season, episode };
    const streamId = type === 'series' ? `${imdbId}:${season}:${episode}` : imdbId;
    let streams = await getTorrentioStreams(streamId, type);
    // Exclude [RD download] streams — they often return "file removed for copyright infringement"
    streams = streams.filter((s) => {
      const text = `${s.name || ''} ${s.title || ''}`;
      return !text.includes('[RD download]');
    });
    streamLoading.classList.add('hidden');

    if (!streams.length) {
      streamError.textContent = 'No streams found for this title.';
      streamError.classList.remove('hidden');
      return;
    }

    // Sort streams by quality (4K, 1080p, 720p, etc.) and format (MP4 first for Firefox)
    const withQuality = streams.map((s) => {
      const text = `${s.name || ''} ${s.title || ''}`.toLowerCase();
      const isMp4 = /\.mp4(\?|$)/i.test(s.url || '') || text.includes('.mp4');
      let quality = 'Other';
      let rank = 99;
      if (/1080p/.test(text)) {
        quality = '1080p';
        rank = 1;
      } else if (/720p/.test(text)) {
        quality = '720p';
        rank = 2;
      } else if (/480p/.test(text)) {
        quality = '480p';
        rank = 3;
      } else if (/2160p|4k|uhd/.test(text)) {
        quality = '4K';
        rank = 4;
      }
      return { ...s, _quality: quality, _qualityRank: rank, _isMp4: isMp4 };
    });

    withQuality
      .sort((a, b) => {
        if (a._qualityRank !== b._qualityRank) return a._qualityRank - b._qualityRank;
        return (b._isMp4 ? 1 : 0) - (a._isMp4 ? 1 : 0);
      })
      .slice(0, 40)
      .forEach((s) => {
      const label = (s.name || 'Stream').replace(/\s+/g, ' ').trim();
      const details = (s.title || '').replace(/[\n\r]/g, ' ').slice(0, 80);
      const formatBadge = s._isMp4 ? '<span class="stream-format-badge">MP4</span>' : '';
      const item = document.createElement('div');
      item.className = 'stream-item';
      item.innerHTML = `
        <div class="stream-item-info">
          <div class="stream-item-name">
            <span class="stream-quality-badge">${s._quality}</span>
            ${formatBadge}
            <span>${label}</span>
          </div>
          <div class="stream-item-details">${details}${details.length >= 80 ? '…' : ''}</div>
        </div>
      `;
      item.addEventListener('click', () => playStream(s));
      streamList.appendChild(item);
    });
  } catch (err) {
    streamLoading.classList.add('hidden');
    streamError.textContent = err.message || 'Failed to load streams.';
    streamError.classList.remove('hidden');
  }
}

// Convert SRT to WebVTT (HTML5 video track format)
function srtToVtt(srt) {
  return 'WEBVTT\n\n' + srt
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}

// Fetch and auto-apply subtitles from Wyzie Subs API
async function autoLoadSubtitles(video, wrapper) {
  const ctx = currentMediaContext;
  if (!ctx?.imdbId || !video) return;

  const subHint = wrapper?.querySelector('.subtitle-hint');
  if (subHint) subHint.textContent = 'Searching subtitles...';

  try {
    let url = `${SUBS_BASE}/search?id=${ctx.imdbId}&language=en&format=srt&encoding=utf-8`;
    if (ctx.type === 'series' && ctx.season && ctx.episode) {
      url += `&season=${ctx.season}&episode=${ctx.episode}`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error('Subtitle search failed');
    const list = await res.json();
    if (!Array.isArray(list) || !list.length) {
      if (subHint) subHint.textContent = 'No subtitles found. Paste URL below.';
      return;
    }

    const sub = list[0];
    let subUrl = sub.url;
    if (!subUrl) {
      if (subHint) subHint.textContent = 'No subtitles found. Paste URL below.';
      return;
    }
    subUrl = subUrl.replace('https://sub.wyzie.ru', SUBS_BASE);
    subUrl = subUrl.includes('encoding=') ? subUrl.replace(/encoding=[^&]+/, 'encoding=utf-8') : subUrl + (subUrl.includes('?') ? '&' : '?') + 'encoding=utf-8';

    const subRes = await fetch(subUrl);
    if (!subRes.ok) throw new Error('Subtitle download failed');
    const srtText = await subRes.text();
    const vtt = srtToVtt(srtText);
    const blob = new Blob([vtt], { type: 'text/vtt' });
    const blobUrl = URL.createObjectURL(blob);

    const existing = video.querySelector('track');
    if (existing) existing.remove();
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.src = blobUrl;
    track.srclang = 'en';
    track.label = sub.display || 'English';
    track.default = true;
    video.appendChild(track);
    if (subHint) subHint.textContent = 'Subtitles loaded.';
  } catch {
    if (subHint) subHint.textContent = 'Auto-load failed. Paste .vtt URL below.';
  }
}

function attachVolumeControl(wrapper) {
  const video = wrapper.querySelector('video');
  const slider = wrapper.querySelector('.volume-slider');
  const volumeControl = wrapper.querySelector('.custom-volume-control');
  if (!video || !slider || !volumeControl) return;

  slider.value = video.volume;
  slider.addEventListener('input', () => {
    video.volume = parseFloat(slider.value);
    video.muted = video.volume === 0;
  });
  video.addEventListener('volumechange', () => {
    slider.value = video.volume;
  });

  // Auto-hide: show on hover, hide 2s after mouse leaves
  let hideTimer;
  wrapper.addEventListener('mouseenter', () => {
    clearTimeout(hideTimer);
    volumeControl.classList.add('visible');
  });
  wrapper.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(() => volumeControl.classList.remove('visible'), 2000);
  });
  volumeControl.addEventListener('mouseenter', () => clearTimeout(hideTimer));
  volumeControl.addEventListener('mouseleave', () => {
    hideTimer = setTimeout(() => volumeControl.classList.remove('visible'), 2000);
  });

  // Subtitles
  const ccBtn = wrapper.querySelector('.cc-btn');
  const subtitlePanel = wrapper.querySelector('.subtitle-panel');
  const subtitleInput = wrapper.querySelector('.subtitle-url-input');
  const loadSubBtn = wrapper.querySelector('.load-subtitle-btn');

  if (ccBtn && subtitlePanel) {
    ccBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      subtitlePanel.classList.toggle('open');
      if (subtitlePanel.classList.contains('open')) {
        volumeControl.classList.add('visible');
        setTimeout(() => {
          const close = (ev) => {
            if (!volumeControl.contains(ev.target)) {
              subtitlePanel.classList.remove('open');
              document.removeEventListener('click', close);
            }
          };
          document.addEventListener('click', close);
        }, 0);
      }
    });
  }
  if (loadSubBtn && subtitleInput && video) {
    loadSubBtn.addEventListener('click', () => {
      const url = subtitleInput.value.trim();
      if (!url) return;
      const existing = video.querySelector('track');
      if (existing) existing.remove();
      const track = document.createElement('track');
      track.kind = 'subtitles';
      track.src = url;
      track.srclang = 'en';
      track.label = 'English';
      track.default = true;
      video.appendChild(track);
      subtitlePanel.classList.remove('open');
      subtitleInput.value = '';
    });
  }
}

function inferVideoType(stream) {
  const url = (stream?.url || '').split('?')[0].toLowerCase();
  const name = `${stream?.name || ''} ${stream?.title || ''}`.toLowerCase();
  if (url.endsWith('.mp4') || url.endsWith('.m4v') || name.includes('.mp4')) return 'video/mp4';
  if (url.endsWith('.webm')) return 'video/webm';
  if (url.endsWith('.mkv') || name.includes('.mkv')) return 'video/x-matroska';
  return '';
}

async function playStream(stream) {
  streamModal.classList.remove('active');

  if (stream.url) {
    // StremThru URL: play in <video> only (no iframe — iframe can trigger download when server sends Content-Disposition: attachment)
    const videoModal = document.getElementById('video-modal');
    const wrapper = videoModal.querySelector('.video-wrapper');
    const video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.muted = false;
    video.volume = 1;
    const type = inferVideoType(stream);
    if (type) {
      const source = document.createElement('source');
      source.src = stream.url;
      source.type = type;
      video.appendChild(source);
    } else {
      video.src = stream.url;
    }
    video.addEventListener('error', () => {
      const msg = video.error?.message || '';
      if (msg.includes('format') || msg.includes('MIME') || video.error?.code === 3) {
        const hint = document.createElement('div');
        hint.className = 'video-error-hint';
        hint.innerHTML = 'Firefox may not support this stream format. Try Chrome, or select a stream that ends in .mp4.';
        wrapper.insertBefore(hint, wrapper.firstChild);
      } else {
        const hint = document.createElement('div');
        hint.className = 'video-error-hint';
        hint.textContent = 'Stream failed to play. Try another stream.';
        wrapper.insertBefore(hint, wrapper.firstChild);
      }
    });
    wrapper.innerHTML = '';
    wrapper.appendChild(video);
    wrapper.insertAdjacentHTML('beforeend', '<div class="custom-volume-control"><button class="volume-btn" aria-label="Volume"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/></svg></button><input type="range" class="volume-slider" min="0" max="1" step="0.05" value="1"><button class="cc-btn" aria-label="Subtitles" title="Subtitles"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zM4 12h4v2H4v-2zm10 6H4v-2h10v2zm6 0h-4v-2h4v2zm0-4H6v-2h12v2z"/></svg></button><div class="subtitle-panel"><div class="subtitle-hint">Loading subtitles...</div><input type="text" class="subtitle-url-input" placeholder="Or paste .vtt URL"><button class="btn btn-play load-subtitle-btn">Load</button></div></div>');
    attachVolumeControl(wrapper);
    autoLoadSubtitles(wrapper.querySelector('video'), wrapper);
    videoModal.classList.add('active');
    video.play().catch(() => {});
    return;
  }

  const videoModal = document.getElementById('video-modal');
  const wrapper = videoModal.querySelector('.video-wrapper');
  wrapper.innerHTML = '<div class="video-loading">No direct stream URL. Try another stream.</div>';
  videoModal.classList.add('active');
}

function closeStreamModal() {
  streamModal.classList.remove('active');
}

streamModal.querySelector('.stream-modal-close').addEventListener('click', closeStreamModal);
streamModal.querySelector('.modal-backdrop').addEventListener('click', closeStreamModal);

// Profile dropdown toggle
const profileMenu = document.querySelector('.profile-menu');
const profileAvatar = document.querySelector('.profile-avatar');

profileAvatar?.addEventListener('click', (e) => {
  e.stopPropagation();
  profileMenu?.classList.toggle('open');
});

document.addEventListener('click', () => profileMenu?.classList.remove('open'));

// Admin Modal (Settings hidden behind Auth0 admin login)
const adminModal = document.getElementById('admin-modal');
const adminLink = document.getElementById('admin-link');
const adminSettingsBtn = document.getElementById('admin-settings-btn');

function isCurrentUserAdmin() {
  return !!authUser && authUser.email === ADMIN_EMAIL;
}

adminLink?.addEventListener('click', async (e) => {
  e.preventDefault();
  profileMenu?.classList.remove('open');

  if (!auth0Client) {
    await initAuth();
  }
  if (!auth0Client) return;

  const isAuthenticated = await auth0Client.isAuthenticated();
  if (!isAuthenticated) {
    await auth0Client.loginWithRedirect({
      authorizationParams: {
        redirect_uri: window.location.origin,
        audience: AUTH0_AUDIENCE,
      },
    });
    return;
  }

  if (isCurrentUserAdmin()) {
    adminModal?.classList.add('active');
  } else {
    alert('You are signed in but not an admin.');
  }
});

document.getElementById('account-link')?.addEventListener('click', (e) => {
  e.preventDefault();
  profileMenu?.classList.remove('open');
  document.getElementById('account-modal')?.classList.add('active');
});

document.getElementById('signout-link')?.addEventListener('click', async (e) => {
  e.preventDefault();
  profileMenu?.classList.remove('open');
  if (auth0Client) {
    const isAuthenticated = await auth0Client.isAuthenticated();
    if (isAuthenticated) {
      auth0Client.logout({
        logoutParams: {
          returnTo: window.location.origin,
        },
      });
      return;
    }
  }
  document.getElementById('signout-modal')?.classList.add('active');
});

document.getElementById('account-modal')?.querySelector('.account-close')?.addEventListener('click', () => {
  document.getElementById('account-modal')?.classList.remove('active');
});
document.getElementById('account-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => {
  document.getElementById('account-modal')?.classList.remove('active');
});

document.getElementById('signout-modal')?.querySelector('.signout-close')?.addEventListener('click', () => {
  document.getElementById('signout-modal')?.classList.remove('active');
});
document.getElementById('signout-modal')?.querySelector('.modal-backdrop')?.addEventListener('click', () => {
  document.getElementById('signout-modal')?.classList.remove('active');
});

adminModal?.querySelector('.admin-close')?.addEventListener('click', () => {
  adminModal?.classList.remove('active');
});

adminModal?.querySelector('.modal-backdrop')?.addEventListener('click', () => {
  adminModal?.classList.remove('active');
});

adminSettingsBtn?.addEventListener('click', () => {
  adminModal?.classList.remove('active');
  settingsModal?.classList.add('active');
});

// Settings Modal
const settingsModal = document.getElementById('settings-modal');
const settingsOkBtn = document.getElementById('settings-ok-btn');

settingsModal?.querySelector('.settings-close')?.addEventListener('click', () => {
  settingsModal?.classList.remove('active');
});

settingsModal?.querySelector('.modal-backdrop')?.addEventListener('click', () => {
  settingsModal?.classList.remove('active');
});

settingsOkBtn?.addEventListener('click', () => {
  settingsModal?.classList.remove('active');
});

// Escape key
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeMovieModal();
    closeVideoModal();
    closeStreamModal();
    closeEpisodeModal();
    adminModal?.classList.remove('active');
    document.getElementById('account-modal')?.classList.remove('active');
    document.getElementById('signout-modal')?.classList.remove('active');
    settingsModal?.classList.remove('active');
  }
});

function updateProfileUI() {
  const avatar = document.querySelector('.profile-avatar');
  if (!avatar) return;
  if (authUser?.name || authUser?.email) {
    const src = (authUser.name || authUser.email).trim();
    avatar.textContent = src.charAt(0).toUpperCase();
  } else {
    avatar.textContent = 'U';
  }
}

async function initAuth() {
  if (authInitPromise) return authInitPromise;
  if (!window.auth0 && typeof window.createAuth0Client !== 'function') return null;

  authInitPromise = createAuth0ClientWrapper({
    domain: AUTH0_DOMAIN,
    clientId: AUTH0_CLIENT_ID,
    authorizationParams: {
      audience: AUTH0_AUDIENCE,
      redirect_uri: window.location.origin,
    },
    cacheLocation: 'localstorage',
    useRefreshTokens: true,
  });

  auth0Client = await authInitPromise;

  if (window.location.search.includes('code=') && window.location.search.includes('state=')) {
    try {
      await auth0Client.handleRedirectCallback();
    } catch {}
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  const isAuthenticated = await auth0Client.isAuthenticated();
  authUser = isAuthenticated ? await auth0Client.getUser() : null;
  updateProfileUI();

  return auth0Client;
}

// Row titles for restore (matches content rows order)
const ROW_TITLES = [
  'Trending Movies', 'Top Rated Movies', 'Popular Movies', 'Action & Adventure', 'Sci-Fi & Fantasy', 'Comedy Movies',
  'Trending TV Shows', 'Top Rated TV Shows', 'Popular TV Shows', 'Drama TV Shows', 'Comedy TV Shows',
  'Anime Movies', 'Anime TV Shows',
];

function resetSearchUI() {
  document.querySelectorAll('.content-row').forEach((row, i) => {
    row.style.display = 'block';
    const title = row.querySelector('.row-title');
    if (title) title.textContent = ROW_TITLES[i] || title.textContent;
  });
}

// Register Monetag verification service worker
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Init (show loading screen only on first open)
initAuth().catch(() => {});
loadMovies(true);
attachVolumeControl(document.querySelector('.video-wrapper'));
