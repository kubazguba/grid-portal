/**
 * GRID — Talent Collaboration Portal (Hyreus)
 * -------------------------------------------------------------------
 * Includes:
 * - Branding: "GRID" everywhere, logo served from /logo (png/jpg).
 * - Sidebar: client logos, CV counts, active position highlight.
 * - Center header "<Client> — <Position>".
 * - Position Details panel (salary, location, experience, benefits, notes).
 * - Notes: add + delete (admins can delete all; clients only their own).
 * - Status toggle (Yes/Maybe/No/Neutral).
 * - Auth (admins/clients), client scoping, email notifications to admins.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const nodemailer = require('nodemailer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------------- Config ----------------
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const LOGO_DIR = path.join(__dirname, 'logos');

// Users (add client users here)
const users = [
  { email: 'jakub@hyreus.co.uk', password: 'jakub', name: 'Jakub', role: 'admin' },
  { email: 'john@hyreus.co.uk',  password: 'john',  name: 'John',  role: 'admin' },
  // Example client user:
  // { email: 'client@psepower.ie', password: 'pse', name: 'PSE Client', role: 'client', clientId: 'PSE Power' },
];

// Clients & positions (auto-creates folders)
const CLIENTS = {
  'PSE Power': ['Project Manager', 'Safety Advisor', 'Quantity Surveyor', 'Service Engineer'],
  'FlaktGroup': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Burlington Engineering': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Trane': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Munters': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Clancy': ['Project Manager', 'Quantity Surveyor', 'Safety Advisor']
};

const BRAND = { bg: '#4d4445', accent: '#696162', text: '#ffffff', lightCard: '#5a5253' };

// Email (admins only)
const NOTIFY_FROM = 'info@hyreus.co.uk';
const NOTIFY_TO = ['jakub@hyreus.co.uk', 'john@hyreus.co.uk'];
const SMTP_PASSWORD = 'wskrzesic12'; // local use

const transporter = nodemailer.createTransport({
  host: 'smtp.office365.com',
  port: 587,
  secure: false,
  auth: { user: NOTIFY_FROM, pass: SMTP_PASSWORD }
});

// -------------- Helpers & bootstrap --------------
function safeMkdir(p){ if(!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function ensureDirs(){
  safeMkdir(DATA_DIR);
  safeMkdir(LOGO_DIR);
  // Create structure & files if missing
  Object.keys(CLIENTS).forEach(c => {
    const cdir = path.join(DATA_DIR, c);
    safeMkdir(cdir);
    CLIENTS[c].forEach(pos => {
      const pdir = path.join(cdir, pos);
      safeMkdir(path.join(pdir, 'files'));
      const fb = path.join(pdir, 'feedback.json');
      if (!fs.existsSync(fb)) fs.writeFileSync(fb, JSON.stringify({}, null, 2));
      const det = path.join(pdir, 'details.json');
      if (!fs.existsSync(det)) fs.writeFileSync(det, JSON.stringify(defaultDetails(), null, 2));
    });
  });
}
function feedbackPath(client, position){
  return path.join(DATA_DIR, client, position, 'feedback.json');
}
function detailsPath(client, position){
  return path.join(DATA_DIR, client, position, 'details.json');
}
function filesDirPath(client, position){
  return path.join(DATA_DIR, client, position, 'files');
}
function readJSON(fp, fallback){
  if (!fs.existsSync(fp)) return (fallback ?? {});
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return (fallback ?? {}); }
}
function writeJSON(fp, data){
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}
function listDirs(dir){
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
}
function listFiles(dir){
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => !f.startsWith('.'));
}
function defaultDetails(){
  return { salary: "", location: "", experience: "", benefits: "", notes: "" };
}

// -------------- Auth --------------
app.use(session({
  secret: 'hyreus-local-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 1000 * 60 * 60 * 8 }
}));

function requireAuth(req, res, next){
  if (req.session && req.session.user) return next();
  res.status(401).json({ error: 'unauthorized' });
}

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = users.find(x => x.email === email && x.password === password);
  if (!u) return res.status(401).json({ error: 'invalid' });
  req.session.user = { email: u.email, name: u.name || '', role: u.role, clientId: u.clientId || null };
  res.json({ ok: true, user: req.session.user });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', (req, res) => res.json({ user: req.session.user || null }));

// -------------- Email helpers --------------
async function sendEmail(type, { client, position, file, content, actor }){
  const when = new Date().toLocaleString();
  let subject, html;
  if (type === 'status') {
    subject = `Status update – ${file}`;
    html = `<p><b>Client:</b> ${client}</p><p><b>Position:</b> ${position}</p><p><b>File:</b> ${file}</p><p><b>New status:</b> ${content}</p><p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p><p>${when}</p>`;
  } else {
    subject = `New note – ${file}`;
    html = `<p><b>Client:</b> ${client}</p><p><b>Position:</b> ${position}</p><p><b>File:</b> ${file}</p><p><b>Note:</b> ${content}</p><p><b>By:</b> ${actor.name} &lt;${actor.email}&gt;</p><p>${when}</p>`;
  }
  try { await transporter.sendMail({ from: NOTIFY_FROM, to: NOTIFY_TO, subject, html }); }
  catch (e) { console.error('Email error:', e.message); }
}

// -------------- APIs --------------
app.get('/api/clients', requireAuth, (req, res) => {
  const u = req.session.user;
  if (u.role === 'admin') {
    return res.json({ clients: listDirs(DATA_DIR) });
  } else {
    return res.json({ clients: [u.clientId] });
  }
});

// Positions with counts
app.get('/api/positions', requireAuth, (req, res) => {
  const client = req.query.client || '';
  const u = req.session.user;
  if (!client) return res.status(400).json({ error: 'client required' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const posDirs = listDirs(path.join(DATA_DIR, client));
  const positions = posDirs.map(p => {
    const count = listFiles(filesDirPath(client, p)).length;
    return { name: p, count };
  });
  res.json({ positions });
});

app.get('/api/list', requireAuth, (req, res) => {
  const client = req.query.client || '';
  const pos = req.query.pos || '';
  const u = req.session.user;
  if (!client || !pos) return res.status(400).json({ error: 'missing' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const fbPath = feedbackPath(client, pos);
  const filesDir = filesDirPath(client, pos);
  const files = listFiles(filesDir);
  const fb = readJSON(fbPath, {});
  files.forEach(f => { if (!fb[f]) fb[f] = { decision: 'neutral', notes: [] }; });
  writeJSON(fbPath, fb);
  res.json({ files, status: fb });
});

// Position details
app.get('/api/details', requireAuth, (req, res) => {
  const client = req.query.client || '';
  const pos = req.query.pos || '';
  const u = req.session.user;
  if (!client || !pos) return res.status(400).json({ error: 'missing' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });
  const det = readJSON(detailsPath(client, pos), defaultDetails());
  res.json({ details: det });
});
app.post('/api/details', requireAuth, (req, res) => {
  const { client, position, details } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !details) return res.status(400).json({ error: 'bad request' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const detPath = detailsPath(client, position);
  const merged = Object.assign(defaultDetails(), details);
  writeJSON(detPath, merged);
  res.json({ ok: true, details: merged });
});

// Stream file
app.get('/api/file', requireAuth, (req, res) => {
  const client = req.query.client || '';
  const pos = req.query.pos || '';
  const name = req.query.name || '';
  const u = req.session.user;
  if (!client || !pos || !name) return res.status(400).send('missing');
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).send('forbidden');
  const fpath = path.join(filesDirPath(client, pos), name);
  if (!fs.existsSync(fpath)) return res.status(404).send('not found');
  res.setHeader('Content-Disposition', 'inline; filename=' + name);
  fs.createReadStream(fpath).pipe(res);
});

// Update status
app.post('/api/status', requireAuth, async (req, res) => {
  const { client, position, file, status } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !['yes','maybe','no','neutral'].includes(status)) return res.status(400).json({ error: 'bad request' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });

  const fbPath = feedbackPath(client, position);
  const fb = readJSON(fbPath, {});
  if (!fb[file]) fb[file] = { decision: 'neutral', notes: [] };
  fb[file].decision = (fb[file].decision === status && status !== 'neutral') ? 'neutral' : status;
  writeJSON(fbPath, fb);
  await sendEmail('status', { client, position, file, content: fb[file].decision, actor: u });
  res.json({ ok: true });
});

// Add note
app.post('/api/note', requireAuth, async (req, res) => {
  const { client, position, file, text } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !text) return res.status(400).json({ error: 'bad request' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });
  const fbPath = feedbackPath(client, position);
  const fb = readJSON(fbPath, {});
  if (!fb[file]) fb[file] = { decision: 'neutral', notes: [] };
  fb[file].notes.unshift({ text: String(text).trim(), authorEmail: u.email, authorName: u.name, timestamp: new Date().toISOString() });
  writeJSON(fbPath, fb);
  await sendEmail('note', { client, position, file, content: text, actor: u });
  res.json({ ok: true });
});

// Delete note
app.post('/api/note-delete', requireAuth, (req, res) => {
  const { client, position, file, timestamp } = req.body || {};
  const u = req.session.user;
  if (!client || !position || !file || !timestamp) return res.status(400).json({ error: 'bad request' });
  if (u.role !== 'admin' && u.clientId !== client) return res.status(403).json({ error: 'forbidden' });
  const fbPath = feedbackPath(client, position);
  const fb = readJSON(fbPath, {});
  if (!fb[file] || !Array.isArray(fb[file].notes)) return res.json({ ok: true });
  const notes = fb[file].notes;
  const idx = notes.findIndex(n => n.timestamp === timestamp);
  if (idx === -1) return res.json({ ok: true });
  const isAuthor = (notes[idx].authorEmail === u.email);
  if (!(u.role === 'admin' || isAuthor)) return res.status(403).json({ error: 'forbidden' });
  notes.splice(idx, 1);
  fb[file].notes = notes;
  writeJSON(fbPath, fb);
  res.json({ ok: true });
});

// -------------- Logos --------------
// Main logo (supports png or jpg)
app.get('/logo', (req, res) => {
  const png = path.join(__dirname, 'logo.png');
  const jpg = path.join(__dirname, 'logo.jpg');
  if (fs.existsSync(png)) return res.sendFile(png);
  if (fs.existsSync(jpg)) return res.sendFile(jpg);
  res.status(404).end();
});
// Client logos: /logos/<Client>  (route will resolve .png or .jpg)
app.get('/logos/:client', (req, res) => {
  const id = req.params.client;
  const png = path.join(LOGO_DIR, `${id}.png`);
  const jpg = path.join(LOGO_DIR, `${id}.jpg`);
  if (fs.existsSync(png)) return res.sendFile(png);
  if (fs.existsSync(jpg)) return res.sendFile(jpg);
  res.status(404).end();
});

// -------------- UI --------------
app.get('/', (req, res) => {
  const local = (req.headers.host || '').includes('localhost') || (req.headers.host || '').includes('127.0.0.1');

  const css = `
    html,body{height:100%} body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:${BRAND.bg};color:${BRAND.text};}
    .wrap{max-width:1200px;margin:0 auto;padding:20px;}
    input,select,textarea{background:#40393a;color:#fff;border:1px solid ${BRAND.accent};border-radius:8px;padding:8px;}
    button{border:1px solid ${BRAND.accent};background:#40393a;color:#fff;border-radius:8px;padding:8px 12px;cursor:pointer;}
    button:hover{filter:brightness(1.06)}
    .layout{display:grid;grid-template-columns:260px 1fr;gap:16px;}
    .sidebar{background:#40393a;border:1px solid ${BRAND.accent};border-radius:12px;padding:16px;display:flex;flex-direction:column;gap:12px;position:sticky;top:20px;height:calc(100vh - 40px);}
    .logo{display:flex;flex-direction:column;align-items:center;gap:8px;}
    .pos{padding:6px;border:1px solid ${BRAND.accent};border-radius:8px;margin-bottom:6px;cursor:pointer;}
    .pos.active{background:#5a5253;}
    .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;}
    .card{position:relative;border:1px solid ${BRAND.accent};border-radius:10px;background:#463f40;padding:12px;display:flex;flex-direction:column;gap:8px;}
    .file{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
    .note{width:100%}
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
      ${local ? '<div style="opacity:.6;font-size:12px;margin-top:6px;">Admins: jakub@hyreus.co.uk / jakub &nbsp; | &nbsp; john@hyreus.co.uk / john</div>' : ''}
    </div>

    <div id="app" style="display:none;"></div>
  </div>

  <script>
    let ME=null, CURRENT_CLIENT="", CURRENT_POS="";
    async function api(p,o){return fetch(p,o).then(r=>r.json())}
    async function me(){const j=await api('/api/me'); ME=j.user; return ME;}

    async function login(){
      const email=document.getElementById('email').value;
      const password=document.getElementById('password').value;
      const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});
      if(r.ok){ init(); } else { alert('Login failed'); }
    }
    async function logout(){ await fetch('/api/logout',{method:'POST'}); location.reload(); }

    function clientLogoImgTag(name){
      const src='/logos/'+encodeURIComponent(name);
      return '<img src="'+src+'" onerror="this.style.display=\\'none\\'" style="width:140px;max-height:90px;object-fit:contain;border-radius:6px;border:1px solid ${BRAND.accent};"/>';
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
        left += '<div id="clientLogoBox" style="text-align:center;"></div>';
        left += '<div style="margin-top:4px;"><select id="clientSel" style="width:100%;"></select></div>';
      } else if(u.role==='client' && u.clientId){
        left += '<div style="text-align:center;">'+clientLogoImgTag(u.clientId)+'</div>';
      }

      left += '<div id="positions"></div>';
      left += '<div class="footer"><div class="sep"></div>powered by Hyreus</div>';
      left += '<div style="margin-top:8px;"><button onclick="logout()">Logout</button></div></aside>';

      const right = '<main><div id="main"></div></main>';
      app.innerHTML = '<div class="layout">'+left+right+'</div>';

      await loadClients();
    }

    async function loadClients(){
      const j = await api('/api/clients');
      if(ME.role==='admin'){
        const sel=document.getElementById('clientSel');
        sel.innerHTML='';
        (j.clients||[]).forEach(c=>{
          const o=document.createElement('option'); o.value=c; o.textContent=c; sel.appendChild(o);
        });
        if(j.clients && j.clients.length){ pickClient(j.clients[0]); }
        sel.onchange=function(){ pickClient(this.value); };
      }else{
        pickClient(ME.clientId);
      }
    }

    function updateAdminClientLogo(){
      const box=document.getElementById('clientLogoBox');
      if(!box) return;
      if(!CURRENT_CLIENT){ box.innerHTML=''; return; }
      box.innerHTML = clientLogoImgTag(CURRENT_CLIENT);
    }

    async function pickClient(c){
      CURRENT_CLIENT=c;
      updateAdminClientLogo();
      const r = await api('/api/positions?client='+encodeURIComponent(c));
      const box=document.getElementById('positions'); box.innerHTML='';
      (r.positions||[]).forEach(p=>{
        const d=document.createElement('div'); d.className='pos'; d.innerHTML = p.name + ' ('+p.count+')';
        d.onclick=function(){ selectPosition(p.name, d); };
        box.appendChild(d);
      });
      document.getElementById('main').innerHTML = '<h2 style="margin-top:0;text-align:center;">'+(c||'')+'</h2><p style="text-align:center;">Select a position from the left.</p>';
    }

    async function selectPosition(pos, el){
      CURRENT_POS=pos;
      // highlight active
      const box=document.getElementById('positions');
      Array.prototype.forEach.call(box.children, function(x){ x.classList.remove('active'); });
      if(el) el.classList.add('active');
      await loadPosition(pos);
    }

    async function loadPosition(pos){
      // load details + files
      const detailsResp = await api('/api/details?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(pos));
      const listResp = await api('/api/list?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(pos));
      const main = document.getElementById('main');

      // header
      let h = '<div class="titleCentered">'+CURRENT_CLIENT+' — '+pos+'</div>';

      // details summary
      const d = (detailsResp.details || {});
      function fmt(v){ return v && String(v).trim() ? String(v) : '<span class="muted">Not provided</span>'; }
      h += '<div class="details" id="detBox">';
      h += '<h3>Position Details</h3>';
      h += '<div class="field"><div class="label">💼 Salary</div><div>'+fmt(d.salary)+'</div></div>';
      h += '<div class="field"><div class="label">📍 Location</div><div>'+fmt(d.location)+'</div></div>';
      h += '<div class="field"><div class="label">🧠 Experience</div><div>'+fmt(d.experience)+'</div></div>';
      h += '<div class="field"><div class="label">💰 Benefits</div><div>'+fmt(d.benefits)+'</div></div>';
      h += '<div class="field"><div class="label">🗒 Notes</div><div>'+fmt(d.notes)+'</div></div>';
      h += '<div style="margin-top:8px;"><button onclick="editDetails()">Edit Details</button></div>';
      h += '</div>';

      // files grid
      h += '<div class="grid">';
      (listResp.files||[]).forEach(f=>{
        const safeId = f.replace(/[^a-zA-Z0-9]/g,'_');
        const s = (listResp.status||{})[f] || { decision:'neutral', notes:[] };
        let overlay = '#0000';
        if(s.decision==='yes') overlay = '#1f6b3b55';
        else if(s.decision==='maybe') overlay = '#b86e0055';
        else if(s.decision==='no') overlay = '#7a1b1b55';
        h += '<div class="card">';
        h += '<div class="file"><a target="_blank" style="color:#a8d1ff;text-decoration:none;" href="/api/file?client='+encodeURIComponent(CURRENT_CLIENT)+'&pos='+encodeURIComponent(CURRENT_POS)+'&name='+encodeURIComponent(f)+'">'+f+'</a></div>';
        h += '<div style="display:flex;gap:6px;flex-wrap:wrap;">';
        h += '<button onclick="setStatus(\\''+f+'\\',\\'yes\\')">Yes</button>';
        h += '<button onclick="setStatus(\\''+f+'\\',\\'maybe\\')">Maybe</button>';
        h += '<button onclick="setStatus(\\''+f+'\\',\\'no\\')">No</button>';
        h += '<button onclick="setStatus(\\''+f+'\\',\\'neutral\\')">Neutral</button>';
        h += '</div>';
        h += '<textarea id="nt'+safeId+'" class="note" placeholder="Add a note..."></textarea>';
        h += '<div><button onclick="addNote(\\''+f+'\\')">Add Note</button></div>';
        h += '<div style="position:absolute;inset:0;border-radius:10px;pointer-events:none;background:'+overlay+'"></div>';
        h += '<div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">';
        (s.notes||[]).forEach(n=>{
          const canDel = (ME.role==='admin') || (n.authorEmail===ME.email);
          h += '<div class="noteRow">';
          h += '<div><div><b>'+(n.authorName||'')+'</b> &lt;'+n.authorEmail+'&gt; — '+new Date(n.timestamp).toLocaleString()+'</div><div>'+n.text+'</div></div>';
          h += (canDel ? '<button class="trash" onclick="delNote(\\''+f+'\\',\\''+n.timestamp+'\\')">🗑️</button>' : '');
          h += '</div>';
        });
        h += '</div></div>'; // card
      });
      h += '</div>'; // grid

      main.innerHTML = h;
      window._currentDetails = d;
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

    async function setStatus(f,s){
      await fetch('/api/status',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({client:CURRENT_CLIENT,position:CURRENT_POS,file:f,status:s})
      });
      await loadPosition(CURRENT_POS);
    }

    async function addNote(f){
      const id = 'nt'+f.replace(/[^a-zA-Z0-9]/g,'_');
      const t = document.getElementById(id).value.trim();
      if(!t) return;
      await fetch('/api/note',{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({client:CURRENT_CLIENT,position:CURRENT_POS,file:f,text:t})
      });
      document.getElementById(id).value='';
      await loadPosition(CURRENT_POS);
    }

    async function delNote(file, ts){
      if(!confirm('Delete this note?')) return;
      const r = await fetch('/api/note-delete', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ client: CURRENT_CLIENT, position: CURRENT_POS, file: file, timestamp: ts })
      });
      if(r.ok){ await loadPosition(CURRENT_POS); } else { alert('Failed to delete'); }
    }

    // start
    me().then(u => { if(u){ init(); } });
  </script>
  </body></html>`;

  res.send(html);
});

// -------------- Start --------------
app.listen(PORT, () => {
  ensureDirs();
  console.log('\\n🚀 GRID (Hyreus) running on http://localhost:'+PORT);
  console.log('   Main logo path: /logo  (place logo.png or logo.jpg in app folder)');
  console.log('   Client logos: /logos/<Client>.png or .jpg');
  console.log('   Position details stored per role as details.json');
  console.log('   Login hint shown only on localhost.');
});
