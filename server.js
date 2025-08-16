// server.js
const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '.'))); // Serve static files like html

const CLIENT_ID = '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';
const client = new OAuth2Client(CLIENT_ID);
const SECRET = 'your_secret_key_change_this'; // Change in production

const pool = new Pool({
  connectionString: 'postgresql://flowpad_user:MAOwGkTa8Et6OqgPGgiv8VLrBFX1vBqE@dpg-d2gb69vdiees73dauq4g-a/flowpad',
});

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        name TEXT
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS graphs (
        id SERIAL PRIMARY KEY,
        owner_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        title TEXT,
        data JSONB
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS shares (
        graph_id INTEGER REFERENCES graphs(id) ON DELETE CASCADE,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (graph_id, user_id)
      );
    `);
    console.log('Database tables initialized');
  } catch (err) {
    console.error('Failed to initialize database:', err);
  }
}

initDb();

async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

app.post('/api/login', async (req, res) => {
  const { token } = req.body;
  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const email = payload.email;
    const name = payload.name;

    let result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      result = await pool.query('INSERT INTO users (email, name) VALUES ($1, $2) RETURNING *', [email, name]);
    }
    const user = result.rows[0];
    const jwtToken = jwt.sign({ id: user.id, email: user.email }, SECRET, { expiresIn: '1d' });
    res.json({ token: jwtToken });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: 'Invalid token' });
  }
});

app.get('/api/graphs', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  try {
    const result = await pool.query(`
      SELECT g.id, g.title, (g.owner_id = $1) AS is_owner
      FROM graphs g
      WHERE g.owner_id = $1
      UNION
      SELECT g.id, g.title, false AS is_owner
      FROM graphs g
      JOIN shares s ON s.graph_id = g.id
      WHERE s.user_id = $1
    `, [userId]);
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/graphs', authMiddleware, async (req, res) => {
  const { title } = req.body;
  const userId = req.user.id;
  try {
    const result = await pool.query(
      'INSERT INTO graphs (owner_id, title, data) VALUES ($1, $2, $3) RETURNING id',
      [userId, title || 'New Graph', '{}']
    );
    res.json({ id: result.rows[0].id });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.get('/api/graphs/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const graphId = req.params.id;
  try {
    const accessResult = await pool.query(`
      SELECT 1 FROM graphs WHERE id = $1 AND owner_id = $2
      UNION
      SELECT 1 FROM shares WHERE graph_id = $1 AND user_id = $2
    `, [graphId, userId]);
    if (accessResult.rows.length === 0) return res.status(403).json({ error: 'No access' });

    const result = await pool.query('SELECT title, data FROM graphs WHERE id = $1', [graphId]);
    res.json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.put('/api/graphs/:id', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const graphId = req.params.id;
  const { data, title } = req.body;
  try {
    const accessResult = await pool.query(`
      SELECT 1 FROM graphs WHERE id = $1 AND owner_id = $2
      UNION
      SELECT 1 FROM shares WHERE graph_id = $1 AND user_id = $2
    `, [graphId, userId]);
    if (accessResult.rows.length === 0) return res.status(403).json({ error: 'No access' });

    await pool.query('UPDATE graphs SET data = $1, title = $2 WHERE id = $3', [data, title, graphId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/graphs/:id/share', authMiddleware, async (req, res) => {
  const userId = req.user.id;
  const graphId = req.params.id;
  const { email } = req.body;
  try {
    const ownerResult = await pool.query('SELECT owner_id FROM graphs WHERE id = $1', [graphId]);
    if (ownerResult.rows.length === 0 || ownerResult.rows[0].owner_id !== userId) {
      return res.status(403).json({ error: 'Not owner' });
    }

    const targetResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (targetResult.rows.length === 0) return res.status(404).json({ error: 'User not found' });

    const targetId = targetResult.rows[0].id;
    await pool.query('INSERT INTO shares (graph_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [graphId, targetId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Serve HTML files
app.get('/index.html', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/graph.html', (req, res) => res.sendFile(path.join(__dirname, 'graph.html')));

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));