// server.js
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const fetch = require('node-fetch');

require('dotenv').config();

const app = express();
app.set('trust proxy', 1);            // required for secure cookies behind Vercel/CDN
app.use(express.json());
app.use(cookieParser());
app.use(express.static('.'));         // serve index.html, graph.html, etc.

const {
  DATABASE_URL = 'postgresql://flowpad_n12z_user:0rnsR2CXHUkuYHQIb4z4Xme0Tx0BZKlb@dpg-d2gcuk0dl3ps73f6l8t0-a.oregon-postgres.render.com/flowpad_n12z',
  GOOGLE_CLIENT_ID = '790227037830-2o2si0qtoqo4nsli5s6drrtfks98b88r.apps.googleusercontent.com',
  JWT_SECRET = 'change-me'
} = process.env;

// ----- Database (no optional flags / no dbInitialized guards) -----
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // works with most hosted PG (Neon/Render/Heroku)
  max: 5
});

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      google_id VARCHAR(255) UNIQUE NOT NULL,
      email VARCHAR(255) UNIQUE NOT NULL,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS graphs (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(255) NOT NULL,
      data JSONB NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS graph_shares (
      id SERIAL PRIMARY KEY,
      graph_id INTEGER REFERENCES graphs(id) ON DELETE CASCADE,
      shared_with_email VARCHAR(255) NOT NULL,
      shared_by_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}
initDatabase().catch(err => {
  console.error('Failed to init DB:', err);
  // Let the app run; API calls will throw if DB truly unreachable
});

// ----- Google OAuth -----
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

// ----- Helper: auth middleware -----
async function authenticateToken(req, res, next) {
  try {
    const auth = req.headers['authorization'];
    const headerToken = auth && auth.startsWith('Bearer ') ? auth.slice(7) : null;
    const cookieToken = req.cookies?.auth_token || null;
    const token = headerToken || cookieToken;
    if (!token) return res.status(401).json({ error: 'Access token required' });

    const decoded = jwt.verify(token, JWT_SECRET);
    const { rows } = await pool.query('SELECT * FROM users WHERE id=$1', [decoded.userId]);
    if (rows.length === 0) return res.status(401).json({ error: 'Invalid token' });

    req.user = rows[0];
    next();
  } catch (e) {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// ----- Static routes -----
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/graph', (_, res) => res.sendFile(path.join(__dirname, 'graph.html')));
app.get('/privacy', (_, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));
app.get('/terms', (_, res) => res.sendFile(path.join(__dirname, 'terms-of-service.html')));

// ----- Health -----
app.get('/api/health', async (_, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', ts: new Date().toISOString() });
  } catch {
    res.json({ status: 'ok', database: 'error', ts: new Date().toISOString() });
  }
});

// ----- Auth -----
app.post('/api/auth/google', async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return res.status(400).json({ error: 'Missing idToken' });

    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_CLIENT_ID });
    const payload = ticket.getPayload();
    if (payload.aud !== GOOGLE_CLIENT_ID) return res.status(401).json({ error: 'Invalid token audience' });

    const { sub: googleId, email, name } = payload;
    let { rows } = await pool.query('SELECT * FROM users WHERE google_id=$1', [googleId]);
    if (rows.length === 0) {
      const ins = await pool.query(
        'INSERT INTO users (google_id, email, name) VALUES ($1,$2,$3) RETURNING *',
        [googleId, email, name]
      );
      rows = ins.rows;
    }
    const user = rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    // same-origin cookie (Vercel): Lax + secure in prod
    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/'
    });

    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Auth error:', err?.message || err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ----- Graphs API -----
// Get all graphs for a user
app.get('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM graphs WHERE user_id = $1 OR id IN (SELECT graph_id FROM graph_shares WHERE shared_with = $1) ORDER BY updated_at DESC',
      [req.user.id]
    );
    client.release();
    
    const own = result.rows.filter(g => g.user_id === req.user.id);
    const shared = result.rows.filter(g => g.user_id !== req.user.id);
    
    res.json({ own, shared });
  } catch (err) {
    console.error('Error fetching graphs:', err);
    res.status(500).json({ error: 'Failed to fetch graphs' });
  }
});

// Get a specific graph with caching
app.get('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const graphId = req.params.id;
    
    // Check cache first
    let cached = getCachedGraph(graphId);
    if (cached) {
      console.log(`Serving graph ${graphId} from cache`);
      return res.json(cached.data);
    }
    
    // Fetch from database
    const client = await pool.connect();
    const result = await client.query(
      'SELECT * FROM graphs WHERE id = $1 AND (user_id = $2 OR id IN (SELECT graph_id FROM graph_shares WHERE shared_with = $2))',
      [graphId, req.user.id]
    );
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found' });
    }
    
    const graph = result.rows[0];
    
    // Cache the graph data
    cacheGraph(graphId, graph);
    
    res.json(graph);
  } catch (err) {
    console.error('Error fetching graph:', err);
    res.status(500).json({ error: 'Failed to fetch graph' });
  }
});

// Create a new graph
app.post('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const { title, data } = req.body;
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO graphs (title, data, user_id) VALUES ($1, $2, $3) RETURNING *',
      [title, JSON.stringify(data), req.user.id]
    );
    client.release();
    
    const newGraph = result.rows[0];
    
    // Cache the new graph
    cacheGraph(newGraph.id, newGraph);
    
    res.status(201).json(newGraph);
  } catch (err) {
    console.error('Error creating graph:', err);
    res.status(500).json({ error: 'Failed to create graph' });
  }
});

// Update a graph with caching
app.put('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const graphId = req.params.id;
    const { title, data } = req.body;
    
    // Update cache immediately for instant feedback
    const cached = getCachedGraph(graphId);
    if (cached) {
      cached.data.title = title;
      cached.data.data = data;
      cached.lastModified = Date.now();
      cached.dirty = true;
    }
    
    // Update database
    const client = await pool.connect();
    await client.query(
      'UPDATE graphs SET title = $1, data = $2, updated_at = NOW() WHERE id = $3 AND (user_id = $4 OR id IN (SELECT graph_id FROM graph_shares WHERE shared_with = $4))',
      [title, JSON.stringify(data), graphId, req.user.id]
    );
    client.release();
    
    // Mark cache as clean since we just saved
    if (cached) {
      cached.dirty = false;
    }
    
    res.json({ success: true, message: 'Graph updated successfully' });
  } catch (err) {
    console.error('Error updating graph:', err);
    res.status(500).json({ error: 'Failed to update graph' });
  }
});

// Real-time updates endpoint with caching
app.post('/api/graphs/:id/realtime', authenticateToken, async (req, res) => {
  try {
    const graphId = req.params.id;
    const { updates } = req.body;
    
    // Get cached graph or fetch from database
    let cached = getCachedGraph(graphId);
    if (!cached) {
      const client = await pool.connect();
      const result = await client.query('SELECT * FROM graphs WHERE id = $1', [graphId]);
      client.release();
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Graph not found' });
      }
      
      cacheGraph(graphId, result.rows[0]);
      cached = getCachedGraph(graphId);
    }
    
    // Apply updates to cached data
    updates.forEach(update => {
      switch (update.type) {
        case 'tile_move':
          const tile = cached.data.data.tiles.find(t => t.id === update.data.tileId);
          if (tile) {
            tile.x = update.data.x;
            tile.y = update.data.y;
          }
          break;
        case 'tile_delete':
          cached.data.data.tiles = cached.data.data.tiles.filter(t => t.id !== update.data.tileId);
          cached.data.data.connections = cached.data.data.connections.filter(
            c => c.fromTile !== update.data.tileId && c.toTile !== update.data.tileId
          );
          break;
        case 'connection_delete':
          cached.data.data.connections = cached.data.data.connections.filter(
            c => c.id !== update.data.connectionId
          );
          break;
        case 'tile_create':
          cached.data.data.tiles.push(update.data);
          break;
        case 'connection_create':
          cached.data.data.connections.push(update.data);
          break;
      }
    });
    
    // Mark as dirty for auto-save
    markGraphDirty(graphId);
    
    res.json({ success: true, message: 'Updates applied successfully' });
  } catch (err) {
    console.error('Error applying real-time updates:', err);
    res.status(500).json({ error: 'Failed to apply updates' });
  }
});

// Force save a specific graph
app.post('/api/graphs/:id/save', authenticateToken, async (req, res) => {
  try {
    const graphId = req.params.id;
    await saveCachedGraph(graphId);
    res.json({ success: true, message: 'Graph saved successfully' });
  } catch (err) {
    console.error('Error saving graph:', err);
    res.status(500).json({ error: 'Failed to save graph' });
  }
});

// Get graph cache status
app.get('/api/graphs/:id/cache-status', authenticateToken, async (req, res) => {
  try {
    const graphId = req.params.id;
    const cached = getCachedGraph(graphId);
    
    if (!cached) {
      return res.json({ cached: false });
    }
    
    res.json({
      cached: true,
      lastModified: cached.lastModified,
      dirty: cached.dirty,
      dataSize: JSON.stringify(cached.data).length
    });
  } catch (err) {
    console.error('Error getting cache status:', err);
    res.status(500).json({ error: 'Failed to get cache status' });
  }
});

app.post('/api/graphs/:id/share', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { email } = req.body;
  const g = await pool.query('SELECT * FROM graphs WHERE id=$1 AND user_id=$2',[id, req.user.id]);
  if (g.rows.length === 0) return res.status(404).json({ error: 'Graph not found' });

  const exists = await pool.query(
    'SELECT 1 FROM graph_shares WHERE graph_id=$1 AND shared_with_email=$2',
    [id, email]
  );
  if (exists.rows.length) return res.status(400).json({ error: 'Already shared with this email' });

  await pool.query(
    'INSERT INTO graph_shares (graph_id, shared_with_email, shared_by_user_id) VALUES ($1,$2,$3)',
    [id, email, req.user.id]
  );
  res.json({ message: 'Graph shared successfully' });
});

// ----- AI Suggestions API -----
app.post('/api/ai-suggestions', authenticateToken, async (req, res) => {
  try {
    const { targetTile, existingTiles, connections } = req.body;
    
    const response = await fetch('https://magicloops.dev/api/loop/b43cee3e-e9c9-49cb-a87a-4411bfab1542/run', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        targetTile,
        existingTiles,
        connections
      })
    });

    if (!response.ok) {
      throw new Error(`Magic Loop API error: ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('AI suggestions error:', err);
    res.status(500).json({ error: 'Failed to get AI suggestions' });
  }
});

// ----- Errors -----
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ----- Export for Vercel / start locally -----
module.exports = app;

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Listening on http://localhost:${PORT}`));
}
