// N1 STORE — zero-dependency Node server (Node 18+).
// Storefront + staff dashboard API + Stripe Checkout (Apple Pay & cards).
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CURRENCY = (process.env.CURRENCY || 'aed').toLowerCase();
const DEMO = !STRIPE_KEY; // no Stripe key = demo mode, orders are marked paid instantly

const PUBLIC = path.join(__dirname, 'public');
const DB_FILE = path.join(__dirname, 'data', 'db.json');

// ---------- tiny JSON database ----------
function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { products: seedProducts(), orders: [] }; }
}
let db = loadDb();
function saveDb() {
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function seedProducts() {
  const mk = (name, category, price, description) => ({
    id: crypto.randomUUID(), name, category, price, description, image: '', active: true, createdAt: Date.now(),
  });
  return [
    mk('Streaming Premium — 1 Month', 'Subscriptions', 29, 'Full-HD streaming on 4 screens. Delivered to your email within minutes.'),
    mk('Music Plus — 3 Months', 'Subscriptions', 55, 'Ad-free music and offline downloads. Works worldwide.'),
    mk('Game Credit Card — 100 AED', 'Gift Cards', 105, 'Digital code for your console or PC store wallet.'),
    mk('App Store Card — 50 AED', 'Gift Cards', 52, 'Redeemable code for apps, games and in-app purchases.'),
    mk('Antivirus Pro — 1 Year', 'Software', 79, 'Licence key for 3 devices with real-time protection.'),
    mk('Design Suite — Student Licence', 'Software', 149, 'Annual licence key. Proof of enrolment required.'),
    mk('Web Development Bootcamp', 'Courses', 199, '40 hours of video lessons with lifetime access.'),
    mk('English Fluency Course', 'Courses', 89, 'Self-paced course with speaking practice and certificates.'),
  ];
}
if (!fs.existsSync(DB_FILE)) saveDb();

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
function send(res, status, body, headers = {}) {
  const isObj = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isObj ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  try { return JSON.parse(raw.toString('utf8') || '{}'); } catch { return {}; }
}
const money = n => Math.round(Number(n) * 100) / 100;
const clean = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const validEmail = e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 160;

// ---------- staff sessions ----------
const sessions = new Map(); // token -> expiry
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => { const i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); });
  return out;
}
function isStaff(req) {
  const t = parseCookies(req).n1_staff;
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
const loginAttempts = new Map(); // ip -> {n, reset}
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// ---------- Stripe (REST, no SDK) ----------
async function stripe(method, endpoint, form) {
  const res = await fetch('https://api.stripe.com/v1' + endpoint, {
    method,
    headers: { Authorization: `Bearer ${STRIPE_KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form ? new URLSearchParams(form).toString() : undefined,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || 'Stripe error');
  return data;
}
function markPaid(order, extra = {}) {
  if (order.status === 'pending') {
    order.status = 'paid';
    order.paidAt = Date.now();
    Object.assign(order, extra);
    saveDb();
  }
}

// ---------- API ----------
async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;

  if (p === '/api/config' && m === 'GET') return send(res, 200, { currency: CURRENCY.toUpperCase(), demo: DEMO });

  if (p === '/api/products' && m === 'GET')
    return send(res, 200, db.products.filter(x => x.active !== false).sort((a, b) => b.createdAt - a.createdAt));

  // --- checkout ---
  if (p === '/api/checkout' && m === 'POST') {
    const body = await readJson(req);
    const email = clean(body.email, 160).toLowerCase();
    const name = clean(body.name, 80);
    if (!validEmail(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (!name) return send(res, 400, { error: 'Enter your name.' });
    const items = [];
    for (const it of Array.isArray(body.items) ? body.items.slice(0, 30) : []) {
      const prod = db.products.find(x => x.id === it.id && x.active !== false);
      const qty = Math.min(Math.max(parseInt(it.qty, 10) || 0, 0), 20);
      if (prod && qty) items.push({ id: prod.id, name: prod.name, price: prod.price, qty }); // price always from the server
    }
    if (!items.length) return send(res, 400, { error: 'Your cart is empty.' });
    const total = money(items.reduce((s, i) => s + i.price * i.qty, 0));
    const order = {
      id: 'N1-' + crypto.randomBytes(3).toString('hex').toUpperCase(),
      items, total, email, name, status: 'pending', method: DEMO ? 'demo' : 'stripe', createdAt: Date.now(), delivered: false,
    };
    db.orders.push(order);
    saveDb();

    if (DEMO) {
      markPaid(order, { method: 'demo' });
      return send(res, 200, { url: `${BASE_URL}/success.html?order=${order.id}&demo=1` });
    }
    try {
      const form = {
        mode: 'payment',
        customer_email: email,
        success_url: `${BASE_URL}/success.html?order=${order.id}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${BASE_URL}/?cancelled=1`,
        'metadata[order_id]': order.id,
        'payment_intent_data[metadata][order_id]': order.id,
      };
      items.forEach((it, i) => {
        form[`line_items[${i}][quantity]`] = String(it.qty);
        form[`line_items[${i}][price_data][currency]`] = CURRENCY;
        form[`line_items[${i}][price_data][unit_amount]`] = String(Math.round(it.price * 100));
        form[`line_items[${i}][price_data][product_data][name]`] = it.name;
      });
      const session = await stripe('POST', '/checkout/sessions', form);
      order.stripeSession = session.id; saveDb();
      return send(res, 200, { url: session.url });
    } catch (e) {
      order.status = 'failed'; saveDb();
      return send(res, 502, { error: 'Payment could not be started. ' + e.message });
    }
  }

  // The success page asks this; for Stripe orders we confirm with Stripe itself.
  if (p === '/api/order-status' && m === 'GET') {
    const order = db.orders.find(o => o.id === url.searchParams.get('order'));
    if (!order) return send(res, 404, { error: 'Order not found.' });
    if (order.status === 'pending' && order.stripeSession && !DEMO) {
      try {
        const s = await stripe('GET', `/checkout/sessions/${encodeURIComponent(order.stripeSession)}`);
        if (s.payment_status === 'paid') markPaid(order, { method: 'stripe' });
      } catch { /* leave pending */ }
    }
    return send(res, 200, { id: order.id, status: order.status, total: order.total, email: order.email });
  }

  if (p === '/api/webhook' && m === 'POST') {
    const raw = await readBody(req);
    if (STRIPE_WEBHOOK_SECRET) {
      const sig = String(req.headers['stripe-signature'] || '');
      const parts = Object.fromEntries(sig.split(',').map(s => s.split('=')));
      const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET).update(`${parts.t}.${raw}`).digest('hex');
      let ok = false;
      try { ok = parts.v1 && crypto.timingSafeEqual(Buffer.from(parts.v1, 'hex'), Buffer.from(expected, 'hex')); } catch { ok = false; }
      if (!ok || Math.abs(Date.now() / 1000 - Number(parts.t)) > 600) return send(res, 400, 'bad signature');
    } else return send(res, 400, 'webhook secret not configured');
    const evt = JSON.parse(raw.toString('utf8'));
    if (evt.type === 'checkout.session.completed' && evt.data.object.payment_status === 'paid') {
      const order = db.orders.find(o => o.id === evt.data.object.metadata?.order_id);
      if (order) markPaid(order, { method: 'stripe' });
    }
    return send(res, 200, { received: true });
  }

  // --- staff ---
  if (p === '/api/admin/login' && m === 'POST') {
    const ip = req.socket.remoteAddress || 'x';
    const a = loginAttempts.get(ip) || { n: 0, reset: Date.now() + 15 * 60_000 };
    if (a.reset < Date.now()) { a.n = 0; a.reset = Date.now() + 15 * 60_000; }
    if (a.n >= 8) return send(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    const body = await readJson(req);
    if (!ADMIN_PASSWORD) return send(res, 503, { error: 'Set the ADMIN_PASSWORD environment variable first.' });
    if (!safeEqual(String(body.password || ''), ADMIN_PASSWORD)) {
      a.n++; loginAttempts.set(ip, a);
      return send(res, 401, { error: 'Wrong password.' });
    }
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + 12 * 3600_000);
    const secure = BASE_URL.startsWith('https') ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': `n1_staff=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secure}` });
  }
  if (p === '/api/admin/logout' && m === 'POST') {
    sessions.delete(parseCookies(req).n1_staff);
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'n1_staff=; HttpOnly; Path=/; Max-Age=0' });
  }

  if (p.startsWith('/api/admin/')) {
    if (!isStaff(req)) return send(res, 401, { error: 'Sign in required.' });
    // same-origin only for state-changing requests
    if (m !== 'GET') {
      const origin = req.headers.origin;
      if (origin && origin !== BASE_URL && !origin.startsWith('http://localhost')) return send(res, 403, { error: 'Bad origin.' });
    }

    if (p === '/api/admin/me') return send(res, 200, { ok: true, demo: DEMO, currency: CURRENCY.toUpperCase() });

    if (p === '/api/admin/overview' && m === 'GET') {
      const paid = db.orders.filter(o => o.status === 'paid');
      const day = 86400000;
      const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
      const days = [];
      for (let i = 13; i >= 0; i--) {
        const from = startOfToday.getTime() - i * day;
        const sum = paid.filter(o => o.createdAt >= from && o.createdAt < from + day).reduce((s, o) => s + o.total, 0);
        days.push({ date: new Date(from).toISOString().slice(0, 10), revenue: money(sum) });
      }
      const customers = new Map();
      paid.forEach(o => {
        const c = customers.get(o.email) || { email: o.email, name: o.name, orders: 0, spent: 0, last: 0 };
        c.orders++; c.spent = money(c.spent + o.total); c.last = Math.max(c.last, o.createdAt); c.name = o.name;
        customers.set(o.email, c);
      });
      const revenue = money(paid.reduce((s, o) => s + o.total, 0));
      const last30 = money(paid.filter(o => o.createdAt > Date.now() - 30 * day).reduce((s, o) => s + o.total, 0));
      const top = {};
      paid.forEach(o => o.items.forEach(i => { top[i.name] = (top[i.name] || 0) + i.qty; }));
      return send(res, 200, {
        revenue, last30, orders: paid.length, pending: db.orders.filter(o => o.status === 'pending').length,
        customers: customers.size, avgOrder: paid.length ? money(revenue / paid.length) : 0,
        days, customerList: [...customers.values()].sort((a, b) => b.spent - a.spent),
        topProducts: Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, qty]) => ({ name, qty })),
      });
    }

    if (p === '/api/admin/orders' && m === 'GET')
      return send(res, 200, [...db.orders].sort((a, b) => b.createdAt - a.createdAt).slice(0, 500));

    const om = p.match(/^\/api\/admin\/orders\/([\w-]+)\/delivered$/);
    if (om && m === 'POST') {
      const order = db.orders.find(o => o.id === om[1]);
      if (!order) return send(res, 404, { error: 'Order not found.' });
      const body = await readJson(req);
      order.delivered = !!body.delivered; saveDb();
      return send(res, 200, order);
    }

    if (p === '/api/admin/products' && m === 'GET')
      return send(res, 200, [...db.products].sort((a, b) => b.createdAt - a.createdAt));

    if (p === '/api/admin/products' && m === 'POST') {
      const b = await readJson(req, 1_800_000);
      const price = money(b.price);
      const name = clean(b.name, 90);
      if (!name) return send(res, 400, { error: 'Enter a product name.' });
      if (!(price > 0) || price > 1_000_000) return send(res, 400, { error: 'Enter a price above zero.' });
      let image = '';
      if (typeof b.image === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(b.image) && b.image.length < 1_500_000) image = b.image;
      const prod = {
        id: crypto.randomUUID(), name, category: clean(b.category, 40) || 'General', price,
        description: clean(b.description, 300), image, active: true, createdAt: Date.now(),
      };
      db.products.push(prod); saveDb();
      return send(res, 201, prod);
    }

    const pm = p.match(/^\/api\/admin\/products\/([\w-]+)$/);
    if (pm && m === 'DELETE') {
      const before = db.products.length;
      db.products = db.products.filter(x => x.id !== pm[1]);
      saveDb();
      return send(res, 200, { deleted: before - db.products.length });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  return send(res, 404, { error: 'Not found.' });
}

// ---------- static files ----------
function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  if (rel === '/dashboard') rel = '/dashboard.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, 'Forbidden');
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    send(res, 200, data, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
      'Referrer-Policy': 'same-origin',
      ...(ext === '.html' ? { 'X-Frame-Options': 'DENY' } : {}),
    });
  });
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, BASE_URL);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
    serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error.' });
  }
}).listen(PORT, () => {
  console.log(`N1 STORE running at ${BASE_URL}`);
  console.log(DEMO ? 'Payments: DEMO mode (set STRIPE_SECRET_KEY for real Apple Pay and card payments)' : 'Payments: Stripe Checkout (Apple Pay + cards)');
  if (!ADMIN_PASSWORD) console.log('Dashboard login is disabled until you set ADMIN_PASSWORD.');
});
