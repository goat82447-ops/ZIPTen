<<<<<<< HEAD
# .NET Backend Services

Production-grade C# authentication and parcel services using ASP.NET Core 10 and MongoDB.

## Services

### AuthService (Port 5000)
User authentication, login, PIN verification.

### ParcelService (Port 5001)
Parcel tracking and delivery management.

## Prerequisites

- .NET 10 SDK
- MongoDB Atlas account
- Visual Studio or VS Code

## Setup

### 1. Clone and Restore
=======
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
>>>>>>> 6e3eb25d9cdd03fbca41f325220c054d6bf52ed8

```bash
cd dotnet
dotnet build LunchBox.slnx
<<<<<<< HEAD
```

### 2. Configure Database

Edit `appsettings.json`:
```json
{
  "MongoDb": {
    "ConnectionString": "mongodb+srv://Akhil:Welcome2@cluster0.yosm6gj.mongodb.net/",
=======
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
>>>>>>> 6e3eb25d9cdd03fbca41f325220c054d6bf52ed8
    "DatabaseName": "lunchbox"
  }
}
```

<<<<<<< HEAD
### 3. Run Services

```bash
# Terminal 1: AuthService
cd AuthService
dotnet run

# Terminal 2: ParcelService
cd ParcelService
dotnet run
```

## API Endpoints

### AuthService

**GET /api/auth/demo-user**
Get first user in database.

**POST /api/auth/login**
```json
{
  "email": "demo@lunchbox.local",
  "password": "LunchBox@123"
}
```
Response:
```json
{
  "id": 1,
  "fullName": "Aarav Sharma",
  "email": "demo@lunchbox.local",
  "securityPin": "4821"
}
```

**POST /api/auth/verify-pin**
```json
{
  "userId": 1,
  "pin": "4821"
}
```

### ParcelService

Similar endpoints for parcel management.

## Default Credentials

=======
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
>>>>>>> 6e3eb25d9cdd03fbca41f325220c054d6bf52ed8
- Email: `demo@lunchbox.local`
- Password: `LunchBox@123`
- PIN: `4821`

<<<<<<< HEAD
## Docker

### Build
```bash
docker build -t ekart-auth:latest AuthService/
docker build -t ekart-parcel:latest ParcelService/
```

### Run
```bash
docker run -p 5000:80 -e MongoDb__ConnectionString=mongodb+srv://... ekart-auth:latest
docker run -p 5001:80 -e MongoDb__ConnectionString=mongodb+srv://... ekart-parcel:latest
```

## Project Structure

```
dotnet/
├── AuthService/
│   ├── Program.cs              # Entry point
│   ├── AuthService.csproj      # Project file
│   ├── appsettings.json        # Config
│   ├── Data/
│   │   ├── AuthDbContext.cs    # MongoDB context
│   │   └── AuthSeeder.cs       # Seed data
│   └── Models/
│       ├── UserAccount.cs
│       ├── LoginRequest.cs
│       └── LoginResponse.cs
└── ParcelService/
    └── Similar structure
```

## Testing

### Health Check
```bash
curl http://localhost:5000/
```

### Login
```bash
curl -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "demo@lunchbox.local",
    "password": "LunchBox@123"
  }'
```

### Verify PIN
```bash
curl -X POST http://localhost:5000/api/auth/verify-pin \
  -H "Content-Type: application/json" \
  -d '{
    "userId": 1,
    "pin": "4821"
  }'
```

## Troubleshooting

**MongoDB Connection Error**
- Check connection string in appsettings.json
- Verify MongoDB Atlas IP whitelist
- Ensure database exists

**Port Already in Use**
```bash
netstat -ano | findstr :5000
taskkill /PID <PID> /F
```

**Build Error**
```bash
dotnet clean
dotnet restore
dotnet build
```
=======
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
>>>>>>> 6e3eb25d9cdd03fbca41f325220c054d6bf52ed8
