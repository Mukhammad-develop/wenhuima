// Wenhui Ma portfolio server: serves the website and the AI admin panel at /admin.
// No dependencies; needs Node 18+.  Start with:  node server.js
'use strict';
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

// ---------- config ----------
const ROOT = __dirname;
loadEnv(path.join(ROOT, '.env'));
const PORT = parseInt(process.env.PORT || '3000', 10);
const ADMIN_USER = process.env.ADMIN_USERNAME || '';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || '';
const API_KEY = process.env.OPENROUTER_API_KEY || '';
const DEFAULT_MODEL = process.env.AI_MODEL || 'anthropic/claude-sonnet-5.5';
const MODELS = [
  { id: 'anthropic/claude-sonnet-5.5', label: 'Claude Sonnet 5.5 (recommended)' },
  { id: 'anthropic/claude-opus-5.5', label: 'Claude Opus 5.5 (strongest, ~2× cost)' },
];
if (!MODELS.some(m => m.id === DEFAULT_MODEL)) MODELS.unshift({ id: DEFAULT_MODEL, label: DEFAULT_MODEL });
const SITE = path.resolve(process.env.SITE_DIR || path.join(ROOT, 'site'));
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const ADMIN_DIR = path.join(ROOT, 'admin');
const HISTORY = path.join(DATA, 'history');
const CHAT_FILE = path.join(DATA, 'chat.json');
const MAX_STEPS = 60;

if (!ADMIN_USER || !ADMIN_PASS) console.warn('WARNING: ADMIN_USERNAME / ADMIN_PASSWORD not set in .env — admin login disabled.');
if (!API_KEY) console.warn('WARNING: OPENROUTER_API_KEY not set in .env — AI chat disabled.');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if (/^(['"]).*\1$/.test(v)) v = v.slice(1, -1);
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

// When SITE_DIR points at an empty persistent disk, seed it with the bundled site.
function seedSite() {
  const bundled = path.join(ROOT, 'site');
  if (SITE === bundled) return;
  if (fs.existsSync(SITE) && fs.readdirSync(SITE).length) return;
  fs.mkdirSync(SITE, { recursive: true });
  fs.cpSync(bundled, SITE, { recursive: true });
  console.log('Seeded', SITE, 'from bundled site/');
}
seedSite();
fs.mkdirSync(HISTORY, { recursive: true });

// ---------- helpers ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf',
  '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};
const TEXT_EXT = new Set(['.html', '.htm', '.css', '.js', '.mjs', '.json', '.svg', '.txt', '.md', '.xml', '.webmanifest', '.csv']);

function inside(base, rel) {
  const p = path.resolve(base, String(rel || '').replace(/^[/\\]+/, ''));
  if (p !== base && !p.startsWith(base + path.sep)) throw new Error('Path is outside the website folder: ' + rel);
  return p;
}
const relSite = p => path.relative(SITE, p).split(path.sep).join('/');

function sendJSON(res, code, obj, headers = {}) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 40 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function serveFile(req, res, file, cache) {
  let st;
  try { st = await fsp.stat(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'Content-Type': type, 'Cache-Control': cache, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
  const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
  if (range) {
    let start = range[1] === '' ? st.size - parseInt(range[2], 10) : parseInt(range[1], 10);
    let end = range[1] !== '' && range[2] !== '' ? parseInt(range[2], 10) : st.size - 1;
    start = Math.max(0, start); end = Math.min(end, st.size - 1);
    if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); res.end(); return true; }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

// Image size from file header (png / jpeg / gif / webp) so uploads can be placed with the right aspect ratio.
function imageSize(buf) {
  try {
    if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.slice(0, 6).toString('ascii').startsWith('GIF')) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') {
      const t = buf.slice(12, 16).toString('ascii');
      if (t === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (t === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
      if (t === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const mk = buf[i + 1];
        if (mk >= 0xc0 && mk <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(mk)) return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* unknown */ }
  return null;
}

// ---------- auth ----------
// token -> expiry; saved to disk so a server restart doesn't log the admin out
const SESSIONS_FILE = path.join(DATA, 'sessions.json');
const sessions = new Map((() => { try { return Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8'))); } catch { return []; } })());
function saveSessions() {
  for (const [t, exp] of sessions) if (exp < Date.now()) sessions.delete(t);
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(Object.fromEntries(sessions)), { mode: 0o600 });
}
const SESSION_MS = 30 * 24 * 3600 * 1000;
const loginFails = new Map(); // ip -> [timestamps]

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function reloadSessions() {
  try { for (const [t, exp] of Object.entries(JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')))) sessions.set(t, exp); } catch { /* none yet */ }
}
function authed(req) {
  const t = cookies(req).wm_admin;
  if (t && !sessions.has(t)) reloadSessions(); // the host may run several copies of this app
  const exp = t && sessions.get(t);
  if (!exp) return false;
  if (exp < Date.now()) { sessions.delete(t); return false; }
  return true;
}
function safeEq(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function clientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
}
function isHttps(req) { return req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https'; }

// ---------- chat storage ----------
let chat = loadChat();
function loadChat() {
  try { return JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch { return { messages: [], log: [] }; }
}
function saveChat() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CHAT_FILE + '.tmp', JSON.stringify(chat));
  fs.renameSync(CHAT_FILE + '.tmp', CHAT_FILE);
}

// ---------- change history (undo) ----------
class ChangeSet {
  constructor(prompt) {
    this.id = new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex');
    this.dir = path.join(HISTORY, this.id);
    this.prompt = prompt;
    this.files = new Map(); // rel -> existed
  }
  async before(abs) {
    const rel = relSite(abs);
    if (this.files.has(rel)) return;
    let existed = false;
    try {
      const st = await fsp.stat(abs);
      if (st.isFile()) {
        existed = true;
        const dest = path.join(this.dir, 'files', rel);
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.copyFile(abs, dest);
      }
    } catch { /* new file */ }
    this.files.set(rel, existed);
    await this.save();
  }
  async save() {
    await fsp.mkdir(this.dir, { recursive: true });
    await fsp.writeFile(path.join(this.dir, 'manifest.json'), JSON.stringify({
      id: this.id, time: new Date().toISOString(), prompt: this.prompt,
      files: [...this.files].map(([p, existed]) => ({ path: p, existed })),
    }, null, 1));
  }
}
async function listHistory() {
  const out = [];
  for (const id of (await fsp.readdir(HISTORY).catch(() => [])).sort().reverse()) {
    try { out.push(JSON.parse(await fsp.readFile(path.join(HISTORY, id, 'manifest.json'), 'utf8'))); } catch { /* skip */ }
  }
  return out;
}
async function undoLast() {
  const [last] = await listHistory();
  if (!last) return null;
  const dir = path.join(HISTORY, last.id);
  for (const f of last.files) {
    const abs = inside(SITE, f.path);
    if (f.existed) {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.copyFile(path.join(dir, 'files', f.path), abs);
    } else {
      await fsp.rm(abs, { force: true });
    }
  }
  await fsp.rm(dir, { recursive: true, force: true });
  return last;
}

// ---------- AI tools ----------
const TOOLS = [
  {
    name: 'list_files',
    description: 'List files and folders in the website (recursive). Paths are relative to the website root.',
    parameters: { type: 'object', properties: { path: { type: 'string', description: 'Folder to list, default "" (root).' } } },
  },
  {
    name: 'read_file',
    description: 'Read a text file with line numbers. Use start_line/end_line for long files. Very long lines are cut at 4000 characters (use search_files to find exact text inside them).',
    parameters: {
      type: 'object', required: ['path'],
      properties: { path: { type: 'string' }, start_line: { type: 'integer' }, end_line: { type: 'integer' } },
    },
  },
  {
    name: 'write_file',
    description: 'Create a file or replace its whole content. Folders are created automatically.',
    parameters: { type: 'object', required: ['path', 'content'], properties: { path: { type: 'string' }, content: { type: 'string' } } },
  },
  {
    name: 'edit_file',
    description: 'Replace exact text in a file. old_string must match the file exactly (including whitespace) and be unique unless replace_all is true. Prefer this over write_file for changes to existing files.',
    parameters: {
      type: 'object', required: ['path', 'old_string', 'new_string'],
      properties: { path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' }, replace_all: { type: 'boolean' } },
    },
  },
  {
    name: 'search_files',
    description: 'Search text files of the website for a string (or regular expression if regex=true). Returns file:line and a snippet.',
    parameters: {
      type: 'object', required: ['query'],
      properties: { query: { type: 'string' }, regex: { type: 'boolean' }, path: { type: 'string', description: 'Folder or file to search, default whole site.' } },
    },
  },
  {
    name: 'move_file',
    description: 'Rename or move a file inside the website.',
    parameters: { type: 'object', required: ['from', 'to'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the website (it can still be restored with the Undo button).',
    parameters: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
  },
];

async function walk(dir, out = []) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out); else out.push(p);
  }
  return out;
}
const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(1) + ' MB';

async function runTool(name, a, cs) {
  switch (name) {
    case 'list_files': {
      const base = inside(SITE, a.path || '');
      const files = await walk(base);
      const lines = [];
      for (const f of files.sort()) {
        const st = await fsp.stat(f);
        let extra = '';
        if (/\.(png|jpe?g|gif|webp)$/i.test(f)) {
          const fd = await fsp.open(f, 'r'); const b = Buffer.alloc(65536); await fd.read(b, 0, 65536, 0); await fd.close();
          const s = imageSize(b); if (s) extra = ` ${s.w}×${s.h}`;
        }
        lines.push(`${relSite(f)}  (${kb(st.size)}${extra})`);
      }
      return lines.join('\n') || '(empty)';
    }
    case 'read_file': {
      const abs = inside(SITE, a.path);
      if (!TEXT_EXT.has(path.extname(abs).toLowerCase())) {
        const st = await fsp.stat(abs);
        return `${a.path} is a binary file (${kb(st.size)}); it cannot be read as text. Reference it by path in HTML/CSS.`;
      }
      const lines = (await fsp.readFile(abs, 'utf8')).split('\n');
      const s = Math.max(1, a.start_line || 1);
      const e = Math.min(lines.length, a.end_line || s + 1499);
      let out = '', total = 0;
      for (let i = s; i <= e; i++) {
        let l = lines[i - 1];
        if (l.length > 4000) l = l.slice(0, 4000) + ` …[line cut: ${l.length} chars total]`;
        out += `${i}\t${l}\n`; total += l.length;
        if (total > 150000) { out += `…[stopped at line ${i}; ask for start_line=${i + 1}]\n`; break; }
      }
      return `${a.path} (${lines.length} lines)\n` + out + (e < lines.length && total <= 150000 ? `…[${lines.length - e} more lines; use start_line=${e + 1}]` : '');
    }
    case 'write_file': {
      const abs = inside(SITE, a.path);
      await cs.before(abs);
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, String(a.content ?? ''));
      return `Wrote ${a.path} (${kb(Buffer.byteLength(String(a.content ?? '')))})`;
    }
    case 'edit_file': {
      const abs = inside(SITE, a.path);
      const text = await fsp.readFile(abs, 'utf8');
      const old = String(a.old_string ?? '');
      if (!old) throw new Error('old_string is empty');
      const count = text.split(old).length - 1;
      if (count === 0) throw new Error('old_string was not found in ' + a.path + '. Read the file again and copy the text exactly.');
      if (count > 1 && !a.replace_all) throw new Error(`old_string appears ${count} times in ${a.path}; add more surrounding text or set replace_all.`);
      await cs.before(abs);
      await fsp.writeFile(abs, a.replace_all ? text.split(old).join(String(a.new_string ?? '')) : text.replace(old, () => String(a.new_string ?? '')));
      return `Edited ${a.path} (${a.replace_all ? count : 1} replacement${count > 1 && a.replace_all ? 's' : ''})`;
    }
    case 'search_files': {
      const base = inside(SITE, a.path || '');
      const st = await fsp.stat(base);
      const files = st.isDirectory() ? await walk(base) : [base];
      const re = a.regex ? new RegExp(a.query, 'i') : null;
      const q = String(a.query).toLowerCase();
      const hits = [];
      for (const f of files) {
        if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
        const lines = (await fsp.readFile(f, 'utf8')).split('\n');
        lines.forEach((l, i) => {
          const idx = re ? l.search(re) : l.toLowerCase().indexOf(q);
          if (idx >= 0 && hits.length < 200) {
            const from = Math.max(0, idx - 150);
            hits.push(`${relSite(f)}:${i + 1}: ${from ? '…' : ''}${l.slice(from, idx + 250)}${l.length > idx + 250 ? '…' : ''}`);
          }
        });
      }
      return hits.length ? hits.join('\n') + (hits.length >= 200 ? '\n…[more results cut]' : '') : 'No matches.';
    }
    case 'move_file': {
      const from = inside(SITE, a.from), to = inside(SITE, a.to);
      await cs.before(from); await cs.before(to);
      await fsp.mkdir(path.dirname(to), { recursive: true });
      await fsp.rename(from, to);
      return `Moved ${a.from} → ${a.to}`;
    }
    case 'delete_file': {
      const abs = inside(SITE, a.path);
      await cs.before(abs);
      await fsp.rm(abs);
      return `Deleted ${a.path}`;
    }
  }
  throw new Error('Unknown tool ' + name);
}

const SYSTEM_PROMPT = `You are the website builder for Wenhui Ma's art & design portfolio. You work inside the site's admin panel: the site owner (the admin) tells you in plain language how they want their website to look or what it should contain, and you make it happen by editing the website's files directly with your tools. Changes go live on the real website as soon as you save them.

Do whatever the admin asks: any redesign, new page, new layout, animation, colour scheme, font, content change, or completely new site. Be bold and creative when they ask for design; make it look polished and professional, like a top designer would. If a request is vague, make a strong design decision yourself rather than asking lots of questions; ask only when you truly can't proceed.

## How the website is built
- Plain static HTML/CSS/JS, no build step. All paths you use are relative to the website root. The home page is index.html; "/about" serves about.html, etc.
- Pages: index.html (home), about.html, example-project-01..04.html (four projects), detail01-1, detail01-2, detail02-1, detail03-1, detail03-2, detail04-1 (.html) — detail pages behind the arrows on project pages.
- Shared styles: assets/css/site.css (large; the "---- Site styles ----" section holds the site's own design rules; text styles like h1/h2/bodycopy/.caption are defined there). Fonts: assets/css/ibmplexsans.css, assets/css/lindenhill.css, Inter Tight in site.css. You may add any other fonts, e.g. from Google Fonts via <link>.
- Each page has an inline <style> in <head> with page-specific rules (e.g. padding of [id="K…"] .page-content), and a line \`window.SITE_MEDIA = {...}\` mapping media hashes to files: {"HASH": {"src": "assets/images/…", "w": width, "h": height, "video": false}}.
- Content lives inside <bodycopy> in each page. It uses custom elements rendered by assets/js/site.js:
  - <column-set gutter="…"><column-unit span="N">…</column-unit>…</column-set> — columns (12-unit grid).
  - <media-item hash="HASH" …> — an image/video; HASH must exist in that page's window.SITE_MEDIA. Attributes like scale, rotation, class="zoomable" (click to zoom), media-style, freeform-x/y/scale/z (position inside a gallery-freeform, % of width).
  - <gallery-freeform>, <gallery-grid columns="N">, <gallery-slideshow> — containers for media-items.
  - <text-icon icon="…"> — arrow icons.
  You don't have to use these: plain HTML (<img src="assets/images/…">, <video>, <div>s with CSS grid/flex) works perfectly and is often simpler for new designs. You may also rewrite site.js or replace the whole structure if a redesign needs it.
- Images: assets/images/, videos: assets/videos/, admin uploads: assets/uploads/. Use list_files to see them with sizes.
- On phones (aspect ratio ≤ 4:5) site.js adds class "mobile" to <html>; columns stack. Every design must look good on both desktop and phone — use responsive CSS.

## How to work
- Look before you change: read the relevant files (or search_files) first. Prefer edit_file for targeted changes; use write_file for new files or full rewrites.
- Keep links relative (e.g. href="about.html"). When adding a page, also add it to the navigation on the other pages if it should be reachable.
- When the admin attaches images, they are already saved in the site at the path given in their message; use them directly (the message includes their pixel size).
- Every change is recorded; the admin has an Undo button that reverts your last turn, so don't worry about being too careful — but never break the site: check your HTML is well-formed.
- You cannot see the rendered page yourself; the admin sees a live preview next to the chat and will tell you if something looks wrong.
- When finished, reply briefly in plain, friendly language (no code unless asked) saying what you changed and where to look. Reply in the same language the admin writes in.`;

// Keep the context small: old tool outputs and big file writes are shortened.
function contextMessages() {
  const msgs = chat.messages;
  let userIdx = [];
  msgs.forEach((m, i) => { if (m.role === 'user') userIdx.push(i); });
  const keepFrom = userIdx.length > 40 ? userIdx[userIdx.length - 40] : 0;
  const recentFrom = userIdx.length > 2 ? userIdx[userIdx.length - 2] : 0;
  return msgs.slice(keepFrom).map((m, j) => {
    const i = j + keepFrom;
    if (i >= recentFrom) return m;
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 600)
      return { ...m, content: m.content.slice(0, 600) + '\n…[older tool output shortened]' };
    if (m.role === 'assistant' && m.tool_calls) {
      const { reasoning_details, ...rest } = m;
      return {
        ...rest, tool_calls: m.tool_calls.map(tc => {
          const args = tc.function.arguments || '';
          if (args.length < 1500) return tc;
          let short;
          try { const o = JSON.parse(args); for (const k of Object.keys(o)) if (typeof o[k] === 'string' && o[k].length > 400) o[k] = o[k].slice(0, 400) + '…[shortened]'; short = JSON.stringify(o); }
          catch { short = '{}'; }
          return { ...tc, function: { ...tc.function, arguments: short } };
        }),
      };
    }
    return m;
  });
}

let running = null; // { abort: AbortController }

async function callModel(model, messages, signal, emit) {
  const body = {
    model,
    messages: [{ role: 'system', content: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }] }, ...messages],
    tools: TOOLS.map(t => ({ type: 'function', function: t })),
    max_tokens: 64000,
    stream: true,
    usage: { include: true },
  };
  // cache breakpoint on the latest message so each tool step re-reads the conversation from cache
  const last = body.messages[body.messages.length - 1];
  if (last && last.role !== 'assistant') {
    if (typeof last.content === 'string' && last.role === 'user') body.messages[body.messages.length - 1] = { ...last, content: [{ type: 'text', text: last.content, cache_control: { type: 'ephemeral' } }] };
    else if (Array.isArray(last.content) && last.content.length) {
      const c = last.content.slice(); c[c.length - 1] = { ...c[c.length - 1], cache_control: { type: 'ephemeral' } };
      body.messages[body.messages.length - 1] = { ...last, content: c };
    }
  }
  let r;
  for (let attempt = 0; ; attempt++) {
    try {
      r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST', signal,
        headers: { Authorization: 'Bearer ' + API_KEY, 'Content-Type': 'application/json', 'X-Title': 'Portfolio Admin' },
        body: JSON.stringify(body),
      });
      if ((r.status === 429 || r.status >= 500) && attempt < 3) throw Object.assign(new Error('retry'), { retryable: true });
      break;
    } catch (e) {
      if (signal.aborted || attempt >= 3 || !(e.retryable || e.name === 'TypeError')) throw e;
      await new Promise(res => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  if (!r.ok) {
    const t = await r.text();
    let msg = t; try { msg = JSON.parse(t).error.message; } catch { /* raw */ }
    throw new Error(`AI service error ${r.status}: ${msg}`);
  }
  const msg = { role: 'assistant', content: '' };
  const calls = [];
  let reasoningDetails = [], usage = null, finish = null, buf = '';
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      if (ev.error) throw new Error('AI service error: ' + (ev.error.message || JSON.stringify(ev.error)));
      if (ev.usage) usage = ev.usage;
      const ch = ev.choices && ev.choices[0];
      if (!ch) continue;
      if (ch.finish_reason) finish = ch.finish_reason;
      const d = ch.delta || {};
      if (d.content) { msg.content += d.content; emit('text', { text: d.content }); }
      if (d.reasoning_details) reasoningDetails.push(...d.reasoning_details);
      for (const tc of d.tool_calls || []) {
        const i = tc.index ?? calls.length;
        if (!calls[i]) { calls[i] = { id: tc.id, type: 'function', function: { name: '', arguments: '' } }; }
        if (tc.id) calls[i].id = tc.id;
        if (tc.function?.name) { calls[i].function.name += tc.function.name; emit('tool_start', { i, name: calls[i].function.name }); }
        if (tc.function?.arguments) {
          calls[i].function.arguments += tc.function.arguments;
          emit('tool_progress', { i, name: calls[i].function.name, bytes: calls[i].function.arguments.length });
        }
      }
    }
  }
  if (calls.length) msg.tool_calls = calls.filter(Boolean);
  if (reasoningDetails.length) msg.reasoning_details = mergeReasoning(reasoningDetails);
  if (!msg.content) msg.content = msg.tool_calls ? null : '';
  return { msg, usage, finish };
}
// Streamed reasoning arrives in fragments; join consecutive fragments of the same kind.
function mergeReasoning(parts) {
  const out = [];
  for (const p of parts) {
    const prev = out[out.length - 1];
    if (prev && prev.type === p.type && (prev.index ?? 0) === (p.index ?? 0)) {
      if (p.text) prev.text = (prev.text || '') + p.text;
      if (p.summary) prev.summary = (prev.summary || '') + p.summary;
      if (p.data) prev.data = (prev.data || '') + p.data;
      if (p.signature) prev.signature = p.signature;
    } else out.push({ ...p });
  }
  return out;
}

function describeCall(name, a) {
  switch (name) {
    case 'list_files': return 'Looking at files' + (a.path ? ' in ' + a.path : '');
    case 'read_file': return 'Reading ' + a.path;
    case 'write_file': return 'Writing ' + a.path;
    case 'edit_file': return 'Editing ' + a.path;
    case 'search_files': return 'Searching for “' + String(a.query).slice(0, 60) + '”';
    case 'move_file': return `Moving ${a.from} → ${a.to}`;
    case 'delete_file': return 'Deleting ' + a.path;
  }
  return name;
}

async function runAgent(userContent, displayText, attachments, model, emit, signal) {
  const cs = new ChangeSet(displayText.slice(0, 300));
  chat.messages.push({ role: 'user', content: userContent });
  chat.log.push({ role: 'user', text: displayText, attachments, time: Date.now() });
  const entry = { role: 'assistant', text: '', steps: [], time: Date.now(), model };
  chat.log.push(entry);
  saveChat();
  let cost = 0;
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const { msg, usage, finish } = await callModel(model, contextMessages(), signal, (t, d) => {
        if (t === 'text') entry.text += d.text;
        emit(t, d);
      });
      if (usage && usage.cost) cost += usage.cost;
      chat.messages.push(msg);
      if (!msg.tool_calls || !msg.tool_calls.length) {
        if (finish === 'length') emit('text', { text: '\n\n(The reply was cut off because it was too long.)' });
        break;
      }
      for (const tc of msg.tool_calls) {
        let args = {}, result, ok = true;
        try { args = JSON.parse(tc.function.arguments || '{}'); } catch { ok = false; result = 'Error: tool arguments were not valid JSON (the output may have been cut off). Try again with smaller pieces, e.g. several edit_file calls.'; }
        const label = describeCall(tc.function.name, args);
        emit('tool', { id: tc.id, label });
        if (ok) {
          try { result = await runTool(tc.function.name, args, cs); }
          catch (e) { ok = false; result = 'Error: ' + e.message; }
        }
        entry.steps.push({ label, ok });
        emit('tool_done', { id: tc.id, label, ok, changed: ok && /^(write_file|edit_file|move_file|delete_file)$/.test(tc.function.name) });
        chat.messages.push({ role: 'tool', tool_call_id: tc.id, content: String(result) });
      }
      saveChat();
      if (step === MAX_STEPS - 1) emit('text', { text: '\n\n(Stopped after many steps — say “continue” to keep going.)' });
    }
  } catch (e) {
    if (signal.aborted) { entry.text += (entry.text ? '\n\n' : '') + '(Stopped.)'; emit('text', { text: '\n\n(Stopped.)' }); }
    else {
      const detail = e.cause ? ` (${e.cause.code || e.cause.message || e.cause})` : '';
      entry.error = (e.message === 'fetch failed' ? 'Could not reach the AI service' : e.message) + detail + '. Please try again.';
      console.error('agent error:', e, e.cause || '');
      emit('error', { message: entry.error });
    }
    // keep the conversation valid: every tool call needs a result
    const lastMsg = chat.messages[chat.messages.length - 1];
    if (lastMsg && lastMsg.role === 'assistant' && lastMsg.tool_calls) chat.messages.pop();
    if (chat.messages[chat.messages.length - 1]?.role === 'user') chat.messages.push({ role: 'assistant', content: entry.text || '(No reply — the request was interrupted.)' });
  }
  entry.cost = cost;
  entry.changeset = cs.files.size ? cs.id : null;
  entry.changed = [...cs.files.keys()];
  saveChat();
  emit('done', { cost, changed: entry.changed });
}

// ---------- HTTP ----------
async function handleApi(req, res, route) {
  if (route === 'login' && req.method === 'POST') {
    const ip = clientIp(req);
    const fails = (loginFails.get(ip) || []).filter(t => t > Date.now() - 15 * 60 * 1000);
    if (fails.length >= 10) return sendJSON(res, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    let b = {}; try { b = JSON.parse((await readBody(req, 10000)).toString()); } catch { /* empty */ }
    if (!ADMIN_USER || !ADMIN_PASS || !safeEq(b.username || '', ADMIN_USER) | !safeEq(b.password || '', ADMIN_PASS)) {
      fails.push(Date.now()); loginFails.set(ip, fails);
      return sendJSON(res, 401, { error: 'Wrong username or password.' });
    }
    loginFails.delete(ip);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, Date.now() + SESSION_MS);
    saveSessions();
    return sendJSON(res, 200, { ok: true }, {
      'Set-Cookie': `wm_admin=${token}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${SESSION_MS / 1000}${isHttps(req) ? '; Secure' : ''}`,
    });
  }
  if (!authed(req)) return sendJSON(res, 401, { error: 'Please log in.' });
  if (!running) chat = loadChat(); // pick up changes made by another copy of the app
  // reject cross-site POSTs
  if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)
    return sendJSON(res, 403, { error: 'Bad origin' });

  if (route === 'logout' && req.method === 'POST') {
    sessions.delete(cookies(req).wm_admin);
    saveSessions();
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': 'wm_admin=; Path=/admin; Max-Age=0' });
  }
  if (route === 'state' && req.method === 'GET') {
    const pages = (await fsp.readdir(SITE)).filter(f => f.endsWith('.html')).sort((a, b) => a === 'index.html' ? -1 : b === 'index.html' ? 1 : a.localeCompare(b));
    const hist = await listHistory();
    return sendJSON(res, 200, { log: chat.log, models: MODELS, model: DEFAULT_MODEL, pages, running: !!running, canUndo: hist.length > 0, aiReady: !!API_KEY });
  }
  if (route === 'new' && req.method === 'POST') {
    if (running) return sendJSON(res, 409, { error: 'Wait for the current reply to finish.' });
    chat = { messages: [], log: [] }; saveChat();
    return sendJSON(res, 200, { ok: true });
  }
  if (route === 'stop' && req.method === 'POST') {
    if (running) running.abort.abort();
    return sendJSON(res, 200, { ok: true });
  }
  if (route === 'undo' && req.method === 'POST') {
    if (running) return sendJSON(res, 409, { error: 'Wait for the current reply to finish.' });
    const u = await undoLast();
    if (!u) return sendJSON(res, 200, { ok: false, message: 'Nothing to undo.' });
    chat.log.push({ role: 'system', text: `Undid: “${u.prompt.slice(0, 120)}” (${u.files.length} file${u.files.length === 1 ? '' : 's'} restored)`, time: Date.now() });
    chat.messages.push({ role: 'user', content: `[Admin panel note: the admin pressed Undo. The changes from the request “${u.prompt.slice(0, 200)}” were reverted; these files are back to how they were before: ${u.files.map(f => f.path).join(', ')}. Re-read files before editing them.]` });
    chat.messages.push({ role: 'assistant', content: 'Understood — those changes were undone.' });
    saveChat();
    const hist = await listHistory();
    return sendJSON(res, 200, { ok: true, files: u.files.map(f => f.path), canUndo: hist.length > 0 });
  }
  if (route === 'chat' && req.method === 'POST') {
    if (!API_KEY) return sendJSON(res, 500, { error: 'OPENROUTER_API_KEY is not set on the server.' });
    if (running) return sendJSON(res, 409, { error: 'The AI is still working on the previous message.' });
    let b; try { b = JSON.parse((await readBody(req)).toString()); } catch { return sendJSON(res, 400, { error: 'Bad request' }); }
    const text = String(b.message || '').trim();
    const images = Array.isArray(b.images) ? b.images.slice(0, 10) : [];
    if (!text && !images.length) return sendJSON(res, 400, { error: 'Empty message' });
    const model = MODELS.some(m => m.id === b.model) ? b.model : DEFAULT_MODEL;

    // save attachments into the site
    const attachments = [], parts = [];
    for (const img of images) {
      const m = /^data:(image\/(png|jpeg|gif|webp|svg\+xml));base64,(.+)$/.exec(img.data || '');
      if (!m) continue;
      const buf = Buffer.from(m[3], 'base64');
      const ext = { png: 'png', jpeg: 'jpg', gif: 'gif', webp: 'webp', 'svg+xml': 'svg' }[m[2]];
      const base = String(img.name || 'image').replace(/\.[^.]+$/, '').replace(/[^\w\-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'image';
      const rel = `assets/uploads/${Date.now().toString(36)}-${base}.${ext}`;
      await fsp.mkdir(path.join(SITE, 'assets/uploads'), { recursive: true });
      await fsp.writeFile(inside(SITE, rel), buf);
      const size = imageSize(buf);
      attachments.push({ path: rel, w: size?.w, h: size?.h });
      if (ext !== 'svg') parts.push({ type: 'image_url', image_url: { url: img.data } });
    }
    let fullText = text;
    if (attachments.length) fullText += `\n\n[Attached image${attachments.length > 1 ? 's' : ''}, already saved in the site: ${attachments.map(a => a.path + (a.w ? ` (${a.w}×${a.h})` : '')).join(', ')}]`;
    const userContent = parts.length ? [{ type: 'text', text: fullText }, ...parts] : fullText;

    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    const emit = (type, data) => { try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch { /* client gone */ } };
    const abort = new AbortController();
    running = { abort };
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 15000);
    try {
      await runAgent(userContent, text, attachments, model, emit, abort.signal);
    } finally {
      clearInterval(ping);
      running = null;
      // store images as paths, not base64, in the saved conversation
      for (const m of chat.messages) if (m.role === 'user' && Array.isArray(m.content)) m.content = m.content.filter(p => p.type === 'text').map(p => p.text).join('\n');
      saveChat();
      res.end();
    }
    return;
  }
  sendJSON(res, 404, { error: 'Not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    let p;
    try { p = decodeURIComponent(url.pathname); } catch { res.writeHead(400); return res.end('Bad request'); }

    if (p === '/admin' || p.startsWith('/admin/')) {
      if (p.startsWith('/admin/api/')) return await handleApi(req, res, p.slice('/admin/api/'.length));
      if (p === '/admin') { res.writeHead(301, { Location: '/admin/' }); return res.end(); }
      const file = inside(ADMIN_DIR, p === '/admin/' ? 'index.html' : p.slice('/admin/'.length));
      if (await serveFile(req, res, file, 'no-cache')) return;
      res.writeHead(404); return res.end('Not found');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let file = inside(SITE, p.endsWith('/') ? p + 'index.html' : p);
    const html = 'no-cache';
    const asset = 'public, max-age=300';
    if (await serveFile(req, res, file, file.endsWith('.html') ? html : asset)) return;
    if (!path.extname(file) && await serveFile(req, res, file + '.html', html)) return;
    if (await serveFile(req, res, path.join(file, 'index.html'), html)) return;
    res.statusCode = 404;
    if (await fsp.stat(path.join(SITE, '404.html')).then(() => true, () => false)) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return fs.createReadStream(path.join(SITE, '404.html')).pipe(res);
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Page not found');
  } catch (e) {
    console.error(e);
    if (!res.headersSent) { res.writeHead(/outside the website/.test(e.message) ? 403 : 500); }
    res.end();
  }
});
server.requestTimeout = 0; // AI replies can stream for several minutes
server.listen(PORT, () => console.log(`Website: http://localhost:${PORT}/   Admin: http://localhost:${PORT}/admin`));
