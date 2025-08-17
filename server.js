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
  console.log('🔄 Initializing database...');
  
  // Wipe and recreate database on every server restart
  await wipeAndRecreateDatabase();
  
  console.log('✅ Database initialization completed');
}

async function wipeAndRecreateDatabase() {
  const client = await pool.connect();
  
  try {
    console.log('🗑️  Wiping existing database...');
    
    // Drop all tables in correct order (respecting foreign keys)
    await client.query('DROP TABLE IF EXISTS graph_shares CASCADE');
    await client.query('DROP TABLE IF EXISTS graphs CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');
    
    console.log('✅ All tables dropped successfully');
    
    // Recreate tables with fresh schema
    console.log('🏗️  Creating fresh database schema...');
    
    // Users table
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Users table created');
    
    // Graphs table
    await client.query(`
      CREATE TABLE graphs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Graphs table created');
    
    // Graph shares table
    await client.query(`
      CREATE TABLE graph_shares (
        id SERIAL PRIMARY KEY,
        graph_id INTEGER REFERENCES graphs(id) ON DELETE CASCADE,
        shared_with_email VARCHAR(255) NOT NULL,
        shared_by_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        permission VARCHAR(50) DEFAULT 'viewer',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('✅ Graph shares table created');
    
    // Create indexes for better performance
    await client.query('CREATE INDEX IF NOT EXISTS idx_graphs_user_id ON graphs(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_graph_id ON graph_shares(graph_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_email ON graph_shares(shared_with_email);');
    console.log('✅ Performance indexes created');
    
    console.log('🎉 Database wipe and recreation completed!');
    console.log('📊 Fresh schema created with:');
    console.log('   - users table');
    console.log('   - graphs table');
    console.log('   - graph_shares table');
    console.log('   - proper foreign key relationships');
    console.log('   - performance indexes');
    
  } catch (error) {
    console.error('❌ Error during database wipe/recreation:', error);
    throw error;
  } finally {
    client.release();
  }
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

// Manual database wipe endpoint (for development)
app.post('/api/admin/wipe-database', async (req, res) => {
  try {
    console.log('🔄 Manual database wipe requested...');
    
    // Wipe and recreate database
    await wipeAndRecreateDatabase();
    
    // Clear any in-memory caches
    graphCache.clear();
    
    console.log('✅ Manual database wipe completed');
    res.json({ message: 'Database wiped and recreated successfully' });
  } catch (error) {
    console.error('❌ Error during manual database wipe:', error);
    res.status(500).json({ error: 'Failed to wipe database' });
  }
});

// Health check endpoint
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
    const userId = req.user.id;
    
    // Get user's own graphs - only use columns that exist
    const ownGraphsQuery = `
      SELECT id, title, data, created_at, updated_at
      FROM graphs 
      WHERE user_id = $1 
      ORDER BY updated_at DESC
    `;
    
    // Get shared graphs - only use columns that exist
    const sharedGraphsQuery = `
      SELECT g.id, g.title, g.data, g.created_at, g.updated_at
      FROM graphs g
      INNER JOIN graph_shares gs ON g.id = gs.graph_id
      WHERE gs.shared_with_email = $1 AND g.user_id != $1
      ORDER BY g.updated_at DESC
    `;
    
    const [ownGraphs, sharedGraphs] = await Promise.all([
      pool.query(ownGraphsQuery, [userId]),
      pool.query(sharedGraphsQuery, [req.user.email]) // Use req.user.email for shared_with_email
    ]);
    
    const graphs = [
      ...ownGraphs.rows.map(g => ({ ...g, type: 'own' })),
      ...sharedGraphs.rows.map(g => ({ ...g, type: 'shared' }))
    ];
    
    res.json(graphs);
  } catch (error) {
    console.error('Error fetching graphs:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get a specific graph with caching
app.get('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check cache first
    if (graphCache.has(id)) {
      const cached = graphCache.get(id);
      return res.json(cached);
    }
    
    // Fetch from database - only use columns that exist
    const client = await pool.connect();
    const result = await client.query(
      'SELECT id, title, data, created_at, updated_at, user_id FROM graphs WHERE id = $1 AND (user_id = $2 OR id IN (SELECT graph_id FROM graph_shares WHERE shared_with_email = $2))',
      [id, req.user.email] // Use email for shared_with_email
    );
    client.release();
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found' });
    }
    
    const graph = result.rows[0];
    
    // Parse data if it's a string
    if (typeof graph.data === 'string') {
      try {
        graph.data = JSON.parse(graph.data);
      } catch (e) {
        graph.data = {};
      }
    }
    
    // Cache the result
    graphCache.set(id, graph);
    
    res.json(graph);
  } catch (error) {
    console.error('Error fetching graph:', error);
    res.status(500).json({ error: error.message });
  }
});

// Create a new graph
app.post('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const { title, data } = req.body;
    const userId = req.user.id;
    
    // Create graph - only use columns that exist
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO graphs (title, data, user_id, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, title, data, created_at, updated_at',
      [title, JSON.stringify(data), userId]
    );
    client.release();
    
    const newGraph = result.rows[0];
    
    // Cache the new graph
    graphCache.set(newGraph.id, newGraph);
    
    res.status(201).json(newGraph);
  } catch (error) {
    console.error('Error creating graph:', error);
    res.status(500).json({ error: error.message });
  }
});

// Update a graph with caching
app.put('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, data } = req.body;
    const userId = req.user.id;
    
    // Check if user owns the graph or has edit access
    const client = await pool.connect();
    
    // First check ownership
    let ownershipResult = await client.query(
      'SELECT user_id FROM graphs WHERE id = $1',
      [id]
    );
    
    if (ownershipResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Graph not found' });
    }
    
    const graph = ownershipResult.rows[0];
    
    // Check if user owns the graph or has editor access
    let canEdit = graph.user_id === userId;
    
    if (!canEdit) {
      // Check if user has editor access through sharing
      const shareResult = await client.query(
        'SELECT permission FROM graph_shares WHERE graph_id = $1 AND shared_with_email = $2',
        [id, req.user.email]
      );
      
      canEdit = shareResult.rows.length > 0 && shareResult.rows[0].permission === 'editor';
    }
    
    if (!canEdit) {
      client.release();
      return res.status(403).json({ error: 'No edit access to this graph' });
    }
    
    // Update the graph - only use columns that exist
    await client.query(
      'UPDATE graphs SET title = $1, data = $2, updated_at = NOW() WHERE id = $3',
      [title, JSON.stringify(data), id]
    );
    
    client.release();
    
    // Update cache if it exists
    if (graphCache.has(id)) {
      const cached = graphCache.get(id);
      cached.title = title;
      cached.data = data;
      cached.updated_at = new Date().toISOString();
      graphCache.set(id, cached);
    }
    
    res.json({ message: 'Graph updated successfully' });
  } catch (error) {
    console.error('Error updating graph:', error);
    res.status(500).json({ error: error.message });
  }
});

// Real-time updates endpoint with caching
app.post('/api/graphs/:id/realtime', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { updates } = req.body;
    const userId = req.user.id;
    
    // Check if user has access to this graph
    const client = await pool.connect();
    const accessResult = await client.query(
      'SELECT user_id FROM graphs WHERE id = $1 AND (user_id = $2 OR id IN (SELECT graph_id FROM graph_shares WHERE shared_with_email = $2))',
      [id, req.user.email]
    );
    client.release();
    
    if (accessResult.rows.length === 0) {
      return res.status(403).json({ error: 'No access to this graph' });
    }
    
    // Get current cached data
    let graphData = graphCache.get(id);
    if (!graphData) {
      // If not in cache, fetch from database
      const client = await pool.connect();
      const result = await client.query(
        'SELECT id, title, data, created_at, updated_at FROM graphs WHERE id = $1',
        [id]
      );
      client.release();
      
      if (result.rows.length === 0) {
        return res.status(404).json({ error: 'Graph not found' });
      }
      
      graphData = result.rows[0];
      if (typeof graphData.data === 'string') {
        try {
          graphData.data = JSON.parse(graphData.data);
        } catch (e) {
          graphData.data = {};
        }
      }
      
      graphCache.set(id, graphData);
    }
    
    // Apply updates to cached data
    updates.forEach(update => {
      switch (update.type) {
        case 'tile_create':
        case 'tile_update':
        case 'tile_move':
        case 'tile_delete':
          if (!graphData.data.tiles) graphData.data.tiles = [];
          // Apply tile updates
          break;
        case 'connection_create':
        case 'connection_delete':
          if (!graphData.data.connections) graphData.data.connections = [];
          // Apply connection updates
          break;
      }
    });
    
    // Mark as dirty for auto-save
    graphCache.set(id, { ...graphData, dirty: true });
    
    res.json({ message: 'Updates applied successfully' });
  } catch (error) {
    console.error('Error applying real-time updates:', error);
    res.status(500).json({ error: error.message });
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

// Share graph with permissions
app.post('/api/graphs/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, permission = 'viewer' } = req.body; // Default to viewer if no permission specified
    const userId = req.user.id;
    
    // Validate permission
    if (!['viewer', 'editor'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission level' });
    }
    
    // Check if user owns the graph
    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You can only share graphs you own' });
    }
    
    // Check if already shared with this email
    const existingShare = await pool.query(
      'SELECT id FROM graph_shares WHERE graph_id = $1 AND shared_with_email = $2',
      [id, email]
    );
    
    if (existingShare.rows.length > 0) {
      // Update existing permission
      await pool.query(
        'UPDATE graph_shares SET permission = $1, updated_at = NOW() WHERE graph_id = $2 AND shared_with_email = $3',
        [permission, id, email]
      );
      
      res.json({ message: 'Permission updated successfully' });
    } else {
      // Create new share
      await pool.query(
        'INSERT INTO graph_shares (graph_id, shared_with_email, permission, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW())',
        [id, email, permission]
      );
      
      res.json({ message: 'Graph shared successfully' });
    }
  } catch (error) {
    console.error('Error sharing graph:', error);
    res.status(500).json({ message: 'Failed to share graph' });
  }
});

// Get shared users for a graph
app.get('/api/graphs/:id/shared-users', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if user owns the graph
    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Get shared users
    const sharedUsers = await pool.query(
      'SELECT shared_with_email as email, permission, created_at FROM graph_shares WHERE graph_id = $1 ORDER BY created_at DESC',
      [id]
    );
    
    res.json(sharedUsers.rows);
  } catch (error) {
    console.error('Error getting shared users:', error);
    res.status(500).json({ message: 'Failed to get shared users' });
  }
});

// Change user permission
app.put('/api/graphs/:id/change-permission', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, permission } = req.body;
    const userId = req.user.id;
    
    // Validate permission
    if (!['viewer', 'editor'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission level' });
    }
    
    // Check if user owns the graph
    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Update permission
    const result = await pool.query(
      'UPDATE graph_shares SET permission = $1, updated_at = NOW() WHERE graph_id = $2 AND shared_with_email = $3',
      [permission, id, email]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Share not found' });
    }
    
    res.json({ message: 'Permission updated successfully' });
  } catch (error) {
    console.error('Error changing permission:', error);
    res.status(500).json({ message: 'Failed to change permission' });
  }
});

// Remove shared user
app.delete('/api/graphs/:id/remove-user', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    const userId = req.user.id;
    
    // Check if user owns the graph
    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }
    
    // Remove share
    const result = await pool.query(
      'DELETE FROM graph_shares WHERE graph_id = $1 AND shared_with_email = $2',
      [id, email]
    );
    
    if (result.rowCount === 0) {
      return res.status(404).json({ message: 'Share not found' });
    }
    
    res.json({ message: 'User removed successfully' });
  } catch (error) {
    console.error('Error removing user:', error);
    res.status(500).json({ message: 'Failed to remove user' });
  }
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
