const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const { startRelay } = require('./relay');
const { resolveLink } = require('./links');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const MAX_VIDEO_SECONDS = 15;
const START_HIDDEN = process.argv.includes('--hidden');

// ---------- Config ----------
const CONFIG_PATH = path.join(app.getPath('userData'), 'config.json');
const DEFAULT_CONFIG = {
  serverUrl: 'ws://localhost:8080',
  name: '',
  room: '',
  volume: 0.6,
  imageSeconds: 6,
  dnd: false,
  host: false,
  hostPort: 8080,
  closeBehavior: 'ask', // 'ask' | 'tray' | 'quit'
};

// defaults.json est intégré au .exe : adresse du serveur et code du salon pré-remplis pour les potes
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}
const BUNDLED_DEFAULTS = readJson(path.join(__dirname, 'defaults.json'));

function loadConfig() {
  return { ...DEFAULT_CONFIG, ...BUNDLED_DEFAULTS, ...readJson(CONFIG_PATH) };
}

function saveConfig() {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

let config = loadConfig();

// ---------- Lancement au démarrage de Windows ----------
function getAutostart() {
  return app.isPackaged && app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
}

function setAutostart(enabled) {
  // En mode dev (electron .), le raccourci de démarrage pointerait vers electron.exe : on ne le fait qu'avec l'appli installée
  if (!app.isPackaged) return false;
  app.setLoginItemSettings({ openAtLogin: !!enabled, args: ['--hidden'] });
  return getAutostart();
}

// ---------- Fenêtres ----------
let overlayWin = null;
let controlWin = null;
let tray = null;
let quitting = false;

function createOverlay() {
  const { bounds } = screen.getPrimaryDisplay();
  overlayWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
    },
  });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.setIgnoreMouseEvents(true);
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    overlayWin.showInactive();
    pushSettingsToOverlay();
  });
}

function createControl() {
  controlWin = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 400,
    minHeight: 600,
    title: 'LiveChat Potes',
    backgroundColor: '#0f0d17',
    autoHideMenuBar: true,
    show: false,
    icon: makeIcon(64),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  controlWin.loadFile(path.join(__dirname, 'renderer', 'control.html'));
  controlWin.once('ready-to-show', () => {
    // Lancé au démarrage de Windows : on reste discret dans la zone de notification
    if (!START_HIDDEN || !config.name) controlWin.show();
  });
  controlWin.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    handleCloseRequest();
  });
}

async function handleCloseRequest() {
  if (config.closeBehavior === 'quit') return quitApp();
  if (config.closeBehavior === 'tray') return controlWin.hide();

  const { response, checkboxChecked } = await dialog.showMessageBox(controlWin, {
    type: 'question',
    title: 'LiveChat Potes',
    message: 'Fermer LiveChat Potes ?',
    detail:
      "En arrière-plan, tu continues de recevoir les GIFs et vidéos de tes potes. L'appli reste accessible avec l'icône près de l'horloge.",
    buttons: ['Laisser tourner en arrière-plan', 'Quitter complètement', 'Annuler'],
    defaultId: 0,
    cancelId: 2,
    checkboxLabel: 'Retenir mon choix',
    noLink: true,
  });
  if (response === 2) return;
  if (checkboxChecked) {
    config.closeBehavior = response === 0 ? 'tray' : 'quit';
    saveConfig();
    controlWin.webContents.send('config', publicConfig());
  }
  if (response === 0) controlWin.hide();
  else quitApp();
}

function quitApp() {
  quitting = true;
  app.quit();
}

function showControl() {
  if (!controlWin) return;
  controlWin.show();
  controlWin.focus();
}

// Icône générée à la volée (dégradé violet → rose avec un triangle "play"), pas besoin de fichier image
function makeIcon(size) {
  const buf = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const r = size / 2 - 0.5;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const d = Math.hypot(x - c, y - c);
      const alpha = Math.max(0, Math.min(1, r - d + 0.5));
      if (alpha <= 0) continue;
      const t = (x + y) / (2 * size);
      let R = 168 + (236 - 168) * t;
      let G = 85 + (72 - 85) * t;
      let B = 247 + (153 - 247) * t;
      // triangle "play" blanc au centre
      const px = (x - c) / size;
      const py = (y - c) / size;
      if (px > -0.16 && px < 0.24 && Math.abs(py) < (0.24 - px) * 0.75) R = G = B = 255;
      buf[i] = B;
      buf[i + 1] = G;
      buf[i + 2] = R;
      buf[i + 3] = Math.round(alpha * 255);
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

function createTray() {
  tray = new Tray(makeIcon(16));
  tray.setToolTip('LiveChat Potes');
  tray.on('click', showControl);
  refreshTrayMenu();
}

function refreshTrayMenu() {
  if (!tray) return;
  tray.setToolTip(`LiveChat Potes${config.dnd ? ' (ne pas déranger)' : ''}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Ouvrir LiveChat Potes', click: showControl },
      { label: 'Ne pas déranger', type: 'checkbox', checked: config.dnd, click: () => setDnd(!config.dnd) },
      { label: "Effacer l'écran  (Ctrl+Maj+X)", click: clearOverlay },
      { type: 'separator' },
      { label: 'Quitter LiveChat Potes', click: quitApp },
    ])
  );
}

// ---------- Overlay ----------
function pushSettingsToOverlay() {
  overlayWin?.webContents.send('settings', {
    volume: config.volume,
    imageSeconds: config.imageSeconds,
    maxVideoSeconds: MAX_VIDEO_SECONDS,
  });
}

function clearOverlay() {
  overlayWin?.webContents.send('clear');
}

function setDnd(value) {
  config.dnd = value;
  saveConfig();
  if (value) clearOverlay();
  wsSend({ type: 'status', dnd: value });
  refreshTrayMenu();
  controlWin?.webContents.send('config', publicConfig());
}

function publicConfig() {
  return { ...config, autostart: getAutostart(), maxVideoSeconds: MAX_VIDEO_SECONDS };
}

// ---------- Mises à jour automatiques (GitHub Releases) ----------
const UPDATE_CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
let autoUpdater = null;
let updateState = { status: 'idle' }; // idle | dev | checking | downloading | ready | none | error

function setUpdate(state) {
  updateState = state;
  controlWin?.webContents.send('update', updateState);
}

function checkForUpdates() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((e) => setUpdate({ status: 'error', message: e.message }));
}

function setupUpdates() {
  // En mode dev (electron .), pas de mise à jour : il n'y a rien d'installé à remplacer
  if (!app.isPackaged) return setUpdate({ status: 'dev' });
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => setUpdate({ status: 'checking' }));
  autoUpdater.on('update-not-available', () => setUpdate({ status: 'none', checkedAt: Date.now() }));
  autoUpdater.on('update-available', (info) => setUpdate({ status: 'downloading', version: info.version, percent: 0 }));
  autoUpdater.on('download-progress', (p) => setUpdate({ ...updateState, status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', (info) => {
    setUpdate({ status: 'ready', version: info.version });
    tray?.displayBalloon({
      title: 'Mise à jour prête',
      content: `LiveChat Potes ${info.version} s'installera à la prochaine fermeture (ou redémarre maintenant depuis l'appli).`,
    });
  });
  autoUpdater.on('error', (e) => setUpdate({ status: 'error', message: e.message }));
  checkForUpdates();
  setInterval(checkForUpdates, UPDATE_CHECK_EVERY_MS);
}

function installUpdateNow() {
  if (updateState.status !== 'ready' || !autoUpdater) return;
  quitting = true;
  stopHosting();
  autoUpdater.quitAndInstall(true, true); // silencieux, puis relance l'appli
}

// ---------- Hébergement (serveur relais intégré) ----------
let relay = null;

// Lance le relais puis appelle onReady une fois qu'il écoute (pour s'y connecter sans erreur)
function startHosting(onReady) {
  if (relay) return onReady?.();
  relay = startRelay({
    port: config.hostPort,
    log: (line) => console.log(`[relais] ${line}`),
    onListening: () => onReady?.(),
    onError: (e) => {
      relay = null;
      const text =
        e.code === 'EADDRINUSE'
          ? `Le port ${config.hostPort} est déjà utilisé (un autre serveur LiveChat tourne déjà ?).`
          : `Impossible d'héberger : ${e.message}`;
      controlWin?.webContents.send('toast', { kind: 'error', text });
    },
  });
}

function stopHosting() {
  relay?.close();
  relay = null;
}

function effectiveServerUrl() {
  return config.host ? `ws://localhost:${config.hostPort}` : config.serverUrl;
}

// ---------- Connexion au serveur ----------
let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let status = 'disconnected';
let presence = [];

function setStatus(s, detail) {
  status = s;
  controlWin?.webContents.send('status', { status: s, detail });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function connect() {
  clearTimeout(reconnectTimer);
  if (ws) {
    ws.removeAllListeners();
    try { ws.terminate(); } catch {}
    ws = null;
  }
  const url = effectiveServerUrl();
  if (!url || !config.name || !config.room) {
    setStatus('disconnected', 'Remplis ton pseudo, le serveur et le code du salon.');
    return;
  }

  setStatus('connecting');
  try {
    ws = new WebSocket(url, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: 10000 });
  } catch (e) {
    setStatus('error', `Adresse du serveur invalide : ${e.message}`);
    return;
  }

  ws.on('open', () => {
    reconnectDelay = 1000;
    ws.send(JSON.stringify({ type: 'hello', name: config.name, room: config.room, dnd: config.dnd }));
  });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'welcome':
        setStatus('connected');
        break;
      case 'presence':
        presence = msg.users;
        controlWin?.webContents.send('presence', { users: msg.users, refreshed: !!msg.refreshed });
        break;
      case 'error':
        controlWin?.webContents.send('toast', { kind: 'error', text: msg.message });
        break;
      case 'sent': {
        let text = 'Envoyé !';
        if (msg.total === 0) text = "Personne d'autre n'est connecté.";
        else if (msg.delivered === 0) text = 'Pas envoyé : mode Ne pas déranger activé chez eux.';
        else if (msg.delivered < msg.total) text = `Envoyé à ${msg.delivered}/${msg.total} (les autres sont en Ne pas déranger).`;
        controlWin?.webContents.send('toast', { kind: msg.delivered > 0 ? 'ok' : 'error', text });
        controlWin?.webContents.send('sent', { id: msg.id, clientId: msg.clientId, recipients: msg.recipients || [] });
        break;
      }
      case 'ack':
        controlWin?.webContents.send('ack', { id: msg.id, by: msg.by, status: msg.status });
        break;
      case 'media':
        if (config.dnd) {
          wsSend({ type: 'ack', id: msg.id, status: 'skipped' });
          return;
        }
        wsSend({ type: 'ack', id: msg.id, status: 'received' });
        overlayWin?.webContents.send('media', msg);
        controlWin?.webContents.send('received', { from: msg.from, kind: msg.kind, text: msg.text, source: msg.source, at: Date.now() });
        break;
    }
  });

  ws.on('close', () => {
    setStatus('disconnected', 'Reconnexion…');
    presence = [];
    controlWin?.webContents.send('presence', { users: [] });
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 15000);
  });

  ws.on('error', (e) => {
    setStatus('error', e.message);
  });
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => ({
  config: publicConfig(),
  status,
  presence,
  version: app.getVersion(),
  packaged: app.isPackaged,
  update: updateState,
}));

ipcMain.handle('check-updates', () => checkForUpdates());
ipcMain.on('install-update', installUpdateNow);

ipcMain.handle('save-connection', (_e, { serverUrl, name, room, host }) => {
  if (serverUrl !== undefined) config.serverUrl = String(serverUrl || '').trim();
  if (name !== undefined) config.name = String(name || '').trim().slice(0, 24);
  if (room !== undefined) config.room = String(room || '').trim().slice(0, 64);
  if (host !== undefined) config.host = !!host;
  saveConfig();
  if (config.host) startHosting(connect);
  else {
    stopHosting();
    connect();
  }
  return publicConfig();
});

ipcMain.handle('save-prefs', (_e, prefs) => {
  if (typeof prefs.volume === 'number') config.volume = Math.min(1, Math.max(0, prefs.volume));
  if (typeof prefs.imageSeconds === 'number') config.imageSeconds = Math.min(30, Math.max(2, prefs.imageSeconds));
  if (['ask', 'tray', 'quit'].includes(prefs.closeBehavior)) config.closeBehavior = prefs.closeBehavior;
  saveConfig();
  pushSettingsToOverlay();
  return publicConfig();
});

ipcMain.handle('set-dnd', (_e, value) => {
  setDnd(!!value);
  return publicConfig();
});

ipcMain.handle('set-autostart', (_e, value) => {
  setAutostart(value);
  return publicConfig();
});

ipcMain.handle('refresh-presence', () => wsSend({ type: 'who' }));

ipcMain.handle('resolve-link', (_e, url) => resolveLink(url));

ipcMain.handle('send-media', (_e, payload) => {
  const ok = wsSend({ type: 'media', ...payload });
  return ok ? { ok: true } : { ok: false, error: 'Pas connecté au serveur.' };
});

ipcMain.handle('preview-self', (_e, payload) => {
  // Test local : affiche le média sur ton propre écran
  overlayWin?.webContents.send('media', { ...payload, id: `local-${Date.now()}`, from: `${config.name || 'Moi'} (test)` });
  return { ok: true };
});

// L'overlay signale ce qu'il a fait du média : affiché, échec, ou ignoré (écran effacé)
ipcMain.on('overlay-ack', (_e, { id, status }) => {
  if (!id || String(id).startsWith('local-')) return;
  wsSend({ type: 'ack', id, status });
});

ipcMain.on('clear-overlay', clearOverlay);
ipcMain.on('quit-app', quitApp);

// ---------- Démarrage ----------
app.on('second-instance', showControl);

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('fr.potes.livechat');
  createOverlay();
  createControl();
  createTray();

  globalShortcut.register('CommandOrControl+Shift+X', clearOverlay);
  globalShortcut.register('CommandOrControl+Shift+D', () => setDnd(!config.dnd));

  // Si l'écran change (résolution, écran principal…), on recale l'overlay
  screen.on('display-metrics-changed', () => {
    const { bounds } = screen.getPrimaryDisplay();
    overlayWin?.setBounds(bounds);
  });

  if (config.host) startHosting(connect);
  else connect();

  setupUpdates();
});

app.on('before-quit', () => {
  quitting = true;
  stopHosting();
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
