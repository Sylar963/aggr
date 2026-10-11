import express from 'express'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { config } from 'dotenv'

config()

const __filename = new URL(import.meta.url).pathname
let __dirname = path.dirname(__filename)

if(process.platform === "win32"){
	__dirname = __dirname.substring(1)
}

const app = express()
const PORT = process.env.DIST_SERVER_PORT || process.env.PORT || 8060
const HOST = '0.0.0.0'
const DATA_FILE = process.env.WORKSPACES_DB || process.env.DATABASE_URL || path.join(__dirname, '..', 'data', 'workspaces.json')
const IP_SALT = process.env.IP_SALT || 'aggr-workspace-dev-salt'
const SHARE_BASE_URL = process.env.SHARE_BASE_URL || process.env.API_BASE || ''
const DELETE_TOKEN = process.env.WORKSPACE_DELETE_TOKEN || ''
const MAX_WORKSPACE_SIZE = Number(process.env.MAX_WORKSPACE_SIZE || 500 * 1024)
const MAX_COMPRESSED_SIZE = Number(process.env.MAX_COMPRESSED_SIZE || 100 * 1024)
const DEFAULT_TTL_SECONDS = Number(process.env.WORKSPACE_TTL_SECONDS || 30 * 24 * 60 * 60)
const MAX_TTL_SECONDS = Number(process.env.WORKSPACE_MAX_TTL_SECONDS || 365 * 24 * 60 * 60)
const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789'
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

let workspaceDb = null
let writeQueue = Promise.resolve()

function getLocalIP() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address
      }
    }
  }
  return 'localhost'
}

function jsonError(res, status, message) {
  return res.status(status).json({ error: message })
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || '')
    .toString()
    .split(',')[0]
    .trim() || req.socket.remoteAddress || 'unknown'
}

function hashIP(ip) {
  return crypto
    .createHash('sha256')
    .update(IP_SALT + ip)
    .digest('hex')
    .substring(0, 16)
}

function generateId(length = 10) {
  const bytes = crypto.randomBytes(length)
  let id = ''

  for (const byte of bytes) {
    id += ID_ALPHABET[byte % ID_ALPHABET.length]
  }

  return id
}

function sanitizeWorkspace(value, depth = 0) {
  if (depth > 50) {
    throw new Error('Workspace nesting is too deep')
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => sanitizeWorkspace(item, depth + 1))
  }

  return Object.keys(value).reduce((cleaned, key) => {
    if (!FORBIDDEN_KEYS.has(key)) {
      cleaned[key] = sanitizeWorkspace(value[key], depth + 1)
    }

    return cleaned
  }, {})
}

function validateWorkspacePayload(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object')
  }

  if (!body.workspace || typeof body.workspace !== 'object' || Array.isArray(body.workspace)) {
    throw new Error('workspace must be an object')
  }

  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 200)) {
    throw new Error('name must be a string up to 200 characters')
  }

  if (body.ttl !== undefined) {
    if (!Number.isFinite(body.ttl) || body.ttl < 3600 || body.ttl > MAX_TTL_SECONDS) {
      throw new Error(`ttl must be between 3600 and ${MAX_TTL_SECONDS} seconds`)
    }
  }

  const workspace = sanitizeWorkspace(body.workspace)
  const rawJson = JSON.stringify(workspace)
  const rawSize = Buffer.byteLength(rawJson)

  if (rawSize > MAX_WORKSPACE_SIZE) {
    throw new Error(`Workspace exceeds ${MAX_WORKSPACE_SIZE} bytes`)
  }

  const compressed = gzipSync(Buffer.from(rawJson), { level: 9, memLevel: 9 })

  if (compressed.length > MAX_COMPRESSED_SIZE) {
    throw new Error(`Compressed workspace exceeds ${MAX_COMPRESSED_SIZE} bytes`)
  }

  return {
    workspace,
    rawSize,
    compressed,
    name: (body.name || workspace.name || 'Untitled Workspace').toString().substring(0, 200),
    ttl: body.ttl || DEFAULT_TTL_SECONDS
  }
}

function decompressWorkspace(record) {
  return JSON.parse(gunzipSync(Buffer.from(record.data, 'base64')).toString())
}

function getOrigin(req) {
  if (SHARE_BASE_URL) {
    return SHARE_BASE_URL.replace(/\/$/, '')
  }

  const protocol = req.headers['x-forwarded-proto'] || req.protocol || 'http'
  return `${protocol}://${req.get('host')}`
}

async function ensureDb() {
  if (workspaceDb) {
    return workspaceDb
  }

  await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })

  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8')
    workspaceDb = JSON.parse(raw)
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw error
    }

    workspaceDb = { workspaces: {} }
  }

  if (!workspaceDb.workspaces || typeof workspaceDb.workspaces !== 'object') {
    workspaceDb.workspaces = {}
  }

  return workspaceDb
}

async function saveDb() {
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true })
    await fs.writeFile(DATA_FILE, JSON.stringify(workspaceDb, null, 2))
  })

  return writeQueue
}

function isExpired(record) {
  return record.expiresAt && new Date(record.expiresAt).getTime() <= Date.now()
}

async function cleanupExpiredWorkspaces() {
  const db = await ensureDb()
  let changed = false

  for (const [id, record] of Object.entries(db.workspaces)) {
    if (isExpired(record)) {
      delete db.workspaces[id]
      changed = true
    }
  }

  if (changed) {
    await saveDb()
  }
}

function createRateLimiter({ windowMs, max, message = 'Too many requests. Try again later.' }) {
  const hits = new Map()

  return (req, res, next) => {
    const now = Date.now()
    const key = hashIP(getClientIP(req))
    const hit = hits.get(key)

    if (!hit || hit.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs })
      return next()
    }

    hit.count++

    if (hit.count > max) {
      res.set('Retry-After', Math.ceil((hit.resetAt - now) / 1000).toString())
      return jsonError(res, 429, message)
    }

    return next()
  }
}

function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('X-Frame-Options', 'SAMEORIGIN')
  res.set('Cross-Origin-Resource-Policy', 'cross-origin')

  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }

  next()
}

function corsHeaders(req, res, next) {
  const allowedOrigins = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
  const origin = req.headers.origin

  if (!origin || !allowedOrigins.length || allowedOrigins.includes(origin)) {
    res.set('Access-Control-Allow-Origin', origin || '*')
  }

  res.set('Vary', 'Origin')
  res.set('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization')
  res.set('Access-Control-Max-Age', '86400')

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
}

app.disable('x-powered-by')
app.set('trust proxy', true)
app.use(securityHeaders)
app.use(corsHeaders)
app.use(createRateLimiter({ windowMs: 15 * 60 * 1000, max: 100 }))
app.use(express.json({ limit: MAX_WORKSPACE_SIZE + 1024 }))

const createLimiter = createRateLimiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many workspaces created. Try again later.'
})
const readLimiter = createRateLimiter({ windowMs: 60 * 1000, max: 30 })

app.get('/api/health', async (req, res, next) => {
  try {
    await ensureDb()
    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: 'connected',
      version: process.env.npm_package_version
    })
  } catch (error) {
    next(error)
  }
})

app.post('/api/workspaces', createLimiter, async (req, res, next) => {
  try {
    const payload = validateWorkspacePayload(req.body)
    const db = await ensureDb()
    let id = generateId()

    while (db.workspaces[id]) {
      id = generateId()
    }

    const now = new Date()
    const expiresAt = payload.ttl ? new Date(now.getTime() + payload.ttl * 1000).toISOString() : null
    const workspace = {
      id,
      slug: id,
      name: payload.name,
      data: payload.compressed.toString('base64'),
      rawSize: payload.rawSize,
      compressedSize: payload.compressed.length,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      expiresAt,
      viewCount: 0,
      ipHash: hashIP(getClientIP(req)),
      userAgent: (req.headers['user-agent'] || '').toString().substring(0, 300)
    }

    db.workspaces[id] = workspace
    await saveDb()

    res.status(201).json({
      id,
      url: `${getOrigin(req)}/w/${id}`,
      expiresAt
    })
  } catch (error) {
    if (/workspace|body|name|ttl|compressed/i.test(error.message)) {
      return jsonError(res, 400, error.message)
    }

    next(error)
  }
})

app.get('/api/workspaces/:id', readLimiter, async (req, res, next) => {
  try {
    const db = await ensureDb()
    const record = db.workspaces[req.params.id]

    if (!record) {
      return jsonError(res, 404, 'Workspace not found')
    }

    if (isExpired(record)) {
      delete db.workspaces[req.params.id]
      await saveDb()
      return jsonError(res, 410, 'Workspace expired')
    }

    record.viewCount++
    record.updatedAt = new Date().toISOString()
    await saveDb()

    res.json({
      workspace: decompressWorkspace(record),
      name: record.name,
      createdAt: record.createdAt,
      expiresAt: record.expiresAt,
      viewCount: record.viewCount
    })
  } catch (error) {
    next(error)
  }
})

app.get('/api/workspaces/:id/meta', readLimiter, async (req, res, next) => {
  try {
    const db = await ensureDb()
    const record = db.workspaces[req.params.id]

    if (!record) {
      return jsonError(res, 404, 'Workspace not found')
    }

    if (isExpired(record)) {
      delete db.workspaces[req.params.id]
      await saveDb()
      return jsonError(res, 410, 'Workspace expired')
    }

    const workspace = decompressWorkspace(record)
    const panes = workspace.states && workspace.states.panes && workspace.states.panes.panes
    const markets = panes
      ? Object.values(panes).flatMap(pane => Array.isArray(pane.markets) ? pane.markets : [])
      : []
    const exchanges = [...new Set(markets.map(market => market.exchange).filter(Boolean))]

    res.json({
      name: record.name,
      createdAt: record.createdAt,
      viewCount: record.viewCount,
      expiresAt: record.expiresAt,
      paneCount: panes ? Object.keys(panes).length : 0,
      exchanges
    })
  } catch (error) {
    next(error)
  }
})

app.delete('/api/workspaces/:id', async (req, res, next) => {
  try {
    if (DELETE_TOKEN) {
      const token = (req.headers.authorization || '').toString().replace(/^Bearer\s+/i, '')

      if (token !== DELETE_TOKEN) {
        return jsonError(res, 401, 'Invalid delete token')
      }
    }

    const db = await ensureDb()

    if (!db.workspaces[req.params.id]) {
      return jsonError(res, 404, 'Workspace not found')
    }

    delete db.workspaces[req.params.id]
    await saveDb()

    res.status(204).end()
  } catch (error) {
    next(error)
  }
})

app.use(express.static(path.join(__dirname, '..', 'dist')))
app.get('/*', (req, res) => {
  res.sendFile('index.html', {
    root: __dirname + '/../dist'
  })
})

app.use((err, req, res, next) => {
  const requestId = crypto.randomUUID()

  console.error('Unhandled request error', {
    requestId,
    message: err.message,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined,
    method: req.method,
    url: req.url,
    ip: hashIP(getClientIP(req)),
    timestamp: new Date().toISOString()
  })

  res.status(500).json({ error: 'Internal server error', requestId })
})

cleanupExpiredWorkspaces().catch(error => {
  console.error('Failed to clean expired workspaces', error)
})
setInterval(() => {
  cleanupExpiredWorkspaces().catch(error => {
    console.error('Failed to clean expired workspaces', error)
  })
}, 24 * 60 * 60 * 1000).unref()

app.listen(PORT, HOST, () => {
  const localIP = getLocalIP()
  console.log(`aggr dist server started on http://${localIP}:${PORT}`)
  console.log(`workspace share API using ${DATA_FILE}`)
})
