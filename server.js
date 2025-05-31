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

const redis = new Redis({
    host: process.env.REDISHOST || "localhost",
    port: parseInt(process.env.REDISPORT || "6379"),
    password: process.env.REDISPASSWORD || undefined,
});
const REDIS_HISTORY_KEY = "downloads_history";

app.use(cors());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use("/downloads", express.static(downloadsDir));
app.use(express.static(path.join(__dirname, "public")));

app.post("/download", async (req, res) => {
    const { url } = req.body;
    if (!url) return res.status(400).send("No URL provided");

    try {
        const info = await ytdl.getInfo(url);
        const title = info.videoDetails.title;
        const videoId = info.videoDetails.videoId;
        const timestamp = Date.now();
        const fileName = `audio_${timestamp}.wav`;
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
                title,
                videoId,
                timestamp,
            };
            await redis.lpush(REDIS_HISTORY_KEY, JSON.stringify(entry));
            const fileUrl = `/downloads/${fileName}`;
            console.log("✅ Saved:", fileUrl);
            res.json({ downloadUrl: fileUrl });
        });
    } catch (err) {
        console.error("Metadata error:", err);
        return res.status(500).send("Could not fetch video info");
    }
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
