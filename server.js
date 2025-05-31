// === server.js with Redis ===
const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const ytdl = require("ytdl-core");
const Redis = require("ioredis");

const app = express();
const PORT = process.env.PORT || 3001;

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const redis = new Redis(process.env.REDIS_URL + "?family=0");
const REDIS_HISTORY_KEY = "downloads_history";

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/downloads", express.static(downloadsDir));
app.use(express.static(path.join(__dirname, "public")));

app.post("/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send("No URL provided");

    const timestamp = Date.now();
    const fileName = `audio_${timestamp}.wav`;
    const outputPath = `downloads/${fileName}`;
    let title = "Unknown Title";
    let videoId = null;

    try {
        const info = await ytdl.getInfo(url);
        title = info.videoDetails?.title || title;
        videoId = info.videoDetails?.videoId || null;
    } catch (err) {
        console.warn("⚠️ Failed to fetch metadata. Using fallback.");
        const match = url.match(/(?:v=|be\/)([\w-]{11})/);
        if (match) videoId = match[1];
    }

    const command = `yt-dlp -f bestaudio --extract-audio --audio-format wav -o "${outputPath}" "${url}"`;

    exec(command, async (err) => {
        if (err) {
            console.error("Download error:", err);
            return res.status(500).send("Download failed");
        }

        const entry = {
            url,
            fileName,
            title,
            videoId,
            timestamp,
        };

        await redis.lpush("downloads_history", JSON.stringify(entry));
        const fileUrl = `/downloads/${fileName}`;
        console.log("✅ Saved:", fileUrl);
        res.json({ downloadUrl: fileUrl });
    });
});
app.get("/history", async (req, res) => {
    try {
        const entries = await redis.lrange(REDIS_HISTORY_KEY, 0, -1);
        const data = entries.map((e) => JSON.parse(e));
        res.json(data);
    } catch (err) {
        console.error("History error:", err);
        res.status(500).send("Could not load history");
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
