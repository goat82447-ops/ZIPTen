# Node.js Backend Monorepo

Fast, production-ready Express.js backend with auth, menu, orders, and job queue.

## Quick Start

```bash
npm install
npm start
# Runs on http://localhost:3000
```

## Environment Setup

```bash
cp .env.example .env
# Edit .env with your MongoDB URI and Redis config
```

## Docker

```bash
docker-compose up
```

## Features

- ✅ User authentication (OTP + SMS)
- ✅ Menu management
- ✅ Order processing
- ✅ Background job queue (BullMQ)
- ✅ MongoDB integration
- ✅ Redis caching

## Endpoints

- `POST /api/auth/login` - Login
- `POST /api/auth/verify-otp` - Verify OTP
- `GET /api/menu` - Menu items
- `POST /api/orders` - Create order

See [API.md](API.md) for full reference.

## Development

```bash
# Install dev dependencies
npm install --save-dev nodemon

# Start with auto-reload
nodemon src/index.js

# Set variables
AUTH_ONLY_MODE=1 npm start
```

## Production

```bash
# Build Docker image
docker build -t ekart-backend:1.0.0 .

# Deploy to Render/Heroku/AWS
# See ../DEPLOYMENT.md
```

## Logs

```bash
# View logs
npm start 2>&1 | tee app.log

# With timestamps
npm start 2>&1 | while IFS= read -r line; do echo "$(date '+%Y-%m-%d %H:%M:%S') $line"; done
```
