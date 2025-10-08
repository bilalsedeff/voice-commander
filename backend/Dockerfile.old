# Production Dockerfile for Voice Commander Backend
# Multi-stage build for optimal image size and security

# Stage 1: Build TypeScript application
FROM node:18-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY prisma ./prisma/

# Install dependencies (including devDependencies for build)
RUN npm ci

# Copy source code
COPY . .

# Generate Prisma Client
RUN npx prisma generate

# Build TypeScript application
RUN npm run build

# Stage 2: Production runtime
FROM node:18-alpine AS runtime

WORKDIR /app

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy package files
COPY --chown=nodejs:nodejs package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy Prisma schema and migrations
COPY --chown=nodejs:nodejs prisma ./prisma/

# Copy built application from builder stage
COPY --chown=nodejs:nodejs --from=builder /app/dist ./dist

# Generate Prisma Client (needed for production runtime)
RUN npx prisma generate

# Switch to non-root user
USER nodejs

# Expose API port
EXPOSE 3000

# Health check endpoint
HEALTHCHECK --interval=30s --timeout=3s --start-period=40s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start application with migration check
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/index.js"]
