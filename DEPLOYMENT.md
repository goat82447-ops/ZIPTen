# Deployment Guide

## Quick Deployment Matrix

| Platform | Backend | Difficulty | Cost |
|----------|---------|-----------|------|
| Render | Node.js | Easy | Free/Paid |
| Docker | Both | Medium | Varies |
| Azure App Service | Both | Medium | Paid |
| AWS ECS | Both | Hard | Paid |
| Heroku | Node.js | Easy | Paid (Free tier ended) |

## Node.js Deployment

### Option 1: Render (Recommended)

1. **Push to GitHub**
   ```bash
   git add .
   git commit -m "Add Ekart backend"
   git push origin main
   ```

2. **Create Render Service**
   - Dashboard → New Web Service
   - Connect GitHub repo
   - Branch: `main`

3. **Configure Service**
   ```
   Name: ekart-backend
   Environment: Node
   Root Directory: nodejs-monorepo
   Build Command: npm install
   Start Command: npm start
   Plan: Standard ($7/month)
   ```

4. **Set Environment Variables**
   ```
   MONGODB_URI=mongodb+srv://Akhil:Welcome2@...
   REDIS_HOST=your-redis-host
   REDIS_PORT=6379
   AUTH_ONLY_MODE=0
   OTP_DEBUG_MODE=0
   SENDGRID_API_KEY=your-key
   ```

5. **Deploy**
   - Click "Create Web Service"
   - Wait ~5 minutes
   - Access: `https://ekart-backend.onrender.com`

### Option 2: Docker (Local or Any Cloud)

1. **Build Image**
   ```bash
   cd nodejs-monorepo
   docker build -t ekart-backend:1.0.0 .
   ```

2. **Run Locally**
   ```bash
   docker run -p 3000:3000 \
     -e MONGODB_URI=your-uri \
     -e REDIS_HOST=host.docker.internal \
     ekart-backend:1.0.0
   ```

3. **Push to Registry**
   ```bash
   docker tag ekart-backend:1.0.0 your-registry/ekart-backend:1.0.0
   docker push your-registry/ekart-backend:1.0.0
   ```

4. **Deploy to ECS/Kubernetes**
   - Use registry image
   - Set environment variables
   - Configure health check: `GET /health`
   - Expose port 3000

### Option 3: Docker Compose (Development)

```bash
cd nodejs-monorepo
docker-compose up
# MongoDB: localhost:27017
# Redis: localhost:6379
# Backend: localhost:3000
```

## .NET Deployment

### Option 1: Azure App Service

1. **Prepare for Deployment**
   ```bash
   cd dotnet/AuthService
   dotnet build -c Release
   dotnet publish -c Release -o publish
   ```

2. **Create App Service**
   - Azure Portal → App Services → Create
   - Runtime: .NET 10
   - OS: Linux
   - Tier: Standard B1

3. **Deploy Code**
   ```bash
   az webapp up \
     --name ekart-auth-service \
     --resource-group ekart-rg \
     --runtime 'DOTNETCORE|10.0' \
     --sku B1
   ```

4. **Configure App Settings**
   ```
   MongoDb__ConnectionString: mongodb+srv://...
   MongoDb__DatabaseName: lunchbox
   ASPNETCORE_ENVIRONMENT: Production
   ```

5. **Access Service**
   - URL: `https://ekart-auth-service.azurewebsites.net`

### Option 2: Docker (Any Platform)

1. **Create Dockerfile**
   ```dockerfile
   FROM mcr.microsoft.com/dotnet/runtime:10
   WORKDIR /app
   COPY publish .
   ENTRYPOINT ["dotnet", "AuthService.dll"]
   ```

2. **Build & Deploy**
   ```bash
   docker build -t ekart-auth:latest .
   docker run -p 5000:80 \
     -e MongoDb__ConnectionString=mongodb+srv://... \
     ekart-auth:latest
   ```

### Option 3: AWS ECS

1. **Create ECR Repository**
   ```bash
   aws ecr create-repository --repository-name ekart-auth
   ```

2. **Build & Push**
   ```bash
   docker build -t ekart-auth:latest .
   docker tag ekart-auth:latest 123456789.dkr.ecr.us-east-1.amazonaws.com/ekart-auth:latest
   docker push 123456789.dkr.ecr.us-east-1.amazonaws.com/ekart-auth:latest
   ```

3. **Create ECS Service**
   - Cluster → Create Service
   - Task definition → AuthService
   - Container: `ekart-auth:latest`
   - Port: 80
   - Environment variables

## Monitoring & Logs

### Node.js (Render)
- Logs: Dashboard → Logs tab
- Health: `https://ekart-backend.onrender.com/health`
- Monitor: Real-time request logs

### .NET (Azure)
- Logs: App Service → App Service logs
- Application Insights: Enable diagnostics
- Query: `AppTraces | summarize by Message`

### Docker
- Logs: `docker logs container_id`
- Stream: `docker logs -f container_id`

## SSL/TLS

### Render
- Automatic SSL with custom domain
- DNS settings in domain registrar
- Certificate: Auto-renewed

### Azure App Service
- Auto HTTPS enabled
- Custom certificate: Upload PFX
- Binding: Auto-configured

### Docker
- Use Nginx reverse proxy
- Let's Encrypt certificates
- Auto-renewal with certbot

## Scaling

### Node.js (Render)
1. Dashboard → Service Settings
2. Scroll to "Advanced"
3. Increase reserved instances
4. Restart service

### .NET (Azure)
1. App Service → Scale up/out
2. Increase instance size OR add replicas
3. Load balancer: Auto-configured

### Docker (Kubernetes)
```bash
kubectl scale deployment ekart-backend --replicas=3
```

## Troubleshooting

### MongoDB Connection Failed
```
Error: ECONNREFUSED mongodb+srv://...
Solution:
1. Check connection string in env vars
2. Verify MongoDB Atlas IP whitelist
3. Ensure database exists
```

### Redis Connection Failed
```
Error: ECONNREFUSED redis://localhost:6379
Solution:
1. For auth-only mode: Set AUTH_ONLY_MODE=1
2. Ensure Redis is running/deployed
3. Check firewall rules
```

### Port Already in Use
```
Error: listen EADDRINUSE :::3000
Solution:
1. Kill process: lsof -i :3000 | kill -9 PID
2. Change port: PORT=3001 npm start
```

## Production Checklist

- [ ] Set `OTP_DEBUG_MODE=0`
- [ ] Set `NODE_ENV=production`
- [ ] Verify MongoDB connection
- [ ] Configure email service (SendGrid/Gmail)
- [ ] Set strong admin credentials
- [ ] Enable CORS for frontend domain only
- [ ] Configure backup strategy
- [ ] Set up monitoring/alerts
- [ ] Test health endpoints
- [ ] Review security logs

## Rollback Procedure

### Render
1. Go to Dashboard
2. Deployments tab
3. Select previous version
4. Click "Redeploy"

### Azure
```bash
az webapp deployment slot swap \
  --name ekart-auth \
  --resource-group ekart-rg \
  --slot staging
```

### Docker
```bash
docker pull old-image:tag
docker stop current-container
docker run -d old-image:tag
```
