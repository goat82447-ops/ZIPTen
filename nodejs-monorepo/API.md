# API Reference

## Base URL
- Development: `http://localhost:3000`
- Production: `https://ekart-backend.onrender.com` (or your domain)

## Authentication Endpoints

### POST /api/auth/login
Login with username and password, receive OTP codes.

**Request:**
```json
{
  "username": "user",
  "password": "user123"
}
```

**Response:**
```json
{
  "tempToken": "uuid-string",
  "message": "Login successful.",
  "channels": {
    "email": "user@example.com",
    "mobile": "+1234567890"
  }
}
```

### POST /api/auth/verify-otp
Verify OTP codes received via email and SMS.

**Request:**
```json
{
  "tempToken": "uuid-from-login",
  "emailOtp": "123456",
  "mobileOtp": "654321"
}
```

**Response:**
```json
{
  "sessionToken": "session-uuid",
  "message": "OTP verification successful."
}
```

## Menu Endpoints

### GET /api/menu
Fetch all available menu items.

**Response:**
```json
[
  {
    "id": "1",
    "name": "Pepperoni Pizza",
    "price": 12.99,
    "description": "Classic pizza with mozzarella"
  }
]
```

## Order Endpoints

### POST /api/orders
Create a new order.

**Request:**
```json
{
  "userId": "user-id",
  "items": [
    {
      "id": "1",
      "name": "Pizza",
      "price": 12.99,
      "quantity": 1
    }
  ],
  "deliveryAddress": {
    "lat": 28.6139,
    "lng": 77.2090
  }
}
```

**Response:**
```json
{
  "id": "order-uuid",
  "userId": "user-id",
  "items": [...],
  "totalPrice": 12.99,
  "status": "received",
  "jobId": "job-id",
  "createdAt": "2026-06-05T10:00:00Z"
}
```

### GET /api/orders/:orderId
Get order details and status.

**Response:**
```json
{
  "id": "order-uuid",
  "status": "received",
  "totalPrice": 12.99,
  "createdAt": "2026-06-05T10:00:00Z"
}
```

## Health Endpoint

### GET /health
Service health check.

**Response:**
```json
{
  "service": "ekart-backend",
  "status": "ok",
  "mode": "full",
  "timestamp": "2026-06-05T10:00:00Z"
}
```

### GET /
Service info and available endpoints.

**Response:**
```json
{
  "service": "ekart-backend",
  "status": "ok",
  "version": "1.0.0",
  "mode": "full",
  "endpoints": ["/health", "/api/auth/*", "/api/menu", "/api/orders", "/api/jobs"]
}
```

## Error Responses

All endpoints return errors in this format:

```json
{
  "error": "Error description"
}
```

Common status codes:
- 200: Success
- 201: Created
- 400: Bad Request
- 401: Unauthorized
- 500: Internal Server Error
