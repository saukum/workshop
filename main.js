const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
const oauth = require('./oauth');

app.setName('Mark Desk');

const isWin = process.platform === 'win32';
let win = null;
let current = null; // { child }

// ---------- settings ----------
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function saveSettings(s) {
  try {
    fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
    fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
  } catch {}
}

// ---------- own chat history (independent of the CLI's session store) ----------
const historyDir = () => path.join(app.getPath('userData'), 'history');
const validId = id => typeof id === 'string' && /^[A-Za-z0-9-]{8,64}$/.test(id);
const historyFile = id => path.join(historyDir(), id + '.json');

ipcMain.handle('history:list', () => {
  let names = [];
  try { names = fs.readdirSync(historyDir()).filter(n => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    try {
      const c = JSON.parse(fs.readFileSync(path.join(historyDir(), n), 'utf8'));
      if (!validId(c.id)) continue;
      out.push({ id: c.id, title: c.title || 'Без названия', cwd: c.cwd || '', updatedAt: c.updatedAt || 0 });
    } catch {}
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
});

ipcMain.handle('history:load', (_e, id) => {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(historyFile(id), 'utf8')); } catch { return null; }
});

ipcMain.handle('history:save', (_e, chat) => {
  if (!chat || !validId(chat.id) || !Array.isArray(chat.items)) return false;
  try {
    fs.mkdirSync(historyDir(), { recursive: true });
    const tmp = historyFile(chat.id) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(chat));
    fs.renameSync(tmp, historyFile(chat.id)); // atomic replace
    return true;
  } catch { return false; }
});

ipcMain.handle('history:delete', (_e, id) => {
  if (!validId(id)) return false;
  try { fs.unlinkSync(historyFile(id)); return true; } catch { return false; }
});

// ---------- MCP servers (own list, passed to the CLI via --mcp-config on every run) ----------
const mcpFile = () => path.join(app.getPath('userData'), 'mcp.json');
const mcpRunFile = () => path.join(app.getPath('userData'), 'mcp-run.json');

function strMap(o) {
  const r = {};
  if (o && typeof o === 'object') {
    for (const [k, v] of Object.entries(o)) if (k && typeof v === 'string') r[k] = v;
  }
  return r;
}

function sanitizeServer(s) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name || '').trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) return null;
  const type = ['stdio', 'http', 'sse'].includes(s.type) ? s.type : 'stdio';
  const out = { name, type, enabled: s.enabled !== false };
  if (type === 'stdio') {
    const command = String(s.command || '').trim();
    if (!command) return null;
    out.command = command;
    out.args = Array.isArray(s.args) ? s.args.map(String) : [];
    out.env = strMap(s.env);
  } else {
    const url = String(s.url || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    out.url = url;
    out.headers = strMap(s.headers);
  }
  return out;
}

function sanitizeMcp(j) {
  const seen = new Set();
  const servers = [];
  for (const s of (j && Array.isArray(j.servers) ? j.servers : [])) {
    const c = sanitizeServer(s);
    if (c && !seen.has(c.name)) { seen.add(c.name); servers.push(c); }
  }
  return { servers, useCliServers: !(j && j.useCliServers === false) };
}

function loadMcp() {
  try { return sanitizeMcp(JSON.parse(fs.readFileSync(mcpFile(), 'utf8').replace(/^﻿/, ''))); }
  catch { return { servers: [], useCliServers: true }; }
}

ipcMain.handle('mcp:get', () => loadMcp());
ipcMain.handle('mcp:save', (_e, cfg) => {
  const clean = sanitizeMcp(cfg);
  try { oauth.prune(clean.servers.filter(s => s.type !== 'stdio')); } catch {}
  try {
    fs.mkdirSync(path.dirname(mcpFile()), { recursive: true });
    fs.writeFileSync(mcpFile(), JSON.stringify(clean, null, 2), { mode: 0o600 });
  } catch {}
  return clean;
});

// ---------- MCP OAuth (sign in to remote servers such as Higgsfield) ----------
ipcMain.handle('oauth:status', () => oauth.statusFor(loadMcp().servers.filter(s => s.type !== 'stdio')));

ipcMain.handle('oauth:login', async (_e, name) => {
  const s = loadMcp().servers.find(x => x.name === name && x.type !== 'stdio');
  if (!s) return { ok: false, error: 'Удалённый сервер не найден' };
  try {
    await oauth.login(name, s.url, {
      openExternal: u => shell.openExternal(u),
      onUrl: u => { if (win && !win.isDestroyed()) win.webContents.send('oauth:event', { name, type: 'url', url: u }); }
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
});

ipcMain.handle('oauth:cancel', () => oauth.cancel());
ipcMain.handle('oauth:logout', (_e, name) => { oauth.logout(String(name)); return true; });

// Extra CLI args that hook the enabled servers into a run. Must be appended LAST (variadic flags).
async function buildMcpArgs() {
  const cfg = loadMcp();
  const active = cfg.servers.filter(s => s.enabled);
  if (!active.length && cfg.useCliServers) return [];
  const mcpServers = {};
  for (const s of active) {
    if (s.type === 'stdio') {
      mcpServers[s.name] = { type: 'stdio', command: s.command, args: s.args, env: s.env };
      continue;
    }
    // Remote server: add the OAuth access token (refreshing it if needed) unless the user set their own header.
    const headers = { ...s.headers };
    if (!Object.keys(headers).some(k => k.toLowerCase() === 'authorization')) {
      const token = await oauth.getAccessToken(s.name, s.url).catch(() => null);
      if (token) headers.Authorization = 'Bearer ' + token;
    }
    mcpServers[s.name] = { type: s.type, url: s.url, headers };
  }
  try {
    fs.mkdirSync(path.dirname(mcpRunFile()), { recursive: true });
    fs.writeFileSync(mcpRunFile(), JSON.stringify({ mcpServers }), { mode: 0o600 });
  } catch { return []; }
  const args = ['--mcp-config', mcpRunFile()];
  if (!cfg.useCliServers) args.push('--strict-mcp-config');
  // Non-interactive runs cannot ask, so servers the user switched on are pre-approved.
  if (active.length) args.push('--allowedTools', active.map(s => 'mcp__' + s.name).join(','));
  return args;
}

// ---------- locating the claude CLI ----------
function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function findBundled() {
  // Claude desktop app keeps its own CLI at <data>/claude-code/<version>/<hash>/claude(.exe)
  const bases = [];
  if (isWin && process.env.LOCALAPPDATA) {
    const root = path.join(process.env.LOCALAPPDATA, 'Claude-Data');
    try {
      for (const d of fs.readdirSync(root)) bases.push(path.join(root, d, 'claude-code'));
    } catch {}
  }
  if (process.platform === 'darwin') {
    bases.push(path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude-code'));
  }
  const exe = isWin ? 'claude.exe' : 'claude';
  const found = [];
  for (const base of bases) {
    try {
      for (const ver of fs.readdirSync(base)) {
        for (const h of fs.readdirSync(path.join(base, ver))) {
          const p = path.join(base, ver, h, exe);
          if (fs.existsSync(p)) found.push({ ver, p });
        }
      }
    } catch {}
  }
  found.sort((a, b) => cmp(b.ver, a.ver));
  return found[0] && found[0].p;
}

function findOnPath() {
  try {
    const out = execFileSync(isWin ? 'where.exe' : 'which', ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).filter(Boolean);
    return lines.find(l => /\.exe$/i.test(l)) || lines[0];
  } catch { return null; }
}

function findClaude() {
  const s = loadSettings();
  if (s.cliPath && fs.existsSync(s.cliPath)) return s.cliPath;
  const local = path.join(os.homedir(), '.local', 'bin', isWin ? 'claude.exe' : 'claude');
  return findOnPath() || (fs.existsSync(local) ? local : null) || findBundled() || null;
}

const needsShell = p => isWin && /\.(cmd|bat)$/i.test(p);

function runCli(cli, args, timeout = 20000) {
  return new Promise(resolve => {
    let out = '';
    const c = spawn(cli, args, { shell: needsShell(cli), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const t = setTimeout(() => c.kill(), timeout);
    c.stdout.on('data', d => (out += d));
    c.stderr.on('data', d => (out += d));
    c.on('error', () => { clearTimeout(t); resolve(''); });
    c.on('close', () => { clearTimeout(t); resolve(out.trim()); });
  });
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 640,
    minHeight: 480,
    backgroundColor: '#1f1e1d',
    title: 'Mark Desk',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.on('closed', () => { win = null; });
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { killCurrent(); if (loginProc) killProc(loginProc); app.quit(); });

// ---------- IPC ----------
ipcMain.handle('cli:info', async () => {
  const p = findClaude();
  if (!p) return { found: false };
  const version = (await runCli(p, ['--version'])).split('\n')[0];
  let loggedIn = false, method = '';
  try {
    const j = JSON.parse(await runCli(p, ['auth', 'status']));
    loggedIn = !!j.loggedIn;
    method = j.authMethod || '';
  } catch {}
  return { found: true, path: p, version, loggedIn, method };
});

ipcMain.handle('cli:pick', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Укажите claude CLI',
    properties: ['openFile'],
    filters: isWin ? [{ name: 'Executable', extensions: ['exe', 'cmd'] }] : []
  });
  if (r.canceled || !r.filePaths[0]) return null;
  const s = loadSettings();
  s.cliPath = r.filePaths[0];
  saveSettings(s);
  return s.cliPath;
});

// ---------- in-app login (claude auth login) ----------
let loginProc = null;

function killProc(child) {
  if (!child) return;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

ipcMain.handle('login:start', () => {
  if (loginProc) killProc(loginProc);
  const cli = findClaude();
  if (!cli) return { ok: false, error: 'Claude CLI не найден' };
  const send = d => { if (win && !win.isDestroyed()) win.webContents.send('login:event', d); };

  const child = spawn(cli, ['auth', 'login'], {
    env: cleanEnv(),
    shell: needsShell(cli),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  loginProc = child;

  let seenUrl = false;
  let tail = '';
  const onData = d => {
    const text = String(d);
    tail = (tail + text).slice(-8000);
    if (!seenUrl) {
      const m = tail.match(/https:\/\/[^\s"'<>]+/);
      if (m) { seenUrl = true; send({ type: 'url', url: m[0] }); }
    }
  };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.stdin.on('error', () => {});
  child.on('error', err => { if (loginProc === child) loginProc = null; send({ type: 'done', code: -1, error: String(err.message || err) }); });
  child.on('close', code => {
    if (loginProc === child) loginProc = null;
    send({ type: 'done', code });
  });
  return { ok: true };
});

ipcMain.handle('login:code', (_e, code) => {
  if (!loginProc || typeof code !== 'string') return false;
  const c = code.trim();
  if (!c || c.length > 4000 || /[\r\n]/.test(c)) return false;
  try { loginProc.stdin.write(c + '\n'); return true; } catch { return false; }
});

ipcMain.handle('login:cancel', () => { killProc(loginProc); loginProc = null; return true; });

ipcMain.handle('dialog:folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});

ipcMain.handle('app:defaults', () => ({ home: os.homedir() }));

const MODES = new Set(['default', 'acceptEdits', 'plan', 'bypassPermissions']);

function killCurrent() {
  if (!current) return;
  const { child } = current;
  try {
    if (isWin) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill('SIGTERM');
  } catch {}
}

ipcMain.handle('claude:send', async (_e, opts) => {
  if (current) return { ok: false, error: 'Уже выполняется запрос' };
  const cli = findClaude();
  if (!cli) return { ok: false, error: 'Claude CLI не найден' };

  const { prompt, cwd, sessionId, model, permissionMode } = opts || {};
  if (typeof prompt !== 'string' || !prompt.trim()) return { ok: false, error: 'Пустой запрос' };
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, error: 'Папка проекта не существует' };

  const args = ['-p', '--output-format', 'stream-json', '--verbose', '--include-partial-messages'];
  args.push('--permission-mode', MODES.has(permissionMode) ? permissionMode : 'acceptEdits');
  if (model && /^[\w.\-\[\]]+$/.test(model)) args.push('--model', model);
  if (sessionId && /^[0-9a-f-]{36}$/i.test(sessionId)) args.push('--resume', sessionId);
  args.push(...(await buildMcpArgs())); // keep last: --mcp-config/--allowedTools accept multiple values
  if (current) return { ok: false, error: 'Уже выполняется запрос' }; // another send won the race while tokens refreshed

  const child = spawn(cli, args, {
    cwd,
    env: cleanEnv(),
    shell: needsShell(cli),
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  current = { child };

  let buf = '';
  let stderr = '';
  const send = (ch, data) => { if (win && !win.isDestroyed()) win.webContents.send(ch, data); };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { send('claude:event', JSON.parse(line)); } catch { /* non-JSON noise */ }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
  child.on('error', err => {
    current = null;
    send('claude:done', { code: -1, stderr: String(err.message || err) });
  });
  child.on('close', code => {
    if (buf.trim()) { try { send('claude:event', JSON.parse(buf.trim())); } catch {} }
    current = null;
    send('claude:done', { code, stderr: stderr.trim() });
  });

  // The prompt goes through stdin so no quoting/escaping issues on Windows.
  child.stdin.write(prompt);
  child.stdin.end();
  return { ok: true };
});

ipcMain.handle('claude:stop', () => { killCurrent(); return true; });
