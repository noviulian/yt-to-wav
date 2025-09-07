FROM node:18-slim

# Install ffmpeg, yt-dlp dependencies, and curl for health checks
RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    python3 \
    python3-pip && rm -rf /var/lib/apt/lists/*

# Install yt-dlp
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && chmod a+rx /usr/local/bin/yt-dlp

# Set work directory
WORKDIR /app

# Copy source files
COPY . .

# Install dependencies
RUN npm install

# Create required folders if missing
RUN mkdir -p downloads && touch download_log.json

# Expose port
EXPOSE 8080

# Start server
CMD ["npm", "start"]
