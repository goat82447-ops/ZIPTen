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

```bash
cd dotnet
dotnet build LunchBox.slnx
```

### 2. Configure Database

Edit `appsettings.json`:
```json
{
  "MongoDb": {
    "ConnectionString": "mongodb+srv://Akhil:Welcome2@cluster0.yosm6gj.mongodb.net/",
    "DatabaseName": "lunchbox"
  }
}
```

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

- Email: `demo@lunchbox.local`
- Password: `LunchBox@123`
- PIN: `4821`

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
