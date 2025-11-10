// =============================================================
// Hyreus Talent Portal — Stable build (Windows-friendly, no backticks)
// Features: magic link per client (persisted), auto-create folders,
// sidebar positions, notes, Yes/Maybe/No overlays, logo + footer.
// Folder layout: data/<Client>/<Position>/files/<CVs>
// Branding colours: bg #4d4445, accent #696162, text #ffffff
// =============================================================

const fs = require('fs');
const path = require('path');
const express = require('express');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'db.json');

// ---- Define your clients & positions (auto-created if missing) ----
const CLIENTS = {
  'PSE Power': ['Project Manager', 'Safety Advisor', 'Quantity Surveyor', 'Service Engineer'],
  'FlaktGroup': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Burlington Engineering': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Trane': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Munters': ['Project Manager', 'Sales Engineer', 'Service Technician'],
  'Clancy': ['Project Manager', 'Quantity Surveyor', 'Safety Advisor']
};

// ---------- helpers ----------
function safeMkdir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function ensureDirs() {
  safeMkdir(DATA_DIR);
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ clients: {} }, null, 2));
}

function readDB() {
  ensureDirs();
  return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function writeDB(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}

function autoCreateFolderTree() {
  // Make sure every client/position/files exists + feedback.json
  Object.keys(CLIENTS).forEach(function(client) {
    const clientDir = path.join(DATA_DIR, client);
    safeMkdir(clientDir);
    CLIENTS[client].forEach(function(pos) {
      const posDir = path.join(clientDir, pos);
      const filesDir = path.join(posDir, 'files');
      const feedbackPath = path.join(posDir, 'feedback.json');
      safeMkdir(filesDir);
      if (!fs.existsSync(feedbackPath)) fs.writeFileSync(feedbackPath, JSON.stringify({}, null, 2));
    });
  });
}

function listDirectories(dir) {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter(function(d){ return d.isDirectory(); })
      .map(function(d){ return d.name; });
  } catch (e) {
    console.error('listDirectories error for', dir, e);
    return [];
  }
}

function positionsForClient(clientDir) {
  // A position is any subfolder that contains a "files" folder
  try {
    const entries = fs.readdirSync(clientDir, { withFileTypes: true });
    const positions = [];
    for (var i=0; i<entries.length; i++){
      const e = entries[i];
      if (!e.isDirectory()) continue;
      const posDir = path.join(clientDir, e.name);
      const filesPath = path.join(posDir, 'files');
      if (fs.existsSync(filesPath) && fs.statSync(filesPath).isDirectory()) {
        positions.push(e.name);
      }
    }
    // Debug:
    console.log('📁  Scanned positions for', clientDir, '=>', positions);
    return positions;
  } catch (err) {
    console.error('positionsForClient error for', clientDir, err);
    return [];
  }
}

function getClientByToken(token) {
  const db = readDB();
  const meta = db.clients[token];
  if (!meta) return null;
  const clientDir = path.join(DATA_DIR, meta.id);
  return { meta: meta, clientDir: clientDir };
}

function positionPaths(clientDir, position) {
  const posDir = path.join(clientDir, position);
  const filesDir = path.join(posDir, 'files');
  const feedbackPath = path.join(posDir, 'feedback.json');
  safeMkdir(filesDir);
  if (!fs.existsSync(feedbackPath)) fs.writeFileSync(feedbackPath, JSON.stringify({}, null, 2));
  return { posDir: posDir, filesDir: filesDir, feedbackPath: feedbackPath };
}

function listFiles(filesDir) {
  if (!fs.existsSync(filesDir)) return [];
  try {
    return fs.readdirSync(filesDir).filter(function(f){ return !f.startsWith('.'); });
  } catch (e) {
    console.error('listFiles error for', filesDir, e);
    return [];
  }
}

// ---------- static: local logo ----------
app.get('/logo.jpg', function(req, res){
  const p = path.join(__dirname, 'logo.jpg');
  if (!fs.existsSync(p)) return res.status(404).send('logo not found');
  res.sendFile(p);
});

// ---------- APIs ----------
app.get('/api/client/:token', function(req, res){
  const c = getClientByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'invalid token' });
  const positions = positionsForClient(c.clientDir);
  res.json({ client: c.meta, positions: positions });
});

app.get('/api/list/:token', function(req, res){
  const c = getClientByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'invalid token' });
  const position = req.query.pos || '';
  if (!position) return res.status(400).json({ error: 'position required' });

  const paths = positionPaths(c.clientDir, position);
  const files = listFiles(paths.filesDir);
  const status = JSON.parse(fs.readFileSync(paths.feedbackPath, 'utf8'));
  res.json({ files: files, status: status });
});

app.get('/api/file/:token', function(req, res){
  const c = getClientByToken(req.params.token);
  if (!c) return res.status(404).send('invalid token');
  const position = req.query.pos || '';
  const file = req.query.name || '';
  if (!position || !file) return res.status(400).send('missing params');

  const paths = positionPaths(c.clientDir, position);
  const filePath = path.join(paths.filesDir, file);
  if (!fs.existsSync(filePath)) return res.status(404).send('not found');

  res.setHeader('Content-Disposition', 'inline; filename=' + file);
  fs.createReadStream(filePath).pipe(res);
});

app.post('/api/feedback/:token', function(req, res){
  const c = getClientByToken(req.params.token);
  if (!c) return res.status(404).json({ error: 'invalid token' });

  const position = req.body.position || '';
  const file = req.body.file || '';
  const decision = req.body.decision || ''; // yes | maybe | no | ''
  const note = req.body.note || '';

  if (!position || !file) return res.status(400).json({ error: 'position and file required' });

  const paths = positionPaths(c.clientDir, position);
  const status = JSON.parse(fs.readFileSync(paths.feedbackPath, 'utf8'));
  status[file] = { decision: decision, note: note };
  fs.writeFileSync(paths.feedbackPath, JSON.stringify(status, null, 2));
  res.json({ ok: true });
});

// ---------- Page: magic link ----------
app.get('/c/:token', function(req, res){
  const token = req.params.token;
  const c = getClientByToken(token);
  if (!c) return res.status(404).send('Invalid link');

  // Build HTML with concatenated strings (no backticks)
  var html = [];
  html.push('<!doctype html><html lang="en"><head><meta charset="utf-8"/>');
  html.push('<meta name="viewport" content="width=device-width, initial-scale=1"/>');
  html.push('<title>Hyreus Talent Portal — ' + c.meta.name + '</title>');
  html.push('<style>');
  html.push('html,body{height:100%;} body{margin:0;font-family:Segoe UI,Arial,sans-serif;background:#4d4445;color:#fff;}');
  html.push('.layout{display:grid;grid-template-columns:260px 1fr;min-height:100vh;}');
  html.push('.sidebar{background:#40393a;border-right:1px solid #696162;display:flex;flex-direction:column;gap:16px;padding:16px;position:sticky;top:0;height:100vh;}');
  html.push('.logo{display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center;}');
  html.push('.logo img{width:160px;height:auto;border-radius:8px;border:1px solid #696162;cursor:pointer;}');
  html.push('.clientname{font-weight:700;opacity:.9;margin-top:4px;}');
  html.push('.title{font-size:16px;font-weight:700;margin:8px 0 4px 0;opacity:.9;}');
  html.push('.positions{display:flex;flex-direction:column;gap:6px;overflow:auto;}');
  html.push('.pos{display:flex;align-items:center;gap:8px;padding:8px;border-radius:8px;border:1px solid #696162;background:#4b4445;cursor:pointer;}');
  html.push('.pos:hover{filter:brightness(1.1);} .pos.active{background:#5a5253;}');
  html.push('.folder{font-size:16px;}');
  html.push('.main{padding:20px;display:flex;flex-direction:column;gap:12px;}');
  html.push('.topbar{display:flex;align-items:center;justify-content:space-between;gap:8px;}');
  html.push('.back{border:1px solid #696162;background:#40393a;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer;}');
  html.push('.back:hover{filter:brightness(1.1);}');
  html.push('.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:8px;}');
  html.push('.card{position:relative;border:1px solid #696162;border-radius:10px;background:#463f40;padding:12px;display:flex;flex-direction:column;gap:8px;}');
  html.push('.file{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}');
  html.push('.note{width:100%;background:#40393a;color:#fff;border:1px solid #696162;border-radius:8px;padding:8px;}');
  html.push('.btns{display:flex;gap:8px;flex-wrap:wrap;}');
  html.push('.btn{border:none;color:#fff;padding:8px 10px;border-radius:8px;cursor:pointer;}');
  html.push('.btn-yes{background:#1f6b3b;} .btn-maybe{background:#b86e00;} .btn-no{background:#7a1b1b;}');
  html.push('.overlay{position:absolute;inset:0;border-radius:10px;pointer-events:none;opacity:.25;}');
  html.push('.ov-yes{background:#1f6b3b;} .ov-maybe{background:#b86e00;} .ov-no{background:#7a1b1b;} .ov-none{background:#0000;}');
  html.push('.footer{text-align:center;color:#c7c2c3;font-size:12px;opacity:.8;padding:12px;border-top:1px solid #696162;margin-top:auto;}');
  html.push('a.dl{color:#a8d1ff;text-decoration:none;} a.dl:hover{text-decoration:underline;}');
  html.push('</style></head><body>');
  html.push('<div class="layout">');

  // Sidebar
  html.push('<aside class="sidebar">');
  html.push('<div class="logo"><img src="/logo.jpg" id="logo-link" alt="HYREUS logo"/><div class="clientname" id="clientname"></div></div>');
  html.push('<div class="title">Positions</div><div class="positions" id="positions"></div>');
  html.push('<div class="footer">Powered by Hyreus Talent Portal</div>');
  html.push('</aside>');

  // Main
  html.push('<main class="main">');
  html.push('<div class="topbar"><div id="posTitle" style="font-size:18px;font-weight:700;"></div><button class="back" id="backBtn">Back to Positions</button></div>');
  html.push('<div class="grid" id="cards"></div>');
  html.push('</main>');

  html.push('</div>'); // layout

  // Client-side script (no backticks)
  html.push('<script>');
  html.push('var TOKEN=' + JSON.stringify(token) + ';');
  html.push('var CURRENT_POS="";');
  html.push('var clientNameEl=document.getElementById("clientname");');
  html.push('var positionsEl=document.getElementById("positions");');
  html.push('var cardsEl=document.getElementById("cards");');
  html.push('var posTitleEl=document.getElementById("posTitle");');
  html.push('var backBtn=document.getElementById("backBtn");');
  html.push('var logoLink=document.getElementById("logo-link");');

  // Load client + positions
  html.push('async function loadClient(){');
  html.push('  var r=await fetch("/api/client/"+TOKEN);');
  html.push('  if(!r.ok){ document.body.innerHTML="Invalid link"; return; }');
  html.push('  var d=await r.json();');
  html.push('  clientNameEl.textContent=d.client.name;');
  html.push('  positionsEl.innerHTML="";');
  html.push('  if(!d.positions || d.positions.length===0){');
  html.push('    var none=document.createElement("div"); none.style.opacity=".8"; none.textContent="No positions found"; positionsEl.appendChild(none);');
  html.push('    return;');
  html.push('  }');
  html.push('  d.positions.forEach(function(p){');
  html.push('    var item=document.createElement("div"); item.className="pos";');
  html.push('    var icon=document.createElement("span"); icon.className="folder"; icon.textContent="📁";');
  html.push('    var name=document.createElement("span"); name.textContent=p;');
  html.push('    item.appendChild(icon); item.appendChild(name);');
  html.push('    item.addEventListener("click", function(){ selectPosition(p, item); });');
  html.push('    positionsEl.appendChild(item);');
  html.push('  });');
  html.push('  showWelcome();');
  html.push('}');

  // Welcome state
  html.push('function showWelcome(){');
  html.push('  CURRENT_POS=""; posTitleEl.textContent="Select a position from the left"; cardsEl.innerHTML="";');
  html.push('  Array.prototype.forEach.call(positionsEl.children,function(c){ c.classList.remove("active"); });');
  html.push('}');

  // Select a position
  html.push('async function selectPosition(pos, el){');
  html.push('  CURRENT_POS=pos; posTitleEl.textContent=pos;');
  html.push('  Array.prototype.forEach.call(positionsEl.children,function(c){ c.classList.remove("active"); });');
  html.push('  if(el) el.classList.add("active");');
  html.push('  await loadFiles();');
  html.push('}');

  // Load files for the current position
  html.push('async function loadFiles(){');
  html.push('  if(!CURRENT_POS){ showWelcome(); return; }');
  html.push('  var r=await fetch("/api/list/"+TOKEN+"?pos="+encodeURIComponent(CURRENT_POS));');
  html.push('  var d=await r.json();');
  html.push('  cardsEl.innerHTML="";');
  html.push('  d.files.forEach(function(fname){');
  html.push('    var s=d.status[fname] || { decision:"", note:"" };');
  html.push('    var card=document.createElement("div"); card.className="card";');
  html.push('    var ov=document.createElement("div"); ov.className="overlay";');
  html.push('    if(s.decision==="yes"){ ov.classList.add("ov-yes"); }');
  html.push('    else if(s.decision==="maybe"){ ov.classList.add("ov-maybe"); }');
  html.push('    else if(s.decision==="no"){ ov.classList.add("ov-no"); }');
  html.push('    else { ov.classList.add("ov-none"); }');
  html.push('    var fdiv=document.createElement("div"); fdiv.className="file";');
  html.push('    var a=document.createElement("a"); a.className="dl"; a.target="_blank"; a.textContent=fname; a.href="/api/file/"+TOKEN+"?pos="+encodeURIComponent(CURRENT_POS)+"&name="+encodeURIComponent(fname);');
  html.push('    fdiv.appendChild(a);');
  html.push('    var btns=document.createElement("div"); btns.className="btns";');
  html.push('    var by=document.createElement("button"); by.className="btn btn-yes"; by.textContent="Yes";');
  html.push('    var bm=document.createElement("button"); bm.className="btn btn-maybe"; bm.textContent="Maybe";');
  html.push('    var bn=document.createElement("button"); bn.className="btn btn-no"; bn.textContent="No";');
  html.push('    btns.appendChild(by); btns.appendChild(bm); btns.appendChild(bn);');
  html.push('    var note=document.createElement("textarea"); note.className="note"; note.placeholder="Add note..."; note.value=(s.note||"");');
  html.push('    by.addEventListener("click", function(){ saveFeedback(fname,"yes",note); });');
  html.push('    bm.addEventListener("click", function(){ saveFeedback(fname,"maybe",note); });');
  html.push('    bn.addEventListener("click", function(){ saveFeedback(fname,"no",note); });');
  html.push('    note.addEventListener("change", function(){ saveFeedback(fname,(s.decision||""),note); });');
  html.push('    card.appendChild(ov); card.appendChild(fdiv); card.appendChild(btns); card.appendChild(note);');
  html.push('    cardsEl.appendChild(card);');
  html.push('  });');
  html.push('}');

  // Save feedback
  html.push('async function saveFeedback(fname, decision, noteEl){');
  html.push('  var noteVal = noteEl ? noteEl.value : "";');
  html.push('  await fetch("/api/feedback/"+TOKEN,{ method:"POST", headers:{ "Content-Type":"application/json" }, body: JSON.stringify({ position: CURRENT_POS, file: fname, decision: decision, note: noteVal }) });');
  html.push('  await loadFiles();');
  html.push('}');

  // Back and logo -> home
  html.push('backBtn.addEventListener("click", showWelcome);');
  html.push('logoLink.addEventListener("click", showWelcome);');

  html.push('loadClient();');
  html.push('</script>');
  html.push('</body></html>');

  res.send(html.join(''));
});

// ---------- Bootstrap: create folders, then create tokens only if missing ----------
function bootstrap() {
  ensureDirs();
  autoCreateFolderTree();

  var db = readDB();
  var hasClients = Object.keys(db.clients).length > 0;
  if (hasClients) {
    console.log('ℹ️  Using existing tokens from db.json');
    return;
  }

  console.log('\n🗂️  Generating client links for first run:');
  Object.keys(CLIENTS).forEach(function(id){
    const token = uuidv4();
    db.clients[token] = { id: id, name: id };
    console.log('🔗 ' + id + ' → http://localhost:' + PORT + '/c/' + token);
  });
  writeDB(db);
}

app.listen(PORT, function(){
  console.log('\n🚀 Hyreus Talent Portal running on http://localhost:' + PORT);
  bootstrap();
});
