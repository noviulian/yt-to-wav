# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a YouTube audio downloader service built with Node.js and Express. It provides a modern web interface for downloading YouTube videos as MP3 or WAV files, with Redis-backed download history and metadata fetching. The application defaults to MP3 format for smaller file sizes.

## Architecture

- **Backend**: Express.js server (`server.js`) handling API endpoints
- **Frontend**: Modern responsive UI with Tailwind CSS and Lucide icons (`public/index.html`)
- **Storage**: Local file system (`downloads/` directory) for audio files
- **Cache**: Redis for download history persistence
- **External Dependencies**: 
  - `yt-dlp` command-line tool (must be installed separately)
  - YouTube API for metadata via `ytapi.apps.mattw.io`
  - Tailwind CSS (via CDN) for styling
  - Lucide icons (via CDN) for UI icons

## Key Components

### API Endpoints
- `POST /download` - Downloads YouTube video as MP3 or WAV file (accepts `format` parameter)
- `GET /history` - Retrieves download history from Redis
- `POST /delete` - Deletes audio file and removes from history
- Static file serving for downloaded files at `/downloads`

### Core Functions
- `extractVideoId()` - Extracts YouTube video ID from URL
- `fetchMetadata()` - Gets video title and thumbnail from external API
- `sanitizeFileName()` - Cleans video titles for safe file naming

## Development Commands

```bash
# Install dependencies
npm install

# Start the server (port 8080 by default)
npm start
# or
node server.js
```

## Environment Requirements

- Node.js >= 16
- `yt-dlp` installed and available in PATH
- Redis server running (set `REDIS_URL` environment variable)
- Port 8080 available (or set `PORT` environment variable)

## File Structure

```
├── server.js          # Main Express server
├── package.json       # Node.js dependencies and scripts
├── public/
│   └── index.html    # Web interface
├── downloads/         # Generated directory for audio files
└── Dockerfile        # Container deployment configuration
```