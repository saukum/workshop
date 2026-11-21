'use strict';

const $ = id => document.getElementById(id);
const els = {
  messages: $('messages'), empty: $('empty'), input: $('input'),
  send: $('sendBtn'), stop: $('stopBtn'), folderBtn: $('folderBtn'), folderLabel: $('folderLabel'),
  model: $('model'), mode: $('mode'), newChat: $('newChat'),
  banner: $('banner'), bannerText: $('bannerText'), bannerBtn: $('bannerBtn'), cliStatus: $('cliStatus'),
  chatList: $('chatList'), chatListEmpty: $('chatListEmpty')
};

// ---------- persisted prefs (UI-level only; chats live in the history store) ----------
const store = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} }
};

// The current conversation. `items` is the full, replayable transcript:
//   {t:'user',text} {t:'assistant',text} {t:'think',text}
//   {t:'tool',id,name,hint,inputText,result,isError} {t:'error',text} {t:'meta',text}
let chat = null;

const state = {
  running: false,
  cliReady: false,
  _stick: true,
  // per-turn streaming state
  streamedIds: new Set(),
  bubble: null,       // { body, item }
  think: null,        // { pre, item }
  tools: new Map(),   // tool_use_id -> { d, item }
  turnHadText: false,
  gotResult: false,
  resumeFailed: false,
  lastText: '',
  isRetry: false
};

function emptyChat() {
  return {
    id: null, title: '', cwd: store.get('cwd', ''), sessionId: null,
    model: els.model.value, mode: els.mode.value,
    createdAt: null, updatedAt: null, items: []
  };
}

// ---------- tiny safe markdown ----------
const esc = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function inline(t) {
  return t.split(/(`[^`\n]+`)/).map((part, i) => {
    if (i % 2) return '<code>' + part.slice(1, -1) + '</code>';
    return part
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }).join('');
}

function renderMarkdown(src) {
  const blocks = [];
  const withoutCode = src.replace(/```[^\n]*\n?([\s\S]*?)(```|$)/g, (_m, code) => {
    blocks.push('<pre><code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });

  const out = [];
  let para = [], list = null;
  const flushPara = () => { if (para.length) { out.push('<p>' + inline(para.join('<br>')) + '</p>'); para = []; } };
  const flushList = () => {
    if (list) { out.push(`<${list.t}>` + list.items.map(i => `<li>${inline(i)}</li>`).join('') + `</${list.t}>`); list = null; }
  };

  for (const raw of esc(withoutCode).split('\n')) {
    let m;
    if (/^\u0000\d+\u0000$/.test(raw.trim())) { flushPara(); flushList(); out.push(raw.trim()); }
    else if ((m = raw.match(/^(#{1,4})\s+(.*)$/))) {
      flushPara(); flushList();
      const n = m[1].length + 1;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
    }
    else if ((m = raw.match(/^\s*[-*]\s+(.*)$/))) {
      flushPara();
      if (!list || list.t !== 'ul') { flushList(); list = { t: 'ul', items: [] }; }
      list.items.push(m[1]);
    }
    else if ((m = raw.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (!list || list.t !== 'ol') { flushList(); list = { t: 'ol', items: [] }; }
      list.items.push(m[1]);
    }
    else if (raw.trim() === '') { flushPara(); flushList(); }
    else { flushList(); para.push(raw); }
  }
  flushPara(); flushList();
  return out.join('\n').replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[+i]);
}

// ---------- DOM mounting (shared by live streaming and history replay) ----------
function atBottom() {
  const m = els.messages;
  return m.scrollHeight - m.scrollTop - m.clientHeight < 80;
}
function scrollDown(force) {
  if (force || state._stick) els.messages.scrollTop = els.messages.scrollHeight;
}
function addMsg(kind, who) {
  els.empty.hidden = true;
  state._stick = atBottom();
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + kind;
  if (who) {
    const w = document.createElement('div');
    w.className = 'who';
    w.textContent = who;
    wrap.appendChild(w);
  }
  const body = document.createElement('div');
  body.className = 'body';
  wrap.appendChild(body);
  els.messages.appendChild(wrap);
  return { wrap, body };
}
function addPlain(node) {
  els.empty.hidden = true;
  state._stick = atBottom();
  const wrap = document.createElement('div');
  wrap.className = 'msg';
  wrap.appendChild(node);
  els.messages.appendChild(wrap);
}

function mountUser(item) { addMsg('user', 'Вы').body.textContent = item.text; }
function mountAssistant(item) {
  const { body } = addMsg('assistant', 'Claude');
  if (item.text) body.innerHTML = renderMarkdown(item.text);
  return body;
}
function mountThink(item) {
  const d = document.createElement('details');
  d.className = 'think';
  d.innerHTML = '<summary>💭 Размышления</summary>';
  const pre = document.createElement('pre');
  pre.textContent = item.text;
  d.appendChild(pre);
  addPlain(d);
  return pre;
}
function appendResult(d, item) {
  const pre = document.createElement('pre');
  pre.textContent = item.result;
  d.appendChild(pre);
  if (item.isError) d.classList.add('err');
}
function mountTool(item) {
  const d = document.createElement('details');
  d.className = 'tool';
  const s = document.createElement('summary');
  s.innerHTML = '🔧 <span class="name"></span><span class="hint"></span>';
  const mcpName = /^mcp__(.+?)__(.+)$/.exec(item.name || '');
  s.querySelector('.name').textContent = mcpName ? mcpName[1] + ' › ' + mcpName[2] : item.name;
  s.querySelector('.hint').textContent = item.hint || '';
  d.appendChild(s);
  const pre = document.createElement('pre');
  pre.textContent = item.inputText || '';
  d.appendChild(pre);
  if (item.result != null) appendResult(d, item);
  addPlain(d);
  return d;
}
function mountNote(kind, text) {
  const { body } = addMsg(kind);
  body.textContent = text;
}
function mountMeta(text) {
  const m = addMsg('meta');
  m.wrap.removeChild(m.body);
  m.wrap.textContent = text;
}

function mountItem(item) {
  switch (item.t) {
    case 'user': mountUser(item); break;
    case 'assistant': mountAssistant(item); break;
    case 'think': mountThink(item); break;
    case 'tool': mountTool(item); break;
    case 'error': mountNote('error', item.text); break;
    case 'meta': mountMeta(item.text); break;
  }
}

// Record + show helpers for live events
function pushNote(kind, text) {
  chat.items.push({ t: kind, text });
  kind === 'meta' ? mountMeta(text) : mountNote(kind, text);
  scrollDown();
}

function newBubble() {
  const item = { t: 'assistant', text: '' };
  chat.items.push(item);
  const body = mountAssistant(item);
  state.bubble = { body, item };
  state.turnHadText = true;
  return state.bubble;
}
function renderBubble() {
  const b = state.bubble;
  if (!b) return;
  state._stick = atBottom();
  b.body.innerHTML = renderMarkdown(b.item.text) + (state.running ? '<span class="typing"></span>' : '');
  scrollDown();
}
function finalizeBubble(b) {
  b.body.innerHTML = renderMarkdown(b.item.text);
}

function toolHint(input) {
  if (!input || typeof input !== 'object') return '';
  const v = input.command || input.file_path || input.path || input.pattern || input.url || input.query || input.description
    || Object.values(input).find(x => typeof x === 'string') || '';
  return String(v).replace(/\s+/g, ' ').slice(0, 90);
}

function addToolCard(block) {
  if (state.tools.has(block.id)) return;
  let inputText = '';
  try { inputText = JSON.stringify(block.input, null, 2); } catch {}
  if (inputText.length > 8000) inputText = inputText.slice(0, 8000) + '\n… (обрезано)';
  const item = { t: 'tool', id: block.id, name: block.name, hint: toolHint(block.input), inputText, result: null, isError: false };
  chat.items.push(item);
  const d = mountTool(item);
  state.tools.set(block.id, { d, item });
  scrollDown();
}

function setToolResult(block) {
  const entry = state.tools.get(block.tool_use_id);
  if (!entry) return;
  let text = block.content;
  if (Array.isArray(text)) text = text.map(c => (c && c.type === 'text' ? c.text : `[${c && c.type}]`)).join('\n');
  text = String(text ?? '');
  entry.item.result = text.length > 6000 ? text.slice(0, 6000) + '\n… (обрезано)' : text;
  entry.item.isError = !!block.is_error;
  appendResult(entry.d, entry.item);
  scheduleSave();
}

// ---------- history persistence ----------
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 400);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!chat || !chat.id || !chat.items.length) return;
  chat.updatedAt = Date.now();
  await window.api.historySave(chat);
  refreshList();
}

async function refreshList() {
  const list = await window.api.historyList();
  els.chatList.textContent = '';
  els.chatListEmpty.hidden = list.length > 0;
  for (const c of list) {
    const row = document.createElement('div');
    row.className = 'chat-item' + (chat && chat.id === c.id ? ' active' : '');
    row.title = (c.cwd ? c.cwd + '\n' : '') + new Date(c.updatedAt).toLocaleString();
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = c.title;
    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = 'Удалить чат';
    del.onclick = async e => {
      e.stopPropagation();
      if (!confirm('Удалить чат «' + c.title + '»? Это нельзя отменить.')) return;
      await window.api.historyDelete(c.id);
      if (chat && chat.id === c.id) newChat(true);
      refreshList();
    };
    row.onclick = () => openChat(c.id);
    row.append(t, del);
    els.chatList.appendChild(row);
  }
}

async function openChat(id) {
  if (state.running || (chat && chat.id === id)) return;
  const c = await window.api.historyLoad(id);
  if (!c) { refreshList(); return; }
  chat = c;
  resetTurn();
  els.messages.querySelectorAll('.msg').forEach(n => n.remove());
  els.empty.hidden = true;
  for (const item of chat.items) mountItem(item);
  els.model.value = chat.model || '';
  els.mode.value = chat.mode || 'acceptEdits';
  setCwdLabel(chat.cwd);
  scrollDown(true);
  els.messages.scrollTop = els.messages.scrollHeight;
  refreshList();
}

// ---------- event handling ----------
function resetTurn() {
  state.streamedIds = new Set();
  state.bubble = null;
  state.think = null;
  state.tools = new Map();
  state.turnHadText = false;
  state.gotResult = false;
  state.resumeFailed = false;
  state.pendingError = null;
}

const NO_SESSION = /No conversation found/i;

function onStream(ev) {
  const e = ev.event;
  if (!e) return;
  switch (e.type) {
    case 'message_start':
      if (e.message && e.message.id) state.streamedIds.add(e.message.id);
      state.bubble = null;
      state.think = null;
      break;
    case 'content_block_start': {
      const cb = e.content_block || {};
      if (cb.type === 'text') newBubble();
      else if (cb.type === 'thinking') {
        const item = { t: 'think', text: '' };
        chat.items.push(item);
        state.think = { pre: mountThink(item), item };
      }
      break;
    }
    case 'content_block_delta': {
      const d = e.delta || {};
      if (d.type === 'text_delta') {
        if (!state.bubble) newBubble();
        state.bubble.item.text += d.text;
        renderBubble();
      } else if (d.type === 'thinking_delta' && state.think) {
        state.think.item.text += d.thinking;
        state.think.pre.textContent = state.think.item.text;
      }
      break;
    }
    case 'content_block_stop':
      if (state.bubble) { const b = state.bubble; state.bubble = null; finalizeBubble(b); }
      state.think = null;
      break;
  }
}

function onEvent(ev) {
  if (ev.parent_tool_use_id) return; // ignore sub-agent chatter
  switch (ev.type) {
    case 'system':
      if (ev.subtype === 'init') {
        if (ev.session_id) chat.sessionId = ev.session_id;
        if (ev.model) els.cliStatus.title = 'Модель: ' + ev.model;
        for (const s of ev.mcp_servers || []) {
          const prefix = 'mcp__' + s.name + '__';
          const tools = (ev.tools || []).filter(t => typeof t === 'string' && t.startsWith(prefix)).length;
          mcp.status.set(s.name, { status: s.status, tools });
        }
        renderMcp();
      }
      break;
    case 'stream_event':
      onStream(ev);
      break;
    case 'assistant': {
      const msg = ev.message || {};
      const streamed = state.streamedIds.has(msg.id);
      for (const block of msg.content || []) {
        if (block.type === 'tool_use') addToolCard(block);
        else if (block.type === 'text' && block.text) {
          if (msg.model === '<synthetic>') {
            // CLI-generated notice (not logged in, session missing, ...), not model output
            state.turnHadText = true;
            if (NO_SESSION.test(block.text)) state.resumeFailed = true;
            else pushNote('error', block.text);
          } else if (!streamed) {
            const b = newBubble();
            b.item.text = block.text;
            finalizeBubble(b);
            state.bubble = null;
          }
        }
      }
      break;
    }
    case 'user': {
      const content = ev.message && ev.message.content;
      if (Array.isArray(content)) for (const block of content) if (block.type === 'tool_result') setToolResult(block);
      break;
    }
    case 'result': {
      state.gotResult = true;
      if (ev.session_id && !ev.is_error) chat.sessionId = ev.session_id;
      if (ev.is_error) {
        if (NO_SESSION.test(ev.result || '')) state.resumeFailed = true;
        else if (!state.turnHadText) state.pendingError = ev.result || 'Ошибка выполнения'; // shown on exit, unless we retry
      }
      const parts = [];
      if (typeof ev.total_cost_usd === 'number' && ev.total_cost_usd > 0) parts.push('$' + ev.total_cost_usd.toFixed(4));
      if (ev.duration_ms) parts.push((ev.duration_ms / 1000).toFixed(1) + ' с');
      if (ev.num_turns) parts.push(ev.num_turns + ' шаг.');
      if (parts.length && !state.resumeFailed && !ev.is_error) pushNote('meta', parts.join(' · '));
      break;
    }
  }
}

function setRunning(v) {
  state.running = v;
  els.send.hidden = v;
  els.stop.hidden = !v;
  els.input.disabled = v;
  if (!v) els.input.focus();
}

// ---------- sending ----------
// The CLI's own session store is only a cache: if its session is gone (or the folder changed),
// we rebuild context from OUR saved transcript, so the history stays independent.
function buildContextPrompt(newText) {
  const lastUser = chat.items.map(i => i.t).lastIndexOf('user');
  const prior = chat.items.slice(0, lastUser).filter(i => i.t === 'user' || i.t === 'assistant');
  if (!prior.length) return newText;
  const lines = [];
  let size = 0;
  for (let i = prior.length - 1; i >= 0; i--) {
    const line = (prior[i].t === 'user' ? 'Пользователь: ' : 'Ассистент: ') + prior[i].text;
    size += line.length;
    if (size > 12000) break;
    lines.unshift(line);
  }
  return 'Ниже сохранённая история предыдущей беседы. Используй её как контекст и продолжай разговор.\n\n<history>\n'
    + lines.join('\n\n') + '\n</history>\n\nНовое сообщение пользователя:\n' + newText;
}

async function runTurn(text, isRetry) {
  resetTurn();
  state.lastText = text;
  state.isRetry = isRetry;
  chat.model = els.model.value;
  chat.mode = els.mode.value;
  const prompt = chat.sessionId ? text : buildContextPrompt(text);
  setRunning(true);
  const r = await window.api.send({
    prompt, cwd: chat.cwd, sessionId: chat.sessionId,
    model: chat.model, permissionMode: chat.mode
  });
  if (!r.ok) { pushNote('error', r.error); setRunning(false); saveNow(); }
}

async function submit() {
  const text = els.input.value.trim();
  if (!text || state.running) return;
  if (!state.cliReady) { mountNote('error', 'Claude CLI не готов — смотрите уведомление сверху.'); return; }
  if (!chat.cwd) {
    const f = await window.api.pickFolder();
    if (!f) return;
    setCwd(f, false);
  }
  if (!chat.id) {
    chat.id = crypto.randomUUID();
    chat.createdAt = Date.now();
    chat.title = text.replace(/\s+/g, ' ').slice(0, 60);
  }
  const item = { t: 'user', text };
  chat.items.push(item);
  mountUser(item);
  scrollDown(true);
  els.input.value = '';
  autosize();
  scheduleSave();
  await runTurn(text, false);
}

function setCwdLabel(p) {
  els.folderLabel.textContent = p || 'выбрать папку…';
  els.folderBtn.title = p || 'Папка проекта';
}

function setCwd(p, notify) {
  const changed = chat.cwd && p !== chat.cwd;
  chat.cwd = p;
  store.set('cwd', p);
  setCwdLabel(p);
  if (changed && chat.sessionId) {
    // CLI sessions are per-folder, so continue from our own transcript instead.
    chat.sessionId = null;
    if (notify && chat.items.length) { pushNote('meta', 'Папка изменена — продолжу по сохранённой истории чата'); scheduleSave(); }
  }
}

function newChat(silent) {
  if (state.running) window.api.stop();
  chat = emptyChat();
  resetTurn();
  els.messages.querySelectorAll('.msg').forEach(n => n.remove());
  els.empty.hidden = false;
  setCwdLabel(chat.cwd);
  if (!silent) { refreshList(); els.input.focus(); }
}

function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(els.input.scrollHeight, 220) + 'px';
}

// ---------- CLI status ----------
async function refreshCli() {
  els.cliStatus.className = 'status';
  els.cliStatus.textContent = 'проверка CLI…';
  const info = await window.api.info();
  els.banner.hidden = true;
  els.bannerBtn.onclick = null;
  if (!info.found) {
    state.cliReady = false;
    els.cliStatus.className = 'status bad';
    els.cliStatus.textContent = 'CLI не найден';
    els.bannerText.textContent = 'Не удалось найти Claude Code CLI (claude). Укажите путь к claude.exe вручную.';
    els.bannerBtn.textContent = 'Указать путь…';
    els.bannerBtn.onclick = async () => { if (await window.api.pickCli()) refreshCli(); };
    els.banner.hidden = false;
    return;
  }
  els.cliStatus.title = info.path;
  if (!info.loggedIn) {
    state.cliReady = false;
    els.cliStatus.className = 'status bad';
    els.cliStatus.textContent = (info.version || 'claude') + ' · не авторизован';
    els.bannerText.textContent = 'Claude CLI не авторизован. Нажмите «Войти», чтобы авторизоваться в аккаунте.';
    els.bannerBtn.textContent = 'Войти';
    els.bannerBtn.onclick = startLogin;
    els.banner.hidden = false;
    return;
  }
  state.cliReady = true;
  els.cliStatus.className = 'status ok';
  els.cliStatus.textContent = info.version + (info.method ? ' · ' + info.method : '');
}

// ---------- in-app login ----------
const lg = {
  panel: $('loginPanel'), open: $('loginOpen'), copy: $('loginCopy'), state: $('loginState'),
  code: $('loginCode'), send: $('loginSend'), cancel: $('loginCancel'), url: null
};

function closeLogin() {
  lg.panel.hidden = true;
  lg.url = null;
  lg.code.value = '';
}

async function startLogin() {
  lg.url = null;
  lg.open.disabled = true;
  lg.copy.disabled = true;
  lg.state.className = 'status';
  lg.state.textContent = 'запускаю вход…';
  lg.panel.hidden = false;
  els.banner.hidden = true;
  const r = await window.api.loginStart();
  if (!r.ok) { lg.state.className = 'status bad'; lg.state.textContent = r.error; }
}

// Accepts a bare code, "code#state", or the whole callback URL from the address bar.
function normalizeLoginInput(v) {
  v = v.trim();
  if (/^https?:\/\//i.test(v) && v.includes('code=')) {
    try {
      const u = new URL(v);
      const code = u.searchParams.get('code'), state = u.searchParams.get('state');
      if (code) return state ? code + '#' + state : code;
    } catch {}
  }
  return v;
}

async function submitLoginCode() {
  const v = normalizeLoginInput(lg.code.value);
  if (!v) return;
  const ok = await window.api.loginCode(v);
  lg.state.className = 'status' + (ok ? '' : ' bad');
  lg.state.textContent = ok ? 'код отправлен, проверяю…' : 'вход не запущен — нажмите «Отмена» и повторите';
  if (ok) lg.code.value = '';
}

lg.open.onclick = () => { if (lg.url) window.open(lg.url, '_blank'); };
lg.copy.onclick = async () => {
  if (!lg.url) return;
  try { await navigator.clipboard.writeText(lg.url); lg.state.className = 'status ok'; lg.state.textContent = 'ссылка скопирована'; }
  catch { lg.state.className = 'status bad'; lg.state.textContent = 'не удалось скопировать'; }
};
lg.send.onclick = submitLoginCode;
lg.code.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submitLoginCode(); } });
lg.cancel.onclick = async () => { await window.api.loginCancel(); closeLogin(); refreshCli(); };

window.api.onLogin(ev => {
  if (ev.type === 'url') {
    lg.url = ev.url;
    lg.open.disabled = false;
    lg.copy.disabled = false;
    lg.state.className = 'status ok';
    lg.state.textContent = 'ожидаю подтверждения в браузере…';
  } else if (ev.type === 'done') {
    closeLogin();
    refreshCli();
  }
});

// ---------- MCP servers ----------
const mg = {
  modal: $('mcpModal'), list: $('mcpList'), empty: $('mcpEmpty'), msg: $('mcpMsg'), cli: $('mcpCli'),
  form: $('mcpForm'), imp: $('mcpImport'), link: $('mcpLinkBtn'),
  name: $('fName'), type: $('fType'), command: $('fCommand'), args: $('fArgs'), env: $('fEnv'),
  url: $('fUrl'), headers: $('fHeaders'), stdio: $('fStdio'), remote: $('fRemote'), importText: $('importText')
};
const mcp = { cfg: { servers: [], useCliServers: true }, status: new Map(), editing: null, oauth: {}, pending: null, oauthUrl: null };
els.mcpBtn = $('mcpBtn');

function mcpMsg(text, bad) {
  mg.msg.className = 'status' + (text ? (bad ? ' bad' : ' ok') : '');
  mg.msg.textContent = text || '';
}

function updateMcpBtn() {
  const n = mcp.cfg.servers.filter(s => s.enabled).length;
  els.mcpBtn.textContent = '🔌 MCP' + (n ? ' · ' + n : '');
}

async function loadMcp() {
  mcp.cfg = await window.api.mcpGet();
  mcp.oauth = await window.api.oauthStatus();
  updateMcpBtn();
  renderMcp();
}

async function saveMcp() {
  mcp.cfg = await window.api.mcpSave(mcp.cfg);
  mcp.oauth = await window.api.oauthStatus();
  updateMcpBtn();
  renderMcp();
}

async function refreshOauth() {
  mcp.oauth = await window.api.oauthStatus();
  renderMcp();
}

async function startOauth(s) {
  mcp.pending = s.name;
  mcp.oauthUrl = null;
  mg.link.hidden = true;
  mcpMsg('Открываю браузер для входа в «' + s.name + '»…');
  renderMcp();
  const r = await window.api.oauthLogin(s.name);
  mcp.pending = null;
  mg.link.hidden = true;
  if (r.ok) {
    mcp.status.delete(s.name);
    mcpMsg('Вход в «' + s.name + '» выполнен. Сервер подключится при следующем сообщении.');
  } else {
    mcpMsg('Не удалось войти: ' + r.error, true);
  }
  await refreshOauth();
}

window.api.onOauth(ev => {
  if (ev.type === 'url') {
    mcp.oauthUrl = ev.url;
    mg.link.hidden = false;
    mcpMsg('Жду подтверждения входа в браузере… Если страница не открылась — скопируйте ссылку.');
  }
});

function mcpSummary(s) {
  return s.type === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.type + ' · ' + s.url;
}

function renderMcp() {
  mg.cli.checked = mcp.cfg.useCliServers;
  mg.list.textContent = '';
  mg.empty.hidden = mcp.cfg.servers.length > 0;
  for (const s of mcp.cfg.servers) {
    const row = document.createElement('div');
    row.className = 'mcp-row' + (s.enabled ? '' : ' off');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = s.enabled;
    cb.title = 'Включить / выключить';
    cb.onchange = () => { s.enabled = cb.checked; saveMcp(); };

    const info = document.createElement('div');
    info.className = 'info';
    const nm = document.createElement('div');
    nm.className = 'nm';
    nm.textContent = s.name;
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = mcpSummary(s);
    sub.title = mcpSummary(s);
    info.append(nm, sub);

    const remote = s.type !== 'stdio';
    const signedIn = remote && !!mcp.oauth[s.name];
    const waiting = mcp.pending === s.name;

    const badge = document.createElement('span');
    const st = mcp.status.get(s.name);
    badge.className = 'badge';
    if (waiting) badge.textContent = 'ожидаю вход в браузере…';
    else if (!s.enabled) badge.textContent = 'выключен';
    else if (!st) badge.textContent = signedIn ? 'вход выполнен · подключится при следующем сообщении' : 'подключится при следующем сообщении';
    else if (st.status === 'connected') { badge.classList.add('ok'); badge.textContent = 'подключён · ' + st.tools + ' инстр.'; }
    else if (st.status === 'needs-auth') { badge.classList.add('bad'); badge.textContent = signedIn ? 'нужно войти заново' : 'нужен вход'; }
    else { badge.classList.add('bad'); badge.textContent = st.status; }

    let auth = null;
    if (remote) {
      auth = document.createElement('button');
      if (waiting) {
        auth.textContent = 'Отмена';
        auth.onclick = () => window.api.oauthCancel();
      } else if (signedIn) {
        auth.textContent = 'Выйти';
        auth.title = 'Забыть вход (OAuth)';
        auth.onclick = async () => { await window.api.oauthLogout(s.name); mcp.status.delete(s.name); mcpMsg(''); await refreshOauth(); };
      } else {
        auth.textContent = 'Войти (OAuth)';
        auth.title = 'Открыть браузер и войти в аккаунт сервера';
        auth.className = 'primary';
        auth.onclick = () => startOauth(s);
        if (mcp.pending) auth.disabled = true;
      }
    }

    const edit = document.createElement('button');
    edit.textContent = 'Изменить';
    edit.onclick = () => openMcpForm(s);
    const del = document.createElement('button');
    del.textContent = '✕';
    del.title = 'Удалить';
    del.onclick = () => {
      if (!confirm('Удалить MCP-сервер «' + s.name + '»?')) return;
      mcp.cfg.servers = mcp.cfg.servers.filter(x => x !== s);
      saveMcp();
    };

    row.append(cb, info, badge);
    if (auth) row.append(auth);
    row.append(edit, del);
    mg.list.appendChild(row);
  }
}

function toggleFormType() {
  const stdio = mg.type.value === 'stdio';
  mg.stdio.hidden = !stdio;
  mg.remote.hidden = stdio;
}

function openMcpForm(s) {
  mg.imp.hidden = true;
  mg.form.hidden = false;
  mcp.editing = s ? s.name : null;
  mg.name.value = s ? s.name : '';
  mg.type.value = s ? s.type : 'stdio';
  mg.command.value = (s && s.command) || '';
  mg.args.value = ((s && s.args) || []).join('\n');
  mg.env.value = Object.entries((s && s.env) || {}).map(([k, v]) => k + '=' + v).join('\n');
  mg.url.value = (s && s.url) || '';
  mg.headers.value = Object.entries((s && s.headers) || {}).map(([k, v]) => k + ': ' + v).join('\n');
  toggleFormType();
  mcpMsg('');
  mg.name.focus();
}

const lines = t => t.split('\n').map(x => x.trim()).filter(Boolean);
function parseMap(text, sep) {
  const out = {};
  for (const line of lines(text)) {
    const i = line.indexOf(sep);
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + sep.length).trim();
  }
  return out;
}

async function saveMcpForm() {
  const name = mg.name.value.trim();
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(name)) { mcpMsg('Название: только латиница, цифры, _ и - (до 40 символов)', true); return; }
  if (name !== mcp.editing && mcp.cfg.servers.some(s => s.name === name)) { mcpMsg('Сервер с таким названием уже есть', true); return; }
  const type = mg.type.value;
  const s = { name, type, enabled: true };
  if (type === 'stdio') {
    s.command = mg.command.value.trim();
    if (!s.command) { mcpMsg('Укажите команду', true); return; }
    s.args = lines(mg.args.value);
    s.env = parseMap(mg.env.value, '=');
  } else {
    s.url = mg.url.value.trim();
    if (!/^https?:\/\//i.test(s.url)) { mcpMsg('URL должен начинаться с http:// или https://', true); return; }
    s.headers = parseMap(mg.headers.value, ':');
  }
  const idx = mcp.cfg.servers.findIndex(x => x.name === mcp.editing);
  if (idx >= 0) { s.enabled = mcp.cfg.servers[idx].enabled; mcp.cfg.servers[idx] = s; if (mcp.editing !== name) mcp.status.delete(mcp.editing); }
  else mcp.cfg.servers.push(s);
  mg.form.hidden = true;
  await saveMcp();
  mcpMsg('Сохранено. Подключится при следующем сообщении.');
}

// Accepts {"mcpServers": {...}}, {"servers": {...}} or a bare {name: {...}} map (as in MCP docs).
async function importMcp() {
  let data;
  try { data = JSON.parse(mg.importText.value); } catch { mcpMsg('Это не корректный JSON', true); return; }
  const map = (data && (data.mcpServers || data.servers)) || data;
  if (!map || typeof map !== 'object' || Array.isArray(map)) { mcpMsg('Не нашёл список серверов', true); return; }
  let added = 0, skipped = 0;
  for (const [name, d] of Object.entries(map)) {
    if (!d || typeof d !== 'object' || !/^[A-Za-z0-9_-]{1,40}$/.test(name)) { skipped++; continue; }
    const type = d.url ? (/sse/i.test(d.type || '') ? 'sse' : 'http') : 'stdio';
    const s = { name, type, enabled: true };
    if (type === 'stdio') {
      if (!d.command) { skipped++; continue; }
      s.command = String(d.command);
      s.args = Array.isArray(d.args) ? d.args.map(String) : [];
      s.env = d.env && typeof d.env === 'object' ? d.env : {};
    } else {
      s.url = String(d.url);
      s.headers = d.headers && typeof d.headers === 'object' ? d.headers : {};
    }
    const idx = mcp.cfg.servers.findIndex(x => x.name === name);
    if (idx >= 0) mcp.cfg.servers[idx] = s; else mcp.cfg.servers.push(s);
    added++;
  }
  mg.importText.value = '';
  mg.imp.hidden = true;
  await saveMcp();
  mcpMsg(added ? `Добавлено серверов: ${added}` + (skipped ? `, пропущено: ${skipped}` : '') : 'Ничего не добавлено', !added);
}

function openMcp() { mg.modal.hidden = false; mcpMsg(''); renderMcp(); }
function closeMcp() { mg.modal.hidden = true; mg.form.hidden = true; mg.imp.hidden = true; }

els.mcpBtn.onclick = openMcp;
$('mcpClose').onclick = closeMcp;
mg.modal.addEventListener('mousedown', e => { if (e.target === mg.modal) closeMcp(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !mg.modal.hidden) closeMcp(); });
$('mcpAdd').onclick = () => openMcpForm(null);
$('mcpImportBtn').onclick = () => { mg.form.hidden = true; mg.imp.hidden = false; mcpMsg(''); mg.importText.focus(); };
$('fSave').onclick = saveMcpForm;
$('fCancel').onclick = () => { mg.form.hidden = true; mcpMsg(''); };
$('importGo').onclick = importMcp;
$('importCancel').onclick = () => { mg.imp.hidden = true; mcpMsg(''); };
mg.type.onchange = toggleFormType;
mg.cli.onchange = () => { mcp.cfg.useCliServers = mg.cli.checked; saveMcp(); };
mg.link.onclick = async () => {
  if (!mcp.oauthUrl) return;
  try { await navigator.clipboard.writeText(mcp.oauthUrl); mcpMsg('Ссылка скопирована — откройте её в браузере.'); }
  catch { mcpMsg('Не удалось скопировать ссылку', true); }
};

// ---------- wiring ----------
els.send.onclick = submit;
els.stop.onclick = () => window.api.stop();
els.newChat.onclick = () => newChat(false);
els.folderBtn.onclick = async () => { const f = await window.api.pickFolder(); if (f) { setCwd(f, true); scheduleSave(); } };
els.input.addEventListener('input', autosize);
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
});
for (const k of ['model', 'mode']) {
  els[k].value = store.get(k, els[k].value);
  els[k].onchange = () => { store.set(k, els[k].value); if (chat) { chat[k === 'mode' ? 'mode' : 'model'] = els[k].value; scheduleSave(); } };
}

window.api.onEvent(onEvent);
window.api.onDone(({ code, stderr }) => {
  if (state.bubble) { finalizeBubble(state.bubble); state.bubble = null; }
  if (NO_SESSION.test(stderr || '')) state.resumeFailed = true;

  if (state.resumeFailed && !state.isRetry) {
    // The CLI no longer has this session: continue from our own saved transcript.
    chat.sessionId = null;
    pushNote('meta', 'Сессия CLI не найдена — продолжаю по сохранённой истории');
    runTurn(state.lastText, true);
    return;
  }
  if (state.pendingError) pushNote('error', state.pendingError);
  else if (!state.gotResult && code !== 0 && code !== null) {
    pushNote('error', stderr || `Процесс завершился с кодом ${code}`);
  }
  setRunning(false);
  saveNow();
});

(async function init() {
  chat = emptyChat();
  setCwdLabel(chat.cwd);
  refreshList();
  refreshCli();
  loadMcp();
  els.input.focus();
})();
