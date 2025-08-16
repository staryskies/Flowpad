// server.js
const express = require('express');
const { Pool } = require('pg');
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');

const app = express();

// Load environment variables
require('dotenv').config();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// PostgreSQL connection
let pool;
try {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://flowpad_user:MAOwGkTa8Et6OqgPGgiv8VLrBFX1vBqE@dpg-d2gb69vdiees73dauq4g-a/flowpad',
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
    idleTimeoutMillis: 30000,
    max: 1 // Limit connections for serverless
  });
} catch (error) {
  console.error('Failed to create database pool:', error);
}

// Google OAuth client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID || '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');

// JWT secret
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';

// Initialize database tables
async function initDatabase() {
  if (!pool) {
    console.error('Database pool not available');
    return;
  }

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        google_id VARCHAR(255) UNIQUE NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS graphs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id),
        title VARCHAR(255) NOT NULL,
        data JSONB NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS graph_shares (
        id SERIAL PRIMARY KEY,
        graph_id INTEGER REFERENCES graphs(id),
        shared_with_email VARCHAR(255) NOT NULL,
        shared_by_user_id INTEGER REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Database initialization error:', error);
  }
}

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  if (!pool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    const result = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    
    req.user = result.rows[0];
    next();
  } catch (error) {
    return res.status(403).json({ error: 'Invalid token' });
  }
};

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    database: pool ? 'connected' : 'disconnected',
    environment: process.env.NODE_ENV || 'development',
    version: '1.0.0'
  });
});

// Test endpoint for Vercel
app.get('/api/test', (req, res) => {
  res.json({ 
    message: 'Flowpad API is working!',
    timestamp: new Date().toISOString()
  });
});

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/graph', (req, res) => {
  res.sendFile(path.join(__dirname, 'graph.html'));
});

// Google authentication
app.post('/api/auth/google', async (req, res) => {
  if (!pool) {
    return res.status(500).json({ error: 'Database connection not available' });
  }

  try {
    const { idToken } = req.body;
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID || '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'
    });

    const payload = ticket.getPayload();
    const { sub: googleId, email, name } = payload;

    // Check if user exists
    let result = await pool.query('SELECT * FROM users WHERE google_id = $1', [googleId]);
    
    if (result.rows.length === 0) {
      // Create new user
      result = await pool.query(
        'INSERT INTO users (google_id, email, name) VALUES ($1, $2, $3) RETURNING *',
        [googleId, email, name]
      );
    }

    const user = result.rows[0];
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({ token, user: { id: user.id, email: user.email, name: user.name } });
  } catch (error) {
    console.error('Google auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Get user's graphs
app.get('/api/graphs', authenticateToken, async (req, res) => {
  try {
    // Get user's own graphs
    const ownGraphs = await pool.query(
      'SELECT * FROM graphs WHERE user_id = $1 ORDER BY updated_at DESC',
      [req.user.id]
    );

    // Get shared graphs
    const sharedGraphs = await pool.query(`
      SELECT g.*, u.name as owner_name 
      FROM graphs g 
      JOIN users u ON g.user_id = u.id 
      JOIN graph_shares gs ON g.id = gs.graph_id 
      WHERE gs.shared_with_email = $1
      ORDER BY g.updated_at DESC
    `, [req.user.email]);

    res.json({
      own: ownGraphs.rows,
      shared: sharedGraphs.rows
    });
  } catch (error) {
    console.error('Get graphs error:', error);
    res.status(500).json({ error: 'Failed to fetch graphs' });
  }
});

// Create new graph
app.post('/api/graphs', authenticateToken, async (req, res) => {
  try {
    const { title, data } = req.body;
    const result = await pool.query(
      'INSERT INTO graphs (user_id, title, data) VALUES ($1, $2, $3) RETURNING *',
      [req.user.id, title, data]
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Create graph error:', error);
    res.status(500).json({ error: 'Failed to create graph' });
  }
});

// Update graph
app.put('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { title, data } = req.body;
    
    const result = await pool.query(
      'UPDATE graphs SET title = $1, data = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3 AND user_id = $4 RETURNING *',
      [title, data, id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found or access denied' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Update graph error:', error);
    res.status(500).json({ error: 'Failed to update graph' });
  }
});

// Share graph
app.post('/api/graphs/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { email } = req.body;

    // Check if graph exists and user owns it
    const graphCheck = await pool.query(
      'SELECT * FROM graphs WHERE id = $1 AND user_id = $2',
      [id, req.user.id]
    );

    if (graphCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found or access denied' });
    }

    // Check if already shared
    const existingShare = await pool.query(
      'SELECT * FROM graph_shares WHERE graph_id = $1 AND shared_with_email = $2',
      [id, email]
    );

    if (existingShare.rows.length > 0) {
      return res.status(400).json({ error: 'Graph already shared with this user' });
    }

    // Create share
    await pool.query(
      'INSERT INTO graph_shares (graph_id, shared_with_email, shared_by_user_id) VALUES ($1, $2, $3)',
      [id, email, req.user.id]
    );

    res.json({ message: 'Graph shared successfully' });
  } catch (error) {
    console.error('Share graph error:', error);
    res.status(500).json({ error: 'Failed to share graph' });
  }
});

// Get graph by ID
app.get('/api/graphs/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user owns the graph or has access through sharing
    const result = await pool.query(`
      SELECT g.* FROM graphs g 
      LEFT JOIN graph_shares gs ON g.id = gs.graph_id 
      WHERE g.id = $1 AND (g.user_id = $2 OR gs.shared_with_email = $3)
    `, [id, req.user.id, req.user.email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Graph not found or access denied' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Get graph error:', error);
    res.status(500).json({ error: 'Failed to fetch graph' });
  }
});

// Initialize database on first request
let dbInitialized = false;
app.use(async (req, res, next) => {
  if (!dbInitialized && pool) {
    try {
      await initDatabase();
      dbInitialized = true;
    } catch (error) {
      console.error('Failed to initialize database:', error);
    }
  }
  next();
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Unhandled error:', error);
  res.status(500).json({ error: 'Internal server error' });
});

// For local development only
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

module.exports = app;