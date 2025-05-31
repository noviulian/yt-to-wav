// === server.js ===
// Full-feature YouTube to WAV downloader web app

const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const path = require("path");
const fs = require("fs");
const bodyParser = require("body-parser");

const app = express();
const PORT = process.env.PORT || 3001;

const downloadsDir = path.join(__dirname, "downloads");
const jsonLogFile = path.join(__dirname, "download_log.json");

if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir);
if (!fs.existsSync(jsonLogFile)) fs.writeFileSync(jsonLogFile, "[]");

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
    const outputPath = path.join(downloadsDir, fileName);
    const command = `yt-dlp -f bestaudio --extract-audio --audio-format wav -o \"${outputPath}\" \"${url}\"`;

    exec(command, (err) => {
        if (err) {
            console.error("Download error:", err);
            return res.status(500).send("Download failed");
        }

        const entry = { url, fileName, timestamp };
        const existing = JSON.parse(fs.readFileSync(jsonLogFile));
        existing.push(entry);
        fs.writeFileSync(jsonLogFile, JSON.stringify(existing, null, 2));

        const fileUrl = `/downloads/${fileName}`;
        res.json({ downloadUrl: fileUrl });
    });
});

app.get("/history", (req, res) => {
    try {
        const data = JSON.parse(fs.readFileSync(jsonLogFile));
        res.json(data.reverse()); // most recent first
    } catch {
        res.status(500).send("Could not load history");
    }
});
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
