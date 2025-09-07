# 🚀 Local Development Setup

## Prerequisites
- [Docker](https://www.docker.com/products/docker-desktop/) installed
- [Docker Compose](https://docs.docker.com/compose/install/) (usually comes with Docker Desktop)

## Quick Start

### Option 1: Using npm scripts (recommended)
```bash
# Start everything (app + Redis)
npm run dev

# View logs in real-time
npm run dev:logs

# Stop everything
npm run dev:down

# Clean up (removes volumes and containers)
npm run dev:clean
```

### Option 2: Using docker-compose directly
```bash
# Start everything
docker-compose up --build

# Start in background
docker-compose up --build -d

# Stop everything
docker-compose down

# View logs
docker-compose logs -f

# Clean up everything (including volumes)
docker-compose down -v --remove-orphans
```

## What gets started:
- **App**: http://localhost:8080 - The YouTube audio downloader
- **Redis**: localhost:6379 - For download history and caching

## File Structure:
```
├── docker-compose.yml    # Multi-service setup
├── Dockerfile           # App container config
├── server.js           # Main application
├── public/             # Frontend files
├── downloads/          # Downloaded files (auto-created)
└── package.json        # Dependencies and scripts
```

## Development Notes:
- Downloaded files are stored in `./downloads/` (mapped to container)
- Redis data persists in Docker volume
- App auto-restarts on code changes (volume mounted)
- Health checks ensure services are ready before connecting

## Troubleshooting:
- If port 8080 is in use: Change the port in `docker-compose.yml`
- If Redis connection fails: Wait for Redis health check to pass
- To reset everything: Run `npm run dev:clean` and start fresh

## Testing:
Once running, visit http://localhost:8080 and try downloading a YouTube video!