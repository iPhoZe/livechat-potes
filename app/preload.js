const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (cb) => {
  const listener = (_e, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld('livechat', {
  // Fenêtre de contrôle
  getState: () => ipcRenderer.invoke('get-state'),
  saveConnection: (c) => ipcRenderer.invoke('save-connection', c),
  savePrefs: (p) => ipcRenderer.invoke('save-prefs', p),
  setDnd: (v) => ipcRenderer.invoke('set-dnd', v),
  setAutostart: (v) => ipcRenderer.invoke('set-autostart', v),
  refreshPresence: () => ipcRenderer.invoke('refresh-presence'),
  resolveLink: (url) => ipcRenderer.invoke('resolve-link', url),
  sendMedia: (p) => ipcRenderer.invoke('send-media', p),
  duelStart: (p) => ipcRenderer.invoke('duel-start', p),
  previewSelf: (p) => ipcRenderer.invoke('preview-self', p),
  clearOverlay: () => ipcRenderer.send('clear-overlay'),
  quit: () => ipcRenderer.send('quit-app'),
  reconnectNow: () => ipcRenderer.invoke('reconnect-now'),
  diagnose: () => ipcRenderer.invoke('diagnose'),
  openLog: () => ipcRenderer.invoke('open-log'),
  copyReport: () => ipcRenderer.invoke('copy-report'),
  reportError: (where, message) => ipcRenderer.send('renderer-error', { where, message }),
  checkUpdates: () => ipcRenderer.invoke('check-updates'),
  installUpdate: () => ipcRenderer.send('install-update'),
  onUpdate: on('update'),
  onStatus: on('status'),
  onPresence: on('presence'),
  onToast: on('toast'),
  onReceived: on('received'),
  onConfig: on('config'),
  onSent: on('sent'),
  onAck: on('ack'),

  // Overlay
  ack: (id, status) => ipcRenderer.send('overlay-ack', { id, status }),
  setHitbox: (box) => ipcRenderer.send('overlay-hitbox', box),
  duelClick: (id) => ipcRenderer.send('duel-click', id),
  onDuel: on('duel'),
  onDuelPos: on('duel-pos'),
  onDuelEnd: on('duel-end'),
  onMedia: on('media'),
  onClear: on('clear'),
  onSettings: on('settings'),
});
