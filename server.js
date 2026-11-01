const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;
const uploadDir = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use('/uploads', express.static(uploadDir, { maxAge: '7d' }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(session({
  store: new PgSession({ pool, tableName: 'user_sessions', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'replace-this-secret-before-deploying',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadDir),
  filename: (_, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${path.extname(file.originalname).toLowerCase()}`)
});
const avatarUpload = multer({
  storage, limits: { fileSize: 2 * 1024 * 1024 },
  fileFilter: (_, file, cb) => cb(null, ['image/png','image/jpeg','image/webp','image/gif'].includes(file.mimetype))
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY, username VARCHAR(24) UNIQUE NOT NULL,
      display_name VARCHAR(32) NOT NULL, password_hash TEXT NOT NULL,
      avatar TEXT, is_admin BOOLEAN DEFAULT FALSE, created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title VARCHAR(120) NOT NULL, body TEXT NOT NULL, tags TEXT[] DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS announcements (
      id SERIAL PRIMARY KEY, message VARCHAR(500) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS posts_created_idx ON posts(created_at DESC);
  `);
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD) {
    const username = process.env.ADMIN_USERNAME.trim().toLowerCase();
    const hash = await bcrypt.hash(process.env.ADMIN_PASSWORD, 12);
    await pool.query(
      `INSERT INTO users(username, display_name, password_hash, is_admin)
       VALUES($1, $1, $2, TRUE)
       ON CONFLICT(username) DO UPDATE SET is_admin=TRUE`,
      [username, hash]
    );
  }
}

const clean = (v, max) => String(v || '').trim().slice(0, max);
const publicUser = u => ({ id: u.id, username: u.username, displayName: u.display_name, avatar: u.avatar, isAdmin: u.is_admin });
function requireAuth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: 'Please sign in first.' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.user?.isAdmin) return res.status(403).json({ error: 'Admin access required.' });
  next();
}

app.get('/api/health', (_, res) => res.json({ ok: true }));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));
app.post('/api/register', authLimiter, async (req, res) => {
  try {
    const username = clean(req.body.username, 24).toLowerCase();
    const displayName = clean(req.body.displayName || username, 32);
    const password = String(req.body.password || '');
    if (!/^[a-z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3–24 characters: letters, numbers or underscores.' });
    if (password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Password must be 8–72 characters.' });
    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users(username, display_name, password_hash) VALUES($1,$2,$3) RETURNING *',
      [username, displayName || username, hash]
    );
    req.session.user = publicUser(result.rows[0]);
    res.json({ user: req.session.user });
  } catch (e) {
    res.status(e.code === '23505' ? 409 : 500).json({ error: e.code === '23505' ? 'That username is already taken.' : 'Could not create account.' });
  }
});
app.post('/api/login', authLimiter, async (req, res) => {
  const username = clean(req.body.username, 24).toLowerCase();
  const result = await pool.query('SELECT * FROM users WHERE username=$1', [username]);
  const user = result.rows[0];
  if (!user || !(await bcrypt.compare(String(req.body.password || ''), user.password_hash)))
    return res.status(401).json({ error: 'Incorrect username or password.' });
  req.session.user = publicUser(user);
  res.json({ user: req.session.user });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));

app.patch('/api/profile', requireAuth, async (req, res) => {
  const displayName = clean(req.body.displayName, 32);
  if (!displayName) return res.status(400).json({ error: 'Display name cannot be empty.' });
  const result = await pool.query('UPDATE users SET display_name=$1 WHERE id=$2 RETURNING *', [displayName, req.session.user.id]);
  req.session.user = publicUser(result.rows[0]);
  res.json({ user: req.session.user });
});
app.post('/api/profile/avatar', requireAuth, avatarUpload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PNG, JPG, WEBP or GIF image (max 2 MB).' });
  const avatar = `/uploads/${req.file.filename}`;
  const result = await pool.query('UPDATE users SET avatar=$1 WHERE id=$2 RETURNING *', [avatar, req.session.user.id]);
  req.session.user = publicUser(result.rows[0]);
  res.json({ user: req.session.user });
});

app.get('/api/posts', async (req, res) => {
  const q = clean(req.query.q, 100);
  const tag = clean(req.query.tag, 30);
  const params = [];
  let where = '';
  if (q) { params.push(`%${q}%`); where += ` WHERE (p.title ILIKE $${params.length} OR p.body ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.username ILIKE $${params.length} OR array_to_string(p.tags, ' ') ILIKE $${params.length})`; }
  if (tag) { params.push(tag); where += `${where ? ' AND' : ' WHERE'} $${params.length} = ANY(p.tags)`; }
  const result = await pool.query(
    `SELECT p.id,p.title,p.body,p.tags,p.created_at,u.id AS author_id,u.username,u.display_name,u.avatar
     FROM posts p JOIN users u ON u.id=p.user_id${where} ORDER BY p.created_at DESC LIMIT 100`, params
  );
  res.json({ posts: result.rows });
});
app.post('/api/posts', requireAuth, async (req, res) => {
  const title = clean(req.body.title, 120);
  const body = clean(req.body.body, 8000);
  const tags = [...new Set((Array.isArray(req.body.tags) ? req.body.tags : String(req.body.tags || '').split(','))
    .map(t => clean(t, 24).toLowerCase().replace(/[^a-z0-9-]/g, '')).filter(Boolean))].slice(0, 5);
  if (title.length < 3 || body.length < 3) return res.status(400).json({ error: 'Title and post content must each have at least 3 characters.' });
  const result = await pool.query('INSERT INTO posts(user_id,title,body,tags) VALUES($1,$2,$3,$4) RETURNING id', [req.session.user.id,title,body,tags]);
  res.json({ id: result.rows[0].id });
});
app.get('/api/announcements/latest', async (_, res) => {
  const result = await pool.query('SELECT id,message,created_at FROM announcements ORDER BY id DESC LIMIT 1');
  res.json({ announcement: result.rows[0] || null });
});
app.post('/api/announcements', requireAuth, requireAdmin, async (req, res) => {
  const message = clean(req.body.message, 500);
  if (!message) return res.status(400).json({ error: 'Announcement cannot be empty.' });
  const result = await pool.query('INSERT INTO announcements(message) VALUES($1) RETURNING id,message,created_at', [message]);
  res.json({ announcement: result.rows[0] });
});
app.get('/api/users', async (req, res) => {
  const q = clean(req.query.q, 60);
  if (!q) return res.json({ users: [] });
  const result = await pool.query(
    `SELECT id,username,display_name,avatar FROM users
     WHERE username ILIKE $1 OR display_name ILIKE $1
     ORDER BY username LIMIT 20`, [`%${q}%`]);
  res.json({ users: result.rows });
});

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'Image upload failed. Maximum size is 2 MB.' });
  res.status(500).json({ error: 'Something went wrong.' });
});

initDb().then(() => app.listen(PORT, () => console.log(`Better16 Wiki running on ${PORT}`)))
  .catch(err => { console.error('Database initialization failed:', err); process.exit(1); });
