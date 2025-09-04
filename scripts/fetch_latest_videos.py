import os
import sys
import json
import logging
import re
from datetime import datetime, timezone
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

# --- Configuration ---
API_KEY = os.getenv("YOUTUBE_API_KEY")
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CHANNELS_FILE = os.path.join(BASE_DIR, '..', 'data', 'channels.json')
OUTPUT_FILE = os.path.join(BASE_DIR, '..', 'docs', 'videos.json')
MAX_VIDEOS_PER_CHANNEL = 5

# --- Logging Setup ---
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')

def get_youtube_service():
    """Initializes and returns the YouTube API service client, or raises an error."""
    if not API_KEY:
        raise ValueError("YOUTUBE_API_KEY environment variable not set.")
    try:
        return build('youtube', 'v3', developerKey=API_KEY)
    except Exception as e:
        logging.error(f"Failed to build YouTube service: {e}")
        raise

def load_channels():
    """Loads channel data from the JSON file."""
    try:
        with open(CHANNELS_FILE, 'r') as f:
            data = json.load(f)
            return data.get("channels", [])
    except FileNotFoundError:
        logging.error(f"Channels file not found at: {CHANNELS_FILE}")
        return []
    except json.JSONDecodeError:
        logging.error(f"Error decoding JSON from: {CHANNELS_FILE}")
        return []

def get_uploads_playlist_id(youtube, channel_id):
    """Gets the ID of the 'uploads' playlist for a given channel."""
    try:
        request = youtube.channels().list(part="contentDetails", id=channel_id)
        response = request.execute()
        if not response.get("items"):
            logging.warning(f"Channel not found for ID: {channel_id}")
            return None
        return response["items"][0]["contentDetails"]["relatedPlaylists"]["uploads"]
    except HttpError as e:
        logging.error(f"HTTP error getting uploads playlist for channel {channel_id}: {e}")
        return None
    except (KeyError, IndexError) as e:
        logging.error(f"Error parsing channel response for {channel_id}: {e}")
        return None

def get_latest_video_ids_from_playlist(youtube, playlist_id):
    """Gets the latest video IDs from a given playlist ID."""
    try:
        request = youtube.playlistItems().list(
            part="contentDetails",
            playlistId=playlist_id,
            maxResults=MAX_VIDEOS_PER_CHANNEL
        )
        response = request.execute()
        return [item['contentDetails']['videoId'] for item in response.get("items", [])]
    except HttpError as e:
        logging.error(f"HTTP error getting videos from playlist {playlist_id}: {e}")
        return []

def get_video_details(youtube, video_ids):
    """Fetches full details for a list of video IDs in batches."""
    video_details = []
    # The API allows up to 50 IDs per request
    for i in range(0, len(video_ids), 50):
        batch_ids = video_ids[i:i+50]
        try:
            request = youtube.videos().list(
                part="snippet,contentDetails",
                id=",".join(batch_ids)
            )
            response = request.execute()
            video_details.extend(response.get("items", []))
        except HttpError as e:
            logging.error(f"HTTP error getting video details for batch: {e}")
            continue
    return video_details

def parse_iso8601_duration(duration_str):
    """Parses an ISO 8601 duration string (e.g., PT2M34S) and formats it as MM:SS."""
    if not duration_str:
        return "N/A"

    match = re.match(r'PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?', duration_str)
    if not match:
        return "N/A"

    hours, minutes, seconds = match.groups('0')
    hours, minutes, seconds = int(hours), int(minutes), int(seconds)

    if hours > 0:
        return f"{hours}:{minutes:02d}:{seconds:02d}"
    else:
        return f"{minutes:02d}:{seconds:02d}"

def main():
    """Main function to orchestrate the video fetching and processing."""
    logging.info("Starting YouTube video fetch script.")

    try:
        youtube = get_youtube_service()
    except (ValueError, Exception) as e:
        logging.critical(f"Failed to initialize YouTube service: {e}")
        sys.exit(1)

    channels = load_channels()
    if not channels:
        logging.warning("No channels found in channels.json. Exiting.")
        return

    video_id_to_channel_map = {}
    for channel in channels:
        channel_id = channel.get("channel_id")
        channel_name = channel.get("name")
        logging.info(f"Processing channel: {channel_name}")

        if not all([channel_id, channel_name]):
            logging.warning(f"Skipping channel due to missing 'channel_id' or 'name': {channel}")
            continue

        uploads_playlist_id = get_uploads_playlist_id(youtube, channel_id)
        if not uploads_playlist_id:
            logging.warning(f"Could not find uploads playlist for {channel_name}. Skipping.")
            continue

        video_ids = get_latest_video_ids_from_playlist(youtube, uploads_playlist_id)
        for video_id in video_ids:
            video_id_to_channel_map[video_id] = channel_name

    all_video_ids = list(video_id_to_channel_map.keys())

    if not all_video_ids:
        logging.info("No new videos found across all channels. Writing empty list to file.")
        all_videos_formatted = []
    else:
        logging.info(f"Found {len(all_video_ids)} video IDs to fetch details for.")
        video_details = get_video_details(youtube, all_video_ids)

        all_videos_formatted = []
        for item in video_details:
            video_id = item['id']
            all_videos_formatted.append({
                "title": item["snippet"]["title"],
                "url": f"https://www.youtube.com/watch?v={video_id}",
                "thumbnail_url": item["snippet"]["thumbnails"].get("high", {}).get("url"),
                "upload_date": item["snippet"]["publishedAt"],
                "channel_name": video_id_to_channel_map.get(video_id, "Unknown Channel"),
                "duration": parse_iso8601_duration(item["contentDetails"].get("duration"))
            })

        all_videos_formatted.sort(key=lambda v: v["upload_date"], reverse=True)

    output_data = {
        "last_updated_utc": datetime.now(timezone.utc).isoformat(),
        "videos": all_videos_formatted
    }

    try:
        os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
        with open(OUTPUT_FILE, 'w') as f:
            json.dump(output_data, f, indent=4)
        logging.info(f"Successfully saved data for {len(all_videos_formatted)} videos to {OUTPUT_FILE}")
    except IOError as e:
        logging.error(f"Failed to write to output file {OUTPUT_FILE}: {e}")
        sys.exit(1)

    logging.info("Script finished.")

if __name__ == "__main__":
    main()
