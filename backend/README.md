# Voice Commander Backend

Production API server for Voice Commander - voice-controlled MCP orchestration platform.

## Environment Variables

Required for production:
- `DATABASE_URL` - PostgreSQL connection (from Railway)
- `JWT_SECRET` - JWT signing secret
- `JWT_REFRESH_SECRET` - Refresh token secret
- `ENCRYPTION_KEY` - Data encryption key
- `GOOGLE_CLIENT_ID` - Google OAuth client ID
- `GOOGLE_CLIENT_SECRET` - Google OAuth client secret
- `FRONTEND_URL` - Frontend URL (https://voicecommander.org)
- `BACKEND_URL` - Backend URL (from Railway)

## Deployment

This backend is deployed on Railway with automatic builds from GitHub main branch.
