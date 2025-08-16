// server.js
const express = require('express');
const path = require('path');
const cookieParser = require('cookie-parser');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');

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
app.get('/api/graphs', authenticateToken, async (req, res) => {
  const own = await pool.query(
    'SELECT * FROM graphs WHERE user_id=$1 ORDER BY updated_at DESC',
    [req.user.id]
  );
  const shared = await pool.query(`
    SELECT g.*, u.name AS owner_name
    FROM graphs g
    JOIN users u ON g.user_id = u.id
    JOIN graph_shares gs ON g.id = gs.graph_id
    WHERE gs.shared_with_email = $1
    ORDER BY g.updated_at DESC
  `,[req.user.email]);
  res.json({ own: own.rows, shared: shared.rows });
});

app.post('/api/graphs', authenticateToken, async (req, res) => {
  const { title, data } = req.body;
  const r = await pool.query(
    'INSERT INTO graphs (user_id, title, data) VALUES ($1,$2,$3) RETURNING *',
    [req.user.id, title || 'Untitled', data || { tiles: [], connections: [] }]
  );
  res.json(r.rows[0]);
});

app.put('/api/graphs/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const { title, data } = req.body;
  const r = await pool.query(
    `UPDATE graphs
     SET title=$1, data=$2, updated_at=CURRENT_TIMESTAMP
     WHERE id=$3 AND user_id=$4
     RETURNING *`,
    [title, data, id, req.user.id]
  );
  if (r.rows.length === 0) return res.status(404).json({ error: 'Graph not found' });
  res.json(r.rows[0]);
});

app.get('/api/graphs/:id', authenticateToken, async (req, res) => {
  const { id } = req.params;
  const r = await pool.query(`
    SELECT g.*
    FROM graphs g
    LEFT JOIN graph_shares gs ON g.id = gs.graph_id
    WHERE g.id=$1 AND (g.user_id=$2 OR gs.shared_with_email=$3)
  `,[id, req.user.id, req.user.email]);
  if (r.rows.length === 0) return res.status(404).json({ error: 'Graph not found' });
  res.json(r.rows[0]);
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
