document.addEventListener('DOMContentLoaded', () => {
    const videoGridContainer = document.getElementById('video-grid-container');
    const lastUpdatedElem = document.getElementById('last-updated');
    const searchBar = document.getElementById('search-bar');
    let allVideos = [];
    let allChannels = [];

    const fetchVideos = async () => {
        try {
            // Add a cache-busting query parameter
            const response = await fetch(`videos.json?v=${new Date().getTime()}`);
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            const data = await response.json();
            allVideos = data.videos;
            // Group videos by channel
            const channelsMap = allVideos.reduce((acc, video) => {
                const channelName = video.channel_name || 'Unknown Channel';
                if (!acc[channelName]) {
                    acc[channelName] = [];
                }
                acc[channelName].push(video);
                return acc;
            }, {});
            allChannels = Object.entries(channelsMap).map(([name, videos]) => ({ name, videos }));

            updateLastUpdated(data.last_updated_utc);
            displayChannels(allChannels);
        } catch (error) {
            console.error('Error fetching video data:', error);
            videoGridContainer.innerHTML = '<p style="text-align: center; color: #ff6b6b;">Could not load video data. Please try again later.</p>';
            lastUpdatedElem.textContent = 'Last updated: Error';
        }
    };

    const formatDate = (isoString) => {
        if (!isoString) return 'No date';
        const date = new Date(isoString);
        return date.toLocaleDateString('en-US', {
            year: 'numeric',
            month: 'long',
            day: 'numeric',
        });
    };

    const updateLastUpdated = (isoString) => {
        if (!isoString) return;
        const date = new Date(isoString);
        lastUpdatedElem.textContent = `Last updated: ${date.toLocaleString()}`;
    };

    const createVideoCard = (video) => {
        const title = video.title || 'Untitled Video';
        const thumbnailUrl = video.thumbnail_url || 'placeholder.jpg'; // A fallback image would be good
        return `
            <a href="${video.url}" target="_blank" class="video-card" rel="noopener noreferrer" title="${title}">
                <div class="thumbnail-container">
                    <img src="${thumbnailUrl}" alt="" loading="lazy">
                </div>
                <div class="video-info">
                    <h3 class="video-title">${title}</h3>
                    <div class="video-meta">
                        <span>${formatDate(video.upload_date)}</span>
                        <span>${video.duration || ''}</span>
                    </div>
                </div>
            </a>
        `;
    };

    const displayChannels = (channels) => {
        if (!channels || channels.length === 0) {
            videoGridContainer.innerHTML = '<p style="text-align: center;">No videos found matching your search.</p>';
            return;
        }
        videoGridContainer.innerHTML = channels.map(channel => `
            <section class="channel-section">
                <h2 class="channel-title">${channel.name}</h2>
                <div class="video-grid">
                    ${channel.videos.map(createVideoCard).join('')}
                </div>
            </section>
        `).join('');
    };

    const filterVideos = (query) => {
        const lowerCaseQuery = query.toLowerCase().trim();
        if (!lowerCaseQuery) {
            displayChannels(allChannels);
            return;
        }

        const filteredChannels = allChannels.map(channel => {
            const filteredVideos = channel.videos.filter(video =>
                (video.title && video.title.toLowerCase().includes(lowerCaseQuery)) ||
                (video.channel_name && video.channel_name.toLowerCase().includes(lowerCaseQuery))
            );
            return { ...channel, videos: filteredVideos };
        }).filter(channel => channel.videos.length > 0);

        displayChannels(filteredChannels);
    };

    searchBar.addEventListener('input', (e) => {
        filterVideos(e.target.value);
    });

    fetchVideos();
});
