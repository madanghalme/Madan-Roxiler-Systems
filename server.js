
const express = require('express');
const bodyParser = require('body-parser');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');

const SECRET = process.env.JWT_SECRET || 'dev_secret_change_me';
const PORT = process.env.PORT || 3000;

const app = express();
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));

// Initialize DB
const DB_FILE = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(DB_FILE);

function runAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function getAsync(sql, params=[]) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

async function init() {
  // users: id, name, email, address, password_hash, role
  await runAsync(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT UNIQUE,
    address TEXT,
    password_hash TEXT,
    role TEXT
  );`);

  // stores: id, name, email, address, owner_id
  await runAsync(`CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT,
    address TEXT,
    owner_id INTEGER,
    FOREIGN KEY(owner_id) REFERENCES users(id)
  );`);

  // ratings: id, user_id, store_id, rating (1-5)
  await runAsync(`CREATE TABLE IF NOT EXISTS ratings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    store_id INTEGER,
    rating INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(store_id) REFERENCES stores(id)
  );`);

  // seed an admin and a store owner if not exists
  const admin = await getAsync("SELECT * FROM users WHERE email = ?", ['admin@gmail.com']);
  if (!admin) {
    const h = await bcrypt.hash('Admin@123!', 10);
    await runAsync("INSERT INTO users (name,email,address,password_hash,role) VALUES (?,?,?,?,?)",
      ['System Administrator', 'admin@gmail.com', 'HQ', h, 'admin']);
  }
  const owner = await getAsync("SELECT * FROM users WHERE email = ?", ['madan@.com']);
  if (!owner) {
    const h = await bcrypt.hash('madan@123!', 10);
    const res = await runAsync("INSERT INTO users (name,email,address,password_hash,role) VALUES (?,?,?,?,?)",
      ['Store Owner', 'madan@gmail.com', 'Shop Address', h, 'owner']);
    const ownerId = res.lastID;
    await runAsync("INSERT INTO stores (name,email,address,owner_id) VALUES (?,?,?,?)",
      [' Store','store@example.com','Demo Address', ownerId]);
  }
}

init().catch(err => console.error(err));

// --- Middleware: auth ---
function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({error:'Missing auth header'});
  const parts = header.split(' ');
  if (parts.length !== 2) return res.status(401).json({error:'Bad auth header'});
  const token = parts[1];
  try {
    const payload = jwt.verify(token, SECRET);
    req.user = payload;
    next();
  } catch(err) {
    return res.status(401).json({error:'Invalid token'});
  }
}

// --- Helpers: validations ---
function validatePassword(pw) {
  if (!pw) return false;
  return pw.length>=8 && pw.length<=16 && /[A-Z]/.test(pw) && /[^A-Za-z0-9]/.test(pw);
}

function validateName(name) {
  return typeof name === 'string' && name.length>=20 && name.length<=60;
}

function validateAddress(addr) {
  return typeof addr === 'string' && addr.length<=400;
}

// --- Auth routes ---
app.post('/api/signup', async (req,res) => {
  try {
    const {name,email,address,password} = req.body;
    if (!validateName(name)) return res.status(400).json({error:'Name must be 20-60 characters'});
    if (!validateAddress(address)) return res.status(400).json({error:'Address too long'});
    if (!validatePassword(password)) return res.status(400).json({error:'Password must be 8-16 chars, include uppercase and special char'});
    const hash = await bcrypt.hash(password, 10);
    await runAsync("INSERT INTO users (name,email,address,password_hash,role) VALUES (?,?,?,?,?)",
      [name,email,address,hash,'user']);
    return res.json({ok:true});
  } catch(err) {
    if (err && err.message && err.message.includes('UNIQUE constraint')) {
      return res.status(400).json({error:'Email already exists'});
    }
    console.error(err);
    return res.status(500).json({error:'Server error'});
  }
});

app.post('/api/login', async (req,res) => {
  const {email,password} = req.body;
  const user = await getAsync("SELECT * FROM users WHERE email = ?", [email]);
  if (!user) return res.status(400).json({error:'Invalid credentials'});
  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(400).json({error:'Invalid credentials'});
  const token = jwt.sign({id:user.id,role:user.role,email:user.email,name:user.name}, SECRET, {expiresIn:'7d'});
  return res.json({token});
});

app.post('/api/change-password', authMiddleware, async (req,res) => {
  const {oldPassword,newPassword} = req.body;
  const user = await getAsync("SELECT * FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.status(404).json({error:'User not found'});
  const ok = await bcrypt.compare(oldPassword, user.password_hash);
  if (!ok) return res.status(400).json({error:'Old password incorrect'});
  if (!validatePassword(newPassword)) return res.status(400).json({error:'New password invalid'});
  const hash = await bcrypt.hash(newPassword, 10);
  await runAsync("UPDATE users SET password_hash = ? WHERE id = ?", [hash, user.id]);
  return res.json({ok:true});
});

// --- Admin routes ---
function requireRole(role) {
  return (req,res,next) => {
    if (!req.user) return res.status(401).json({error:'Unauthorized'});
    if (req.user.role !== role && req.user.role !== 'admin') return res.status(403).json({error:'Forbidden'});
    next();
  }
}

// Add new store (admin)
app.post('/api/admin/stores', authMiddleware, requireRole('admin'), async (req,res) => {
  const {name,email,address,owner_id} = req.body;
  await runAsync("INSERT INTO stores (name,email,address,owner_id) VALUES (?,?,?,?)", [name,email,address,owner_id||null]);
  res.json({ok:true});
});

// Add new user (admin)
app.post('/api/admin/users', authMiddleware, requireRole('admin'), async (req,res) => {
  const {name,email,address,password,role} = req.body;
  if (!validateName(name)) return res.status(400).json({error:'Name must be 20-60 chars'});
  if (!validatePassword(password)) return res.status(400).json({error:'Password invalid'});
  const hash = await bcrypt.hash(password,10);
  await runAsync("INSERT INTO users (name,email,address,password_hash,role) VALUES (?,?,?,?,?)", [name,email,address,hash,role||'user']);
  res.json({ok:true});
});

// Admin dashboard counts
app.get('/api/admin/dashboard', authMiddleware, requireRole('admin'), async (req,res) => {
  const totalUsers = await getAsync("SELECT COUNT(*) as c FROM users");
  const totalStores = await getAsync("SELECT COUNT(*) as c FROM stores");
  const totalRatings = await getAsync("SELECT COUNT(*) as c FROM ratings");
  res.json({
    users: totalUsers.c,
    stores: totalStores.c,
    ratings: totalRatings.c
  });
});

// Lists with filtering and sorting (simple)
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req,res) => {
  const {q,sortBy,order='asc'} = req.query;
  let sql = "SELECT id,name,email,address,role FROM users";
  const params = [];
  if (q) { sql += " WHERE name LIKE ? OR email LIKE ? OR address LIKE ?"; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (sortBy) sql += ` ORDER BY ${sortBy} ${order.toUpperCase()}`;
  const rows = await allAsync(sql, params);
  res.json(rows);
});

app.get('/api/admin/stores', authMiddleware, requireRole('admin'), async (req,res) => {
  const {q,sortBy,order='asc'} = req.query;
  let sql = `SELECT s.id,s.name,s.email,s.address, IFNULL(AVG(r.rating),0) as rating
             FROM stores s LEFT JOIN ratings r ON s.id = r.store_id`;
  const params = [];
  if (q) { sql += " WHERE s.name LIKE ? OR s.email LIKE ? OR s.address LIKE ?"; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += " GROUP BY s.id";
  if (sortBy) sql += ` ORDER BY ${sortBy} ${order.toUpperCase()}`;
  const rows = await allAsync(sql, params);
  res.json(rows);
});

// Admin view user details
app.get('/api/admin/users/:id', authMiddleware, requireRole('admin'), async (req,res) => {
  const id = req.params.id;
  const user = await getAsync("SELECT id,name,email,address,role FROM users WHERE id = ?", [id]);
  if (!user) return res.status(404).json({error:'Not found'});
  if (user.role === 'owner') {
    // compute rating for their stores
    const r = await getAsync(`SELECT AVG(rating) as avg FROM ratings WHERE store_id IN (SELECT id FROM stores WHERE owner_id = ?)`, [id]);
    user.rating = r.avg || 0;
  }
  res.json(user);
});

// --- Store listing & ratings for normal users ---
app.get('/api/stores', authMiddleware, async (req,res) => {
  const {q,sortBy,order='asc'} = req.query;
  let sql = `SELECT s.id,s.name,s.address, IFNULL(AVG(r.rating),0) as overallRating,
             (SELECT rating FROM ratings r2 WHERE r2.store_id = s.id AND r2.user_id = ?) as yourRating
             FROM stores s LEFT JOIN ratings r ON s.id = r.store_id GROUP BY s.id`;
  const rows = await allAsync(sql, [req.user.id]);
  res.json(rows);
});

// Submit or modify a rating
app.post('/api/stores/:id/rate', authMiddleware, async (req,res) => {
  const storeId = req.params.id;
  const {rating} = req.body;
  if (![1,2,3,4,5].includes(Number(rating))) return res.status(400).json({error:'Rating must be 1-5'});
  const existing = await getAsync("SELECT * FROM ratings WHERE user_id = ? AND store_id = ?", [req.user.id, storeId]);
  if (existing) {
    await runAsync("UPDATE ratings SET rating = ?, created_at = CURRENT_TIMESTAMP WHERE id = ?", [rating, existing.id]);
  } else {
    await runAsync("INSERT INTO ratings (user_id,store_id,rating) VALUES (?,?,?)", [req.user.id, storeId, rating]);
  }
  res.json({ok:true});
});

// Store owner dashboard: list users who rated their store and average rating
app.get('/api/owner/dashboard', authMiddleware, async (req,res) => {
  // allow owner or admin
  if (req.user.role !== 'owner' && req.user.role !== 'admin') return res.status(403).json({error:'Forbidden'});
  const stores = await allAsync("SELECT id,name FROM stores WHERE owner_id = ?", [req.user.id]);
  const out = [];
  for (const s of stores) {
    const users = await allAsync(`SELECT u.id,u.name,u.email,r.rating FROM ratings r JOIN users u ON r.user_id = u.id WHERE r.store_id = ?`, [s.id]);
    const avgRow = await getAsync("SELECT AVG(rating) as avg FROM ratings WHERE store_id = ?", [s.id]);
    out.push({store: s, ratings: users, average: avgRow.avg || 0});
  }
  res.json(out);
});

// Simple public info endpoint
app.get('/api/me', authMiddleware, async (req,res) => {
  const u = await getAsync("SELECT id,name,email,address,role FROM users WHERE id = ?", [req.user.id]);
  res.json(u);
});

// Fallback - serve frontend
app.get('*', (req,res) => {
  res.sendFile(path.join(__dirname, 'public','index.html'));
});

app.listen(PORT, () => {
  console.log("Server running on port", PORT);
  console.log("Seed admin: admin@gmail.com / Admin@123!");
  console.log("Seed owner: madan@gmail.com / madan@123");
});
