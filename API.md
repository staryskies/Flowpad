# Flowpad API Documentation

## Overview

Flowpad provides a comprehensive REST API for managing graphs, users, and collaboration features. All API endpoints use JSON for request/response bodies and JWT tokens for authentication.

## Base URL
- Development: `http://localhost:3000`
- Production: `https://your-domain.com`

## Authentication

### Google OAuth Sign-in
```http
POST /api/auth/google
Content-Type: application/json

{
  "idToken": "google_id_token_here"
}
```

**Response:**
```json
{
  "token": "jwt_token_here",
  "user": {
    "id": 1,
    "email": "user@example.com",
    "name": "User Name"
  }
}
```

### Using JWT Tokens
Include the JWT token in the Authorization header:
```http
Authorization: Bearer your_jwt_token_here
```

## User Management

### Get User Profile
```http
GET /api/user/profile
Authorization: Bearer {token}
```

### Update User Profile
```http
PUT /api/user/profile
Authorization: Bearer {token}
Content-Type: application/json

{
  "name": "New Name"
}
```

## Graph Management

### List Graphs
```http
GET /api/graphs
Authorization: Bearer {token}
```

**Response:**
```json
[
  {
    "id": 1,
    "title": "My Graph",
    "data": {
      "tiles": [...],
      "connections": [...]
    },
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z",
    "type": "own"
  }
]
```

### Get Specific Graph
```http
GET /api/graphs/{id}
Authorization: Bearer {token}
```

### Create Graph
```http
POST /api/graphs
Authorization: Bearer {token}
Content-Type: application/json

{
  "title": "New Graph",
  "data": {
    "tiles": [],
    "connections": []
  }
}
```

### Update Graph
```http
PUT /api/graphs/{id}
Authorization: Bearer {token}
Content-Type: application/json

{
  "title": "Updated Title",
  "data": {
    "tiles": [...],
    "connections": [...]
  }
}
```

### Delete Graph
```http
DELETE /api/graphs/{id}
Authorization: Bearer {token}
```

### Get Graph Statistics
```http
GET /api/graphs/{id}/stats
Authorization: Bearer {token}
```

**Response:**
```json
{
  "tile_count": 5,
  "connection_count": 3,
  "total_characters": 150,
  "last_updated": "2024-01-01T00:00:00Z",
  "data_size_bytes": 1024
}
```

## Real-time & Caching

### Apply Real-time Updates
```http
POST /api/graphs/{id}/realtime
Authorization: Bearer {token}
Content-Type: application/json

{
  "updates": [...]
}
```

### Force Save Graph
```http
POST /api/graphs/{id}/save
Authorization: Bearer {token}
```

### Get Cache Status
```http
GET /api/graphs/{id}/cache-status
Authorization: Bearer {token}
```

## Sharing & Collaboration

### Share Graph
```http
POST /api/graphs/{id}/share
Authorization: Bearer {token}
Content-Type: application/json

{
  "email": "user@example.com",
  "permission": "viewer"
}
```

### Get Shared Users
```http
GET /api/graphs/{id}/shared-users
Authorization: Bearer {token}
```

### Change User Permission
```http
PUT /api/graphs/{id}/change-permission
Authorization: Bearer {token}
Content-Type: application/json

{
  "email": "user@example.com",
  "permission": "editor"
}
```

### Remove Shared User
```http
DELETE /api/graphs/{id}/remove-user
Authorization: Bearer {token}
Content-Type: application/json

{
  "email": "user@example.com"
}
```

### Get Collaborators
```http
GET /api/graphs/{id}/collaborators
Authorization: Bearer {token}
```

## Inbox & Invitations

### Get Inbox
```http
GET /api/graphs/inbox
Authorization: Bearer {token}
```

### Respond to Invitation
```http
POST /api/graphs/inbox/{id}/{action}
Authorization: Bearer {token}
```
Where `{action}` is either `accept` or `reject`.

## AI Features

### Get AI Suggestions
```http
POST /api/ai-suggestions
Authorization: Bearer {token}
Content-Type: application/json

{
  "prompt": "Create a user registration flow",
  "targetTile": {...},
  "existingTiles": [...],
  "connections": [...]
}
```

## System Endpoints

### Health Check
```http
GET /api/health
```

### Deployment Checklist
```http
GET /api/checklist
```

## Error Responses

All endpoints return appropriate HTTP status codes:

- `200` - Success
- `201` - Created
- `400` - Bad Request
- `401` - Unauthorized
- `403` - Forbidden
- `404` - Not Found
- `500` - Internal Server Error

Error responses include a JSON object with an `error` field:
```json
{
  "error": "Error message here"
}
```

## Data Structures

### Graph Data Structure
```json
{
  "tiles": [
    {
      "id": "tile_123",
      "x": 100,
      "y": 200,
      "title": "Tile Title",
      "content": "Tile content"
    }
  ],
  "connections": [
    {
      "id": "conn_456",
      "from": "tile_123",
      "to": "tile_789",
      "style": "solid"
    }
  ]
}
```

## Rate Limiting

Currently no rate limiting is implemented, but it's recommended for production use.

## CORS

CORS is configured to allow requests from:
- Development: `http://localhost:3000`, `http://127.0.0.1:3000`
- Production: Configure your domain in the server settings
