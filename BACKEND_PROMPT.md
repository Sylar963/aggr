# Aggr Workspace Sharing Backend — Build Instructions

## Goal

Build a secure backend API that enables shareable workspace links for the Aggr cryptocurrency trade aggregator. Users should be able to save their workspace configuration server-side and share a clean URL (e.g., `your-domain.com/w/abc123`) that anyone can open to see the same chart layout, indicators, and settings.

---

## Architecture Overview

```
┌─────────────┐     POST /api/workspaces      ┌─────────────────┐
│  Aggr App   │ ──────────────────────────────▶│  Backend API    │
│  (Frontend) │ ◀──────────────────────────────│  (Node/Express) │
│  Vue 2 SPA  │     GET /api/workspaces/:id    │                 │
└─────────────┘                                └────────┬────────┘
                                                        │
                                                 ┌──────▼──────┐
                                                 │  Database   │
                                                 │  (SQLite /  │
                                                 │  PostgreSQL)│
                                                 └─────────────┘
```

---

## Step 1: Choose Your Stack

**Recommended:**
- Runtime: Node.js 20+
- Framework: Express.js (already in the project) or Fastify
- Database: SQLite (simple, file-based) or PostgreSQL (production)
- ORM: Drizzle ORM or Prisma
- Validation: Zod
- Rate Limiting: express-rate-limit
- Security: helmet, cors, crypto

**Why this stack:** The Aggr project already uses Node.js and Express in `dist-server/index.mjs`. Keeping the same stack minimizes dependencies and deployment complexity.

---

## Step 2: Database Schema

```sql
-- Workspaces table
CREATE TABLE workspaces (
    id          TEXT PRIMARY KEY,           -- Short ID (8-12 chars, nanoid)
    slug        TEXT UNIQUE NOT NULL,       -- URL-friendly identifier
    data        TEXT NOT NULL,             -- JSON-serialized workspace (compressed)
    created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
    expires_at  DATETIME,                  -- Optional TTL (e.g., 30 days)
    view_count  INTEGER DEFAULT 0,
    ip_hash     TEXT,                      -- Hashed creator IP for abuse tracking
    user_agent  TEXT                       -- Truncated UA for analytics
);

-- Index for fast lookups
CREATE INDEX idx_workspaces_slug ON workspaces(slug);
CREATE INDEX idx_workspaces_expires ON workspaces(expires_at);

-- Rate limiting table (if using DB-based rate limiting)
CREATE TABLE rate_limits (
    ip_hash     TEXT PRIMARY KEY,
    count       INTEGER DEFAULT 1,
    window_start DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

---

## Step 3: API Endpoints

### 3.1 POST /api/workspaces — Create/Update Workspace

```
Request:
{
    "workspace": { ... },           // The full workspace JSON object
    "name": "My Trading Setup",     // Optional display name
    "ttl": 2592000                  // Optional TTL in seconds (default: 30 days)
}

Response (201):
{
    "id": "a1b2c3d4e5f6",
    "url": "https://your-domain.com/w/a1b2c3d4e5f6",
    "expiresAt": "2025-02-15T12:00:00Z"
}
```

**Implementation:**
1. Validate input with Zod schema
2. Compress workspace JSON with `zlib.gzipSync()` (workspace JSONs can be 50-200KB)
3. Generate short ID with `nanoid` (custom alphabet: `a-z0-9`, length 10)
4. Hash creator IP with SHA-256 + salt for abuse tracking
5. Store in database with expiration
6. Return the shareable URL

### 3.2 GET /api/workspaces/:id — Retrieve Workspace

```
Response (200):
{
    "workspace": { ... },           // Decompressed workspace JSON
    "name": "My Trading Setup",
    "createdAt": "2025-01-15T12:00:00Z",
    "viewCount": 42
}
```

**Implementation:**
1. Look up workspace by slug/id
2. Check if expired → return 410 Gone
3. Decompress with `zlib.gunzipSync()`
4. Increment view count
5. Return workspace data

### 3.3 DELETE /api/workspaces/:id — Delete Workspace

```
Headers: Authorization: Bearer <token>   // Optional: for workspace owner
```

### 3.4 GET /api/workspaces/:id/meta — Workspace Metadata (for preview)

```
Response (200):
{
    "name": "My Trading Setup",
    "createdAt": "2025-01-15T12:00:00Z",
    "viewCount": 42,
    "expiresAt": "2025-02-15T12:00:00Z",
    "paneCount": 4,
    "exchanges": ["BINANCE", "BYBIT"]
}
```

---

## Step 4: Security Implementation

### 4.1 Input Validation

```typescript
import { z } from 'zod';

const WorkspaceSchema = z.object({
    workspace: z.object({
        id: z.string().max(100),
        name: z.string().max(200),
        states: z.record(z.any()).refine(
            (states) => JSON.stringify(states).length <= 500000,  // 500KB max
            'Workspace data too large'
        )
    }),
    name: z.string().max(200).optional(),
    ttl: z.number().min(3600).max(31536000).optional()  // 1 hour to 1 year
});
```

### 4.2 Rate Limiting

```typescript
import rateLimit from 'express-rate-limit';

// Global rate limit: 100 requests per 15 minutes per IP
const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
});

// Workspace creation: 5 per hour per IP
const createLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 5,
    message: { error: 'Too many workspaces created. Try again later.' }
});

// Workspace retrieval: 30 per minute per IP
const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 30,
});
```

### 4.3 Security Headers

```typescript
import helmet from 'helmet';

app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
        }
    },
    crossOriginEmbedderPolicy: false,  // Needed for iframe embedding
    crossOriginResourcePolicy: { policy: "cross-origin" }
}));
```

### 4.4 CORS Configuration

```typescript
import cors from 'cors';

app.use(cors({
    origin: [
        'https://your-domain.com',
        'http://localhost:8080'  // Development
    ],
    methods: ['GET', 'POST', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 86400  // 24 hours preflight cache
}));
```

### 4.5 Data Sanitization

```typescript
function sanitizeWorkspace(data: any): any {
    // Remove any potentially dangerous fields
    const forbidden = ['__proto__', 'constructor', 'prototype'];
    
    function clean(obj: any): any {
        if (typeof obj !== 'object' || obj === null) return obj;
        
        if (Array.isArray(obj)) {
            return obj.map(clean);
        }
        
        return Object.keys(obj).reduce((acc, key) => {
            if (forbidden.includes(key)) return acc;
            acc[key] = clean(obj[key]);
            return acc;
        }, {} as any);
    }
    
    return clean(data);
}
```

### 4.6 IP Hashing (Privacy-Respecting Abuse Tracking)

```typescript
import crypto from 'crypto';

const IP_SALT = process.env.IP_SALT || crypto.randomBytes(32).toString('hex');

function hashIP(ip: string): string {
    return crypto
        .createHash('sha256')
        .update(IP_SALT + ip)
        .digest('hex')
        .substring(0, 16);  // Truncate for storage efficiency
}

function getClientIP(req: Request): string {
    return req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim() 
        || req.socket.remoteAddress 
        || 'unknown';
}
```

### 4.7 Workspace Size Limits

```typescript
const MAX_WORKSPACE_SIZE = 500 * 1024;  // 500KB raw
const MAX_COMPRESSED_SIZE = 100 * 1024;  // 100KB compressed

function validateWorkspaceSize(workspace: any): boolean {
    const rawSize = JSON.stringify(workspace).length;
    if (rawSize > MAX_WORKSPACE_SIZE) {
        throw new Error('Workspace too large');
    }
    return true;
}
```

---

## Step 5: Compression Implementation

```typescript
import { gzipSync, gunzipSync } from 'zlib';

function compressWorkspace(data: any): Buffer {
    const json = JSON.stringify(data);
    return gzipSync(Buffer.from(json), {
        level: 9,          // Maximum compression
        memLevel: 9        // Maximum memory usage for best ratio
    });
}

function decompressWorkspace(compressed: Buffer): any {
    const json = gunzipSync(compressed).toString();
    return JSON.parse(json);
}

// Typical compression ratios for workspace JSON:
// Raw: ~100-200KB → Compressed: ~20-40KB (70-80% reduction)
```

---

## Step 6: Frontend Integration

### 6.1 Modify workspacesService.ts

Add a method to check for server-side workspace IDs on load:

```typescript
async function checkServerWorkspace(urlId: string): Promise<Workspace | null> {
    try {
        const response = await fetch(`${API_BASE}/api/workspaces/${urlId}`);
        if (!response.ok) return null;
        
        const data = await response.json();
        return data.workspace;
    } catch (error) {
        console.error('Failed to fetch server workspace:', error);
        return null;
    }
}
```

### 6.2 Modify getCurrentWorkspace()

In `workspacesService.ts`, update the workspace resolution logic:

```typescript
async getCurrentWorkspace(): Promise<Workspace> {
    const urlId = this.getUrlWorkspaceId();
    
    if (urlId) {
        // First, check if it's a server-side workspace
        const serverWorkspace = await checkServerWorkspace(urlId);
        if (serverWorkspace) {
            // Import it into local IndexedDB
            await this.addAndSetWorkspace(serverWorkspace);
            return serverWorkspace;
        }
        
        // Fallback to local lookup
        const localWorkspace = await this.getWorkspace(urlId);
        if (localWorkspace) return localWorkspace;
        
        // Create new local workspace with this ID
        return this.createWorkspace(urlId);
    }
    
    // ... existing fallback logic
}
```

### 6.3 Add Share Button Component

```vue
<template>
    <div class="share-workspace">
        <button @click="shareWorkspace" :disabled="isSharing">
            {{ isSharing ? 'Sharing...' : 'Share Workspace' }}
        </button>
        
        <div v-if="shareUrl" class="share-url">
            <input :value="shareUrl" readonly ref="urlInput" />
            <button @click="copyUrl">Copy</button>
        </div>
    </div>
</template>

<script>
export default {
    data() {
        return {
            isSharing: false,
            shareUrl: null
        };
    },
    methods: {
        async shareWorkspace() {
            this.isSharing = true;
            try {
                const workspace = this.$store.state.panes;
                const response = await fetch(`${API_BASE}/api/workspaces`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        workspace: workspace,
                        name: workspace.name || 'Untitled Workspace'
                    })
                });
                
                const data = await response.json();
                this.shareUrl = data.url;
            } catch (error) {
                console.error('Failed to share workspace:', error);
            } finally {
                this.isSharing = false;
            }
        },
        
        async copyUrl() {
            await navigator.clipboard.writeText(this.shareUrl);
            alert('URL copied to clipboard!');
        }
    }
};
</script>
```

---

## Step 7: Deployment

### 7.1 Environment Variables

```bash
# .env.production
API_BASE=https://your-domain.com
DATABASE_URL=./data/workspaces.db
IP_SALT=your-random-salt-here
PORT=8060
NODE_ENV=production

# Optional: PostgreSQL
# DATABASE_URL=postgresql://user:pass@localhost:5432/aggr
```

### 7.2 Docker Deployment

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
RUN npm ci --only=production

# Copy application
COPY dist/ ./dist/
COPY dist-server/ ./dist-server/

# Create data directory
RUN mkdir -p /app/data

# Expose port
EXPOSE 8060

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8060/api/health || exit 1

CMD ["node", "./dist-server/index.mjs"]
```

### 7.3 Docker Compose

```yaml
version: '3.8'

services:
  aggr:
    build: .
    ports:
      - "8060:8060"
    volumes:
      - ./data:/app/data
    environment:
      - NODE_ENV=production
      - DATABASE_URL=/app/data/workspaces.db
      - IP_SALT=${IP_SALT}
    restart: unless-stopped
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

### 7.4 Nginx Reverse Proxy (Production)

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;

    # API endpoints
    location /api/ {
        proxy_pass http://127.0.0.1:8060;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Rate limiting
        limit_req zone=api burst=20 nodelay;
    }

    # Static files (Aggr frontend)
    location / {
        root /var/www/aggr/dist;
        try_files $uri $uri/ /index.html;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
    }
}

# Rate limiting zone
limit_req_zone $binary_remote_addr zone=api:10m rate=10r/s;
```

---

## Step 8: Monitoring & Logging

### 8.1 Health Check Endpoint

```typescript
app.get('/api/health', (req, res) => {
    res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: 'connected',  // Add actual DB check
        version: process.env.npm_package_version
    });
});
```

### 8.2 Request Logging

```typescript
import morgan from 'morgan';

// Combined format with IP hashing for privacy
morgan.token('ip-hash', (req) => hashIP(getClientIP(req)));

app.use(morgan(':method :url :status :res[content-length] - :response-time ms ip::ip-hash'));
```

### 8.3 Error Tracking

```typescript
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', {
        message: err.message,
        stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
        url: req.url,
        method: req.method,
        ip: hashIP(getClientIP(req)),
        timestamp: new Date().toISOString()
    });
    
    res.status(500).json({
        error: 'Internal server error',
        requestId: crypto.randomUUID()
    });
});
```

---

## Step 9: Testing

### 9.1 Unit Tests

```typescript
// tests/workspaces.test.ts
import { describe, it, expect } from 'vitest';
import { compressWorkspace, decompressWorkspace } from '../src/utils/compression';

describe('Workspace Compression', () => {
    it('should compress and decompress workspace data', () => {
        const original = {
            id: 'test-workspace',
            name: 'Test',
            states: { panes: {}, settings: {} }
        };
        
        const compressed = compressWorkspace(original);
        const decompressed = decompressWorkspace(compressed);
        
        expect(decompressed).toEqual(original);
    });
});
```

### 9.2 Integration Tests

```typescript
// tests/api.test.ts
import request from 'supertest';
import app from '../src/app';

describe('Workspace API', () => {
    it('should create a workspace', async () => {
        const response = await request(app)
            .post('/api/workspaces')
            .send({
                workspace: {
                    id: 'test',
                    name: 'Test Workspace',
                    states: { panes: {} }
                }
            });
        
        expect(response.status).toBe(201);
        expect(response.body.id).toBeDefined();
        expect(response.body.url).toContain('/w/');
    });
    
    it('should reject oversized workspaces', async () => {
        const oversized = {
            workspace: {
                id: 'test',
                name: 'Test',
                states: { data: 'x'.repeat(600000) }  // 600KB
            }
        };
        
        const response = await request(app)
            .post('/api/workspaces')
            .send(oversized);
        
        expect(response.status).toBe(400);
    });
});
```

### 9.3 Load Testing

```bash
# Using Apache Bench
ab -n 1000 -c 50 -p workspace.json -T application/json \
    https://your-domain.com/api/workspaces

# Using k6
k6 run --vus 100 --duration 30s loadtest.js
```

---

## Step 10: Checklist

### Security
- [ ] Input validation with Zod
- [ ] Rate limiting (global + per-endpoint)
- [ ] Security headers (helmet)
- [ ] CORS configuration
- [ ] IP hashing for abuse tracking
- [ ] Workspace size limits
- [ ] Data sanitization (prototype pollution prevention)
- [ ] SQL injection prevention (parameterized queries)
- [ ] HTTPS enforcement

### Functionality
- [ ] Create workspace endpoint
- [ ] Retrieve workspace endpoint
- [ ] Delete workspace endpoint
- [ ] Workspace metadata endpoint
- [ ] JSON compression
- [ ] Expiration/TTL support
- [ ] Frontend share button
- [ ] URL-based workspace loading

### Operations
- [ ] Health check endpoint
- [ ] Request logging
- [ ] Error tracking
- [ ] Database backups
- [ ] Monitoring alerts
- [ ] Docker deployment
- [ ] Nginx reverse proxy
- [ ] SSL/TLS certificate

### Testing
- [ ] Unit tests
- [ ] Integration tests
- [ ] Load testing
- [ ] Security audit
- [ ] Penetration testing

---

## Quick Start Commands

```bash
# 1. Clone and setup
cd /home/aladhi/aladhi/aggr
mkdir -p server/src
cd server

# 2. Initialize project
npm init -y
npm install express cors helmet rate-limit-zod nanoid compression
npm install -D typescript @types/node vitest supertest

# 3. Create database schema
npx prisma init
# Edit prisma/schema.prisma with the schema above
npx prisma db push

# 4. Run development
npm run dev

# 5. Build for production
npm run build

# 6. Deploy
docker-compose up -d
```

---

## Estimated Time

| Task | Time |
|------|------|
| Backend API setup | 4-6 hours |
| Database integration | 2-3 hours |
| Security implementation | 3-4 hours |
| Frontend integration | 2-3 hours |
| Testing | 2-3 hours |
| Deployment | 2-3 hours |
| **Total** | **15-22 hours** |

---

## Notes

- The workspace JSON is typically 50-200KB raw, 20-40KB compressed
- Consider using Redis for rate limiting in production with multiple instances
- For high availability, use PostgreSQL with read replicas
- Monitor disk usage if using SQLite (workspaces accumulate over time)
- Implement cleanup job for expired workspaces (run daily)
