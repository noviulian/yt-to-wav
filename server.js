// === server.js with improved external API metadata ===
const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");
const Redis = require("ioredis");
const axios = require("axios");

const app = express();
const PORT = process.env.PORT || 8080;

const downloadsDir = path.join(__dirname, "downloads");
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);

const redis = new Redis(`${process.env.REDIS_URL}?family=0`);
const REDIS_HISTORY_KEY = "downloads_history";

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/downloads", express.static(downloadsDir));
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

app.post("/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send("No URL provided");

    const timestamp = Date.now();

    const videoId = extractVideoId(url);
    const meta = videoId
        ? await fetchMetadata(videoId)
        : { title: "Unknown Title", thumbnail: null };

    const fileName = `audio_${meta.title}.wav`;
    const outputPath = `downloads/${fileName}`;

    const command = `yt-dlp -f bestaudio --extract-audio --audio-format wav -o \"${outputPath}\" \"${url}\"`;

    exec(command, async (err) => {
        if (err) {
            console.error("Download error:", err);
            return res.status(500).send("Download failed");
        }

        const entry = {
            url,
            fileName,
            title: meta.title,
            thumbnail: meta.thumbnail,
            videoId,
            timestamp,
        };

        await redis.lpush(REDIS_HISTORY_KEY, JSON.stringify(entry));
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

app.post("/delete", async (req, res) => {
    const { fileName } = req.body;
    const filePath = path.join(__dirname, "downloads", fileName);
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

        const entries = await redis.lrange("downloads_history", 0, -1);
        const filtered = entries.filter((e) => !e.includes(fileName));
        await redis.del("downloads_history");
        if (filtered.length) {
            await redis.rpush("downloads_history", ...filtered);
        }
        res.sendStatus(200);
    } catch (e) {
        console.error("Delete error:", e);
        res.sendStatus(500);
    }
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
