// === server.js with progress tracking, unique history, and expiration info ===
const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const axios = require("axios");
const { createProxyMiddleware } = require('http-proxy-middleware');

const app = express();
const PORT = process.env.PORT || 8080;

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

// Configure Redis connection for Railway deployment
const redisConfig = {
    // Try REDIS_URL first (Railway provides this with full connection string)
    ...(process.env.REDIS_URL && { 
        connectString: process.env.REDIS_URL,
        family: 0 // Use IPv4
    }),
    // Fallback to individual components if REDIS_URL doesn't work
    ...(!process.env.REDIS_URL && process.env.REDIS_PUBLIC_URL && {
        connectString: process.env.REDIS_PUBLIC_URL,
        family: 0
    }),
    // Additional Railway-specific configuration
    ...(process.env.REDIS_PASSWORD && {
        password: process.env.REDIS_PASSWORD
    }),
    // Connection stability settings for Railway
    retryDelayOnFailover: 100,
    enableReadyCheck: false,
    maxRetriesPerRequest: null,
    lazyConnect: true,
    keepAlive: 30000
};

const redis = process.env.REDIS_URL 
    ? new Redis(process.env.REDIS_URL, { family: 0 })
    : new Redis(redisConfig);

// Add Redis connection event handlers for debugging
redis.on('connect', () => {
    console.log('✅ Connected to Redis');
});

redis.on('ready', () => {
    console.log('🚀 Redis is ready for commands');
});

redis.on('error', (err) => {
    console.error('❌ Redis connection error:', err.message);
});

redis.on('close', () => {
    console.log('🔌 Redis connection closed');
});

redis.on('reconnecting', () => {
    console.log('🔄 Reconnecting to Redis...');
});
const REDIS_HISTORY_KEY = "downloads_history";
const REDIS_STATUS_KEY = "download_status";
const REDIS_CACHE_KEY = "file_cache";
const FILE_TTL_DAYS = 14;
const FILE_TTL_MS = FILE_TTL_DAYS * 24 * 60 * 60 * 1000;
const REDIS_VIEWER_PASSWORD = process.env.REDIS_VIEWER_PASSWORD || "admin123";

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
// Remove static middleware for downloads - handled by custom route
app.use(express.static(path.join(__dirname, "public")));

function extractVideoId(url) {
    const match = url.match(/(?:v=|be\/|embed\/|watch\?v=)([\w-]{11})/);
    console.log({ id: match ? match[1] : null });
    return match ? match[1] : null;
}

async function fetchMetadata(videoId) {
    try {
        const apiUrl = `https://ytapi.apps.mattw.io/v3/videos?key=foo1&quotaUser=ytwav&part=snippet&id=${videoId}`;
        const response = await axios.get(apiUrl);
        const data = response.data;
        console.log({ dataFromAPI: data });
        if (data.items && data.items.length > 0) {
            const snippet = data.items[0].snippet;
            return {
                title: snippet.title || "Unknown Title",
                thumbnail: snippet.thumbnails?.high?.url || null,
            };
        }
    } catch (e) {
        console.warn("⚠️ API fetch failed:", e.message);
    }
    return { title: "Unknown Title", thumbnail: null };
}

function sanitizeFileName(name) {
    return name.replace(/[\/\\?%*:|"<>]/g, "").trim();
}

// Generate unique download ID
function generateDownloadId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Get cached file info
async function getCachedFile(videoId, format) {
    try {
        const cacheKey = `${REDIS_CACHE_KEY}:${videoId}:${format}`;
        const cached = await redis.get(cacheKey);
        if (!cached) return null;
        
        const fileInfo = JSON.parse(cached);
        const fileName = `video_${videoId}.${format}`;
        const filePath = path.join(downloadsDir, fileName);
        
        // Check if file still exists on disk
        if (!fs.existsSync(filePath)) {
            // File was deleted, remove from cache
            await redis.del(cacheKey);
            return null;
        }
        
        // Update access time (extends TTL)
        fileInfo.lastAccessed = Date.now();
        await redis.setex(cacheKey, FILE_TTL_DAYS * 24 * 60 * 60, JSON.stringify(fileInfo));
        
        return fileInfo;
    } catch (error) {
        console.error("Cache check error:", error);
        return null;
    }
}

// Cache file info
async function cacheFileInfo(videoId, format, metadata) {
    try {
        const cacheKey = `${REDIS_CACHE_KEY}:${videoId}:${format}`;
        const fileInfo = {
            videoId,
            format,
            title: metadata.title,
            thumbnail: metadata.thumbnail,
            fileName: `video_${videoId}.${format}`,
            cached: Date.now(),
            lastAccessed: Date.now()
        };
        
        // Cache for 14 days
        await redis.setex(cacheKey, FILE_TTL_DAYS * 24 * 60 * 60, JSON.stringify(fileInfo));
        return fileInfo;
    } catch (error) {
        console.error("Cache store error:", error);
    }
}

// Add to history without duplicates
async function addToHistory(entry) {
    try {
        // Get existing history
        const entries = await redis.lrange(REDIS_HISTORY_KEY, 0, -1);
        const existingEntries = entries.map(e => JSON.parse(e));
        
        // Check if this video+format combination already exists
        const isDuplicate = existingEntries.some(existing => 
            existing.videoId === entry.videoId && existing.format === entry.format
        );
        
        if (!isDuplicate) {
            // Add new entry only if it doesn't exist
            await redis.lpush(REDIS_HISTORY_KEY, JSON.stringify(entry));
            console.log(`➕ Added to history: ${entry.title} (${entry.format})`);
        } else {
            console.log(`📋 Skipped duplicate history entry: ${entry.title} (${entry.format})`);
        }
    } catch (error) {
        console.error("History add error:", error);
    }
}

// Cleanup expired files
async function cleanupExpiredFiles() {
    try {
        console.log("🧹 Starting cleanup of expired files...");
        const pattern = `${REDIS_CACHE_KEY}:*`;
        const keys = await redis.keys(pattern);
        let deletedCount = 0;
        
        for (const key of keys) {
            const cached = await redis.get(key);
            if (!cached) continue;
            
            const fileInfo = JSON.parse(cached);
            const fileName = fileInfo.fileName;
            const filePath = path.join(downloadsDir, fileName);
            const isExpired = Date.now() - fileInfo.lastAccessed > FILE_TTL_MS;
            
            if (isExpired || !fs.existsSync(filePath)) {
                // Delete file if it exists
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🗑️ Deleted expired file: ${fileName}`);
                }
                
                // Remove from cache
                await redis.del(key);
                
                // Remove from history if present
                const historyEntries = await redis.lrange(REDIS_HISTORY_KEY, 0, -1);
                const filteredHistory = historyEntries.filter(entry => {
                    const parsed = JSON.parse(entry);
                    return parsed.fileName !== fileName;
                });
                
                if (filteredHistory.length < historyEntries.length) {
                    await redis.del(REDIS_HISTORY_KEY);
                    if (filteredHistory.length > 0) {
                        await redis.rpush(REDIS_HISTORY_KEY, ...filteredHistory);
                    }
                }
                
                deletedCount++;
            }
        }
        
        console.log(`✅ Cleanup complete. Deleted ${deletedCount} expired files.`);
    } catch (error) {
        console.error("Cleanup error:", error);
    }
}

// Run cleanup every 6 hours
setInterval(cleanupExpiredFiles, 6 * 60 * 60 * 1000);
// Run cleanup on startup
setTimeout(cleanupExpiredFiles, 10000);

app.post("/download", async (req, res) => {
    const { url, format = "mp3" } = req.body;
    if (!url) return res.status(400).send("No URL provided");
    
    // Validate format
    const validFormats = ["mp3", "wav"];
    if (!validFormats.includes(format)) {
        return res.status(400).send("Invalid format. Supported formats: mp3, wav");
    }

    try {
        const timestamp = Date.now();
        const videoId = extractVideoId(url);
        
        if (!videoId) {
            return res.status(400).send("Invalid YouTube URL");
        }

        // Check cache first
        const cachedFile = await getCachedFile(videoId, format);
        if (cachedFile) {
            console.log(`📋 Cache hit for ${videoId}.${format}`);
            
            // Add to history (won't duplicate)
            const entry = {
                url,
                fileName: cachedFile.fileName,
                title: cachedFile.title,
                thumbnail: cachedFile.thumbnail,
                videoId,
                timestamp,
                format,
            };
            await addToHistory(entry);
            
            // Return cached file immediately
            return res.json({
                downloadId: generateDownloadId(),
                status: 'completed',
                cached: true,
                downloadUrl: `/downloads/${cachedFile.fileName}?title=${encodeURIComponent(cachedFile.title)}&format=${format}`,
                title: cachedFile.title,
                message: 'File served from cache'
            });
        }

        // Not in cache, process normally
        const downloadId = generateDownloadId();
        const meta = await fetchMetadata(videoId);
        const fileName = `video_${videoId}.${format}`;
        const outputPath = path.join("downloads", fileName);

        // Store initial status
        await redis.set(`${REDIS_STATUS_KEY}:${downloadId}`, JSON.stringify({
            id: downloadId,
            status: 'processing',
            title: meta.title,
            thumbnail: meta.thumbnail,
            fileName,
            format,
            videoId,
            progress: 0,
            timestamp
        }), 'EX', 3600);

        // Ensure downloads directory exists
        fs.mkdirSync("downloads", { recursive: true });

        // Function to get yt-dlp args with cookie fallbacks
        const getYtdlpArgs = (browser = 'chrome') => [
            '-f', 'bestaudio',
            '--extract-audio',
            '--audio-format', format,
            '--newline',
            '--progress',
            '--rm-cache-dir',  // Clear cache to avoid 403 errors
            '--socket-timeout', '30',  // Increase timeout
            '--retries', '3',  // Retry failed downloads
            '--force-ipv4',  // Force IPv4 to avoid connection issues
            '--cookies-from-browser', browser,  // Try different browsers
            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            '-o', outputPath,
            url
        ];

        // Use spawn instead of exec for real-time progress
        const ytdlpArgs = getYtdlpArgs('chrome');

        const ytdlp = spawn('yt-dlp', ytdlpArgs);

        let currentProgress = 0;

        ytdlp.stdout.on('data', async (data) => {
            const output = data.toString();
            console.log('yt-dlp output:', output);
            
            // Parse progress from yt-dlp output
            const progressMatch = output.match(/\[download\]\s+(\d+\.?\d*)%/);
            if (progressMatch) {
                currentProgress = parseFloat(progressMatch[1]);
                console.log(`📊 Progress: ${currentProgress}%`);
                
                // Update status with progress
                await redis.set(`${REDIS_STATUS_KEY}:${downloadId}`, JSON.stringify({
                    id: downloadId,
                    status: 'processing',
                    title: meta.title,
                    thumbnail: meta.thumbnail,
                    fileName,
                    format,
                    videoId,
                    progress: currentProgress,
                    timestamp
                }), 'EX', 3600);
            }
        });

        ytdlp.stderr.on('data', (data) => {
            console.log('yt-dlp stderr:', data.toString());
        });

        ytdlp.on('close', async (code) => {
            if (code !== 0) {
                console.error("Download error: yt-dlp exited with code", code);
                
                // Try alternative browsers and formats on error
                if (code === 1) {
                    console.log("🔄 Retrying with different browser cookies and format options...");
                    
                    // Try different browsers in order of preference
                    const browserFallbacks = ['firefox', 'safari', 'edge'];
                    let retryAttempt = 0;
                    
                    const attemptRetry = async (browser) => {
                        const retryYtdlpArgs = [
                            '-f', 'worst[ext=webm]/worst',  // Try worst quality first
                            '--extract-audio',
                            '--audio-format', format,
                            '--newline',
                            '--progress',
                            '--rm-cache-dir',
                            '--socket-timeout', '60',
                            '--retries', '5',
                            '--force-ipv4',
                            '--no-check-certificate',
                            '--cookies-from-browser', browser,
                            '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                            '-o', outputPath,
                            url
                        ];
                        
                        return new Promise((resolve) => {
                            const retryYtdlp = spawn('yt-dlp', retryYtdlpArgs);
                            
                            retryYtdlp.on('close', (retryCode) => {
                                resolve(retryCode);
                            });
                        });
                    };
                    
                    // Try browsers sequentially
                    for (const browser of browserFallbacks) {
                        console.log(`🔄 Trying ${browser} cookies...`);
                        const retryCode = await attemptRetry(browser);
                        
                        if (retryCode === 0) {
                            console.log(`✅ Success with ${browser} cookies`);
                            await handleSuccessfulDownload();
                            return;
                        }
                    }
                    
                    // If all browser attempts fail, try without cookies
                    console.log("🔄 Trying without cookies as final fallback...");
                    const finalRetryArgs = [
                        '-f', 'worst[ext=webm]/worst',
                        '--extract-audio',
                        '--audio-format', format,
                        '--newline',
                        '--progress',
                        '--rm-cache-dir',
                        '--socket-timeout', '60',
                        '--retries', '5',
                        '--force-ipv4',
                        '--no-check-certificate',
                        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        '-o', outputPath,
                        url
                    ];
                    
                    const finalRetry = spawn('yt-dlp', finalRetryArgs);
                    
                    finalRetry.on('close', async (retryCode) => {
                        if (retryCode !== 0) {
                            console.error("All retry attempts failed with code", retryCode);
                            await redis.set(`${REDIS_STATUS_KEY}:${downloadId}`, JSON.stringify({
                                id: downloadId,
                                status: 'error',
                                error: 'Download failed after all retry attempts. This may be due to geographic restrictions, YouTube blocking, or missing browser cookies.',
                                timestamp
                            }), 'EX', 3600);
                            return;
                        }
                        
                        // Success after final retry
                        console.log("✅ Final retry successful without cookies");
                        await handleSuccessfulDownload();
                    });
                    
                    return; // Don't execute the error handling below
                }
                
                await redis.set(`${REDIS_STATUS_KEY}:${downloadId}`, JSON.stringify({
                    id: downloadId,
                    status: 'error',
                    error: 'Download failed',
                    timestamp
                }), 'EX', 3600);
                return;
            }

            await handleSuccessfulDownload();
        });

        async function handleSuccessfulDownload() {

            // Cache the file
            await cacheFileInfo(videoId, format, meta);

            // Mark as completed and add to history
            const entry = {
                url,
                fileName,
                title: meta.title,
                thumbnail: meta.thumbnail,
                videoId,
                timestamp,
                format,
            };

            await addToHistory(entry);
            await redis.set(`${REDIS_STATUS_KEY}:${downloadId}`, JSON.stringify({
                id: downloadId,
                status: 'completed',
                downloadUrl: `/downloads/${fileName}?title=${encodeURIComponent(meta.title)}&format=${format}`,
                fileName,
                title: meta.title,
                thumbnail: meta.thumbnail,
                format,
                videoId,
                progress: 100,
                timestamp
            }), 'EX', 3600);
            
            console.log("✅ Saved and cached:", fileName);
        }

        // Respond immediately with download ID
        res.json({ 
            downloadId, 
            status: 'processing',
            message: 'Download started',
            title: meta.title
        });
        
    } catch (error) {
        console.error("Unexpected error:", error);
        res.status(500).send("Internal server error");
    }
});

// Enhanced download endpoint with proper filename
app.get("/downloads/:filename", (req, res) => {
    const { filename } = req.params;
    const { title, format } = req.query;
    const filePath = path.join(downloadsDir, filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).send("File not found");
    }
    
    // Set proper filename for download
    if (title && format) {
        const safeTitle = sanitizeFileName(title);
        const downloadName = `${safeTitle}.${format}`;
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    }
    
    res.sendFile(filePath);
});

// New endpoint to check download status
app.get("/download/status/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const statusData = await redis.get(`${REDIS_STATUS_KEY}:${id}`);
        
        if (!statusData) {
            return res.status(404).json({ error: 'Download not found' });
        }
        
        const status = JSON.parse(statusData);
        res.json(status);
    } catch (error) {
        console.error("Status check error:", error);
        res.status(500).send("Internal server error");
    }
});

app.get("/history", async (req, res) => {
    try {
        const entries = await redis.lrange(REDIS_HISTORY_KEY, 0, -1);
        const data = entries.map((e) => JSON.parse(e));
        
        // Add proper download URLs with titles and expiration info
        const enhancedData = await Promise.all(data.map(async entry => {
            // Get cache info for expiration time
            const cacheKey = `${REDIS_CACHE_KEY}:${entry.videoId}:${entry.format}`;
            const cached = await redis.get(cacheKey);
            let expiresAt = null;
            let expiresIn = null;
            
            if (cached) {
                const fileInfo = JSON.parse(cached);
                expiresAt = fileInfo.lastAccessed + FILE_TTL_MS;
                expiresIn = Math.max(0, Math.ceil((expiresAt - Date.now()) / (1000 * 60 * 60 * 24))); // days
            }
            
            return {
                ...entry,
                downloadUrl: `/downloads/${entry.fileName}?title=${encodeURIComponent(entry.title)}&format=${entry.format}`,
                copyUrl: `${req.protocol}://${req.get('host')}/downloads/${entry.fileName}?title=${encodeURIComponent(entry.title)}&format=${entry.format}`,
                expiresAt,
                expiresInDays: expiresIn
            };
        }));
        
        res.json(enhancedData);
    } catch (err) {
        console.error("History error:", err);
        res.status(500).send("Could not load history");
    }
});

app.post("/delete", async (req, res) => {
    const { fileName } = req.body;
    const filePath = path.join(__dirname, "downloads", fileName);
    try {
        // Delete file
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }

        // Remove from history
        const entries = await redis.lrange(REDIS_HISTORY_KEY, 0, -1);
        const filtered = entries.filter((e) => !e.includes(fileName));
        await redis.del(REDIS_HISTORY_KEY);
        if (filtered.length) {
            await redis.rpush(REDIS_HISTORY_KEY, ...filtered);
        }
        
        // Remove from cache if it exists
        const videoId = fileName.replace(/^video_/, '').replace(/\.(mp3|wav)$/, '');
        const format = fileName.split('.').pop();
        const cacheKey = `${REDIS_CACHE_KEY}:${videoId}:${format}`;
        await redis.del(cacheKey);
        
        res.sendStatus(200);
    } catch (e) {
        console.error("Delete error:", e);
        res.sendStatus(500);
    }
});

// Cache stats endpoint for debugging
app.get("/cache/stats", async (req, res) => {
    try {
        const pattern = `${REDIS_CACHE_KEY}:*`;
        const keys = await redis.keys(pattern);
        const stats = {
            totalCached: keys.length,
            files: []
        };
        
        for (const key of keys) {
            const cached = await redis.get(key);
            if (cached) {
                const fileInfo = JSON.parse(cached);
                const fileName = fileInfo.fileName;
                const filePath = path.join(downloadsDir, fileName);
                const exists = fs.existsSync(filePath);
                const age = Math.round((Date.now() - fileInfo.lastAccessed) / (1000 * 60 * 60 * 24));
                
                stats.files.push({
                    videoId: fileInfo.videoId,
                    format: fileInfo.format,
                    title: fileInfo.title,
                    fileName,
                    exists,
                    ageInDays: age,
                    expiresInDays: FILE_TTL_DAYS - age
                });
            }
        }
        
        res.json(stats);
    } catch (error) {
        console.error("Cache stats error:", error);
        res.status(500).send("Internal server error");
    }
});

// Redis viewer authentication middleware
function requireRedisAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Basic ')) {
        res.setHeader('WWW-Authenticate', 'Basic realm="Redis Viewer"');
        return res.status(401).send('Authentication required');
    }
    
    const credentials = Buffer.from(authHeader.split(' ')[1], 'base64').toString();
    const [username, password] = credentials.split(':');
    
    if (password !== REDIS_VIEWER_PASSWORD) {
        return res.status(401).send('Invalid credentials');
    }
    
    next();
}

// RedisInsight access endpoint
app.get("/redis", requireRedisAuth, (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head>
            <title>RedisInsight Access</title>
            <style>
                body { font-family: Arial, sans-serif; margin: 20px; background: #f5f5f5; }
                .container { max-width: 600px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; text-align: center; }
                h1 { color: #d73527; }
                .access-link { display: inline-block; padding: 15px 30px; background: #007bff; color: white; text-decoration: none; border-radius: 5px; margin: 10px; font-size: 16px; }
                .access-link:hover { background: #0056b3; }
                .info { background: #e9ecef; padding: 15px; border-radius: 5px; margin: 20px 0; }
                .warning { background: #fff3cd; border: 1px solid #ffeaa7; color: #856404; padding: 15px; border-radius: 5px; margin: 20px 0; }
                iframe { width: 100%; height: 600px; border: 1px solid #ddd; border-radius: 5px; }
            </style>
        </head>
        <body>
            <div class="container">
                <h1>🔍 Redis Database Access</h1>
                <p>Access the official RedisInsight tool to view and manage your Redis database.</p>
                
                <div class="warning">
                    <strong>⚠️ Proxy Limitation:</strong> RedisInsight works best when accessed directly due to its complex asset loading and WebSocket connections.
                </div>
                
                <a href="http://localhost:5540" class="access-link" target="_blank">
                    🚀 Open RedisInsight (Direct Access)
                </a>
                
                <div class="info">
                    <p><strong>Setup Instructions:</strong></p>
                    <ol style="text-align: left;">
                        <li>Click the link above to open RedisInsight</li>
                        <li>Add a new Redis database with:</li>
                        <ul>
                            <li><strong>Host:</strong> localhost</li>
                            <li><strong>Port:</strong> 6379</li>
                            <li><strong>Name:</strong> YouTube Downloader DB</li>
                        </ul>
                    </ol>
                </div>
                
                <div class="info">
                    <p><strong>RedisInsight Features:</strong></p>
                    <ul style="text-align: left;">
                        <li>Real-time database monitoring</li>
                        <li>Key browser and editor</li>
                        <li>Query workbench</li>
                        <li>Memory analysis</li>
                        <li>Cluster management</li>
                    </ul>
                </div>
            </div>
        </body>
        </html>
    `);
});

// RedisInsight proxy with authentication
const redisInsightProxy = createProxyMiddleware({
    target: process.env.REDISINSIGHT_URL || 'http://localhost:5540',
    changeOrigin: true,
    ws: true,  // Enable websocket proxying
    pathRewrite: {
        '^/redisinsight': '/'
    },
    onProxyReq: (proxyReq, req, res) => {
        // Handle proxy path for RedisInsight
        proxyReq.setHeader('x-forwarded-prefix', '/redisinsight');
    },
    onError: (err, req, res) => {
        console.error('RedisInsight proxy error:', err.message);
        res.status(503).send(`
            <html>
            <body style="font-family: Arial; padding: 20px;">
                <h2>RedisInsight Unavailable</h2>
                <p>Cannot connect to RedisInsight service.</p>
                <p><strong>If running locally:</strong></p>
                <ol>
                    <li>Start RedisInsight with: <code>docker-compose up redisinsight -d</code></li>
                    <li>Or access directly at: <a href="http://localhost:5540" target="_blank">http://localhost:5540</a></li>
                </ol>
                <p><strong>Error:</strong> ${err.message}</p>
                <p><strong>Alternative:</strong> Access RedisInsight directly at the link above (no authentication required)</p>
            </body>
            </html>
        `);
    }
});

// Apply auth middleware to RedisInsight proxy
app.use('/redisinsight', requireRedisAuth, redisInsightProxy);

// Alternative direct access info endpoint
app.get('/redisinsight-info', requireRedisAuth, (req, res) => {
    const redisInsightUrl = process.env.REDISINSIGHT_URL || 'http://localhost:5540';
    res.json({
        message: 'RedisInsight access information',
        directUrl: redisInsightUrl,
        proxyUrl: '/redisinsight',
        note: 'Use the same credentials as the Redis viewer',
        instructions: {
            local: 'Run `docker-compose up redisinsight -d` to start RedisInsight',
            docker: 'Set REDISINSIGHT_URL=http://redisinsight:5540 when running in Docker'
        }
    });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));