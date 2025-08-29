import json
import os
from pathlib import Path
from typing import List, Dict

import requests

CHANNELS_FILE = Path('channels.json')
VIDEOS_FILE = Path('docs/videos.json')
API_KEY = os.getenv('YOUTUBE_API_KEY')
API_URL = 'https://www.googleapis.com/youtube/v3/search'


def load_channels() -> List[str]:
    with CHANNELS_FILE.open() as f:
        data = json.load(f)
    return data.get('channels', [])


def load_existing_videos() -> List[Dict]:
    if not VIDEOS_FILE.exists():
        return []
    with VIDEOS_FILE.open() as f:
        return json.load(f)


def fetch_latest_videos(channel_id: str) -> List[Dict]:
    params = {
        'key': API_KEY,
        'channelId': channel_id,
        'part': 'snippet',
        'order': 'date',
        'maxResults': 5,
        'type': 'video',
    }
    resp = requests.get(API_URL, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()
    videos = []
    for item in data.get('items', []):
        vid = item['id']['videoId']
        snip = item['snippet']
        videos.append({
            'id': vid,
            'title': snip['title'],
            'channel': snip['channelTitle'],
            'thumbnail': snip['thumbnails']['high']['url'],
            'link': f'https://youtu.be/{vid}',
            'publishedAt': snip.get('publishedAt'),
        })
    return videos


def main():
    if not API_KEY:
        raise SystemExit('YOUTUBE_API_KEY not set')
    channels = load_channels()
    existing = load_existing_videos()
    known_ids = {v['id'] for v in existing}
    for channel in channels:
        for video in fetch_latest_videos(channel):
            if video['id'] not in known_ids:
                existing.append(video)
                known_ids.add(video['id'])
    # sort newest first by publishedAt
    existing.sort(key=lambda v: v.get('publishedAt', ''), reverse=True)
    with VIDEOS_FILE.open('w') as f:
        json.dump(existing, f, indent=2)


if __name__ == '__main__':
    main()
