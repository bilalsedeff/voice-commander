# Voice MCP Gateway - Multi-stage Docker Build
# Optimized for development and production deployment

# Development stage
FROM node:18-alpine AS development

# Install system dependencies
RUN apk add --no-cache \
    python3 \
    make \
    g++ \
    libc6-compat \
    curl

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Create necessary directories
RUN mkdir -p logs dist

# Expose ports
EXPOSE 8710 8711

# Development command - run voice server with container networking
CMD ["npm", "run", "dev:voice:container"]

# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install all dependencies including dev dependencies
RUN npm ci

# Copy source code
COPY . .

# Build TypeScript
RUN npm run build

# Production stage
FROM node:18-alpine AS production

# Install system dependencies for production
RUN apk add --no-cache \
    curl \
    dumb-init

# Create app user
RUN addgroup -g 1001 -S nodejs
RUN adduser -S voicemcp -u 1001

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install only production dependencies
RUN npm ci --only=production && npm cache clean --force

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/dashboard ./src/dashboard

# Create necessary directories with proper permissions
RUN mkdir -p logs && chown -R voicemcp:nodejs logs
RUN mkdir -p config && chown -R voicemcp:nodejs config

# Switch to non-root user
USER voicemcp

# Expose ports
EXPOSE 8710 8711

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8710/health || exit 1

# Production command with dumb-init for proper signal handling
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "dist/gateway/voice-server.js"]