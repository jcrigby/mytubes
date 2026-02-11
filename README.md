# MyTubes

A personal, distraction-free YouTube frontend that pulls your subscriptions via Google OAuth, filters out Shorts, and organizes channels into user-defined categories.

## Features

- **OAuth-based subscriptions**: Sign in with Google to automatically pull your YouTube subscriptions — no manual channel configuration
- **Shorts filter**: Automatically removes videos under 60 seconds and those tagged with #shorts
- **Category organization**: Organize channels into categories (Politics, Woodworking, Software Dev, etc.) with auto-suggestions based on YouTube topic data
- **Client-side only**: All API calls happen in the browser using your OAuth token — no backend server needed
- **Local caching**: Subscriptions cached for 24 hours, videos for 30 minutes — minimizes API calls
- **Dark theme**: Responsive design with a clean, focused interface
- **Search**: Filter videos by title or channel name within any category

## Architecture

Everything runs in the browser:

- **Google Identity Services (GIS)** for OAuth with `youtube.readonly` scope
- **YouTube Data API v3** for subscriptions, channels, and video data
- **localStorage** for caching (subscriptions, videos) and user data (categories, token)
- Static site hosted on **GitHub Pages** from the `docs/` directory

## Setup

### 1. Google Cloud Console

You need a Google Cloud project with OAuth credentials configured:

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or reuse an existing one)
3. **Enable YouTube Data API v3**: APIs & Services > Library > search "YouTube Data API v3" > Enable
4. **Configure OAuth consent screen**: APIs & Services > OAuth consent screen > add scope `youtube.readonly`
5. **Create/update OAuth Client ID**: APIs & Services > Credentials > Create/edit a Web Application client
   - Add to Authorized JavaScript origins:
     - `https://YOUR_USERNAME.github.io` (production)
     - `http://localhost:8000` (local development)
6. Copy the Client ID and update `GOOGLE_CLIENT_ID` in `docs/script.js` if different

### 2. Deploy

1. Fork or clone this repository
2. Enable GitHub Pages: Settings > Pages > Deploy from branch `main`, folder `/docs`
3. Visit `https://YOUR_USERNAME.github.io/mytubes/`
4. Click "Sign in with Google" and authorize

### 3. Local Development

```bash
python -m http.server 8000 --directory docs
```

Open `http://localhost:8000` in your browser.

## Usage

1. **Sign in** with your Google account
2. **Review categories**: On first sign-in, channels are auto-categorized based on YouTube topic data. Adjust assignments in the suggestion modal.
3. **Browse videos**: Use category tabs to filter, search bar to find specific content
4. **Manage categories**: Click the gear icon to create/rename/delete categories and reassign channels
5. **Refresh**: Click the refresh button to re-fetch latest videos
6. **Re-sync**: In settings, use "Re-sync Subscriptions" to pick up new subscriptions

## File Structure

| File | Description |
|------|-------------|
| `docs/index.html` | Main HTML with sign-in page, app layout, settings modal, suggestion modal |
| `docs/script.js` | OAuth, YouTube API calls, category management, shorts filter, caching, rendering |
| `docs/style.css` | Dark theme styles, category tabs, modals, skeleton loading, responsive grid |

## Cache Behavior

| Data | TTL | Storage Key |
|------|-----|-------------|
| Subscriptions + channel details | 24 hours | `mytubes_subscriptions` |
| Video data | 30 minutes | `mytubes_videos` |
| Category assignments | No expiry | `mytubes_categories` |
| OAuth token | ~1 hour (from Google) | `yt_access_token` |
