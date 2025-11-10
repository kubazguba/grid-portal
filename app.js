/**
 * GRID — Firebase Cloud Edition v1.1
 * ------------------------------------------------------------
 * Data: Firestore (clients, positions, notes, statuses, users)
 * Files: Firebase Storage (CVs + client logos)
 * Auth: Simple session (admins hardcoded; client users per-client)
 * Emails: Office365 via nodemailer (info@hyreus.co.uk)
 *
 * Admins:
 *  - jakub@hyreus.co.uk / jakubgrid1
 *  - john@hyreus.co.uk  / johngrid1
 *
 * ===== Render ENV VARS to set =====
 * 1) FIREBASE_SERVICE_ACCOUNT   (paste full JSON)
 * 2) FIREBASE_PROJECT_ID        = grid-f4a70
 * 3) FIREBASE_STORAGE_BUCKET    = grid-f4a70.firebasestorage.app   (or your .appspot.com if shown)
 * 4) NOTIFY_FROM                = info@hyreus.co.uk
 * 5) NOTIFY_TO                  = jakub@hyreus.co.uk,john@hyreus.co.uk
 * 6) SMTP_PASSWORD              = <Outlook app password for info@>
 */

const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');
const bodyParser = require('body-parser');
const path = require('path');

// -----------------------------
// Firebase Admin (server-side)
// -----------------------------
const admin = require('firebase-admin');

function initFirebase() {
  const svc = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!svc) {
    console.error('FIREBASE_SERVICE_ACCOUNT missing. Paste your service account JSON into this env var.');
    process.exit(1);
  }
  const creds = JSON.parse(svc);
  const projectId = process.env.FIREBASE_PROJECT_ID || creds.project_id || 'grid-f4a70';
  const storageBucket =
    process.env.FIREBASE_STORAGE_BUCKET || `${projectId}.appspot.com`;

  admin.initializeApp({
    credential: admin.credential.cert(creds),
    storageBucket
  });

  const db = admin.firestore();
  const bucket = admin.storage().bucket();
  return { db, bucket, projectId, storageBucket };
}

const { db, bucket } = initFirebase();

// -----------------------------
// App + config
// -----------------------------
const app = express();
app.use(bodyParser.json({ limit: '25mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '25mb' }));

const PORT = process.env.PORT || 3000;

// Brand palette
const BRAND = { bg: '#4d4445', accent: '#696162', text: '#ffffff', lightCard: '#5a5253' };

// Admin users (hardcoded)
const admins = [
  { email: 'jakub@hyreus.co.uk', password: 'jakubgrid1', name: 'Jakub', role: 'admin' },
  { email: 'john@hyreus.co.uk',  password: 'johngrid1',  name: 'John',  role: 'admin' },
];

// Email transport (Office 365)
const NOTIFY_FROM = process.env.NOTIFY_FROM || 'info@hyreus.co.uk';
const NOTIFY_TO = (process.env.NOTIFY_TO || 'jakub@hyreus.co.uk,john@hyreus.co.uk').split(',');
const SMTP_PASSWORD = process.env.SMTP_PASSWORD || 'wskrzesic12';

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: { user: NOTIFY_FROM, pass: SMTP_PASSWORD }
});

// -----------------------------
// Sessions
// -----------------------------
app.use(session({
  secret: 'grid-firebase-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}
function isAdmin(req) { return req.session?.user?.role === 'admin'; }

// -----------------------------
// Email helper
// -----------------------------
async function sendEmail(type, payload) {
  const when = new Date().toLocaleString();
  let subject = '', html = '';

  if (type === 'status') {
    const { client, position, file, content, actor } = payload;
    subject = `Status update – ${file}`;
    html = `
      <p><b>Client:</b> ${client}</p>
      <p><b>Position:</b> ${position}</p>
      <p><b>File:</b> ${file}</p>
      <p><b>New status:</b> ${content}</p>
      <p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p>
      <p>${when}</p>`;
  } else if (type === 'note') {
    const { client, position, file, content, actor } = payload;
    subject = `New note – ${file}`;
    html = `
      <p><b>Client:</b> ${client}</p>
      <p><b>Position:</b> ${position}</p>
      <p><b>File:</b> ${file}</p>
      <p><b>Note:</b> ${content}</p>
      <p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p>
      <p>${when}</p>`;
  } else if (type === 'new_position') {
    const { client, position, details, actor } = payload;
    subject = `New Position Added – ${client}`;
    html = `
      <p><b>Client:</b> ${client}</p>
      <p><b>Position:</b> ${position}</p>
      <p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p>
      <p><b>Details</b></p>
      <ul>
        <li>Salary: ${details.salary || '-'}</li>
        <li>Location: ${details.location || '-'}</li>
        <li>Experience: ${details.experience || '-'}</li>
        <li>Benefits: ${details.benefits || '-'}</li>
        <li>Notes: ${details.notes || '-'}</li>
      </ul>
      <p>${when}</p>`;
  } else if (type === 'new_client') {
    const { client, actor } = payload;
    subject = `New Client Added – ${client}`;
    html = `
      <p><b>Client:</b> ${client}</p>
      <p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p>
      <p>${when}</p>`;
  } else if (type === 'new_user') {
    const { client, user, actor } = payload;
    subject = `New Client User – ${client}`;
    html = `
      <p><b>Client:</b> ${client}</p>
      <p><b>User:</b> ${user.name} &lt;${user.email}&gt;</p>
      <p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p>
      <p>${when}</p>`;
  }

  try {
    await transporter.sendMail({ from: NOTIFY_FROM, to: NOTIFY_TO, subject, html });
  } catch (e) {
    console.error('Email error:', e.message);
  }
}

// -----------------------------
// Firestore helpers
// -----------------------------
const colClients = () => db.collection('clients');

async function getPositionRef(client, position) {
  return colClients().doc(client).collection('positions').doc(position);
}
function defaultDetails() {
  return { salary: "", location: "", experience: "", benefits: "", notes: "" };
}

// -----------------------------
// Auth endpoints
// -----------------------------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  // Admin?
  const adminUser = admins.find(a => a.email === email && a.password === password);
  if (adminUser) {
    req.session.user = { email: adminUser.email, name: adminUser.name, role: 'admin' };
    return res.json({ ok: true, user: req.session.user });
  }
  // Client user?
  const snap = await colClients().get();
  let found = null, clientId = null;
  for (const doc of snap.docs) {
    const usersRef = doc.ref.collection('users');
    const uq = await usersRef.where('email', '==', email).where('password', '==', password).limit(1).get();
    if (!uq.empty) {
      found = uq.docs[0].data();
      clientId = doc.id;
      break;
    }
  }
  if (!found) return res.status(401).json({ error: 'invalid' });
  req.session.user = { email: found.email, name: found.name || '', role: 'client', clientId };
  res.json({ ok: true, user: req.session.user });
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// -----------------------------
// Client list (admin sees all, client sees own)
// -----------------------------
app.get('/api/clients', requireAuth, async (req, res) => {
  const u = req.session.user;
  if (isAdmin(req)) {
    const snap = await colClients().orderBy(admin.firestore.FieldPath.documentId()).get();
    const clients = snap.docs.map(d => d.id);
    return res.json({ clients });
  } else {
    return res.json({ clients: [u.clientId] });
  }
});

// Client metadata (logo if exists)
app.get('/api/client-meta', requireAuth, async (req, res) => {
  const { client } = req.query || {};
  if (!client) return res.status(400).json({ error: 'missing client' });
  const doc = await colClients().doc(client).get();
  if (!doc.exists) return res.json({ name: client, logoURL: null });
  const data = doc.data() || {};
  res.json({ name: client, logoURL: data.logoURL || null });
});

// -----------------------------
// Client create / delete / edit (admins only)
// -----------------------------
app.post('/api/client-add', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { name, logoBase64 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'client name required' });

  const ref = colClients().doc(name);
  const exists = await ref.get();
  if (exists.exists) return res.status(400).json({ error: 'client exists' });

  let logoURL = null;
  if (logoBase64) {
    const b = logoBase64.split(',').pop();
    const buf = Buffer.from(b, 'base64');
    const file = bucket.file(`logos/${name}.png`);
    await file.save(buf, { contentType: 'image/png', resumable: false, public: false });
    const [signed] = await file.getSignedUrl({ action: 'read', expires: '2099-12-31' });
    logoURL = signed;
  }

  await ref.set({ logoURL });
  await sendEmail('new_client', { client: name, actor: req.session.user });
  res.json({ ok: true });
});

app.post('/api/client-delete', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'client name required' });
  const ref = colClients().doc(name);

  const users = await ref.collection('users').get();
  for (const d of users.docs) await d.ref.delete();

  const positions = await ref.collection('positions').get();
  for (const d of positions.docs) await d.ref.delete();

  await ref.delete();

  try { await bucket.deleteFiles({ prefix: `logos/${name}` }); } catch {}
  try { await bucket.deleteFiles({ prefix: `files/${name}` }); } catch {}

  res.json({ ok: true });
});

app.post('/api/client-edit', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { name, newName, removeLogo, logoBase64 } = req.body || {};
  if (!name) return res.status(400).json({ error: 'missing name' });
  const ref = colClients().doc(name);
  const doc = await ref.get();
  if (!doc.exists) return res.status(404).json({ error: 'client not found' });

  let updates = {};
  if (removeLogo) {
    updates.logoURL = admin.firestore.FieldValue.delete();
    try { await bucket.deleteFiles({ prefix: `logos/${name}` }); } catch {}
  }
  if (logoBase64) {
    const b = logoBase64.split(',').pop();
    const buf = Buffer.from(b, 'base64');
    const file = bucket.file(`logos/${name}.png`);
    await file.save(buf, { contentType: 'image/png', resumable: false, public: false });
    const [signed] = await file.getSignedUrl({ action: 'read', expires: '2099-12-31' });
    updates.logoURL = signed;
  }
  await ref.set(updates, { merge: true });

  if (newName && newName !== name) {
    const newRef = colClients().doc(newName);
    const newDoc = Object.assign({}, (await ref.get()).data() || {});
    await newRef.set(newDoc, { merge: true });

    for (const sub of ['users', 'positions']) {
      const subSnap = await ref.collection(sub).get();
      for (const d of subSnap.docs) {
        await newRef.collection(sub).doc(d.id).set(d.data());
        await d.ref.delete();
      }
    }
    await ref.delete();

    try {
      const [files] = await bucket.getFiles({ prefix: `files/${name}/` });
      for (const f of files) {
        const dest = f.name.replace(`files/${name}/`, `files/${newName}/`);
        await f.copy(bucket.file(dest));
        await f.delete();
      }
    } catch {}
    try {
      const lf = bucket.file(`logos/${name}.png`);
      const [exists] = await lf.exists();
      if (exists) {
        await lf.copy(bucket.file(`logos/${newName}.png`));
        await lf.delete();
      }
    } catch {}
  }

  res.json({ ok: true });
});

// -----------------------------
// Client users (admins only)
// -----------------------------
app.get('/api/client-users', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { client } = req.query || {};
  if (!client) return res.status(400).json({ error: 'missing client' });
  const snap = await colClients().doc(client).collection('users').get();
  const users = snap.docs.map(d => d.data());
  res.json({ users });
});

app.post('/api/client-user-add', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { client, name, email, password, role } = req.body || {};
  if (!client || !email || !password) return res.status(400).json({ error: 'missing fields' });
  const userRef = colClients().doc(client).collection('users').doc(email);
  await userRef.set({ name: name || '', email, password, role: role || 'client' }, { merge: true });
  await sendEmail('new_user', { client, user: { name, email }, actor: req.session.user });
  res.json({ ok: true });
});

app.post('/api/client-user-delete', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admin only' });
  const { client, email } = req.body || {};
  if (!client || !email) return res.status(400).json({ error: 'missing fields' });
  await colClients().doc(client).collection('users').doc(email).delete();
  res.json({ ok: true });
});

// -----------------------------
// Positions
// -----------------------------
app.get('/api/positions', requireAuth, async (req, res) => {
  const { client } = req.query || {};
  const u = req.session.user;
  if (!client) return res.status(400).json({ error: 'client required' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const snap = await colClients().doc(client).collection('positions').orderBy(admin.firestore.FieldPath.documentId()).get();
  const positions = snap.docs.map(d => {
    const data = d.data() || {};
    const count = Array.isArray(data.files) ? data.files.length : 0;
    return { name: d.id, count };
  });
  res.json({ positions });
});

app.post('/api/position', requireAuth, async (req, res) => {
  const { client, position, details } = req.body || {};
  const u = req.session.user;
  if (!client || !position) return res.status(400).json({ error: 'bad request' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, position);
  await ref.set({
    details: Object.assign(defaultDetails(), details || {}),
    files: [],
    feedback: {} // map: filename -> { decision, notes: [] }
  }, { merge: true });

  await sendEmail('new_position', { client, position, details: details || {}, actor: u });
  res.json({ ok: true });
});

// -----------------------------
// Files + feedback
// -----------------------------
app.get('/api/list', requireAuth, async (req, res) => {
  const { client, pos } = req.query || {};
  const u = req.session.user;
  if (!client || !pos) return res.status(400).json({ error: 'missing' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, pos);
  const doc = await ref.get();
  const data = doc.data() || {};
  const files = data.files || [];
  const status = data.feedback || {};
  res.json({ files, status });
});

app.get('/api/details', requireAuth, async (req, res) => {
  const { client, pos } = req.query || {};
  const u = req.session.user;
  if (!client || !pos) return res.status(400).json({ error: 'missing' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, pos);
  const doc = await ref.get();
  const data = doc.data() || {};
  res.json({ details: data.details || defaultDetails() });
});

app.post('/api/details', requireAuth, async (req, res) => {
  const { client, position, details } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !details) return res.status(400).json({ error: 'bad request' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, position);
  await ref.set({ details: Object.assign(defaultDetails(), details) }, { merge: true });
  const doc = await ref.get();
  res.json({ ok: true, details: (doc.data() || {}).details || defaultDetails() });
});

// stream (proxy) a file from storage
app.get('/api/file', requireAuth, async (req, res) => {
  const { client, pos, name } = req.query || {};
  const u = req.session.user;
  if (!client || !pos || !name) return res.status(400).send('missing');
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).send('forbidden');

  const file = bucket.file(`files/${client}/${pos}/${name}`);
  const [exists] = await file.exists();
  if (!exists) return res.status(404).send('not found');

  res.setHeader('Content-Disposition', `inline; filename="${name}"`);
  file.createReadStream().on('error', () => res.status(500).end()).pipe(res);
});

// status toggle
app.post('/api/status', requireAuth, async (req, res) => {
  const { client, position, file, status } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !['yes','maybe','no','neutral'].includes(status)) return res.status(400).json({ error: 'bad request' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, position);
  const doc = await ref.get();
  const data = doc.data() || {};
  const feedback = data.feedback || {};
  const current = feedback[file] || { decision: 'neutral', notes: [] };
  const newDecision = (current.decision === status && status !== 'neutral') ? 'neutral' : status;
  feedback[file] = { decision: newDecision, notes: current.notes || [] };
  await ref.set({ feedback }, { merge: true });

  sendEmail('status', { client, position, file, content: newDecision, actor: u }).catch(()=>{});
  res.json({ ok: true, decision: newDecision });
});

// note add
app.post('/api/note', requireAuth, async (req, res) => {
  const { client, position, file, text } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !text) return res.status(400).json({ error: 'bad request' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, position);
  const doc = await ref.get();
  const data = doc.data() || {};
  const feedback = data.feedback || {};
  const entry = feedback[file] || { decision: 'neutral', notes: [] };
  const note = { text: String(text).trim(), authorEmail: u.email, authorName: u.name, timestamp: new Date().toISOString() };
  entry.notes = [note, ...(entry.notes || [])];
  feedback[file] = entry;
  await ref.set({ feedback }, { merge: true });

  sendEmail('note', { client, position, file, content: text, actor: u }).catch(()=>{});
  res.json({ ok: true, note });
});

// note delete (admin or author)
app.post('/api/note-delete', requireAuth, async (req, res) => {
  const { client, position, file, timestamp } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !timestamp) return res.status(400).json({ error: 'bad request' });
  if (!isAdmin(req) && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const ref = await getPositionRef(client, position);
  const doc = await ref.get();
  const data = doc.data() || {};
  const feedback = data.feedback || {};
  const entry = feedback[file] || { decision: 'neutral', notes: [] };
  const notes = entry.notes || [];
  const idx = notes.findIndex(n => n.timestamp === timestamp);
  if (idx === -1) return res.json({ ok: true });

  const isAuthor = (notes[idx].authorEmail === u.email);
  if (!(isAdmin(req) || isAuthor)) return res.status(403).json({ error: 'forbidden' });

  notes.splice(idx, 1);
  entry.notes = notes;
  feedback[file] = entry;
  await ref.set({ feedback }, { merge: true });
  res.json({ ok: true });
});

// upload CVs (admins only) — base64 JSON
app.post('/api/upload', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admins only' });
  const { client, position, files } = req.body || {};
  if (!client || !position || !Array.isArray(files)) return res.status(400).json({ error: 'bad request' });

  const ref = await getPositionRef(client, position);
  const doc = await ref.get();
  let data = doc.data() || { files: [], feedback: {} };
  data.files = data.files || [];
  data.feedback = data.feedback || {};

  let saved = [];
  for (const f of files) {
    try {
      const name = (f.name || 'unnamed').replace(/[/\\<>:"|?*\x00-\x1F]/g,'_').slice(0,200);
      const b64 = (f.base64 || '').split(',').pop();
      const buf = Buffer.from(b64, 'base64');
      const file = bucket.file(`files/${client}/${position}/${name}`);
      await file.save(buf, { contentType: f.type || 'application/octet-stream', resumable: false, public: false });
      if (!data.files.includes(name)) data.files.push(name);
      if (!data.feedback[name]) data.feedback[name] = { decision: 'neutral', notes: [] };
      saved.push(name);
    } catch (e) {
      console.error('Upload error:', e.message);
    }
  }
  await ref.set({ files: data.files, feedback: data.feedback }, { merge: true });
  res.json({ ok: true, saved });
});

// delete CV (admins only)
app.post('/api/cv-delete', requireAuth, async (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'admins only' });
  const { client, position, name } = req.body || {};
  if (!client || !position || !name) return res.status(400).json({ error: 'bad request' });

  const file = bucket.file(`files/${client}/${position}/${name}`);
  try { await file.delete(); } catch {}
  const ref = await getPositionRef(client, position);
  const doc = await ref.get();
  const data = doc.data() || {};
  let files = data.files || [];
  const feedback = data.feedback || {};
  files = files.filter(v => v !== name);
  delete feedback[name];
  await ref.set({ files, feedback }, { merge: true });
  res.json({ ok: true });
});

// -----------------------------
// Logos route (serve from Storage)
// -----------------------------
app.get('/logos/:client', async (req, res) => {
  const name = req.params.client;
  const file = bucket.file(`logos/${name}.png`);
  const [exists] = await file.exists();
  if (!exists) return res.status(404).end();
  res.setHeader('Content-Type', 'image/png');
  file.createReadStream().on('error', () => res.status(500).end()).pipe(res);
});

// Fallback for main logo (optional, local file if present)
app.get('/logo', (req, res) => {
  const png = path.join(__dirname, 'logo.png');
  const jpg = path.join(__dirname, 'logo.jpg');
  res.sendFile(png, (err) => { if (err) res.sendFile(jpg, (err2)=> err2 && res.status(404).end()); });
});

// -----------------------------
// Minimal UI (updated v1.1)
// -----------------------------
app.get('/', (req, res) => {
  const local =
    (req.headers.host || '').includes('localhost') || (req.headers.host || '').includes('127.0.0.1');

  const css = `
    html,body{height:100%} body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:${BRAND.bg};color:${BRAND.text};}
    .wrap{max-width:1200px;margin:0 auto;padding:20px;}
    input,select,textarea{background:#40393a;color:#fff;border:1px solid ${BRAND.accent};border-radius:8px;padding:8px;}
    textarea{resize:vertical;max-height:120px;overflow:auto;}
    button{border:1px solid ${BRAND.accent};background:#40393a;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;}
    button:hover{filter:brightness(1.06)}
    .layout{display:grid;grid-template-columns:280px 1fr;gap:16px;}
    .sidebar{background:#40393a;border:1px solid ${BRAND.accent};border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;position:sticky;top:20px;height:calc(100vh - 40px);}
    .logo{display:flex;flex-direction:column;align-items:center;gap:8px;}
    .pos{padding:6px;border:1px solid ${BRAND.accent};border-radius:8px;margin-bottom:6px;cursor:pointer;display:flex;justify-content:space-between;gap:6px;}
    .pos.active{background:#5a5253;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;}
    .card{position:relative;border:1px solid ${BRAND.accent};border-radius:10px;background:#463f40;padding:12px;display:flex;flex-direction:column;gap:8px;}
    .file{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.note{
  width:calc(100% - 8px);
  box-sizing:border-box;
  margin:0;
  resize:vertical;
}
    .details{background:${BRAND.lightCard};border:1px solid ${BRAND.accent};border-radius:10px;padding:12px;margin-bottom:12px;}
    .details h3{margin:0 0 8px 0;text-align:left;}
    .titleCentered{font-size:20px;font-weight:700;text-align:center;margin:0 0 12px 0;}
    .muted{opacity:.7}
    .field{display:flex;gap:8px;align-items:center;margin-bottom:6px;}
    .label{width:110px;opacity:.9}
    .noteRow{background:#3a3435;border:1px solid ${BRAND.accent};border-radius:8px;padding:8px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;}
    .trash{background:transparent;border:none;color:#bbb;cursor:pointer;font-size:16px;line-height:1;padding:2px;}
    .trash:hover{color:#fff}
    .footer{margin-top:auto;text-align:center;opacity:.7;font-size:12px;}
    .sep{height:1px;background:${BRAND.accent};margin:8px 0;}
.plus{
  display:flex;
  justify-content:center;
  align-items:center;
  width:calc(100% - 4px);
  margin:0 auto;
  border:1px dashed ${BRAND.accent};
  border-radius:8px;
  padding:8px;
  cursor:pointer;
  opacity:.9;
  text-align:center;
}
    .plus:hover{filter:brightness(1.1)}
    .pill{display:inline-block;border:1px solid ${BRAND.accent};border-radius:999px;padding:2px 8px;font-size:12px;opacity:.85}
    .clientRow{display:flex;justify-content:space-between;align-items:center;border:1px solid ${BRAND.accent};border-radius:8px;padding:6px;margin-bottom:6px;}
    .clientName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding-right:8px;}
    .iconBtn{background:transparent;border:1px solid ${BRAND.accent};border-radius:8px;padding:2px 6px;font-size:14px;color:#ddd;cursor:pointer;}
    .iconBtn:hover{filter:brightness(1.2)}
    .showMore{cursor:pointer;text-decoration:underline;opacity:.85}
  `;

  const html = `<!doctype html><html><head><meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>GRID</title>
  <style>${css}</style></head><body>
  <div class="wrap">
    <div id="loginCard">
      <h2>Login</h2>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <input id="email" placeholder="Email"/>
        <input id="password" type="password" placeholder="Password"/>
        <button onclick="login()">Sign in</button>
      </div>
      ${local ? '<div style="opacity:.6;font-size:12px;margin-top:6px;">Admins: jakub@hyreus.co.uk / jakubgrid1 &nbsp; | &nbsp; john@hyreus.co.uk / johngrid1</div>' : ''}
    </div>

    <div id="app" style="display:none;"></div>
  </div>

  <script>
    let ME=null, CURRENT_CLIENT="", CURRENT_POS="";

    async function api(p,o){const r=await fetch(p,o); if(!r.ok){try{const j=await r.json();throw new Error(j.error||'error')}catch{throw new Error('error')}} return r.json()}
    async function me(){const j=await api('/api/me'); ME=j.user; return ME;}

    async function login(){
      const email=document.getElementById('email').value;
      const password=document.getElementById('password').value;
      try{
        await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})}).then(r=>{if(!r.ok) throw new Error();});
        init();
      }catch{ alert('Login failed'); }
    }
    async function logout(){ await fetch('/api/logout',{method:'POST'}); location.reload(); }

    function clientLogoImgTag(name){
      return '<img src="/logos/'+encodeURIComponent(name)+'" onerror="this.style.display=\\'none\\'" style="width:140px;max-height:90px;object-fit:contain;border-radius:6px;border:1px solid ${BRAND.accent};"/>';
    }

    async function init(){
      const u=await me(); if(!u) return;
      document.getElementById('loginCard').style.display='none';
      const app=document.getElementById('app');
      app.style.display='block';

      let left = '<aside class="sidebar">';
      left += '<div class="logo"><img src="/logo" style="width:160px;max-height:90px;object-fit:contain;border-radius:8px;border:1px solid ${BRAND.accent};"/></div>';

      if(u.role==='admin'){
        left += '<div style="text-align:center;opacity:.9;font-weight:600;">Admin view</div>';
        left += '<div style="margin-top:4px;"><div id="clientList"></div></div>';
        left += '<div class="plus" onclick="openAddClient()" title="Add Client">➕ Add Client</div>';
      } else if(u.role==='client' && u.clientId){
        left += '<div style="text-align:center;">'+clientLogoImgTag(u.clientId)+'<div style="margin-top:6px;">'+u.clientId+'</div></div>';
      }

      left += '<div id="positions"></div>';
   left += '<div id="addPosBtn" class="plus" onclick="openAddPosition()" title="Add Position">➕ Add Position</div>';
      left += '<div class="footer"><div class="sep"></div>powered by Hyreus</div>';
      left += '<div style="margin-top:8px;"><button onclick="logout()">Logout</button></div></aside>';

      const right = '<main><div id="main"></div></main>';
      app.innerHTML = '<div class="layout">'+left+right+'</div>';

      await loadClients();
    }

async function loadClients(){
  const j = await api('/api/clients');
  const box = document.getElementById('clientList');  // ✅ define the target box

  let html = '<select id="clientDropdown" onchange="pickClient(this.value)" style="width:100%;padding:6px;border-radius:8px;background:#40393a;color:#fff;border:1px solid #696162;">';
  html += '<option value="">-- Select Client --</option>';
  (j.clients || []).forEach(c=>{
    html += '<option value="'+c+'" '+(c===CURRENT_CLIENT?'selected':'')+'>'+c+'</option>';
  });
  html += '</select>';
  html += '<div style="margin-top:6px;display:flex;justify-content:space-between;align-items:center;">';
  html += '<div class="plus" style="flex:1;margin:0;" onclick="openAddClient()">➕ Add Client</div>';
  html += '<button class="iconBtn" onclick="if(document.getElementById(\'clientDropdown\').value) delClient(document.getElementById(\'clientDropdown\').value)">🗑️</button>';
  html += '</div>';

  box.innerHTML = html;

  if ((j.clients || []).length && !CURRENT_CLIENT) {
    pickClient(j.clients[0]);
  } else if (ME.role === 'client') {
    pickClient(ME.clientId);
  }
}

    async function pickClient(c){
      CURRENT_CLIENT=c;
      const r = await api('/api/positions?client='+encodeURIComponent(c));
      const box=document.getElementById('positions'); box.innerHTML='';
      (r.positions||[]).forEach(p=>{
        const d=document.createElement('div'); d.className='pos'; d.innerHTML = '<div>'+p.name+'</div><div class="muted">('+p.count+')</div>';
        d.onclick=function(){ selectPosition(p.name, d); };
        box.appendChild(d);
      });
      document.getElementById('main').innerHTML = '<h2 style="margin-top:0;text-align:center;">'+(c||'')+'</h2>' +
        (ME.role==='admin' ? adminClientPanelsHTML() : '<p style="text-align:center;">Select a position from the left.</p>');
      if(ME.role==='admin') await refreshUsers();
    }

    function adminClientPanelsHTML(){
      return \`
        <div class="details">
          <h3>Client Settings</h3>
          <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;">
            <button onclick="promptEditClientName()">✏️ Edit Name</button>
            <input type="file" id="logoFile" accept="image/png,image/jpeg"/>
            <button onclick="uploadLogo()">🖼️ Upload/Replace Logo</button>
            <button onclick="removeLogo()">🗑️ Remove Logo</button>
          </div>
        </div>
        <div class="details">
          <h3>Client Users</h3>
          <div id="userList"></div>
          <div style="margin-top:8px;"><button onclick="openAddUser()">➕ Add New User</button></div>
        </div>
        <p style="text-align:center;">Select a position from the left.</p>
      \`;
    }

    async function refreshUsers(){
      if(ME.role!=='admin' || !CURRENT_CLIENT) return;
      const j = await api('/api/client-users?client='+encodeURIComponent(CURRENT_CLIENT));
      const box = document.getElementById('userList'); if(!box) return;
      box.innerHTML='';
      (j.users||[]).forEach(u=>{
        const row = document.createElement('div'); row.className='noteRow';
        row.innerHTML = '<div>👤 <b>'+ (u.name||'') +'</b> &lt;'+u.email+'&gt; — '+(u.role||'client')+'</div><button class="trash" onclick="delUser(\\''+u.email+'\\')">🗑️</button>';
        box.appendChild(row);
      });
    }

    function openAddClient(){
      const name = prompt('Client name:'); 
      if(!name) return;
      api('/api/client-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
        .then(async ()=>{ 
          await loadClients(); 
          pickClient(name);
        })
        .catch(()=>alert('Failed to add client'));
    }

    async function delClient(name){
      if(!confirm('Delete client "'+name+'"? This removes all positions, users and files.')) return;
      await api('/api/client-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})});
      CURRENT_CLIENT = '';
      await loadClients();
      document.getElementById('positions').innerHTML='';
      document.getElementById('main').innerHTML='';
    }

    async function promptEditClientName(){
      const newName = prompt('New client name:', CURRENT_CLIENT); if(!newName || newName===CURRENT_CLIENT) return;
      await api('/api/client-edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:CURRENT_CLIENT,newName})});
      CURRENT_CLIENT = newName;
      await loadClients();
      pickClient(newName);
    }

    async function uploadLogo(){
      if(!CURRENT_CLIENT){ alert('Pick a client first'); return; }
      const inp=document.getElementById('logoFile'); 
      if(!inp || !inp.files || !inp.files[0]){ alert('Choose a logo file first'); return; }
      const base64 = await readAsDataURL(inp.files[0]);
      await api('/api/client-edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:CURRENT_CLIENT,logoBase64:base64})});
      await loadClients();     // refresh sidebar so logo appears
      pickClient(CURRENT_CLIENT);
    }

    async function removeLogo(){
      if(!CURRENT_CLIENT){ return; }
      if(!confirm('Remove logo?')) return;
      await api('/api/client-edit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:CURRENT_CLIENT,removeLogo:true})});
      await loadClients();     // refresh sidebar
      pickClient(CURRENT_CLIENT);
    }

    function openAddUser(){
      const name = prompt('Full name:') || '';
      const email = prompt('Email:'); if(!email) return;
      const password = prompt('Password:'); if(!password) return;
      const role = (prompt('Role (client/viewer):','client')||'client').toLowerCase()==='viewer'?'viewer':'client';
      api('/api/client-user-add',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:CURRENT_CLIENT,name,email,password,role})})
        .then(()=>refreshUsers());
    }

    async function delUser(email){
      if(!confirm('Remove user '+email+'?')) return;
      await api('/api/client-user-delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:CURRENT_CLIENT,email})});
      await refreshUsers();
    }

    function readAsDataURL(file){ return new Promise(res=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.readAsDataURL(file); }); }
    function safeId(name){ return name.replace(/[^a-zA-Z0-9]/g,'_'); }

    async function selectPosition(pos, el){
      CURRENT_POS=pos;
      const box=document.getElementById('positions');
      Array.prototype.forEach.call(box.children, function(x){ x.classList.remove('active'); });
      if(el) el.classList.add('active');
      await loadPosition(pos);
      if(ME.role==='admin') await refreshUsers();
    }

    function overlayColor(dec){
      if(dec==='yes') return '#1f6b3b55';
      if(dec==='maybe') return '#b86e0055';
      if(dec==='no') return '#7a1b1b55';
      return '#0000';
    }

    function renderNotesList(fileSafeId, notes){
      const boxId = 'notes_'+fileSafeId;
      const total = notes.length;
      const shown = notes.slice(0, 3); // newest first (we prepend on add)
      let html = '';
      shown.forEach(n=>{
        const canDel = (ME.role==='admin') || (n.authorEmail===ME.email);
        html += '<div class="noteRow" data-ts="'+n.timestamp+'">';
        html += '<div><div><b>'+(n.authorName||'')+'</b> &lt;'+n.authorEmail+'&gt; — '+new Date(n.timestamp).toLocaleString()+'</div><div>'+n.text+'</div></div>';
        html += (canDel ? '<button class="trash" onclick="delNoteByTs(\\''+fileSafeId+'\\',\\''+n.timestamp+'\\')">🗑️</button>' : '');
        html += '</div>';
      });
      if (total > 3) {
        html += '<div class="showMore" onclick="toggleNotes(\\''+fileSafeId+'\\')">Show more comments ('+(total-3)+')</div>';
        // store the rest in a hidden container
        html += '<div id="more_'+fileSafeId+'" style="display:none;">';
        notes.slice(3).forEach(n=>{
          const canDel = (ME.role==='admin') || (n.authorEmail===ME.email);
          html += '<div class="noteRow" data-ts="'+n.timestamp+'">';
          html += '<div><div><b>'+(n.authorName||'')+'</b> &lt;'+n.authorEmail+'&gt; — '+new Date(n.timestamp).toLocaleString()+'</div><div>'+n.text+'</div></div>';
          html += (canDel ? '<button class="trash" onclick="delNoteByTs(\\''+fileSafeId+'\\',\\''+n.timestamp+'\\')">🗑️</button>' : '');
          html += '</div>';
        });
        html += '</div>';
      }
      return html;
    }

    function toggleNotes(fileSafeId){
      const el = document.getElementById('more_'+fileSafeId);
      if(!el) return;
      const trigger = el.previousElementSibling; // the "Show more" div
      if (el.style.display==='none'){ el.style.display='block'; if(trigger) trigger.textContent='Hide comments'; }
      else { el.style.display='none'; if(trigger) trigger.textContent='Show more comments'; }
    }

    async function loadPosition(pos){
      const detailsResp = await api('/api/details?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(pos));
      const listResp = await api('/api/list?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(pos));
      const main = document.getElementById('main');

      let h = '<div class="titleCentered">'+CURRENT_CLIENT+' — '+pos+'</div>';

      const d = (detailsResp.details || {});
      function fmt(v){ return v && String(v).trim() ? String(v) : '<span class="muted">Not provided</span>'; }
      h += '<div class="details" id="detBox">';
      h += '<h3>Position Details</h3>';
      h += '<div class="field"><div class="label">💼 Salary</div><div>'+fmt(d.salary)+'</div></div>';
      h += '<div class="field"><div class="label">📍 Location</div><div>'+fmt(d.location)+'</div></div>';
      h += '<div class="field"><div class="label">🧠 Experience</div><div>'+fmt(d.experience)+'</div></div>';
      h += '<div class="field"><div class="label">💰 Benefits</div><div>'+fmt(d.benefits)+'</div></div>';
      h += '<div class="field"><div class="label">🗒 Notes</div><div>'+fmt(d.notes)+'</div></div>';
      h += (ME.role==='admin' || (ME.role==='client' && ME.clientId===CURRENT_CLIENT) ? '<div style="margin-top:8px;"><span class="pill" onclick="editDetails()">Edit Details</span></div>' : '');
      h += '</div>';

      h += '<div class="grid">';
      (listResp.files||[]).forEach(f=>{
        const sid = safeId(f);
        const s = (listResp.status||{})[f] || { decision:'neutral', notes:[] };
        h += '<div class="card" id="card_'+sid+'">';
        h += '<div class="file"><a target="_blank" style="color:#a8d1ff;text-decoration:none;" href="/api/file?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(CURRENT_POS)+'&name='+encodeURIComponent(f)+'">'+f+'</a>';
       h += '</div>'; // close file title line
if(ME.role==='admin'){
  h += '<button class="trash" title="Delete CV" onclick="deleteCV(\\''+f+'\\')" style="position:absolute;bottom:8px;right:8px;">🗑️</button>';
}
        h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        h += '<button onclick="setStatusUI(\\''+f+'\\',\\'yes\\')">Yes</button>';
        h += '<button onclick="setStatusUI(\\''+f+'\\',\\'maybe\\')">Maybe</button>';
        h += '<button onclick="setStatusUI(\\''+f+'\\',\\'no\\')">No</button>';
        h += '<button onclick="setStatusUI(\\''+f+'\\',\\'neutral\\')">Neutral</button>';
        h += '</div>';
        h += '<textarea id="nt'+sid+'" class="note" placeholder="Add a note..."></textarea>';
        h += '<div><button onclick="addNote(\\''+f+'\\')">Add Note</button></div>';
        h += '<div id="ov_'+sid+'" style="position:absolute;inset:0;border-radius:10px;pointer-events:none;background:'+overlayColor(s.decision)+'"></div>';
        // Notes (collapsed when >3)
        const notes = (s.notes||[]);
        h += '<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;" id="notes_'+sid+'">';
        h += renderNotesList(sid, notes);
        h += '</div>';

        h += '</div>'; // card
      });
      h += '</div>';

      if(ME.role==='admin'){
        h += '<div style="margin-top:12px;padding:8px;border:1px dashed ${BRAND.accent};border-radius:8px;" id="dropZone">';
        h += '<div style="margin-bottom:6px;font-weight:600;">Upload CVs</div>';
        h += '<input id="cvFiles" type="file" multiple /> ';
        h += '<button onclick="uploadCVs()">Upload</button> ';
        h += '<div class="muted" style="margin-top:6px;">Or drag & drop files here</div>';
        h += '<span id="upMsg" class="muted" style="margin-left:8px;"></span>';
        h += '</div>';
      }

      main.innerHTML = h;
      window._currentDetails = d;

      // drag & drop events
      const dz = document.getElementById('dropZone');
      if(dz){
        ['dragenter','dragover'].forEach(ev=>{
          dz.addEventListener(ev,e=>{ e.preventDefault(); dz.style.filter='brightness(1.1)'; dz.style.borderColor='#bbb'; });
        });
        ['dragleave','drop'].forEach(ev=>{
          dz.addEventListener(ev,e=>{ e.preventDefault(); dz.style.filter=''; dz.style.borderColor='${BRAND.accent}'; });
        });
        dz.addEventListener('drop', e=>{
          e.preventDefault();
          const files = Array.from(e.dataTransfer.files||[]);
          if(files.length) uploadCVs(files);
        });
      }
    }

    function editDetails(){
      const d = window._currentDetails || {salary:'',location:'',experience:'',benefits:'',notes:''};
      const form = '<div class="details"><h3>Edit Position Details</h3>' +
        '<div class="field"><div class="label">💼 Salary</div><input id="f_salary" value="'+(d.salary||'').replace(/"/g,'&quot;')+'"/></div>' +
        '<div class="field"><div class="label">📍 Location</div><input id="f_location" value="'+(d.location||'').replace(/"/g,'&quot;')+'"/></div>' +
        '<div class="field"><div class="label">🧠 Experience</div><input id="f_experience" value="'+(d.experience||'').replace(/"/g,'&quot;')+'"/></div>' +
        '<div class="field"><div class="label">💰 Benefits</div><input id="f_benefits" value="'+(d.benefits||'').replace(/"/g,'&quot;')+'"/></div>' +
        '<div class="field"><div class="label">🗒 Notes</div><textarea id="f_notes">'+(d.notes||'')+'</textarea></div>' +
        '<div style="display:flex;gap:8px;margin-top:8px;"><button onclick="saveDetails()">Save</button><button onclick="loadPosition(CURRENT_POS)">Cancel</button></div>'+
      '</div>';
      const box = document.getElementById('detBox');
      box.outerHTML = form;
    }

    async function saveDetails(){
      const payload = {
        client: CURRENT_CLIENT,
        position: CURRENT_POS,
        details: {
          salary: document.getElementById('f_salary').value,
          location: document.getElementById('f_location').value,
          experience: document.getElementById('f_experience').value,
          benefits: document.getElementById('f_benefits').value,
          notes: document.getElementById('f_notes').value
        }
      };
      const r = await fetch('/api/details', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
      if (r.ok) { loadPosition(CURRENT_POS); } else { alert('Failed to save'); }
    }

    async function setStatusUI(file, s){
      const oid = 'ov_'+safeId(file);
      const el = document.getElementById(oid);
      if(el) el.style.background = (s==='neutral') ? '#0000' : overlayColor(s);
      const r = await fetch('/api/status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:CURRENT_CLIENT,position:CURRENT_POS,file,status:s})});
      if(r.ok){ const j = await r.json(); if(el) el.style.background = overlayColor(j.decision || s); }
    }

    async function addNote(f){
      const id = 'nt'+safeId(f);
      const t = document.getElementById(id).value.trim();
      if(!t) return;
      const r = await fetch('/api/note',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({client:CURRENT_CLIENT,position:CURRENT_POS,file:f,text:t})});
      if(r.ok){
        document.getElementById(id).value='';
        const j = await r.json(), n=j.note;
        const sid = safeId(f);
        const box = document.getElementById('notes_'+sid);
        if(box){
          // prepend newest
          const canDel = (ME.role==='admin') || (n.authorEmail===ME.email);
          const row = document.createElement('div');
          row.className = 'noteRow';
          row.setAttribute('data-ts', n.timestamp);
          row.innerHTML = '<div><div><b>'+(n.authorName||'')+'</b> &lt;'+n.authorEmail+'&gt; — '+new Date(n.timestamp).toLocaleString()+'</div><div>'+n.text+'</div></div>' + (canDel ? '<button class="trash" onclick="delNoteByTs(\\''+sid+'\\',\\''+n.timestamp+'\\')">🗑️</button>' : '');
          box.prepend(row);

          // Collapse logic: keep only first 3 visible, move others under "more"
          const rows = Array.from(box.querySelectorAll('.noteRow'));
          if (rows.length > 3) {
            // If "more" container missing, create it and show "Show more" link
            let more = document.getElementById('more_'+sid);
            let trigger = box.querySelector('.showMore');
            if (!more) {
              more = document.createElement('div');
              more.id = 'more_'+sid;
              more.style.display = 'none';
              // insert after a new "Show more" line
              const link = document.createElement('div');
              link.className = 'showMore';
              link.textContent = 'Show more comments';
              link.onclick = () => toggleNotes(sid);
              box.appendChild(link);
              box.appendChild(more);
            }
            // Move any rows after index 2 into "more"
            rows.slice(3).forEach(rw => { more.appendChild(rw); });
          }
        }
      }
    }

    async function delNote(file, ts){
      const r = await fetch('/api/note-delete',{method:'POST',headers:{'Content-Type':'application/json'},body: JSON.stringify({ client: CURRENT_CLIENT, position: CURRENT_POS, file, timestamp: ts })});
      if(r.ok){
        const box = document.getElementById('notes_'+safeId(file));
        if(box){ const rows = box.querySelectorAll('.noteRow'); rows.forEach(row => { if(row.getAttribute('data-ts')===ts){ row.remove(); } }); }
      } else { alert('Failed to delete'); }
    }
    // Delete by fileSafeId + timestamp (used in collapsed "more" also)
    function delNoteByTs(fileSafeId, ts){
      // we still need original filename for API; easiest: find the link href in card header
      // but simpler: call API with CURRENT_POS + CURRENT_CLIENT + find ts in both visible and hidden.
      // We'll send using the fileSafeId to find displayed file name:
      const card = document.getElementById('card_'+fileSafeId);
      if(!card) return;
      const a = card.querySelector('.file a');
      if(!a) return;
      const url = new URL(a.href);
      const fname = url.searchParams.get('name');
      delNote(fname, ts);
    }

    async function uploadCVs(passedFiles){
      const inp = document.getElementById('cvFiles');
      const out = document.getElementById('upMsg');

      const fileList = passedFiles || (inp && inp.files ? Array.from(inp.files) : []);
      if(!fileList.length) return;

      out.textContent = 'Uploading...';
      const files = await Promise.all(fileList.map(f => new Promise(res => {
        const r = new FileReader();
        r.onload = () => res({ name: f.name, base64: r.result, type: f.type });
        r.readAsDataURL(f);
      })));

      const r = await fetch('/api/upload', { 
        method:'POST', headers:{'Content-Type':'application/json'}, 
        body: JSON.stringify({ client: CURRENT_CLIENT, position: CURRENT_POS, files }) 
      });
      if(r.ok){ out.textContent='Done.'; await loadPosition(CURRENT_POS); } else { out.textContent='Failed.'; }
    }

    async function deleteCV(name){
      if(!confirm('Delete this CV?')) return;
      const r = await fetch('/api/cv-delete', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ client: CURRENT_CLIENT, position: CURRENT_POS, name }) });
      if(r.ok){ await loadPosition(CURRENT_POS); }
    }

    function openAddPosition(){
      if(!CURRENT_CLIENT){ alert('Select a client first'); return; }
      const title = prompt('New position title:'); if(!title) return;
      const salary = prompt('Salary (optional):') || '';
      const location = prompt('Location (optional):') || '';
      const experience = prompt('Experience (optional):') || '';
      const benefits = prompt('Benefits (optional):') || '';
      const notes = prompt('Notes (optional):') || '';
      saveNewPosition(title, {salary, location, experience, benefits, notes});
    }

    async function saveNewPosition(title, details){
      const r = await fetch('/api/position', { 
        method:'POST', 
        headers:{'Content-Type':'application/json'}, 
        body: JSON.stringify({ client: CURRENT_CLIENT, position: title, details }) 
      });
      if(r.ok){
        await pickClient(CURRENT_CLIENT);                    // refresh list
        const box=document.getElementById('positions');
        Array.prototype.forEach.call(box.children, function(x){
          if(x.firstChild && x.firstChild.textContent===title){ x.click(); }
        });
      }else{ 
        alert('Failed to add position'); 
      }
    }

    me().then(u => { if(u){ init(); } });
  </script>
  </body></html>`;
  res.send(html);
});

// -----------------------------
// Start
// -----------------------------
app.listen(PORT, () => {
  console.log(`\n🚀 GRID (Firebase Cloud) running on port ${PORT}`);
  console.log('   Clients & positions stored in Firestore');
  console.log('   CVs & logos stored in Firebase Storage');
  console.log('   Login hint shown only on localhost.');
});
