# System Architecture

## Overview

Ekart Backend is a multi-language implementation supporting both C# .NET and Node.js/Express.

### Technology Stack

| Component | Node.js | .NET |
|-----------|---------|------|
| Runtime | Node 20 | .NET 10 |
| Framework | Express 4.21 | ASP.NET Core |
| Database | MongoDB | MongoDB |
| Cache | Redis | Redis (optional) |
| Job Queue | BullMQ | - |
| Language | JavaScript | C# |

## Architecture Layers

```
┌─────────────────────────────────────────┐
│         Angular Frontend (Port 4200)    │
└────────────────┬────────────────────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
┌───▼────────┐ ┌─▼───────────┐ ┌──────────┐
│Node.js Mono│ │.NET Services│ │ Auth     │
│(3000)      │ │(5000+)      │ │Service   │
└───┬────────┘ └──┬──────────┘ └──────────┘
    │             │
    └─────┬───────┘
          │
    ┌─────▼──────────┐
    │  MongoDB Atlas │
    │  (Persistence)│
    └────────────────┘

    (Node.js only)
    ┌──────────────┐
    │ Redis + BullMQ
    │ (Job Queue) │
    └──────────────┘
```

## Component Details

### 1. Node.js Monolith (Primary Deployment)

**Location:** `nodejs-monorepo/`

**Services Bundled:**
- **Auth Service** - Login, OTP, session management
- **Menu Service** - Food items catalog
- **Order Service** - Order management
- **Worker Service** - BullMQ async job processor

**Key Files:**
- `src/index.js` - Main entry point
- `package.json` - Dependencies
- `.env` - Configuration

**Ports:**
- Development: `3000`
- Production: Render/Docker

**Strengths:**
- Single process deployment
- Faster development cycle
- Job queue integration
- Lower resource requirements

### 2. .NET Services (Enterprise Option)

**Location:** `dotnet/`

**Services:**
- **AuthService** (Port 5000) - User authentication, PIN verification
- **ParcelService** (Port 5001) - Parcel tracking

**Key Files:**
- `Program.cs` - Service entry point
- `AuthDbContext.cs` - MongoDB integration
- `appsettings.json` - Configuration
- `Models/` - Data models

**Strengths:**
- Type safety
- High performance
- Microservices architecture
- Enterprise ready

## Data Flow

### Authentication Flow

```
User (Angular)
    ↓
    ├→ POST /api/auth/login
    │   (username, password)
    │
    ├→ MongoDB: Find user
    │   Generate OTP codes
    │
    ├→ Response: tempToken + OTP channels
    │
    ├→ POST /api/auth/verify-otp
    │   (tempToken, emailOtp, mobileOtp)
    │
    ├→ MongoDB: Validate OTPs
    │   Create auth session
    │
    └→ Response: sessionToken
        (Valid for 24 hours)
```

### Order Processing Flow (Node.js)

```
User Creates Order
    ↓
POST /api/orders
    ↓
Save to MongoDB
    ↓
Queue Job: order-fulfillment
    ↓
BullMQ + Redis
    ↓
Worker Process
    ├→ Validate order
    ├→ Check inventory
    ├→ Assign captain
    └→ Send notifications
        ↓
    Update MongoDB
```

## Database Schema

### Users Collection
```javascript
{
  _id: ObjectId,
  username: String,
  password: String (bcrypt hashed),
  email: String,
  mobile: String,
  role: String, // customer, captain, admin
  created_at: ISODate,
  last_login: ISODate
}
```

### OTP Codes Collection
```javascript
{
  _id: ObjectId,
  session_token: String (UUID),
  channel: String, // email, mobile
  code: String,    // 6 digits
  consumed: Boolean,
  expires_at: ISODate
}
```

### Orders Collection
```javascript
{
  _id: ObjectId,
  user_id: String,
  items: [{
    id: String,
    name: String,
    price: Number,
    quantity: Number
  }],
  total_price: Number,
  status: String, // received, accepted, completed
  created_at: ISODate,
  delivered_at: ISODate
}
```

## Security

- **Passwords:** Bcrypt hashing (10 rounds)
- **Sessions:** UUID tokens with 24hr expiry
- **OTP:** 6-digit codes, 10-minute expiry
- **CORS:** Enabled for frontend domain
- **Environment:** Sensitive vars in .env

## Deployment Options

### Development
- Local MongoDB & Redis
- Node.js: `npm start`
- .NET: `dotnet run`

### Staging
- Docker Compose with managed services
- Node.js health checks enabled
- Verbose logging

### Production
- **Node.js:** Render, Heroku, AWS ECS
- **.NET:** Azure App Service, AWS ECS, Docker Swarm
- MongoDB Atlas (managed)
- Redis Cache (if needed)

## Performance Considerations

### Node.js
- Connection pooling via Mongoose
- Request caching with Redis
- Job queue for heavy operations
- Morgan logging (production: INFO level)

### .NET
- Async/await patterns
- Connection string pooling
- Dependency injection
- Middleware pipeline optimization

## Monitoring

### Node.js
- Health endpoint: `GET /health`
- Logs: Console (stdout)
- Job queue monitoring via BullMQ

### .NET
- Health endpoint: `GET /`
- Logs: ASP.NET Core logging
- ELK stack (optional)

## Scaling Strategy

### Horizontal
- Multiple instances behind load balancer
- Stateless service design
- Shared MongoDB & Redis

### Vertical
- Increase server CPU/RAM
- Optimize database queries
- Connection pool tuning
