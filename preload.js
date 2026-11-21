const { contextBridge, ipcRenderer } = require('electron');

const on = (channel, cb) => {
  const h = (_e, d) => cb(d);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.removeListener(channel, h);
};

contextBridge.exposeInMainWorld('api', {
  info: () => ipcRenderer.invoke('cli:info'),
  pickCli: () => ipcRenderer.invoke('cli:pick'),
  loginStart: () => ipcRenderer.invoke('login:start'),
  loginCode: code => ipcRenderer.invoke('login:code', code),
  loginCancel: () => ipcRenderer.invoke('login:cancel'),
  onLogin: cb => on('login:event', cb),
  historyList: () => ipcRenderer.invoke('history:list'),
  historyLoad: id => ipcRenderer.invoke('history:load', id),
  historySave: chat => ipcRenderer.invoke('history:save', chat),
  historyDelete: id => ipcRenderer.invoke('history:delete', id),
  oauthStatus: () => ipcRenderer.invoke('oauth:status'),
  oauthLogin: name => ipcRenderer.invoke('oauth:login', name),
  oauthCancel: () => ipcRenderer.invoke('oauth:cancel'),
  oauthLogout: name => ipcRenderer.invoke('oauth:logout', name),
  onOauth: cb => on('oauth:event', cb),
  mcpGet: () => ipcRenderer.invoke('mcp:get'),
  mcpSave: cfg => ipcRenderer.invoke('mcp:save', cfg),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  defaults: () => ipcRenderer.invoke('app:defaults'),
  send: opts => ipcRenderer.invoke('claude:send', opts),
  stop: () => ipcRenderer.invoke('claude:stop'),
  onEvent: cb => on('claude:event', cb),
  onDone: cb => on('claude:done', cb)
});
