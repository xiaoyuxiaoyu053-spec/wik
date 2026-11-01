'use strict';

const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL;
const SESSION_SECRET = process.env.SESSION_SECRET;

if (process.env.NODE_ENV === 'production' && !DATABASE_URL) {
  console.error('ERROR: DATABASE_URL is missing. Add your Render PostgreSQL Internal Database URL.');
  process.exit(1);
}

if (process.env.NODE_ENV === 'production' && !SESSION_SECRET) {
  console.error('ERROR: SESSION_SECRET is missing. Set a long random secret in Render environment variables.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL || 'postgresql://localhost:5432/better16',
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
  max: 10
});

const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '2mb' }));

app.use(session({
  store: new PgSession({
    pool,
    tableName: 'session',
    createTableIfMissing: true
  }),
  secret: SESSION_SECRET || 'development-only-change-this-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000
  }
}));

app.use('/uploads', express.static(uploadDir));
app.use(express.static(path.join(__dirname, 'public')));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase().slice(0, 10);
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) {
      return cb(new Error('Only PNG, JPG, WEBP and GIF images are allowed.'));
    }
    cb(null, true);
  }
});

function cleanText(value, max = 500) {
  return String(value || '').trim().slice(0, max);
}

function getIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded
    ? String(forwarded).split(',')[0].trim()
    : req.socket.remoteAddress || '';
  return ip.slice(0, 100);
}

function asyncRoute(fn) {
  return (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);
}

async function hasColumn(table, column) {
  const result = await pool.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name = $1
       AND column_name = $2`,
    [table, column]
  );
  return result.rowCount > 0;
}

async function addColumn(table, column, definition) {
  if (!await hasColumn(table, column)) {
    await pool.query(`ALTER TABLE "${table}" ADD COLUMN "${column}" ${definition}`);
    console.log(`Database migration: added ${table}.${column}`);
  }
}

async function initDb() {
  console.log('Checking PostgreSQL database...');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username VARCHAR(40) UNIQUE,
      password_hash TEXT,
      display_name VARCHAR(60),
      avatar TEXT,
      bio TEXT,
      role VARCHAR(20) DEFAULT 'user',
      is_banned BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Automatically repair older users tables.
  await addColumn('users', 'username', 'VARCHAR(40)');
  await addColumn('users', 'password_hash', 'TEXT');
  await addColumn('users', 'display_name', 'VARCHAR(60)');
  await addColumn('users', 'avatar', 'TEXT');
  await addColumn('users', 'bio', 'TEXT');
  await addColumn('users', 'role', "VARCHAR(20) DEFAULT 'user'");
  await addColumn('users', 'is_banned', 'BOOLEAN DEFAULT FALSE');
  await addColumn('users', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()');

  await pool.query(`
    UPDATE users
    SET display_name = username
    WHERE display_name IS NULL OR display_name = ''
  `);

  await pool.query(`
    UPDATE users
    SET role = 'user'
    WHERE role IS NULL OR role = ''
  `);

  await pool.query(`
    UPDATE users
    SET is_banned = FALSE
    WHERE is_banned IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title VARCHAR(160),
      content TEXT,
      tags TEXT[] DEFAULT '{}',
      image TEXT,
      is_official BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  // Automatically repair older posts tables.
  await addColumn('posts', 'user_id', 'INTEGER');
  await addColumn('posts', 'title', 'VARCHAR(160)');
  await addColumn('posts', 'content', 'TEXT');
  await addColumn('posts', 'tags', "TEXT[] DEFAULT '{}'");
  await addColumn('posts', 'image', 'TEXT');
  await addColumn('posts', 'is_official', 'BOOLEAN DEFAULT FALSE');
  await addColumn('posts', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()');

  await pool.query(`
    UPDATE posts SET tags = '{}' WHERE tags IS NULL
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY,
      title VARCHAR(160),
      content TEXT,
      active BOOLEAN DEFAULT TRUE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await addColumn('announcements', 'title', 'VARCHAR(160)');
  await addColumn('announcements', 'content', 'TEXT');
  await addColumn('announcements', 'active', 'BOOLEAN DEFAULT TRUE');
  await addColumn('announcements', 'created_at', 'TIMESTAMPTZ DEFAULT NOW()');

  await pool.query(`
    CREATE TABLE IF NOT EXISTS banned_ips (
      id SERIAL PRIMARY KEY,
      ip VARCHAR(100) UNIQUE,
      reason TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT
    )
  `);

  await pool.query(`
    INSERT INTO site_settings (key, value)
    VALUES ('maintenance', 'false')
    ON CONFLICT (key) DO NOTHING
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS posts_created_at_idx
    ON posts (created_at DESC)
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS posts_user_id_idx
    ON posts (user_id)
  `);

  console.log('Database ready. Existing data has been preserved.');
}

async function getUser(userId) {
  const result = await pool.query(
    `SELECT id, username, display_name, avatar, bio, role, is_banned, created_at
     FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function requireLogin(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Please log in first.' });
  }

  const user = await getUser(req.session.userId);

  if (!user || user.is_banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'This account is unavailable.' });
  }

  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  await requireLogin(req, res, async () => {
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Administrator access required.' });
    }
    next();
  });
}

const maintenanceExempt = [
  '/api/health',
  '/api/auth/login',
  '/api/auth/register'
];

app.use(asyncRoute(async (req, res, next) => {
  if (!req.path.startsWith('/api/') || maintenanceExempt.includes(req.path)) {
    return next();
  }

  const setting = await pool.query(
    `SELECT value FROM site_settings WHERE key = 'maintenance'`
  );

  if (setting.rows[0]?.value === 'true') {
    return res.status(503).json({
      error: 'The website is currently under maintenance.'
    });
  }

  next();
}));

app.use(asyncRoute(async (req, res, next) => {
  const ip = getIp(req);
  const result = await pool.query(
    'SELECT id FROM banned_ips WHERE ip = $1',
    [ip]
  );

  if (result.rowCount) {
    return res.status(403).json({ error: 'Access denied.' });
  }

  next();
}));

// Health check
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'Better16 Community Wiki' });
});

// Register
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const username = cleanText(req.body.username, 40);
  const password = String(req.body.password || '');
  const displayName = cleanText(req.body.display_name || username, 60);

  if (!/^[a-zA-Z0-9_]{3,40}$/.test(username)) {
    return res.status(400).json({
      error: 'Username must be 3-40 characters and use letters, numbers or underscores.'
    });
  }

  if (password.length < 8 || password.length > 200) {
    return res.status(400).json({
      error: 'Password must be at least 8 characters.'
    });
  }

  const existing = await pool.query(
    'SELECT id FROM users WHERE LOWER(username) = LOWER($1)',
    [username]
  );

  if (existing.rowCount) {
    return res.status(409).json({ error: 'Username already exists.' });
  }

  const hash = await bcrypt.hash(password, 12);

  const result = await pool.query(
    `INSERT INTO users (username, password_hash, display_name)
     VALUES ($1, $2, $3)
     RETURNING id, username, display_name, avatar, bio, role`,
    [username, hash, displayName]
  );

  req.session.userId = result.rows[0].id;
  res.json({ user: result.rows[0] });
}));

// Login
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const username = cleanText(req.body.username, 40);
  const password = String(req.body.password || '');

  const result = await pool.query(
    `SELECT * FROM users
     WHERE LOWER(username) = LOWER($1)`,
    [username]
  );

  const user = result.rows[0];

  if (!user || !user.password_hash ||
      !await bcrypt.compare(password, user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect username or password.' });
  }

  if (user.is_banned) {
    return res.status(403).json({ error: 'This account has been banned.' });
  }

  req.session.regenerate(err => {
    if (err) {
      return res.status(500).json({ error: 'Could not start session.' });
    }

    req.session.userId = user.id;

    res.json({
      user: {
        id: user.id,
        username: user.username,
        display_name: user.display_name,
        avatar: user.avatar,
        bio: user.bio,
        role: user.role
      }
    });
  });
}));

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ success: true });
  });
});

// Current user
app.get('/api/me', requireLogin, (req, res) => {
  res.json({ user: req.user });
});

// Update profile
app.put('/api/profile', requireLogin, asyncRoute(async (req, res) => {
  const displayName = cleanText(req.body.display_name, 60);
  const bio = cleanText(req.body.bio, 300);

  if (!displayName) {
    return res.status(400).json({ error: 'Display name is required.' });
  }

  const result = await pool.query(
    `UPDATE users
     SET display_name = $1, bio = $2
     WHERE id = $3
     RETURNING id, username, display_name, avatar, bio, role`,
    [displayName, bio, req.user.id]
  );

  res.json({ user: result.rows[0] });
}));

// Upload avatar
app.post('/api/profile/avatar', requireLogin, upload.single('avatar'),
  asyncRoute(async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: 'Please select an image.' });
    }

    const avatar = '/uploads/' + req.file.filename;

    const result = await pool.query(
      `UPDATE users SET avatar = $1
       WHERE id = $2
       RETURNING id, username, display_name, avatar, bio`,
      [avatar, req.user.id]
    );

    res.json({ user: result.rows[0] });
  })
);

// List posts
app.get('/api/posts', asyncRoute(async (req, res) => {
  const result = await pool.query(`
    SELECT
      p.id, p.user_id, p.title, p.content, p.tags, p.image,
      p.is_official, p.created_at,
      u.username, u.display_name, u.avatar
    FROM posts p
    LEFT JOIN users u ON u.id = p.user_id
    ORDER BY p.is_official DESC, p.created_at DESC
    LIMIT 100
  `);

  res.json({ posts: result.rows });
}));

// Create post
app.post('/api/posts', requireLogin, asyncRoute(async (req, res) => {
  const title = cleanText(req.body.title, 160);
  const content = cleanText(req.body.content, 10000);
  const tags = Array.isArray(req.body.tags)
    ? req.body.tags.map(t => cleanText(t, 30)).filter(Boolean).slice(0, 10)
    : [];

  if (!content) {
    return res.status(400).json({ error: 'Post content is required.' });
  }

  const result = await pool.query(
    `INSERT INTO posts (user_id, title, content, tags)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [req.user.id, title, content, tags]
  );

  res.json({ post: result.rows[0] });
}));

// Delete own post
app.delete('/api/posts/:id', requireLogin, asyncRoute(async (req, res) => {
  const postId = Number(req.params.id);

  if (!Number.isInteger(postId)) {
    return res.status(400).json({ error: 'Invalid post ID.' });
  }

  const result = await pool.query(
    `DELETE FROM posts
     WHERE id = $1 AND user_id = $2
     RETURNING id`,
    [postId, req.user.id]
  );

  if (!result.rowCount) {
    return res.status(404).json({ error: 'Post not found.' });
  }

  res.json({ success: true });
}));

// Active announcement
app.get('/api/announcement', asyncRoute(async (_req, res) => {
  const result = await pool.query(
    `SELECT id, title, content, created_at
     FROM announcements
     WHERE active = TRUE
     ORDER BY created_at DESC
     LIMIT 1`
  );

  res.json({ announcement: result.rows[0] || null });
}));

// Admin: dashboard summary
app.get('/api/admin/stats', requireAdmin, asyncRoute(async (_req, res) => {
  const [users, posts, banned, announcement] = await Promise.all([
    pool.query('SELECT COUNT(*)::int AS count FROM users'),
    pool.query('SELECT COUNT(*)::int AS count FROM posts'),
    pool.query('SELECT COUNT(*)::int AS count FROM users WHERE is_banned = TRUE'),
    pool.query(`SELECT value FROM site_settings WHERE key = 'maintenance'`)
  ]);

  res.json({
    users: users.rows[0].count,
    posts: posts.rows[0].count,
    bannedUsers: banned.rows[0].count,
    maintenance: announcement.rows[0]?.value === 'true'
  });
}));

// Admin: create announcement
app.post('/api/admin/announcement', requireAdmin,
  asyncRoute(async (req, res) => {
    const title = cleanText(req.body.title, 160);
    const content = cleanText(req.body.content, 5000);

    if (!content) {
      return res.status(400).json({ error: 'Announcement content is required.' });
    }

    await pool.query('UPDATE announcements SET active = FALSE');

    const result = await pool.query(
      `INSERT INTO announcements (title, content, active)
       VALUES ($1, $2, TRUE)
       RETURNING *`,
      [title, content]
    );

    res.json({ announcement: result.rows[0] });
  })
);

// Admin: remove announcement
app.delete('/api/admin/announcement', requireAdmin,
  asyncRoute(async (_req, res) => {
    await pool.query('UPDATE announcements SET active = FALSE');
    res.json({ success: true });
  })
);

// Admin: publish official post
app.post('/api/admin/posts', requireAdmin,
  asyncRoute(async (req, res) => {
    const title = cleanText(req.body.title, 160);
    const content = cleanText(req.body.content, 10000);
    const tags = Array.isArray(req.body.tags)
      ? req.body.tags.map(t => cleanText(t, 30)).filter(Boolean).slice(0, 10)
      : [];

    if (!content) {
      return res.status(400).json({ error: 'Post content is required.' });
    }

    const result = await pool.query(
      `INSERT INTO posts (user_id, title, content, tags, is_official)
       VALUES ($1, $2, $3, $4, TRUE)
       RETURNING *`,
      [req.user.id, title, content, tags]
    );

    res.json({ post: result.rows[0] });
  })
);

// Admin: delete any post
app.delete('/api/admin/posts/:id', requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    const result = await pool.query(
      'DELETE FROM posts WHERE id = $1 RETURNING id',
      [id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'Post not found.' });
    }

    res.json({ success: true });
  })
);

// Admin: ban or unban account
app.post('/api/admin/users/:id/ban', requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    if (id === req.user.id) {
      return res.status(400).json({ error: 'You cannot ban yourself.' });
    }

    const banned = req.body.banned !== false;

    const result = await pool.query(
      `UPDATE users SET is_banned = $1
       WHERE id = $2
       RETURNING id, username, display_name, is_banned`,
      [banned, id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: result.rows[0] });
  })
);

// Admin: ban IP
app.post('/api/admin/ip-ban', requireAdmin,
  asyncRoute(async (req, res) => {
    const ip = cleanText(req.body.ip, 100);
    const reason = cleanText(req.body.reason, 500);

    if (!ip) {
      return res.status(400).json({ error: 'IP address is required.' });
    }

    await pool.query(
      `INSERT INTO banned_ips (ip, reason)
       VALUES ($1, $2)
       ON CONFLICT (ip) DO UPDATE SET reason = EXCLUDED.reason`,
      [ip, reason]
    );

    res.json({ success: true });
  })
);

// Admin: remove IP ban
app.delete('/api/admin/ip-ban/:ip', requireAdmin,
  asyncRoute(async (req, res) => {
    await pool.query(
      'DELETE FROM banned_ips WHERE ip = $1',
      [cleanText(req.params.ip, 100)]
    );

    res.json({ success: true });
  })
);

// Admin: maintenance mode
app.post('/api/admin/maintenance', requireAdmin,
  asyncRoute(async (req, res) => {
    const enabled = req.body.enabled === true;

    await pool.query(
      `INSERT INTO site_settings (key, value)
       VALUES ('maintenance', $1)
       ON CONFLICT (key)
       DO UPDATE SET value = EXCLUDED.value`,
      [enabled ? 'true' : 'false']
    );

    res.json({ maintenance: enabled });
  })
);

// Admin: list users
app.get('/api/admin/users', requireAdmin,
  asyncRoute(async (_req, res) => {
    const result = await pool.query(`
      SELECT id, username, display_name, role, is_banned, created_at
      FROM users
      ORDER BY created_at DESC
      LIMIT 200
    `);

    res.json({ users: result.rows });
  })
);

// Admin: promote a user to admin
app.post('/api/admin/users/:id/admin', requireAdmin,
  asyncRoute(async (req, res) => {
    const id = Number(req.params.id);

    const result = await pool.query(
      `UPDATE users SET role = $1
       WHERE id = $2
       RETURNING id, username, role`,
      [req.body.admin === true ? 'admin' : 'user', id]
    );

    if (!result.rowCount) {
      return res.status(404).json({ error: 'User not found.' });
    }

    res.json({ user: result.rows[0] });
  })
);

// Unknown API route
app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'API endpoint not found.' });
});

// Frontend fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error(err);

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: 'Image upload failed: ' + err.message });
  }

  res.status(500).json({
    error: process.env.NODE_ENV === 'production'
      ? 'Internal server error.'
      : err.message
  });
});

initDb()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Better16 Community Wiki running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error('Database initialization failed:', err);
    process.exit(1);
  });
