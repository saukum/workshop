'use strict';
// OAuth 2.1 client for remote MCP servers (authorization code + PKCE, dynamic client registration,
// refresh tokens). Tokens are kept in userData/oauth.json, encrypted with the OS keychain via
// Electron safeStorage when available, and injected as `Authorization: Bearer` when a run starts.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const electron = () => require('electron');
const storeFile = () => path.join(electron().app.getPath('userData'), 'oauth.json');

// ---------- token storage ----------
function readAll() {
  try {
    const raw = JSON.parse(fs.readFileSync(storeFile(), 'utf8').replace(/^﻿/, ''));
    if (raw.enc && raw.data) {
      const { safeStorage } = electron();
      if (!safeStorage.isEncryptionAvailable()) return {};
      return JSON.parse(safeStorage.decryptString(Buffer.from(raw.data, 'base64')));
    }
    return raw.tokens || {};
  } catch { return {}; }
}

function writeAll(tokens) {
  const { safeStorage } = electron();
  const out = safeStorage.isEncryptionAvailable()
    ? { enc: true, data: safeStorage.encryptString(JSON.stringify(tokens)).toString('base64') }
    : { enc: false, tokens };
  fs.mkdirSync(path.dirname(storeFile()), { recursive: true });
  fs.writeFileSync(storeFile(), JSON.stringify(out), { mode: 0o600 });
}

// ---------- helpers ----------
const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

function isSecure(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || (x.protocol === 'http:' && LOOPBACK.has(x.hostname));
  } catch { return false; }
}

async function getJson(url) {
  const r = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(r.status + ' ' + url);
  return r.json();
}

async function firstJson(urls) {
  for (const u of urls) {
    if (!isSecure(u)) continue;
    try { return await getJson(u); } catch { /* try next */ }
  }
  return null;
}

// ---------- discovery (RFC 9728 + RFC 8414, with fallbacks) ----------
async function discover(mcpUrl) {
  const u = new URL(mcpUrl);
  let resourceMeta = null;
  let hintedScope = null;

  // An unauthenticated request makes a compliant server answer 401 + WWW-Authenticate.
  try {
    const r = await fetch(mcpUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Mark Desk', version: '0.2.0' } }
      }),
      signal: AbortSignal.timeout(15000)
    });
    const h = r.headers.get('www-authenticate') || '';
    const m = /resource_metadata="([^"]+)"/.exec(h);
    const s = /scope="([^"]+)"/.exec(h);
    if (s) hintedScope = s[1];
    if (m) resourceMeta = await firstJson([m[1]]);
  } catch { /* fall through to well-known probing */ }

  if (!resourceMeta) {
    const p = u.pathname.replace(/\/$/, '');
    resourceMeta = await firstJson([
      `${u.origin}/.well-known/oauth-protected-resource${p}`,
      `${u.origin}/.well-known/oauth-protected-resource`
    ]);
  }

  const issuer = (resourceMeta && Array.isArray(resourceMeta.authorization_servers) && resourceMeta.authorization_servers[0]) || u.origin;
  if (!isSecure(issuer)) throw new Error('Небезопасный адрес сервера авторизации: ' + issuer);
  const iu = new URL(issuer);
  const ip = iu.pathname.replace(/\/$/, '');

  let meta = await firstJson([
    `${iu.origin}/.well-known/oauth-authorization-server${ip}`,
    `${iu.origin}/.well-known/openid-configuration${ip}`,
    `${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`
  ]);
  if (!meta) {
    // Older MCP servers without metadata: default endpoints on the server's origin.
    meta = {
      authorization_endpoint: iu.origin + '/authorize',
      token_endpoint: iu.origin + '/token',
      registration_endpoint: iu.origin + '/register'
    };
  }
  for (const k of ['authorization_endpoint', 'token_endpoint']) {
    if (!meta[k] || !isSecure(meta[k])) throw new Error('У сервера авторизации нет безопасного адреса ' + k);
  }
  if (meta.registration_endpoint && !isSecure(meta.registration_endpoint)) throw new Error('Небезопасный registration_endpoint');
  if (Array.isArray(meta.code_challenge_methods_supported) && !meta.code_challenge_methods_supported.includes('S256')) {
    throw new Error('Сервер не поддерживает PKCE S256');
  }

  const supported = (resourceMeta && resourceMeta.scopes_supported) || meta.scopes_supported || [];
  let scope = hintedScope || (Array.isArray(supported) ? supported.join(' ') : '');
  if (Array.isArray(meta.scopes_supported) && meta.scopes_supported.includes('offline_access') && !/\boffline_access\b/.test(scope)) {
    scope = (scope + ' offline_access').trim();
  }
  return { meta, resource: (resourceMeta && resourceMeta.resource) || mcpUrl, scope };
}

// ---------- dynamic client registration (RFC 7591) ----------
async function registerClient(endpoint, redirectUri) {
  const r = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      client_name: 'Mark Desk',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    }),
    signal: AbortSignal.timeout(15000)
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.client_id) throw new Error('Сервер отклонил регистрацию клиента (' + r.status + ')' + (j.error_description ? ': ' + j.error_description : ''));
  return { clientId: j.client_id, clientSecret: j.client_secret || null, authMethod: j.token_endpoint_auth_method || 'none' };
}

// ---------- token endpoint ----------
async function tokenRequest(entry, params) {
  const body = new URLSearchParams(params);
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  if (entry.clientSecret && entry.authMethod === 'client_secret_basic') {
    headers.Authorization = 'Basic ' + Buffer.from(encodeURIComponent(entry.clientId) + ':' + encodeURIComponent(entry.clientSecret)).toString('base64');
  } else {
    body.set('client_id', entry.clientId);
    if (entry.clientSecret) body.set('client_secret', entry.clientSecret);
  }
  const r = await fetch(entry.tokenEndpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(20000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || ('token endpoint: ' + r.status));
  return j;
}

function applyTokens(entry, j) {
  entry.accessToken = j.access_token;
  if (j.refresh_token) entry.refreshToken = j.refresh_token; // servers may rotate it
  entry.expiresAt = Date.now() + (Number(j.expires_in) > 0 ? Number(j.expires_in) * 1000 : 3600 * 1000);
  if (j.scope) entry.scope = j.scope;
}

// ---------- login flow ----------
let active = null;

const resultPage = (ok, detail) => `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Mark Desk</title>
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#faf9f5;color:#29261f}
@media(prefers-color-scheme:dark){body{background:#1f1e1d;color:#ece9e4}}div{text-align:center;max-width:420px;padding:0 20px}h1{color:${ok ? '#d97757' : '#c2453d'}}</style>
<div><h1>${ok ? 'Вход выполнен' : 'Не удалось войти'}</h1><p>${ok ? 'Можно закрыть эту вкладку и вернуться в Mark Desk.' : String(detail || '').replace(/[<>&"]/g, '')}</p></div></html>`;

function startCallbackServer(expectedState, flow) {
  return new Promise((resolve, reject) => {
    let settle;
    const codePromise = new Promise((res, rej) => { settle = { res, rej }; });
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1');
      if (u.pathname !== '/callback') { res.writeHead(404).end(); return; }
      if (u.searchParams.get('state') !== expectedState) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(false, 'Неверный параметр state'));
        return; // stray request: keep waiting for the real redirect
      }
      const err = u.searchParams.get('error');
      const code = u.searchParams.get('code');
      if (err || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(false, err || 'нет кода'));
        settle.rej(new Error('Сервер вернул ошибку: ' + (u.searchParams.get('error_description') || err || 'нет кода')));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(resultPage(true));
      settle.res(code);
    });
    server.once('error', reject);
    flow.server = server;
    flow.reject = settle.rej;
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, codePromise }));
  });
}

async function login(name, mcpUrl, { openExternal, onUrl } = {}) {
  if (active) throw new Error('Вход уже выполняется');
  const flow = { server: null, reject: null };
  active = flow;
  let timer = null;
  try {
    const d = await discover(mcpUrl);

    const state = b64url(crypto.randomBytes(16));
    const verifier = b64url(crypto.randomBytes(32));
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());

    const { port, codePromise } = await startCallbackServer(state, flow);
    timer = setTimeout(() => flow.reject && flow.reject(new Error('Время ожидания входа истекло (5 минут)')), 5 * 60 * 1000);
    const redirectUri = `http://127.0.0.1:${port}/callback`;

    if (!d.meta.registration_endpoint) {
      throw new Error('Сервер не поддерживает автоматическую регистрацию клиента (нужен свой client_id)');
    }
    const client = await registerClient(d.meta.registration_endpoint, redirectUri);

    const au = new URL(d.meta.authorization_endpoint);
    au.searchParams.set('response_type', 'code');
    au.searchParams.set('client_id', client.clientId);
    au.searchParams.set('redirect_uri', redirectUri);
    au.searchParams.set('code_challenge', challenge);
    au.searchParams.set('code_challenge_method', 'S256');
    au.searchParams.set('state', state);
    au.searchParams.set('resource', d.resource);
    if (d.scope) au.searchParams.set('scope', d.scope);

    if (!isSecure(au.href)) throw new Error('Небезопасная ссылка авторизации');
    if (onUrl) onUrl(au.href);
    if (openExternal) await openExternal(au.href);

    const code = await codePromise;

    const entry = {
      url: mcpUrl, resource: d.resource, tokenEndpoint: d.meta.token_endpoint,
      clientId: client.clientId, clientSecret: client.clientSecret, authMethod: client.authMethod
    };
    const tokens = await tokenRequest(entry, {
      grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: d.resource
    });
    applyTokens(entry, tokens);

    const all = readAll();
    all[name] = entry;
    writeAll(all);
    return { expiresAt: entry.expiresAt, refreshable: !!entry.refreshToken };
  } finally {
    if (timer) clearTimeout(timer);
    if (flow.server) try { flow.server.close(); } catch {}
    active = null;
  }
}

function cancel() {
  if (active && active.reject) { active.reject(new Error('Вход отменён')); return true; }
  return false;
}

// ---------- using / maintaining tokens ----------
async function getAccessToken(name, url) {
  const all = readAll();
  const e = all[name];
  if (!e || e.url !== url) return null;
  if (e.accessToken && e.expiresAt - Date.now() > 60 * 1000) return e.accessToken;
  if (!e.refreshToken) return null;
  try {
    const j = await tokenRequest(e, { grant_type: 'refresh_token', refresh_token: e.refreshToken, resource: e.resource });
    applyTokens(e, j);
    all[name] = e;
    writeAll(all);
    return e.accessToken;
  } catch {
    // Refresh token revoked/expired: the user has to sign in again.
    delete all[name];
    writeAll(all);
    return null;
  }
}

function statusFor(servers) {
  const all = readAll();
  const out = {};
  for (const s of servers) {
    const e = all[s.name];
    if (e && e.url === s.url && (e.refreshToken || e.expiresAt > Date.now())) {
      out[s.name] = { expiresAt: e.expiresAt, refreshable: !!e.refreshToken };
    }
  }
  return out;
}

function logout(name) {
  const all = readAll();
  if (name in all) { delete all[name]; writeAll(all); }
}

// Drop tokens of servers that were deleted or whose URL changed.
function prune(servers) {
  const all = readAll();
  let changed = false;
  for (const n of Object.keys(all)) {
    const s = servers.find(x => x.name === n);
    if (!s || s.url !== all[n].url) { delete all[n]; changed = true; }
  }
  if (changed) writeAll(all);
}

module.exports = { login, cancel, getAccessToken, statusFor, logout, prune, discover };
