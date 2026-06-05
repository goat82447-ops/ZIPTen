# Ekart Backend - Complete Solution

Production-ready backend with both **C# .NET** and **Node.js/Express** implementations.

## 📂 Structure

```
Ekart-Backend-Complete/
├── dotnet/                      # C# .NET Services
│   ├── AuthService/             # Authentication service
│   ├── ParcelService/           # Parcel/delivery tracking
│   └── LunchBox.slnx            # Solution file
├── nodejs-monorepo/             # Node.js Backend
│   ├── src/
│   ├── package.json
│   └── Dockerfile
├── ARCHITECTURE.md              # System design
├── DEPLOYMENT.md                # Deployment guide
└── README.md                    # This file
```

## 🚀 Quick Start

### Option 1: Node.js Backend (Recommended for quick deployment)

```bash
cd nodejs-monorepo
npm install
npm start
# Backend runs on http://localhost:3000
```

With Docker:
```bash
cd nodejs-monorepo
docker-compose up
```

### Option 2: .NET Backend (Production-grade)

```bash
cd dotnet
dotnet build LunchBox.slnx
dotnet run --project AuthService
# AuthService runs on http://localhost:5000
```

## 🎯 Features

### Authentication
- ✅ User login with email/password
- ✅ OTP-based verification (Email + SMS)
- ✅ Session management
- ✅ Voice step-up verification

### Menu Management
- ✅ Browse food items
- ✅ Search and filter
- ✅ Category organization

### Order Processing
- ✅ Create and track orders
- ✅ Real-time status updates
- ✅ Order history

### Job Queue (Node.js only)
- ✅ Background order fulfillment
- ✅ BullMQ + Redis integration
- ✅ Async processing

## 📋 API Endpoints

### Common
- `GET /health` - Service health
- `GET /` - Service info

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/verify-otp` - OTP verification
- `GET /api/auth/demo-user` - Demo user info

### Menu
- `GET /api/menu` - All menu items

### Orders
- `POST /api/orders` - Create order
- `GET /api/orders/:orderId` - Order details

## 🛠 Configuration

### Node.js (.env)
```
MONGODB_URI=mongodb+srv://Akhil:Welcome2@cluster0.yosm6gj.mongodb.net/lunchbox_db
REDIS_HOST=localhost
REDIS_PORT=6379
AUTH_ONLY_MODE=0
OTP_DEBUG_MODE=1
```

### .NET (appsettings.json)
```json
{
  "MongoDb": {
    "ConnectionString": "mongodb+srv://...",
    "DatabaseName": "lunchbox"
  }
}
```

## 📚 Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** - System design & component overview
- **[DEPLOYMENT.md](DEPLOYMENT.md)** - Deploy to Render, Docker, Azure
- **Node.js:** See [nodejs-monorepo/README.md](nodejs-monorepo/README.md)
- **.NET:** See [dotnet/README.md](dotnet/README.md)

## 🔐 Default Credentials

**Node.js Backend:**
- Username: `user`
- Password: `user123`

**.NET Backend:**
- Email: `demo@lunchbox.local`
- Password: `LunchBox@123`
- PIN: `4821`

## 📦 Database

**MongoDB Atlas:**
- Connection: `mongodb+srv://Akhil:Welcome2@cluster0.yosm6gj.mongodb.net/lunchbox_db`
- Database: `lunchbox`
- Collections: users, otpcodes, authsessions, orders, menu_items

**Redis (Node.js only):**
- Queue: `order-fulfillment`
- Cache: Session storage

## 🚢 Deployment

### Node.js to Render
1. Push to GitHub
2. Connect Render
3. Set root directory: `nodejs-monorepo`
4. Configure environment variables

### .NET to Azure / AWS
1. Build: `dotnet build`
2. Publish: `dotnet publish -c Release`
3. Deploy to App Service or ECS

See [DEPLOYMENT.md](DEPLOYMENT.md) for detailed steps.

## 🐳 Docker

### Node.js
```bash
docker build -f nodejs-monorepo/Dockerfile -t ekart-backend:latest .
docker run -p 3000:3000 ekart-backend:latest
```

### .NET
```bash
cd dotnet/AuthService
docker build -t ekart-auth:latest .
docker run -p 5000:5000 ekart-auth:latest
```

## 🧪 Testing

### Node.js Login
```bash
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"user","password":"user123"}'
```

### .NET Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"demo@lunchbox.local","password":"LunchBox@123"}'
```

## 🤝 Contributing

1. Create feature branch
2. Make changes
3. Test locally
4. Push and create PR

## 📞 Support

- Check logs in respective services
- Review DEPLOYMENT.md for troubleshooting
- Verify MongoDB and Redis connectivity
