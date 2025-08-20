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
app.set('trust proxy', 1);            // secure cookies behind Vercel/CDN
app.use(express.json());
app.use(cookieParser());
app.use(express.static('.'));         // serve index.html, graph.html, etc.

// ---------- Env ----------
const {
  DATABASE_URL = 'postgresql://flowpad_n12z_user:0rnsR2CXHUkuYHQIb4z4Xme0Tx0BZKlb@dpg-d2gcuk0dl3ps73f6l8t0-a.oregon-postgres.render.com/flowpad_n12z',
  GOOGLE_CLIENT_ID = '790227037830-2o2si0qtoqo4nsli5s6drrtfks98b88r.apps.googleusercontent.com',
  JWT_SECRET = 'change-me',
  NODE_ENV = 'development'
} = process.env;

// ---------- Database pool (Node runtime; works on Vercel, Render) ----------
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_URL ? { rejectUnauthorized: false } : false,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('connect', (client) => {
  client.query('SET statement_timeout = 60000').catch(() => {});
  client.query('SET idle_in_transaction_session_timeout = 60000').catch(() => {});
});

pool.on('error', (err) => {
  console.error('❌ Pool error:', err.message);
});

// Quick boot log (safe: no secrets)
try {
  if (DATABASE_URL) {
    const u = new URL(DATABASE_URL);
    console.log(`DB host: ${u.hostname} ssl=${!!pool.options?.ssl}`);
  } else {
    console.warn('⚠️ DATABASE_URL not set; DB calls will fail.');
  }
} catch {}

// ---------- DB helpers ----------
async function testDatabaseConnection() {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    console.log('✅ Database connection test successful');
    return true;
  } catch (error) {
    console.error('❌ Database connection test failed:', error.message);
    return false;
  }
}

async function ensureDatabaseSchema() {
  let client;
  try {
    client = await pool.connect();

    const tablesExist = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables 
        WHERE table_schema = 'public' 
        AND table_name = 'users'
      );
    `);

    if (!tablesExist.rows[0].exists) {
      console.log('🏗️ Creating database schema...');

      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          google_id VARCHAR(255) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          name VARCHAR(255) NOT NULL,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        );
      `);

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

      await client.query('CREATE INDEX IF NOT EXISTS idx_graphs_user_id ON graphs(user_id);');
      await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_graph_id ON graph_shares(graph_id);');
      await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_email ON graph_shares(shared_with_email);');

      console.log('🎉 Database schema created successfully!');
    } else {
      console.log('✅ Database schema already exists');
    }
  } finally {
    client?.release();
  }
}

async function initDatabase() {
  console.log('🔄 Initializing database...');
  const ok = await testDatabaseConnection();
  if (!ok) {
    console.log('⚠️ App will run with limited database functionality');
    return;
  }
  try {
    await ensureDatabaseSchema();
    console.log('✅ Database initialization completed');
  } catch (e) {
    console.error('❌ Database schema initialization failed:', e.message);
    console.log('⚠️ App will run with limited database functionality');
  }
}

// Initialize database and then start server
async function startServer() {
  try {
    console.log('🔍 Starting database initialization...');
    await initDatabase();
    console.log('🔍 Database initialization completed, starting HTTP server...');
    
    if (NODE_ENV !== 'production') {
      console.log('🚀 Starting HTTP server...');
      const PORT = process.env.PORT || 3000;
      console.log(`🔧 Port: ${PORT}, NODE_ENV: ${NODE_ENV}`);
      console.log('🔧 About to call app.listen...');
      
      // Add timeout to prevent hanging
      const server = app.listen(PORT, () => {
        console.log(`✅ Listening on http://localhost:${PORT}`);
        console.log('✅ HTTP server startup callback executed');
      });
      
      // Add error handling
      server.on('error', (err) => {
        console.error('❌ Server error:', err);
      });
      
      console.log('✅ HTTP server startup code executed');
    } else {
      console.log('🚀 Production mode - skipping HTTP server startup');
    }
  } catch (err) {
    console.error('Failed to start server:', err);
  }
}

startServer();

// ---------- In-memory cache ----------
const graphCache = new Map();

function getCachedGraph(id) {
  return graphCache.get(String(id));
}

async function saveCachedGraph(id) {
  const key = String(id);
  const cached = graphCache.get(key);
  if (!cached) return; // nothing to save

  const client = await pool.connect();
  try {
    await client.query(
      'UPDATE graphs SET title=$1, data=$2, updated_at=NOW() WHERE id=$3',
      [cached.title, JSON.stringify(cached.data), key]
    );
    graphCache.set(key, { ...cached, dirty: false, lastModified: new Date().toISOString() });
  } finally {
    client.release();
  }
}

// ---------- OAuth / Auth ----------
const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

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
  } catch {
    return res.status(403).json({ error: 'Invalid token' });
  }
}

// ---------- Static routes ----------
app.get('/', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/graph', (_, res) => res.sendFile(path.join(__dirname, 'graph.html')));
app.get('/privacy', (_, res) => res.sendFile(path.join(__dirname, 'privacy-policy.html')));
app.get('/terms', (_, res) => res.sendFile(path.join(__dirname, 'terms-of-service.html')));

// ---------- Admin: wipe DB (dev) ----------
app.post('/api/admin/wipe-database', async (req, res) => {
  let client;
  try {
    client = await pool.connect();
    await client.query('SET statement_timeout = 300000'); // 5 minutes
    await client.query('DROP TABLE IF EXISTS graph_shares CASCADE');
    await client.query('DROP TABLE IF EXISTS graphs CASCADE');
    await client.query('DROP TABLE IF EXISTS users CASCADE');

    // Recreate
    await client.query(`
      CREATE TABLE users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
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
    await client.query('CREATE INDEX IF NOT EXISTS idx_graphs_user_id ON graphs(user_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_graph_id ON graph_shares(graph_id);');
    await client.query('CREATE INDEX IF NOT EXISTS idx_graph_shares_email ON graph_shares(shared_with_email);');

    graphCache.clear();

    res.json({ message: 'Database wiped and recreated successfully' });
  } catch (error) {
    console.error('❌ Error during manual database wipe:', error);
    res.status(500).json({ error: 'Failed to wipe database' });
  } finally {
    client?.release();
  }
});

// ---------- Health & Checklist ----------
app.get('/api/health', async (_, res) => {
  try {
    const client = await pool.connect();
    const result = await Promise.race([
      client.query('SELECT 1 as test'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Database timeout')), 5000)),
    ]);
    client.release();

    res.json({
      status: 'ok',
      database: 'connected',
      timestamp: new Date().toISOString(),
      render: 'compatible',
    });
  } catch (error) {
    console.error('Health check failed:', error.message);
    res.json({
      status: 'ok',
      database: 'error',
      timestamp: new Date().toISOString(),
      error: error.message,
      render: 'compatible',
    });
  }
});

// Returns the deployment checklist info safely (no secret values)
app.get('/api/checklist', async (req, res) => {
  const checklist = {
    env: {
      DATABASE_URL_present: !!DATABASE_URL,
      GOOGLE_CLIENT_ID_present: !!GOOGLE_CLIENT_ID,
      JWT_SECRET_present: !!JWT_SECRET && JWT_SECRET !== 'change-me',
      NODE_ENV,
    },
    runtime: {
      assumed_node_runtime: true, // indicate this must run in Node (not Edge)
    },
    database: {
      pool_ssl_enabled: !!pool.options?.ssl,
    },
  };

  // Augment with a quick live DB probe (non-fatal)
  try {
    const ok = await testDatabaseConnection();
    checklist.database.connection_ok = ok;
  } catch {
    checklist.database.connection_ok = false;
  }

  res.json(checklist);
});

// ---------- Auth ----------
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

    res.cookie('auth_token', token, {
      httpOnly: true,
      secure: NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });

    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error('Auth error:', err?.message || err);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// ---------- Graphs API ----------
app.get('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const ownGraphsQuery = `
      SELECT id, title, data, created_at, updated_at
      FROM graphs
      WHERE user_id = $1
      ORDER BY updated_at DESC
    `;

    const sharedGraphsQuery = `
      SELECT g.id, g.title, g.data, g.created_at, g.updated_at
      FROM graphs g
      INNER JOIN graph_shares gs ON g.id = gs.graph_id
      WHERE gs.shared_with_email = $1 AND g.user_id <> $2
      ORDER BY g.updated_at DESC
    `;

    const [ownGraphs, sharedGraphs] = await Promise.all([
      pool.query(ownGraphsQuery, [userId]),
      pool.query(sharedGraphsQuery, [req.user.email, userId]),
    ]);

    const graphs = [
      ...ownGraphs.rows.map(g => ({ ...g, type: 'own' })),
      ...sharedGraphs.rows.map(g => ({ ...g, type: 'shared' })),
    ];

    res.json(graphs);
  } catch (error) {
    console.error('Error fetching graphs:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Inbox API ----------
app.get('/api/graphs/inbox', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get pending invitations for the user
    const invitations = await pool.query(`
      SELECT 
        gs.id,
        g.title as graph_title,
        u.name as sharer_name,
        gs.permission,
        gs.created_at as shared_at,
        'pending' as status
      FROM graph_shares gs
      INNER JOIN graphs g ON gs.graph_id = g.id
      INNER JOIN users u ON gs.shared_by_user_id = u.id
      WHERE gs.shared_with_email = $1
      ORDER BY gs.created_at DESC
    `, [req.user.email]);
    
    res.json(invitations.rows);
  } catch (error) {
    console.error('Error fetching inbox:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/graphs/inbox/:id/:action', authenticateToken, async (req, res) => {
  try {
    const { id, action } = req.params;
    
    if (!['accept', 'reject'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    
    if (action === 'reject') {
      // Remove the share
      await pool.query(
        'DELETE FROM graph_shares WHERE id = $1 AND shared_with_email = $2',
        [id, req.user.email]
      );
      res.json({ message: 'Invitation rejected' });
    } else {
      // Accept the invitation (keep the share as is)
      res.json({ message: 'Invitation accepted' });
    }
  } catch (error) {
    console.error('Error responding to invitation:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------- Graph by ID ----------
app.get('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    // cache first
    const cached = getCachedGraph(id);
    if (cached) return res.json(cached);

    const client = await pool.connect();
    const result = await client.query(
      `SELECT id, title, data, created_at, updated_at, user_id
       FROM graphs
       WHERE id = $1
         AND (user_id = $2 OR id IN (
           SELECT graph_id FROM graph_shares WHERE shared_with_email = $3
         ))`,
      [id, req.user.id, req.user.email]
    );
    client.release();

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found' });
    }

    const graph = result.rows[0];
    if (typeof graph.data === 'string') {
      try { graph.data = JSON.parse(graph.data); } catch { graph.data = {}; }
    }

    graphCache.set(String(id), graph);
    res.json(graph);
  } catch (error) {
    console.error('Error fetching graph:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const { title, data } = req.body;
    const userId = req.user.id;

    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO graphs (title, data, user_id, created_at, updated_at) VALUES ($1, $2, $3, NOW(), NOW()) RETURNING id, title, data, created_at, updated_at',
      [title, JSON.stringify(data), userId]
    );
    client.release();

    const newGraph = result.rows[0];
    graphCache.set(String(newGraph.id), newGraph);

    res.status(201).json(newGraph);
  } catch (error) {
    console.error('Error creating graph:', error);
    res.status(500).json({ error: error.message });
  }
});

app.put('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, data } = req.body;
    const userId = req.user.id;

    const client = await pool.connect();

    const ownershipResult = await client.query(
      'SELECT user_id FROM graphs WHERE id = $1',
      [id]
    );
    if (ownershipResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Graph not found' });
    }

    const ownerId = ownershipResult.rows[0].user_id;
    let canEdit = ownerId === userId;

    if (!canEdit) {
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

    await client.query(
      'UPDATE graphs SET title = $1, data = $2, updated_at = NOW() WHERE id = $3',
      [title, JSON.stringify(data), id]
    );
    client.release();

    if (graphCache.has(String(id))) {
      const cached = graphCache.get(String(id));
      graphCache.set(String(id), {
        ...cached,
        title,
        data,
        updated_at: new Date().toISOString(),
      });
    }

    res.json({ message: 'Graph updated successfully' });
  } catch (error) {
    console.error('Error updating graph:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/graphs/:id/realtime', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { updates } = req.body;

    const client = await pool.connect();
    const accessResult = await client.query(
      `SELECT user_id FROM graphs
       WHERE id = $1
         AND (user_id = $2 OR id IN (
           SELECT graph_id FROM graph_shares WHERE shared_with_email = $3
         ))`,
      [id, req.user.id, req.user.email]
    );
    client.release();

    if (accessResult.rows.length === 0) {
      return res.status(403).json({ error: 'No access to this graph' });
    }

    let graphData = getCachedGraph(id);
    if (!graphData) {
      const c = await pool.connect();
      const r = await c.query(
        'SELECT id, title, data, created_at, updated_at FROM graphs WHERE id = $1',
        [id]
      );
      c.release();
      if (r.rows.length === 0) return res.status(404).json({ error: 'Graph not found' });
      graphData = r.rows[0];
      if (typeof graphData.data === 'string') {
        try { graphData.data = JSON.parse(graphData.data); } catch { graphData.data = {}; }
      }
    }

    if (!graphData.data) graphData.data = {};
    if (!Array.isArray(graphData.data.tiles)) graphData.data.tiles = [];
    if (!Array.isArray(graphData.data.connections)) graphData.data.connections = [];

    // TODO: apply your real-time update logic here
    // For now we just mark dirty.
    graphCache.set(String(id), { ...graphData, dirty: true, lastModified: new Date().toISOString() });

    res.json({ message: 'Updates applied successfully' });
  } catch (error) {
    console.error('Error applying real-time updates:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/graphs/:id/save', authenticateToken, async (req, res) => {
  try {
    await saveCachedGraph(req.params.id);
    res.json({ success: true, message: 'Graph saved successfully' });
  } catch (err) {
    console.error('Error saving graph:', err);
    res.status(500).json({ error: 'Failed to save graph' });
  }
});

app.get('/api/graphs/:id/cache-status', authenticateToken, async (req, res) => {
  try {
    const cached = getCachedGraph(req.params.id);
    if (!cached) return res.json({ cached: false });
    res.json({
      cached: true,
      lastModified: cached.lastModified,
      dirty: !!cached.dirty,
      dataSize: JSON.stringify(cached.data || {}).length,
    });
  } catch (err) {
    console.error('Error getting cache status:', err);
    res.status(500).json({ error: 'Failed to get cache status' });
  }
});

// ---------- Sharing ----------
app.post('/api/graphs/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, permission = 'viewer' } = req.body;
    const userId = req.user.id;

    if (!['viewer', 'editor'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission level' });
    }

    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'You can only share graphs you own' });
    }

    const existingShare = await pool.query(
      'SELECT id FROM graph_shares WHERE graph_id = $1 AND shared_with_email = $2',
      [id, email]
    );

    if (existingShare.rows.length > 0) {
      await pool.query(
        'UPDATE graph_shares SET permission = $1, updated_at = NOW() WHERE graph_id = $2 AND shared_with_email = $3',
        [permission, id, email]
      );
      res.json({ message: 'Permission updated successfully' });
    } else {
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

app.get('/api/graphs/:id/shared-users', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;

    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

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

app.put('/api/graphs/:id/change-permission', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email, permission } = req.body;
    const userId = req.user.id;

    if (!['viewer', 'editor'].includes(permission)) {
      return res.status(400).json({ message: 'Invalid permission level' });
    }

    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

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

app.delete('/api/graphs/:id/remove-user', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;
    const userId = req.user.id;

    const graphCheck = await pool.query(
      'SELECT id FROM graphs WHERE id = $1 AND user_id = $2',
      [id, userId]
    );
    if (graphCheck.rows.length === 0) {
      return res.status(403).json({ message: 'Access denied' });
    }

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

// ---------- Graph Deletion ----------
app.delete('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if user owns the graph or has admin access
    const graph = await pool.query(
      'SELECT user_id FROM graphs WHERE id = $1',
      [id]
    );
    
    if (!graph.rows[0]) {
      return res.status(404).json({ error: 'Graph not found' });
    }
    
    if (graph.rows[0].user_id !== userId) {
      return res.status(403).json({ error: 'Not authorized to delete this graph' });
    }
    
    // Delete the graph
    await pool.query('DELETE FROM graphs WHERE id = $1', [id]);
    
    res.json({ message: 'Graph deleted successfully' });
  } catch (error) {
    console.error('Error deleting graph:', error);
    res.status(500).json({ error: 'Failed to delete graph' });
  }
});

// Get collaborators for a graph
app.get('/api/graphs/:id/collaborators', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const userId = req.user.id;
    
    // Check if user has access to this graph
    const graph = await pool.query(
      'SELECT user_id FROM graphs WHERE id = $1',
      [id]
    );
    
    if (!graph.rows[0]) {
      return res.status(404).json({ error: 'Graph not found' });
    }
    
    if (graph.rows[0].user_id !== userId) {
      // Check if user is shared with this graph
      const shared = await pool.query(
        'SELECT * FROM graph_shares WHERE graph_id = $1 AND user_id = $2',
        [id, userId]
      );
      
      if (!shared.rows[0]) {
        return res.status(403).json({ error: 'Not authorized to access this graph' });
      }
    }
    
    // Get all users shared with this graph
    const collaborators = await pool.query(`
      SELECT u.id, u.name, u.email, gs.permission, gs.created_at
      FROM graph_shares gs
      JOIN users u ON gs.user_id = u.id
      WHERE gs.graph_id = $1
      ORDER BY gs.created_at DESC
    `, [id]);
    
    res.json(collaborators.rows);
  } catch (error) {
    console.error('Error getting collaborators:', error);
    res.status(500).json({ error: 'Failed to get collaborators' });
  }
});

// Get AI suggestions
app.post('/api/ai-suggestions', authenticateToken, async (req, res) => {
  try {
    const { prompt, targetTile, existingTiles, connections } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    // Simple AI suggestion logic - you can replace this with actual AI integration
    const suggestions = generateAISuggestions(prompt, targetTile, existingTiles, connections);
    
    res.json({ suggestions });
  } catch (error) {
    console.error('Error getting AI suggestions:', error);
    res.status(500).json({ error: 'Failed to get AI suggestions' });
  }
});

// Helper function to generate AI suggestions
function generateAISuggestions(prompt, targetTile, existingTiles, connections) {
  const suggestions = [];
  
  // Analyze the prompt and generate relevant suggestions
  if (prompt.toLowerCase().includes('title') || prompt.toLowerCase().includes('heading')) {
    suggestions.push('Add a clear, descriptive title that summarizes the main concept');
  }
  
  if (prompt.toLowerCase().includes('process') || prompt.toLowerCase().includes('flow')) {
    suggestions.push('Create a step-by-step process flow with numbered steps');
  }
  
  if (prompt.toLowerCase().includes('decision') || prompt.toLowerCase().includes('choice')) {
    suggestions.push('Add decision points with yes/no or multiple choice options');
  }
  
  if (prompt.toLowerCase().includes('input') || prompt.toLowerCase().includes('data')) {
    suggestions.push('Include input validation and data processing steps');
  }
  
  if (prompt.toLowerCase().includes('output') || prompt.toLowerCase().includes('result')) {
    suggestions.push('Add output formatting and result display elements');
  }
  
  if (prompt.toLowerCase().includes('error') || prompt.toLowerCase().includes('exception')) {
    suggestions.push('Include error handling and exception management');
  }
  
  if (prompt.toLowerCase().includes('user') || prompt.toLowerCase().includes('interface')) {
    suggestions.push('Add user interface components and interaction points');
  }
  
  if (prompt.toLowerCase().includes('database') || prompt.toLowerCase().includes('storage')) {
    suggestions.push('Include data persistence and storage operations');
  }
  
  if (prompt.toLowerCase().includes('api') || prompt.toLowerCase().includes('service')) {
    suggestions.push('Add external service integration and API calls');
  }
  
  if (prompt.toLowerCase().includes('test') || prompt.toLowerCase().includes('validate')) {
    suggestions.push('Include testing and validation steps');
  }
  
  // If no specific suggestions were generated, provide generic ones
  if (suggestions.length === 0) {
    suggestions.push('Break down the concept into smaller, manageable components');
    suggestions.push('Add clear labels and descriptions for each element');
    suggestions.push('Consider the user experience and flow direction');
    suggestions.push('Include error handling and edge cases');
  }
  
  return suggestions;
}

// ---------- Errors ----------
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ---------- Export / Local start ----------
module.exports = app;