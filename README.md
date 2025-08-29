# MyTubes

Static YouTube video aggregator powered by GitHub Pages and scheduled GitHub Actions.

## Setup

1. Add your channel IDs to `channels.json`.
2. Create a secret named `YOUTUBE_API_KEY` in the repository settings.
3. Enable GitHub Pages for the `/docs` folder.

## Update script

`update_videos.py` uses the YouTube Data API to fetch the latest videos for each
configured channel and stores the results in `docs/videos.json`.

Run locally:

```bash
pip install requests
export YOUTUBE_API_KEY=your_key
python update_videos.py
```

The workflow in `.github/workflows/update.yml` runs this script on a schedule and commits any changes.

## Website

The static site in `docs/` fetches `videos.json` and displays the newest videos.
Opening `docs/index.html` locally or via GitHub Pages shows the aggregated feed.
