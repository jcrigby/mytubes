# YouTube Channel Monitor

[![Update Videos Workflow](https://github.com/YOUR_USERNAME/YOUR_REPOSITORY/actions/workflows/update-videos.yml/badge.svg)](https://github.com/YOUR_USERNAME/YOUR_REPOSITORY/actions/workflows/update-videos.yml)

A fully automated system to monitor YouTube channels for their latest videos and display them on a static website hosted with GitHub Pages.

## Features

- **Automated Video Fetching**: A Python script uses the YouTube Data API v3 to fetch the latest videos from a list of specified channels.
- **Static Site Generation**: The fetched data is used to generate a clean, responsive static website.
- **GitHub Actions Automation**: The entire process of fetching data and updating the site is automated using a GitHub Actions workflow that runs on a schedule.
- **Easy Configuration**: Channels can be easily added or removed by editing a single JSON file.
- **Responsive Design**: The website is designed to be mobile-friendly and easy to use on any device.
- **Search Functionality**: The frontend includes a simple search bar to filter videos by title or channel name.

## How It Works

1.  A GitHub Actions workflow runs on a schedule (every 6 hours) or can be triggered manually.
2.  The workflow executes a Python script (`scripts/fetch_latest_videos.py`).
3.  The script reads a list of channels from `data/channels.json`.
4.  Using the YouTube API, it fetches the 5 latest videos from each channel.
5.  The collected video data is saved to `docs/videos.json`.
6.  The workflow commits the updated `videos.json` file back to the repository.
7.  GitHub Pages automatically serves the `docs` directory, and the website's JavaScript (`docs/script.js`) reads the `videos.json` file to display the latest videos.

## Setup and Deployment

1.  **Fork this repository:** Create a fork of this repository to your own GitHub account.

2.  **Enable GitHub Actions:** Ensure that GitHub Actions are enabled for your forked repository. They should be enabled by default.

3.  **Set up GitHub Pages:**
    - In your repository, go to `Settings` > `Pages`.
    - Under `Build and deployment`, set the `Source` to **Deploy from a branch**.
    - Set the `Branch` to **main** (or your default branch) and the folder to **/docs**.
    - Click `Save`. Your site will be available at `https://<your-username>.github.io/<your-repo-name>/`.

4.  **Create a YouTube API Key:**
    - You need a YouTube Data API v3 key. You can get one from the [Google Cloud Console](https://console.cloud.google.com/apis/library/youtube.googleapis.com).
    - Make sure the API is enabled for your project.

5.  **Add the API Key to GitHub Secrets:**
    - In your repository, go to `Settings` > `Secrets and variables` > `Actions`.
    - Click `New repository secret`.
    - Name the secret `YOUTUBE_API_KEY`.
    - Paste your API key as the value.

## Configuration

### Adding or Removing Channels

To change which channels are being monitored, simply edit the `data/channels.json` file. You will need the `channel_id` for each channel you want to add. You can often find this in the URL of the channel's homepage.

The format for each channel is:
```json
{
  "name": "Channel Name",
  "channel_id": "UCxxxxxxxxxxxxxxxxx",
  "handle": "@channelhandle",
  "description": "Brief description of the channel"
}
```

Commit your changes to `data/channels.json` and push them to the repository. The next time the workflow runs, it will use your updated list.

## Local Development

To run the project locally for development or testing:

1.  **Clone the repository and navigate into it:**
    ```bash
    git clone https://github.com/YOUR_USERNAME/youtube-channel-monitor.git
    cd youtube-channel-monitor
    ```

2.  **Install dependencies:**
    ```bash
    pip install -r requirements.txt
    ```

3.  **Set the environment variable:**
    You can export it in your shell:
    ```bash
    export YOUTUBE_API_KEY="YOUR_API_KEY_HERE"
    ```

4.  **Run the Python script:**
    ```bash
    python scripts/fetch_latest_videos.py
    ```
    This will generate/update the `docs/videos.json` file.

5.  **Serve the website locally:**
    You can use any local web server. A simple one comes with Python:
    ```bash
    python -m http.server 8000 --directory docs
    ```
    Now, open `http://localhost:8000` in your web browser to see the site.
