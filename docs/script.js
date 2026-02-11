// ==================== Configuration ====================

const GOOGLE_CLIENT_ID = '339196755594-oajh6pqn0o178o9ipsvg7d7r86dg2sv5.apps.googleusercontent.com';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly';

// Cache TTLs
const SUBSCRIPTIONS_TTL = 24 * 60 * 60 * 1000; // 24 hours
const VIDEOS_TTL = 30 * 60 * 1000; // 30 minutes

// ==================== State ====================

let tokenClient = null;
let allSubscriptions = []; // { channelId, title, thumbnail, uploadPlaylistId }
let allVideos = []; // video objects from YouTube API
let categories = { categories: [] }; // { categories: [{ id, name, channelIds }] }
let activeCategory = 'all';
let searchQuery = '';

// ==================== OAuth Module ====================

function initTokenClient() {
    if (tokenClient) return;
    if (typeof google === 'undefined' || !google.accounts) {
        console.error('Google Identity Services not loaded yet');
        return;
    }

    tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: YOUTUBE_SCOPE,
        callback: async (tokenResponse) => {
            if (tokenResponse.error) {
                console.error('OAuth error:', tokenResponse.error);
                return;
            }
            localStorage.setItem('yt_access_token', tokenResponse.access_token);
            localStorage.setItem('yt_token_expiry', Date.now() + (tokenResponse.expires_in * 1000));
            showApp();
            await loadEverything();
        }
    });
}

function startAuth() {
    initTokenClient();
    if (!tokenClient) {
        alert('Google Sign-In is still loading. Please try again in a moment.');
        return;
    }
    tokenClient.requestAccessToken({ prompt: 'consent' });
}

function silentAuth() {
    initTokenClient();
    if (!tokenClient) return false;
    if (isTokenValid()) return true;
    tokenClient.requestAccessToken({ prompt: '' });
    return false;
}

function isTokenValid() {
    const token = localStorage.getItem('yt_access_token');
    const expiry = localStorage.getItem('yt_token_expiry');
    return token && expiry && Date.now() < parseInt(expiry);
}

function getAccessToken() {
    return localStorage.getItem('yt_access_token');
}

function signOut() {
    const token = getAccessToken();
    if (token && google?.accounts?.oauth2) {
        google.accounts.oauth2.revoke(token, () => {
            console.log('Token revoked');
        });
    }
    localStorage.removeItem('yt_access_token');
    localStorage.removeItem('yt_token_expiry');
    showSignIn();
}

async function apiRequest(url) {
    if (!isTokenValid()) {
        silentAuth();
        throw new Error('Token expired. Please sign in again.');
    }
    const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${getAccessToken()}` }
    });
    if (response.status === 401) {
        silentAuth();
        throw new Error('Authentication expired. Please sign in again.');
    }
    if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        throw new Error(err.error?.message || `API error: ${response.status}`);
    }
    return response.json();
}

// ==================== YouTube API Module ====================

async function fetchSubscriptions() {
    let subs = [];
    let pageToken = '';
    do {
        const url = `${YOUTUBE_API}/subscriptions?part=snippet&mine=true&maxResults=50&order=alphabetical${pageToken ? '&pageToken=' + pageToken : ''}`;
        const data = await apiRequest(url);
        for (const item of data.items || []) {
            subs.push({
                channelId: item.snippet.resourceId.channelId,
                title: item.snippet.title,
                thumbnail: item.snippet.thumbnails?.default?.url || ''
            });
        }
        pageToken = data.nextPageToken || '';
    } while (pageToken);
    return subs;
}

async function fetchChannelDetails(channelIds) {
    const results = [];
    for (let i = 0; i < channelIds.length; i += 50) {
        const batch = channelIds.slice(i, i + 50).join(',');
        const url = `${YOUTUBE_API}/channels?part=contentDetails,snippet,topicDetails&id=${batch}`;
        const data = await apiRequest(url);
        for (const item of data.items || []) {
            results.push({
                channelId: item.id,
                uploadPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
                topicCategories: item.topicDetails?.topicCategories || [],
                title: item.snippet?.title || '',
                thumbnail: item.snippet?.thumbnails?.default?.url || ''
            });
        }
    }
    return results;
}

async function fetchLatestVideos(playlistId, count = 10) {
    const url = `${YOUTUBE_API}/playlistItems?part=snippet&playlistId=${playlistId}&maxResults=${count}`;
    try {
        const data = await apiRequest(url);
        return (data.items || []).map(item => ({
            videoId: item.snippet?.resourceId?.videoId,
            title: item.snippet?.title || '',
            thumbnail: item.snippet?.thumbnails?.medium?.url || item.snippet?.thumbnails?.default?.url || '',
            channelTitle: item.snippet?.channelTitle || '',
            channelId: item.snippet?.channelId || '',
            publishedAt: item.snippet?.publishedAt || ''
        })).filter(v => v.videoId);
    } catch (err) {
        console.warn(`Failed to fetch playlist ${playlistId}:`, err.message);
        return [];
    }
}

async function fetchVideoDetails(videoIds) {
    const results = [];
    for (let i = 0; i < videoIds.length; i += 50) {
        const batch = videoIds.slice(i, i + 50).join(',');
        const url = `${YOUTUBE_API}/videos?part=contentDetails,snippet,statistics&id=${batch}`;
        const data = await apiRequest(url);
        for (const item of data.items || []) {
            results.push({
                videoId: item.id,
                title: item.snippet?.title || '',
                thumbnail: item.snippet?.thumbnails?.medium?.url || '',
                channelTitle: item.snippet?.channelTitle || '',
                channelId: item.snippet?.channelId || '',
                publishedAt: item.snippet?.publishedAt || '',
                duration: item.contentDetails?.duration || '',
                viewCount: item.statistics?.viewCount || '0',
                description: item.snippet?.description || ''
            });
        }
    }
    return results;
}

// ==================== Shorts Filter ====================

function parseISO8601Duration(iso) {
    const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!match) return 0;
    const hours = parseInt(match[1] || 0);
    const minutes = parseInt(match[2] || 0);
    const seconds = parseInt(match[3] || 0);
    return hours * 3600 + minutes * 60 + seconds;
}

function formatDuration(iso) {
    const totalSeconds = parseISO8601Duration(iso);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    }
    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function isShort(video) {
    const duration = parseISO8601Duration(video.duration);
    const title = video.title.toLowerCase();
    return duration <= 60 || title.includes('#shorts');
}

// ==================== Category Management ====================

const TOPIC_MAP = {
    'Technology': 'Software Dev',
    'Computer_programming': 'Software Dev',
    'Software': 'Software Dev',
    'Computer_science': 'Software Dev',
    'Programming_language': 'Software Dev',
    'Artificial_intelligence': 'Software Dev',
    'Machine_learning': 'Software Dev',
    'Politics': 'Politics',
    'Society': 'Politics',
    'Government': 'Politics',
    'Activism': 'Politics',
    'Journalism': 'Politics',
    'Woodworking': 'Woodworking',
    'Do_it_yourself': 'DIY & Home',
    'Home_improvement': 'DIY & Home',
    'Entertainment': 'Entertainment',
    'Film': 'Entertainment',
    'Television_program': 'Entertainment',
    'Humour': 'Entertainment',
    'Comedy': 'Entertainment',
    'Performing_arts': 'Entertainment',
    'Music': 'Music',
    'Hip_hop_music': 'Music',
    'Electronic_music': 'Music',
    'Rock_music': 'Music',
    'Classical_music': 'Music',
    'Pop_music': 'Music',
    'Jazz': 'Music',
    'Soul_music': 'Music',
    'Country_music': 'Music',
    'Rhythm_and_blues': 'Music',
    'Independent_music': 'Music',
    'Music_of_Asia': 'Music',
    'Music_of_Latin_America': 'Music',
    'Video_game': 'Gaming',
    'Video_game_culture': 'Gaming',
    'Action_game': 'Gaming',
    'Role-playing_video_game': 'Gaming',
    'Sport': 'Sports',
    'Association_football': 'Sports',
    'Basketball': 'Sports',
    'Baseball': 'Sports',
    'American_football': 'Sports',
    'Ice_hockey': 'Sports',
    'Tennis': 'Sports',
    'Golf': 'Sports',
    'Cricket': 'Sports',
    'Boxing': 'Sports',
    'Mixed_martial_arts': 'Sports',
    'Motorsport': 'Sports',
    'Wrestling': 'Sports',
    'Physical_fitness': 'Health & Fitness',
    'Health': 'Health & Fitness',
    'Nutrition': 'Health & Fitness',
    'Cooking': 'Food & Cooking',
    'Recipe': 'Food & Cooking',
    'Food': 'Food & Cooking',
    'Cuisine': 'Food & Cooking',
    'Tourism': 'Travel',
    'Vehicle': 'Automotive',
    'Automobile': 'Automotive',
    'Motorcycle': 'Automotive',
    'Knowledge': 'Education',
    'Education': 'Education',
    'Science': 'Science',
    'Physics': 'Science',
    'Mathematics': 'Science',
    'Biology': 'Science',
    'Chemistry': 'Science',
    'Nature': 'Science & Nature',
    'Pet': 'Pets & Animals',
    'Animal': 'Pets & Animals',
    'Fashion': 'Lifestyle',
    'Beauty': 'Lifestyle',
    'Lifestyle_(sociology)': 'Lifestyle',
    'Business': 'Business & Finance',
    'Finance': 'Business & Finance',
    'Entrepreneurship': 'Business & Finance',
    'Military': 'History & Military',
    'History': 'History & Military',
    'Religion': 'Religion & Philosophy',
    'Philosophy': 'Religion & Philosophy'
};

function suggestCategoryForChannel(topicCategories) {
    for (const url of topicCategories) {
        const topic = url.split('/').pop();
        if (TOPIC_MAP[topic]) return TOPIC_MAP[topic];
    }
    return 'Uncategorized';
}

function loadCategories() {
    const stored = localStorage.getItem('mytubes_categories');
    if (stored) {
        categories = JSON.parse(stored);
    } else {
        categories = { categories: [] };
    }
}

function saveCategories() {
    localStorage.setItem('mytubes_categories', JSON.stringify(categories));
}

function getCategoryForChannel(channelId) {
    for (const cat of categories.categories) {
        if (cat.channelIds.includes(channelId)) return cat;
    }
    return null;
}

function ensureCategory(name) {
    const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    let cat = categories.categories.find(c => c.id === id);
    if (!cat) {
        cat = { id, name, channelIds: [] };
        categories.categories.push(cat);
    }
    return cat;
}

function assignChannelToCategory(channelId, categoryId) {
    // Remove from all categories first
    for (const cat of categories.categories) {
        cat.channelIds = cat.channelIds.filter(id => id !== channelId);
    }
    // Add to target
    if (categoryId && categoryId !== 'uncategorized') {
        const cat = categories.categories.find(c => c.id === categoryId);
        if (cat) cat.channelIds.push(channelId);
    }
    saveCategories();
}

// ==================== Caching Layer ====================

function getCached(key) {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    try {
        const { data, expiry } = JSON.parse(raw);
        if (expiry && Date.now() > expiry) {
            localStorage.removeItem(key);
            return null;
        }
        return data;
    } catch {
        return null;
    }
}

function setCache(key, data, ttl) {
    const entry = { data, expiry: ttl ? Date.now() + ttl : null };
    try {
        localStorage.setItem(key, JSON.stringify(entry));
    } catch (e) {
        console.warn('Cache write failed (storage full?):', e);
    }
}

function clearAllCache() {
    localStorage.removeItem('mytubes_subscriptions');
    localStorage.removeItem('mytubes_videos');
}

// ==================== Data Loading ====================

async function loadEverything() {
    loadCategories();
    showLoadingState();

    try {
        // Load subscriptions (from cache or API)
        const cachedSubs = getCached('mytubes_subscriptions');
        if (cachedSubs) {
            allSubscriptions = cachedSubs;
        } else {
            await syncSubscriptions();
        }

        // Load videos (from cache or API)
        const cachedVideos = getCached('mytubes_videos');
        if (cachedVideos) {
            allVideos = cachedVideos;
            renderVideos();
        } else {
            await refreshVideos();
        }

        renderCategoryTabs();
        loadUserAvatar();
    } catch (err) {
        console.error('Failed to load:', err);
        document.getElementById('video-grid-container').innerHTML =
            '<p class="error-message">Failed to load data. Please try refreshing.</p>';
    }
}

async function syncSubscriptions() {
    const subs = await fetchSubscriptions();
    const channelIds = subs.map(s => s.channelId);
    const details = await fetchChannelDetails(channelIds);

    // Merge subscription data with channel details
    allSubscriptions = subs.map(sub => {
        const detail = details.find(d => d.channelId === sub.channelId);
        return {
            ...sub,
            uploadPlaylistId: detail?.uploadPlaylistId || null,
            topicCategories: detail?.topicCategories || []
        };
    });

    setCache('mytubes_subscriptions', allSubscriptions, SUBSCRIPTIONS_TTL);

    // Auto-suggest categories if none are set
    const hasCategories = categories.categories.length > 0;
    if (!hasCategories && allSubscriptions.length > 0) {
        autoSuggestCategories();
    }
}

async function refreshVideos() {
    showLoadingState();

    // Fetch latest videos from each subscription's upload playlist
    const playlistFetches = allSubscriptions
        .filter(s => s.uploadPlaylistId)
        .map(s => fetchLatestVideos(s.uploadPlaylistId, 10));

    const playlistResults = await Promise.all(playlistFetches);
    const allVideoItems = playlistResults.flat();

    // Get unique video IDs for detail fetch
    const videoIds = [...new Set(allVideoItems.map(v => v.videoId))];

    if (videoIds.length === 0) {
        allVideos = [];
        setCache('mytubes_videos', allVideos, VIDEOS_TTL);
        renderVideos();
        return;
    }

    // Fetch full details (duration, etc.)
    const details = await fetchVideoDetails(videoIds);

    // Filter out Shorts
    allVideos = details.filter(v => !isShort(v));

    // Sort by publish date, newest first
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    setCache('mytubes_videos', allVideos, VIDEOS_TTL);
    renderVideos();
}

function loadUserAvatar() {
    // Use the Google People API to get user's profile photo
    const token = getAccessToken();
    if (!token) return;

    fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
        headers: { 'Authorization': `Bearer ${token}` }
    })
    .then(r => r.json())
    .then(data => {
        if (data.picture) {
            document.getElementById('user-avatar').src = data.picture;
            document.getElementById('user-avatar').style.display = 'block';
        }
    })
    .catch(() => {});
}

// ==================== Auto-Suggest Categories ====================

function autoSuggestCategories() {
    const suggestions = {}; // channelId -> suggested category name

    for (const sub of allSubscriptions) {
        const suggested = suggestCategoryForChannel(sub.topicCategories);
        suggestions[sub.channelId] = suggested;
    }

    // Build category structure from suggestions
    const categoryNames = [...new Set(Object.values(suggestions))];
    for (const name of categoryNames) {
        if (name !== 'Uncategorized') {
            ensureCategory(name);
        }
    }

    // Assign channels
    for (const [channelId, categoryName] of Object.entries(suggestions)) {
        if (categoryName !== 'Uncategorized') {
            const cat = categories.categories.find(c => c.name === categoryName);
            if (cat && !cat.channelIds.includes(channelId)) {
                cat.channelIds.push(channelId);
            }
        }
    }

    saveCategories();
    showSuggestModal(suggestions);
}

function showSuggestModal(suggestions) {
    const container = document.getElementById('suggest-assignments');
    const allCategoryNames = ['Uncategorized', ...categories.categories.map(c => c.name)];

    container.innerHTML = allSubscriptions.map(sub => {
        const suggested = suggestions[sub.channelId] || 'Uncategorized';
        const options = allCategoryNames.map(name =>
            `<option value="${name}" ${name === suggested ? 'selected' : ''}>${name}</option>`
        ).join('');

        return `
            <div class="suggest-channel" data-channel-id="${sub.channelId}">
                <img class="suggest-channel-thumb" src="${sub.thumbnail}" alt="">
                <span class="suggest-channel-name">${sub.title}</span>
                <select class="suggest-category-select" data-channel-id="${sub.channelId}">
                    ${options}
                </select>
            </div>
        `;
    }).join('');

    document.getElementById('suggest-modal').classList.add('active');
}

function saveSuggestions() {
    const selects = document.querySelectorAll('.suggest-category-select');
    // Reset all channel assignments
    for (const cat of categories.categories) {
        cat.channelIds = [];
    }

    for (const select of selects) {
        const channelId = select.dataset.channelId;
        const categoryName = select.value;
        if (categoryName && categoryName !== 'Uncategorized') {
            const cat = ensureCategory(categoryName);
            if (!cat.channelIds.includes(channelId)) {
                cat.channelIds.push(channelId);
            }
        }
    }

    saveCategories();
    document.getElementById('suggest-modal').classList.remove('active');
    renderCategoryTabs();
    renderVideos();
}

// ==================== Rendering ====================

function showSignIn() {
    document.getElementById('sign-in-page').style.display = 'flex';
    document.getElementById('app').style.display = 'none';
}

function showApp() {
    document.getElementById('sign-in-page').style.display = 'none';
    document.getElementById('app').style.display = 'block';
}

function showLoadingState() {
    const container = document.getElementById('video-grid-container');
    container.innerHTML = '<div class="video-grid">' +
        Array(12).fill('<div class="skeleton-card"><div class="skeleton-thumb"></div><div class="skeleton-info"><div class="skeleton-title"></div><div class="skeleton-meta"></div></div></div>').join('') +
        '</div>';
}

function formatDate(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    const now = new Date();
    const diffMs = now - date;
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffHours < 1) return 'Just now';
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatViewCount(count) {
    const n = parseInt(count);
    if (isNaN(n)) return '';
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M views`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K views`;
    return `${n} views`;
}

function renderCategoryTabs() {
    const tabsContainer = document.getElementById('category-tabs');
    const hasUncategorized = allSubscriptions.some(s => !getCategoryForChannel(s.channelId));

    let tabs = '<button class="category-tab' + (activeCategory === 'all' ? ' active' : '') + '" data-category="all">All</button>';

    for (const cat of categories.categories) {
        tabs += `<button class="category-tab${activeCategory === cat.id ? ' active' : ''}" data-category="${cat.id}">${cat.name}</button>`;
    }

    if (hasUncategorized) {
        tabs += `<button class="category-tab${activeCategory === 'uncategorized' ? ' active' : ''}" data-category="uncategorized">Uncategorized</button>`;
    }

    tabsContainer.innerHTML = tabs;

    // Attach click handlers
    tabsContainer.querySelectorAll('.category-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activeCategory = tab.dataset.category;
            tabsContainer.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderVideos();
        });
    });
}

function getFilteredVideos() {
    let videos = allVideos;

    // Filter by category
    if (activeCategory !== 'all') {
        if (activeCategory === 'uncategorized') {
            const assignedChannels = new Set(categories.categories.flatMap(c => c.channelIds));
            videos = videos.filter(v => !assignedChannels.has(v.channelId));
        } else {
            const cat = categories.categories.find(c => c.id === activeCategory);
            if (cat) {
                const channelSet = new Set(cat.channelIds);
                videos = videos.filter(v => channelSet.has(v.channelId));
            }
        }
    }

    // Filter by search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        videos = videos.filter(v =>
            v.title.toLowerCase().includes(q) ||
            v.channelTitle.toLowerCase().includes(q)
        );
    }

    return videos;
}

function renderVideos() {
    const container = document.getElementById('video-grid-container');
    const videos = getFilteredVideos();

    if (videos.length === 0) {
        if (allVideos.length === 0 && allSubscriptions.length === 0) {
            container.innerHTML = '<p class="empty-message">No subscriptions found. Make sure you have subscriptions on your YouTube account.</p>';
        } else if (videos.length === 0 && searchQuery) {
            container.innerHTML = '<p class="empty-message">No videos match your search.</p>';
        } else {
            container.innerHTML = '<p class="empty-message">No videos found for this category.</p>';
        }
        return;
    }

    // Find channel thumbnails
    const channelThumbs = {};
    for (const sub of allSubscriptions) {
        channelThumbs[sub.channelId] = sub.thumbnail;
    }

    container.innerHTML = '<div class="video-grid">' +
        videos.map(video => {
            const channelThumb = channelThumbs[video.channelId] || '';
            return `
                <a href="https://www.youtube.com/watch?v=${video.videoId}" target="_blank" class="video-card" rel="noopener noreferrer" title="${escapeHtml(video.title)}">
                    <div class="thumbnail-container">
                        <img src="${video.thumbnail}" alt="" loading="lazy">
                        <span class="duration-badge">${formatDuration(video.duration)}</span>
                    </div>
                    <div class="video-info">
                        <img class="channel-thumb" src="${channelThumb}" alt="">
                        <div class="video-text">
                            <h3 class="video-title">${escapeHtml(video.title)}</h3>
                            <p class="video-channel">${escapeHtml(video.channelTitle)}</p>
                            <div class="video-meta">
                                <span>${formatViewCount(video.viewCount)}</span>
                                <span>${formatDate(video.publishedAt)}</span>
                            </div>
                        </div>
                    </div>
                </a>
            `;
        }).join('') +
        '</div>';
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// ==================== Settings UI ====================

function renderSettingsModal() {
    renderCategoryList();
    renderChannelAssignments();
}

function renderCategoryList() {
    const container = document.getElementById('category-list');
    if (categories.categories.length === 0) {
        container.innerHTML = '<p class="settings-note">No categories yet. Add one above or sync subscriptions for auto-suggestions.</p>';
        return;
    }

    container.innerHTML = categories.categories.map(cat => `
        <div class="category-item" data-id="${cat.id}">
            <span class="category-name">${cat.name}</span>
            <span class="category-count">${cat.channelIds.length} channels</span>
            <button class="category-rename-btn" data-id="${cat.id}" title="Rename">&#9998;</button>
            <button class="category-delete-btn" data-id="${cat.id}" title="Delete">&times;</button>
        </div>
    `).join('');

    // Rename handlers
    container.querySelectorAll('.category-rename-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cat = categories.categories.find(c => c.id === btn.dataset.id);
            if (!cat) return;
            const newName = prompt('Rename category:', cat.name);
            if (newName && newName.trim()) {
                cat.name = newName.trim();
                saveCategories();
                renderSettingsModal();
                renderCategoryTabs();
            }
        });
    });

    // Delete handlers
    container.querySelectorAll('.category-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const cat = categories.categories.find(c => c.id === btn.dataset.id);
            if (!cat) return;
            if (!confirm(`Delete category "${cat.name}"? Channels will become uncategorized.`)) return;
            categories.categories = categories.categories.filter(c => c.id !== btn.dataset.id);
            saveCategories();
            renderSettingsModal();
            renderCategoryTabs();
            renderVideos();
        });
    });
}

function renderChannelAssignments() {
    const container = document.getElementById('channel-assignments');
    if (allSubscriptions.length === 0) {
        container.innerHTML = '<p class="settings-note">No subscriptions loaded. Sign in and sync first.</p>';
        return;
    }

    const categoryOptions = [
        '<option value="uncategorized">Uncategorized</option>',
        ...categories.categories.map(c => `<option value="${c.id}">${c.name}</option>`)
    ].join('');

    container.innerHTML = allSubscriptions
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(sub => {
            const currentCat = getCategoryForChannel(sub.channelId);
            const currentId = currentCat ? currentCat.id : 'uncategorized';
            return `
                <div class="channel-assignment">
                    <img class="channel-assign-thumb" src="${sub.thumbnail}" alt="">
                    <span class="channel-assign-name">${sub.title}</span>
                    <select class="channel-assign-select" data-channel-id="${sub.channelId}">
                        ${categoryOptions.replace(`value="${currentId}"`, `value="${currentId}" selected`)}
                    </select>
                </div>
            `;
        }).join('');

    // Change handlers
    container.querySelectorAll('.channel-assign-select').forEach(select => {
        select.addEventListener('change', () => {
            assignChannelToCategory(select.dataset.channelId, select.value);
            renderCategoryTabs();
            renderVideos();
        });
    });
}

// ==================== Event Listeners ====================

function setupEventListeners() {
    // Sign in
    document.getElementById('sign-in-btn').addEventListener('click', startAuth);

    // Sign out
    document.getElementById('sign-out-btn').addEventListener('click', signOut);

    // Search
    document.getElementById('search-bar').addEventListener('input', (e) => {
        searchQuery = e.target.value.trim();
        renderVideos();
    });

    // Refresh
    document.getElementById('refresh-btn').addEventListener('click', async () => {
        clearAllCache();
        await loadEverything();
    });

    // Settings
    document.getElementById('settings-btn').addEventListener('click', () => {
        renderSettingsModal();
        document.getElementById('settings-modal').classList.add('active');
    });
    document.getElementById('settings-close-btn').addEventListener('click', () => {
        document.getElementById('settings-modal').classList.remove('active');
    });
    document.getElementById('settings-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('settings-modal')) {
            document.getElementById('settings-modal').classList.remove('active');
        }
    });

    // Add category
    document.getElementById('add-category-btn').addEventListener('click', () => {
        const input = document.getElementById('new-category-input');
        const name = input.value.trim();
        if (!name) return;
        ensureCategory(name);
        saveCategories();
        input.value = '';
        renderSettingsModal();
        renderCategoryTabs();
    });
    document.getElementById('new-category-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') document.getElementById('add-category-btn').click();
    });

    // Re-sync subscriptions
    document.getElementById('resync-subs-btn').addEventListener('click', async () => {
        const status = document.getElementById('sync-status');
        status.textContent = 'Syncing subscriptions...';
        status.className = 'settings-status';
        try {
            localStorage.removeItem('mytubes_subscriptions');
            await syncSubscriptions();
            status.textContent = `Synced! Found ${allSubscriptions.length} subscriptions.`;
            status.className = 'settings-status success';
            renderChannelAssignments();
            renderCategoryTabs();
        } catch (err) {
            status.textContent = `Error: ${err.message}`;
            status.className = 'settings-status error';
        }
    });

    // Clear cache
    document.getElementById('clear-cache-btn').addEventListener('click', () => {
        clearAllCache();
        const status = document.getElementById('sync-status');
        status.textContent = 'Cache cleared. Refresh to reload.';
        status.className = 'settings-status';
    });

    // Suggest modal
    document.getElementById('suggest-save-btn').addEventListener('click', saveSuggestions);
    document.getElementById('suggest-skip-btn').addEventListener('click', () => {
        document.getElementById('suggest-modal').classList.remove('active');
    });
    document.getElementById('suggest-close-btn').addEventListener('click', () => {
        document.getElementById('suggest-modal').classList.remove('active');
    });
    document.getElementById('suggest-modal').addEventListener('click', (e) => {
        if (e.target === document.getElementById('suggest-modal')) {
            document.getElementById('suggest-modal').classList.remove('active');
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
        }
    });
}

// ==================== Initialization ====================

function init() {
    setupEventListeners();

    if (isTokenValid()) {
        showApp();
        loadEverything();
    } else {
        showSignIn();
        // Try silent auth for returning users
        const hadToken = localStorage.getItem('yt_token_expiry');
        if (hadToken) {
            silentAuth();
        }
    }
}

init();
