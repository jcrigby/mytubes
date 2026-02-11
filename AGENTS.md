# Agent Instructions for MyTubes

## Project Overview

MyTubes is a fully client-side YouTube frontend that uses Google OAuth to pull the user's YouTube subscriptions, filters out Shorts, and organizes channels into user-defined categories. All YouTube API calls happen in the browser — there is no backend or server-side pipeline.

## Architecture

- **OAuth**: Google Identity Services (GIS) with `youtube.readonly` scope
- **API**: YouTube Data API v3 (subscriptions, channels, playlistItems, videos)
- **Storage**: `localStorage` for caching API responses and persisting user categories
- **Hosting**: GitHub Pages serves the `docs/` directory as a static site

## Key Files

- **`docs/index.html`**: Main HTML structure — sign-in page, app layout with header/category tabs/video grid, settings modal, auto-suggest modal
- **`docs/script.js`**: All application logic:
  - OAuth module (init, auth, token management, API requests)
  - YouTube API module (subscriptions, channels, playlists, video details)
  - Shorts filter (duration <= 60s or #shorts in title)
  - Category management (CRUD, auto-suggest from YouTube topic data, localStorage persistence)
  - Caching layer (TTL-based localStorage cache)
  - Rendering (category tabs, video grid, skeleton loading, settings UI)
- **`docs/style.css`**: Dark theme stylesheet — sign-in page, header, category tabs, video cards, skeleton loading animations, modals, responsive breakpoints

## Configuration

The Google OAuth Client ID is defined at the top of `docs/script.js`:
```javascript
const GOOGLE_CLIENT_ID = '339196755594-oajh6pqn0o178o9ipsvg7d7r86dg2sv5.apps.googleusercontent.com';
```

## Local Development

Serve the `docs/` directory with any HTTP server:
```bash
python -m http.server 8000 --directory docs
```
Then open `http://localhost:8000`. Make sure `http://localhost:8000` is in the OAuth client's Authorized JavaScript Origins.

## Key Concepts

- **Shorts filtering**: Videos are excluded if their ISO 8601 duration parses to <= 60 seconds or their title contains `#shorts`
- **Category auto-suggestion**: Uses `topicDetails.topicCategories` from the YouTube Channels API (Wikipedia URLs) mapped to human-readable categories via `TOPIC_MAP`
- **Caching**: Subscriptions cached 24h, videos cached 30min. Categories have no expiry (user data). Cache can be cleared from settings.
- **Token management**: OAuth tokens stored in localStorage with expiry timestamps. Silent re-auth attempted for returning users.
