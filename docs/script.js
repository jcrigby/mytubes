// ==================== Configuration ====================

const GOOGLE_CLIENT_ID = '339196755594-oajh6pqn0o178o9ipsvg7d7r86dg2sv5.apps.googleusercontent.com';
const YOUTUBE_API = 'https://www.googleapis.com/youtube/v3';
const YOUTUBE_SCOPE = 'https://www.googleapis.com/auth/youtube.readonly https://www.googleapis.com/auth/drive.appdata';

// Google Drive appdata
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const CATEGORIES_FILENAME = 'categories.json';

// OpenRouter
const OPENROUTER_AUTH_URL = 'https://openrouter.ai/auth';
const OPENROUTER_TOKEN_URL = 'https://openrouter.ai/api/v1/auth/keys';
const OPENROUTER_API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'anthropic/claude-sonnet-4';

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
let viewMode = 'videos'; // 'videos' or 'channels'
let selectedChannelId = null;
let chatMessages = []; // { role: 'user'|'assistant', content: string }
let driveFileId = null;
let driveSaveTimer = null;

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
    driveFileId = null;
    if (driveSaveTimer) {
        clearTimeout(driveSaveTimer);
        driveSaveTimer = null;
    }
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

// ==================== OpenRouter OAuth PKCE ====================

function generateCodeVerifier() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return btoa(String.fromCharCode.apply(null, array))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
    const encoder = new TextEncoder();
    const data = encoder.encode(verifier);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=/g, '');
}

async function startOpenRouterAuth() {
    const codeVerifier = generateCodeVerifier();
    sessionStorage.setItem('openrouter_code_verifier', codeVerifier);
    const codeChallenge = await generateCodeChallenge(codeVerifier);
    const callbackUrl = window.location.origin + window.location.pathname;
    const authUrl = `${OPENROUTER_AUTH_URL}?callback_url=${encodeURIComponent(callbackUrl)}&code_challenge=${codeChallenge}&code_challenge_method=S256`;
    window.location.href = authUrl;
}

async function handleOpenRouterCallback() {
    const urlParams = new URLSearchParams(window.location.search);
    const code = urlParams.get('code');
    if (!code) return false;

    const codeVerifier = sessionStorage.getItem('openrouter_code_verifier');
    if (!codeVerifier) {
        console.error('No code verifier found');
        return false;
    }

    try {
        const response = await fetch(OPENROUTER_TOKEN_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code: code,
                code_verifier: codeVerifier,
                code_challenge_method: 'S256'
            })
        });

        if (!response.ok) {
            throw new Error(`Token exchange failed: ${response.status}`);
        }

        const data = await response.json();
        if (data.key) {
            localStorage.setItem('openrouter_key', data.key);
            sessionStorage.removeItem('openrouter_code_verifier');
            const cleanUrl = window.location.origin + window.location.pathname;
            window.history.replaceState({}, document.title, cleanUrl);
            return true;
        }
    } catch (err) {
        console.error('OpenRouter OAuth callback error:', err);
    }

    return false;
}

function isOpenRouterConnected() {
    return !!localStorage.getItem('openrouter_key');
}

function disconnectOpenRouter() {
    localStorage.removeItem('openrouter_key');
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

async function loadCategories() {
    // Load from localStorage first (instant cache)
    const stored = localStorage.getItem('mytubes_categories');
    if (stored) {
        categories = JSON.parse(stored);
    } else {
        categories = { categories: [] };
    }

    // Try loading from Drive (authoritative source)
    try {
        const driveData = await readDriveCategories();
        if (driveData && driveData.categories) {
            // Drive has data — use it and update localStorage
            categories = driveData;
            localStorage.setItem('mytubes_categories', JSON.stringify(categories));
        } else if (stored && categories.categories.length > 0) {
            // Drive is empty but localStorage has data — migrate to Drive
            writeDriveCategories(categories).catch(err =>
                console.warn('Drive migration failed:', err.message)
            );
        }
    } catch (err) {
        console.warn('Drive load failed, using localStorage:', err.message);
    }
}

function saveCategories() {
    localStorage.setItem('mytubes_categories', JSON.stringify(categories));
    debouncedDriveSave();
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

// ==================== Drive Appdata Storage ====================

async function findDriveFile() {
    try {
        const data = await apiRequest(
            `${DRIVE_API}/files?spaces=appDataFolder&q=name='${CATEGORIES_FILENAME}'&fields=files(id)`
        );
        if (data.files && data.files.length > 0) {
            driveFileId = data.files[0].id;
            return driveFileId;
        }
        return null;
    } catch (err) {
        console.warn('Drive findFile failed:', err.message);
        return null;
    }
}

async function readDriveCategories() {
    try {
        const fileId = await findDriveFile();
        if (!fileId) return null;
        const data = await apiRequest(`${DRIVE_API}/files/${fileId}?alt=media`);
        return data;
    } catch (err) {
        console.warn('Drive read failed:', err.message);
        return null;
    }
}

async function writeDriveCategories(data) {
    const token = getAccessToken();
    if (!token) return;

    const jsonBody = JSON.stringify(data);

    if (driveFileId) {
        // Update existing file
        const resp = await fetch(`${DRIVE_UPLOAD_API}/files/${driveFileId}?uploadType=media`, {
            method: 'PATCH',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: jsonBody
        });
        if (!resp.ok) throw new Error(`Drive update failed: ${resp.status}`);
    } else {
        // Create new file with multipart upload
        const metadata = {
            name: CATEGORIES_FILENAME,
            parents: ['appDataFolder']
        };
        const boundary = 'mytubes_boundary';
        const body =
            `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
            JSON.stringify(metadata) +
            `\r\n--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
            jsonBody +
            `\r\n--${boundary}--`;

        const resp = await fetch(`${DRIVE_UPLOAD_API}/files?uploadType=multipart`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': `multipart/related; boundary=${boundary}`
            },
            body: body
        });
        if (!resp.ok) throw new Error(`Drive create failed: ${resp.status}`);
        const result = await resp.json();
        driveFileId = result.id;
    }
}

function debouncedDriveSave() {
    if (driveSaveTimer) clearTimeout(driveSaveTimer);
    driveSaveTimer = setTimeout(() => {
        writeDriveCategories(categories).catch(err =>
            console.warn('Drive save failed:', err.message)
        );
    }, 2000);
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
    await loadCategories();
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
            renderView();
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
        renderView();
        return;
    }

    // Fetch full details (duration, etc.)
    const details = await fetchVideoDetails(videoIds);

    // Filter out Shorts
    allVideos = details.filter(v => !isShort(v));

    // Sort by publish date, newest first
    allVideos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

    setCache('mytubes_videos', allVideos, VIDEOS_TTL);
    renderView();
}

function loadUserAvatar() {
    // Fetch the authenticated user's YouTube channel thumbnail
    apiRequest(`${YOUTUBE_API}/channels?part=snippet&mine=true`)
        .then(data => {
            const thumb = data.items?.[0]?.snippet?.thumbnails?.default?.url;
            if (thumb) {
                document.getElementById('user-avatar').src = thumb;
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
    renderView();
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

    // View toggle buttons
    tabs += `<span class="view-toggle-spacer"></span>`;
    tabs += `<div class="view-toggle">`;
    tabs += `<button class="view-toggle-btn${viewMode === 'videos' ? ' active' : ''}" data-view="videos" title="Video grid">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="1" width="6" height="6" rx="1"/><rect x="9" y="1" width="6" height="6" rx="1"/><rect x="1" y="9" width="6" height="6" rx="1"/><rect x="9" y="9" width="6" height="6" rx="1"/></svg>
    </button>`;
    tabs += `<button class="view-toggle-btn${viewMode === 'channels' ? ' active' : ''}" data-view="channels" title="Channel list">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><rect x="1" y="2" width="3" height="3" rx="1.5"/><rect x="6" y="2.5" width="9" height="2" rx="1"/><rect x="1" y="6.5" width="3" height="3" rx="1.5"/><rect x="6" y="7" width="9" height="2" rx="1"/><rect x="1" y="11" width="3" height="3" rx="1.5"/><rect x="6" y="11.5" width="9" height="2" rx="1"/></svg>
    </button>`;
    tabs += `</div>`;

    tabsContainer.innerHTML = tabs;

    // Attach click handlers
    tabsContainer.querySelectorAll('.category-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            activeCategory = tab.dataset.category;
            selectedChannelId = null;
            tabsContainer.querySelectorAll('.category-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderView();
        });
    });

    // View toggle handlers
    tabsContainer.querySelectorAll('.view-toggle-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const newMode = btn.dataset.view;
            if (newMode === viewMode) return;
            viewMode = newMode;
            if (viewMode === 'videos') selectedChannelId = null;
            tabsContainer.querySelectorAll('.view-toggle-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            renderView();
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

function renderView() {
    if (viewMode === 'channels') {
        renderChannelView();
    } else {
        renderVideos();
    }
}

function getFilteredChannels() {
    let channels = [...allSubscriptions].sort((a, b) => a.title.localeCompare(b.title));

    // Filter by category
    if (activeCategory !== 'all') {
        if (activeCategory === 'uncategorized') {
            const assignedChannels = new Set(categories.categories.flatMap(c => c.channelIds));
            channels = channels.filter(ch => !assignedChannels.has(ch.channelId));
        } else {
            const cat = categories.categories.find(c => c.id === activeCategory);
            if (cat) {
                const channelSet = new Set(cat.channelIds);
                channels = channels.filter(ch => channelSet.has(ch.channelId));
            }
        }
    }

    // Filter by search
    if (searchQuery) {
        const q = searchQuery.toLowerCase();
        channels = channels.filter(ch => ch.title.toLowerCase().includes(q));
    }

    return channels;
}

function renderChannelView() {
    const container = document.getElementById('video-grid-container');
    const channels = getFilteredChannels();

    // Auto-select first channel if none selected or selected not in filtered list
    if (!selectedChannelId || !channels.find(ch => ch.channelId === selectedChannelId)) {
        selectedChannelId = channels.length > 0 ? channels[0].channelId : null;
    }

    // Build channel list HTML
    const channelListHtml = channels.length === 0
        ? '<p class="empty-message">No channels match your filters.</p>'
        : channels.map(ch => `
            <div class="channel-list-item${ch.channelId === selectedChannelId ? ' active' : ''}" data-channel-id="${ch.channelId}">
                <img class="channel-list-thumb" src="${ch.thumbnail}" alt="" loading="lazy">
                <span class="channel-list-name">${escapeHtml(ch.title)}</span>
            </div>
        `).join('');

    // Build video grid for selected channel
    let videoPanelHtml = '';
    if (selectedChannelId) {
        const selectedChannel = allSubscriptions.find(s => s.channelId === selectedChannelId);
        const channelVideos = allVideos.filter(v => v.channelId === selectedChannelId);
        const channelThumbs = {};
        for (const sub of allSubscriptions) {
            channelThumbs[sub.channelId] = sub.thumbnail;
        }

        const headerHtml = selectedChannel
            ? `<div class="channel-videos-header">
                <img class="channel-videos-header-thumb" src="${selectedChannel.thumbnail}" alt="">
                <h2>${escapeHtml(selectedChannel.title)}</h2>
               </div>`
            : '';

        if (channelVideos.length === 0) {
            videoPanelHtml = headerHtml + '<p class="empty-message">No videos from this channel.</p>';
        } else {
            videoPanelHtml = headerHtml + '<div class="video-grid">' +
                channelVideos.map(video => {
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
    } else {
        videoPanelHtml = '<p class="empty-message">Select a channel to view its videos.</p>';
    }

    container.innerHTML = `
        <div class="channel-view-layout">
            <div class="channel-list-panel">${channelListHtml}</div>
            <div class="channel-videos-panel">${videoPanelHtml}</div>
        </div>
    `;

    // Attach click handlers to channel list items
    container.querySelectorAll('.channel-list-item').forEach(item => {
        item.addEventListener('click', () => {
            selectedChannelId = item.dataset.channelId;
            // Update active state in list without full re-render
            container.querySelectorAll('.channel-list-item').forEach(i => i.classList.remove('active'));
            item.classList.add('active');
            // Re-render just the right panel
            renderChannelVideosPanel();
        });
    });
}

function renderChannelVideosPanel() {
    const panel = document.querySelector('.channel-videos-panel');
    if (!panel || !selectedChannelId) return;

    const selectedChannel = allSubscriptions.find(s => s.channelId === selectedChannelId);
    const channelVideos = allVideos.filter(v => v.channelId === selectedChannelId);
    const channelThumbs = {};
    for (const sub of allSubscriptions) {
        channelThumbs[sub.channelId] = sub.thumbnail;
    }

    const headerHtml = selectedChannel
        ? `<div class="channel-videos-header">
            <img class="channel-videos-header-thumb" src="${selectedChannel.thumbnail}" alt="">
            <h2>${escapeHtml(selectedChannel.title)}</h2>
           </div>`
        : '';

    if (channelVideos.length === 0) {
        panel.innerHTML = headerHtml + '<p class="empty-message">No videos from this channel.</p>';
    } else {
        panel.innerHTML = headerHtml + '<div class="video-grid">' +
            channelVideos.map(video => {
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
    updateOpenRouterSettings();
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
            renderView();
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
            renderView();
        });
    });
}

// ==================== Chat / AI Category Management ====================

function buildCategorySystemPrompt() {
    const catList = categories.categories.map(c =>
        `- "${c.name}" (id: ${c.id}, ${c.channelIds.length} channels)`
    ).join('\n') || '(none)';

    const subList = allSubscriptions.map(s => {
        const cat = getCategoryForChannel(s.channelId);
        const catLabel = cat ? `${cat.name} (${cat.id})` : 'Uncategorized';
        return `- ${s.title} (id: ${s.channelId}) → ${catLabel}`;
    }).join('\n') || '(none)';

    return `You are an AI assistant that manages YouTube subscription categories for the MyTubes app.

Current categories:
${catList}

Current subscriptions and their category assignments:
${subList}

When the user asks you to manage categories, respond with:
1. A brief human-readable explanation of what you're doing.
2. A JSON action block fenced with \`\`\`actions ... \`\`\` containing an array of operations.

Available actions:
- {"action": "create_category", "name": "Category Name"}
- {"action": "delete_category", "id": "category-id"}
- {"action": "rename_category", "id": "category-id", "name": "New Name"}
- {"action": "assign_channels", "channelIds": ["UC..."], "categoryId": "category-id"}

Rules:
- Category IDs are lowercase with hyphens (e.g. "woodworking", "diy-home").
- When assigning channels, use the exact channel IDs from the subscription list.
- When moving channels to a new category, create it first if it doesn't exist.
- You can include multiple actions in one block. They execute in order.
- If the user asks a question that doesn't require changes, just answer without an action block.
- Be concise in your explanations.`;
}

function updateChatUI() {
    const connected = isOpenRouterConnected();
    const connectDiv = document.getElementById('chat-connect');
    const bodyDiv = document.getElementById('chat-body');

    if (connected) {
        connectDiv.style.display = 'none';
        bodyDiv.style.display = 'flex';
    } else {
        connectDiv.style.display = 'block';
        bodyDiv.style.display = 'none';
    }
}

function updateOpenRouterSettings() {
    const connected = isOpenRouterConnected();
    document.getElementById('openrouter-connect-btn').style.display = connected ? 'none' : 'inline-block';
    document.getElementById('openrouter-connected').style.display = connected ? 'flex' : 'none';
}

function addChatMessage(role, text) {
    const container = document.getElementById('chat-messages');
    const div = document.createElement('div');
    div.className = `chat-msg ${role}`;

    // Render newlines as <br> (escape HTML first)
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    div.innerHTML = escaped.replace(/\n/g, '<br>');

    // Collapse long messages (more than 4 lines / ~200 chars)
    const lineCount = text.split('\n').length;
    if (role === 'assistant' && (lineCount > 4 || text.length > 200)) {
        div.classList.add('chat-msg-collapsed');
        const expandBtn = document.createElement('button');
        expandBtn.className = 'chat-msg-expand';
        expandBtn.textContent = 'Show more';
        expandBtn.addEventListener('click', () => {
            div.classList.toggle('chat-msg-collapsed');
            expandBtn.textContent = div.classList.contains('chat-msg-collapsed') ? 'Show more' : 'Show less';
        });
        div.after(expandBtn);
        // Need to append both to container
        container.appendChild(div);
        container.appendChild(expandBtn);
    } else {
        container.appendChild(div);
    }

    container.scrollTop = container.scrollHeight;
}

function parseActions(responseText) {
    const match = responseText.match(/```actions\s*([\s\S]*?)```/);
    if (!match) return [];
    try {
        return JSON.parse(match[1]);
    } catch (e) {
        console.error('Failed to parse actions:', e);
        return [];
    }
}

function extractExplanation(responseText) {
    // Return text outside the actions fence
    return responseText.replace(/```actions[\s\S]*?```/, '').trim();
}

function executeActions(actions) {
    const results = [];
    for (const act of actions) {
        switch (act.action) {
            case 'create_category': {
                const cat = ensureCategory(act.name);
                results.push(`Created category "${act.name}"`);
                break;
            }
            case 'delete_category': {
                const cat = categories.categories.find(c => c.id === act.id);
                if (cat) {
                    categories.categories = categories.categories.filter(c => c.id !== act.id);
                    results.push(`Deleted category "${cat.name}"`);
                } else {
                    results.push(`Category "${act.id}" not found`);
                }
                break;
            }
            case 'rename_category': {
                const cat = categories.categories.find(c => c.id === act.id);
                if (cat) {
                    const oldName = cat.name;
                    cat.name = act.name;
                    results.push(`Renamed "${oldName}" to "${act.name}"`);
                } else {
                    results.push(`Category "${act.id}" not found`);
                }
                break;
            }
            case 'assign_channels': {
                const targetCat = categories.categories.find(c => c.id === act.categoryId);
                if (targetCat) {
                    for (const channelId of act.channelIds) {
                        assignChannelToCategory(channelId, act.categoryId);
                    }
                    results.push(`Assigned ${act.channelIds.length} channel(s) to "${targetCat.name}"`);
                } else {
                    results.push(`Category "${act.categoryId}" not found`);
                }
                break;
            }
            default:
                results.push(`Unknown action: ${act.action}`);
        }
    }
    saveCategories();
    renderCategoryTabs();
    renderView();
    return results;
}

async function sendChatMessage(userText) {
    addChatMessage('user', userText);
    chatMessages.push({ role: 'user', content: userText });

    const apiKey = localStorage.getItem('openrouter_key');
    if (!apiKey) {
        addChatMessage('system', 'Not connected to OpenRouter.');
        return;
    }

    // Disable input while processing
    const chatInput = document.getElementById('chat-input');
    const chatSendBtn = document.getElementById('chat-send-btn');
    chatInput.disabled = true;
    chatSendBtn.disabled = true;

    // Show thinking indicator
    const thinkingDiv = document.createElement('div');
    thinkingDiv.className = 'chat-msg system chat-thinking';
    thinkingDiv.innerHTML = '<span class="thinking-dots"><span>.</span><span>.</span><span>.</span></span> Thinking';
    document.getElementById('chat-messages').appendChild(thinkingDiv);
    document.getElementById('chat-messages').scrollTop = document.getElementById('chat-messages').scrollHeight;

    try {
        const systemPrompt = buildCategorySystemPrompt();
        const messages = [
            { role: 'system', content: systemPrompt },
            ...chatMessages
        ];

        const response = await fetch(OPENROUTER_API_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: OPENROUTER_MODEL,
                messages: messages
            })
        });

        if (!response.ok) {
            const errData = await response.json().catch(() => ({}));
            throw new Error(errData.error?.message || `API error: ${response.status}`);
        }

        const data = await response.json();
        const assistantText = data.choices?.[0]?.message?.content || 'No response.';

        // Remove thinking indicator
        thinkingDiv.remove();

        // Parse and execute actions
        const actions = parseActions(assistantText);
        const explanation = extractExplanation(assistantText);

        addChatMessage('assistant', explanation);
        chatMessages.push({ role: 'assistant', content: assistantText });

        if (actions.length > 0) {
            const results = executeActions(actions);
            addChatMessage('system', results.join('; '));
        }
    } catch (err) {
        thinkingDiv.remove();
        addChatMessage('system', `Error: ${err.message}`);
        console.error('Chat error:', err);
    } finally {
        chatInput.disabled = false;
        chatSendBtn.disabled = false;
        chatInput.focus();
    }
}

function toggleChatPanel() {
    const panel = document.getElementById('chat-panel');
    panel.classList.toggle('open');
    document.getElementById('app').classList.toggle('chat-open', panel.classList.contains('open'));
    if (panel.classList.contains('open')) {
        updateChatUI();
        document.getElementById('chat-input').focus();
    }
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
        renderView();
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

    // Chat panel
    document.getElementById('chat-toggle-btn').addEventListener('click', toggleChatPanel);
    document.getElementById('chat-close-btn').addEventListener('click', () => {
        document.getElementById('chat-panel').classList.remove('open');
        document.getElementById('app').classList.remove('chat-open');
    });
    document.getElementById('chat-connect-btn').addEventListener('click', startOpenRouterAuth);
    document.getElementById('chat-send-btn').addEventListener('click', () => {
        const input = document.getElementById('chat-input');
        const text = input.value.trim();
        if (!text) return;
        input.value = '';
        sendChatMessage(text);
    });
    document.getElementById('chat-input').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') document.getElementById('chat-send-btn').click();
    });

    // OpenRouter settings
    document.getElementById('openrouter-connect-btn').addEventListener('click', startOpenRouterAuth);
    document.getElementById('openrouter-disconnect-btn').addEventListener('click', () => {
        disconnectOpenRouter();
        updateOpenRouterSettings();
        updateChatUI();
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.querySelectorAll('.modal.active').forEach(m => m.classList.remove('active'));
            document.getElementById('chat-panel').classList.remove('open');
            document.getElementById('app').classList.remove('chat-open');
        }
    });
}

// ==================== Initialization ====================

async function init() {
    // Handle OpenRouter OAuth callback before other setup
    await handleOpenRouterCallback();

    setupEventListeners();
    updateOpenRouterSettings();

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
