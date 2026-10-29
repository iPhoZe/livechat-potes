const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain, globalShortcut, screen, dialog, powerMonitor, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const WebSocket = require('ws');
const { startRelay } = require('./relay');
const { resolveLink } = require('./links');
const { createLogger } = require('./logger');

// Profil séparé pour tester plusieurs instances sur un même PC (LIVECHAT_USER_DATA=dossier)
if (process.env.LIVECHAT_USER_DATA) app.setPath('userData', path.resolve(process.env.LIVECHAT_USER_DATA));

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const log = createLogger(app.getPath('userData'), { echo: !app.isPackaged });
log.info(`--- LiveChat Potes ${app.getVersion()} démarre (${app.isPackaged ? 'installé' : 'dev'}, Windows ${process.getSystemVersion()})`);

// Filet de sécurité : une erreur imprévue est notée dans le journal au lieu d'afficher
// la fenêtre "A JavaScript error occurred in the main process".
process.on('uncaughtException', (e) => log.error('Exception non gérée :', e));
process.on('unhandledRejection', (e) => log.error('Promesse rejetée non gérée :', e instanceof Error ? e : String(e)));

// Envoi sûr vers une fenêtre : pendant la fermeture, les fenêtres peuvent déjà être détruites
function sendTo(win, channel, data) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, data);
}
const toControl = (channel, data) => sendTo(controlWin, channel, data);
const toOverlay = (channel, data) => sendTo(overlayWin, channel, data);

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
  // Écriture atomique : si l'appli est coupée en plein milieu, l'ancien fichier reste intact
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    const tmp = `${CONFIG_PATH}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
    fs.renameSync(tmp, CONFIG_PATH);
  } catch (e) {
    log.error('Impossible d’enregistrer les réglages :', e);
  }
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
  overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
  overlayWin.setVisibleOnAllWorkspaces(true);
  overlayWin.setIgnoreMouseEvents(true, { forward: true });
  overlayWin.loadFile(path.join(__dirname, 'renderer', 'overlay.html'));
  overlayWin.once('ready-to-show', () => {
    overlayWin.showInactive();
    pushSettingsToOverlay();
  });
  // Windows peut lui retirer le "toujours au premier plan" (Discord, jeux, autres fenêtres épinglées…)
  overlayWin.on('always-on-top-changed', (_e, onTop) => !onTop && !reasserting && setTimeout(bringOverlayToFront, 50));
}

// Remet l'overlay au-dessus de TOUTES les fenêtres, y compris celles elles-mêmes "toujours au premier plan".
// Basculer off/on force Windows à réappliquer le niveau, moveTop() le passe devant les autres fenêtres épinglées.
let reasserting = false;
function bringOverlayToFront() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  reasserting = true; // notre propre bascule off/on ne doit pas relancer l'écouteur ci-dessus
  try {
    overlayWin.setAlwaysOnTop(false);
    overlayWin.setAlwaysOnTop(true, 'screen-saver', 1);
    if (!overlayWin.isVisible()) overlayWin.showInactive();
    overlayWin.moveTop();
  } finally {
    setTimeout(() => (reasserting = false), 100);
  }
}

// Pendant qu'un média est à l'écran, on revérifie régulièrement qu'il reste devant
let frontTimer = null;
function keepOverlayInFront(ms = 20000) {
  bringOverlayToFront();
  clearInterval(frontTimer);
  const until = Date.now() + ms;
  frontTimer = setInterval(() => {
    if (Date.now() > until) return clearInterval(frontTimer);
    bringOverlayToFront();
  }, 1000);
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
    toControl('config', publicConfig());
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
  toOverlay('settings', {
    volume: config.volume,
    imageSeconds: config.imageSeconds,
    maxVideoSeconds: MAX_VIDEO_SECONDS,
  });
}

function clearOverlay() {
  toOverlay('clear');
}

function setDnd(value) {
  config.dnd = value;
  saveConfig();
  if (value) clearOverlay();
  wsSend({ type: 'status', dnd: value });
  refreshTrayMenu();
  toControl('config', publicConfig());
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
  toControl('update', updateState);
}

function checkForUpdates() {
  if (!autoUpdater) return;
  autoUpdater.checkForUpdates().catch((e) => setUpdate({ status: 'error', message: e.message }));
}

function setupUpdates() {
  // En mode dev (electron .), pas de mise à jour : il n'y a rien d'installé à remplacer
  if (!app.isPackaged) return setUpdate({ status: 'dev' });
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.logger = { info: (m) => log.info('[maj]', m), warn: (m) => log.warn('[maj]', m), error: (m) => log.error('[maj]', m), debug: () => {} };
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
let hostRetryTimer = null;
let hostError = null;

// Lance le relais puis appelle onReady une fois qu'il écoute (pour s'y connecter sans erreur).
// En cas d'échec (port occupé…), on réessaie toutes les 10 s et on se connecte quand même.
function startHosting(onReady) {
  clearTimeout(hostRetryTimer);
  if (relay) return onReady?.();
  relay = startRelay({
    port: config.hostPort,
    log: (line) => log.info(`[relais] ${line}`),
    onListening: () => {
      hostError = null;
      onReady?.();
    },
    onError: (e) => {
      relay = null;
      hostError =
        e.code === 'EADDRINUSE'
          ? `Le port ${config.hostPort} est déjà utilisé (une autre copie de LiveChat tourne déjà ?).`
          : `Impossible d'héberger : ${e.message}`;
      log.error(`Hébergement impossible (${e.code || e.message}), nouvel essai dans 10 s`);
      toControl('toast', { kind: 'error', text: hostError });
      hostRetryTimer = setTimeout(() => config.host && !quitting && startHosting(), 10000);
      onReady?.();
    },
  });
}

function stopHosting() {
  clearTimeout(hostRetryTimer);
  relay?.close();
  relay = null;
  hostError = null;
}

// ---------- Tunnel playit (pour l'hébergeur) ----------
// Le service playit est en démarrage "manuel" : sans lui, les potes ne peuvent pas joindre le salon.
// En mode hébergement, l'appli le démarre elle-même (pas besoin de droits admin).
const { execFile } = require('child_process');
const PLAYIT_EXE = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'playit_gg', 'bin', 'playit.exe');
const PLAYIT_CHECK_EVERY_MS = 5 * 60 * 1000;
let playitState = 'unknown'; // unknown | absent | running | error

function run(cmd, args) {
  return new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout, stderr) => resolve({ err, out: `${stdout || ''}${stderr || ''}` }))
  );
}

async function playitRunning() {
  const q = await run('sc', ['query', 'playitd']);
  return /RUNNING/.test(q.out);
}

async function ensurePlayit() {
  if (!config.host || process.platform !== 'win32') return;
  if (!fs.existsSync(PLAYIT_EXE)) {
    playitState = 'absent';
    return;
  }
  if (await playitRunning()) {
    playitState = 'running';
    return;
  }
  log.info('Tunnel playit arrêté : démarrage…');
  const r = await run(PLAYIT_EXE, ['start']);
  // le service passe par "START_PENDING" quelques secondes avant "RUNNING"
  playitState = 'error';
  for (let i = 0; i < 10; i++) {
    if (await playitRunning()) {
      playitState = 'running';
      break;
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  if (playitState === 'running') log.info('Tunnel playit démarré');
  else log.error('Impossible de démarrer playit :', r.out.trim() || r.err?.message || 'erreur inconnue');
}

function effectiveServerUrl() {
  return config.host ? `ws://localhost:${config.hostPort}` : config.serverUrl;
}

// ---------- Connexion au serveur ----------
const HANDSHAKE_TIMEOUT_MS = 10000; // ouverture de la connexion
const HELLO_TIMEOUT_MS = 10000; // réponse du salon après "hello"
const PING_EVERY_MS = 15000; // vérifie que le serveur répond toujours
const MAX_RECONNECT_DELAY_MS = 15000;

let ws = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let helloTimer = null;
let pingTimer = null;
let status = 'disconnected';
let statusDetail = '';
let retryAt = null;
let stopReconnect = false; // vrai si le serveur nous a remplacés : on attend que l'utilisateur réessaie
let presence = [];

function setStatus(s, detail = '', at = null) {
  status = s;
  statusDetail = detail;
  retryAt = at;
  toControl('status', { status: s, detail, retryAt: at });
}

function wsSend(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
      return true;
    } catch (e) {
      log.warn('Envoi impossible :', e.message);
    }
  }
  return false;
}

// Messages d'erreur réseau compréhensibles
function friendlyError(e) {
  const code = e?.code || '';
  const msg = String(e?.message || e || '');
  if (code === 'ECONNREFUSED') return "Le serveur refuse la connexion : l'hébergeur a sans doute fermé l'appli ou éteint son PC.";
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return "Adresse du serveur introuvable : vérifie ta connexion Internet (ou l'adresse dans les réglages).";
  if (code === 'ETIMEDOUT' || /handshake has timed out/i.test(msg)) return "Le serveur ne répond pas : PC de l'hébergeur éteint, en veille, ou tunnel playit arrêté ?";
  if (code === 'ECONNRESET' || /socket hang up/i.test(msg)) return "Connexion coupée par le serveur : l'hébergeur n'est probablement pas en ligne.";
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return 'Pas de réseau : vérifie ta connexion Internet.';
  const http = msg.match(/Unexpected server response: (\d+)/);
  if (http) return `L'adresse répond, mais ce n'est pas un serveur LiveChat (HTTP ${http[1]}) : vérifie l'adresse.`;
  return msg || 'Erreur de connexion inconnue.';
}

// Abandonne la connexion en cours sans déclencher de reconnexion ni d'erreur non gérée
function discardSocket() {
  clearTimeout(helloTimer);
  clearInterval(pingTimer);
  if (!ws) return;
  const old = ws;
  ws = null;
  old.removeAllListeners();
  // terminate() sur une connexion pas encore ouverte émet une erreur : sans écouteur, elle ferait planter l'appli
  old.on('error', () => {});
  try {
    old.terminate();
  } catch {}
}

function scheduleReconnect(reason) {
  clearTimeout(reconnectTimer);
  if (quitting || stopReconnect) return;
  const delay = reconnectDelay + Math.floor(Math.random() * 500);
  reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY_MS);
  setStatus('disconnected', reason, Date.now() + delay);
  reconnectTimer = setTimeout(connect, delay);
}

function connect() {
  clearTimeout(reconnectTimer);
  discardSocket();
  stopReconnect = false;
  if (presence.length) {
    presence = [];
    toControl('presence', { users: [] });
  }
  if (quitting) return;

  const url = effectiveServerUrl();
  if (!url || !config.name || !config.room) {
    setStatus('disconnected', 'Remplis ton pseudo, le serveur et le code du salon.');
    return;
  }

  setStatus('connecting');
  let sock;
  try {
    sock = new WebSocket(url, { maxPayload: 64 * 1024 * 1024, handshakeTimeout: HANDSHAKE_TIMEOUT_MS });
  } catch (e) {
    // Adresse mal écrite : réessayer ne servirait à rien, il faut la corriger dans les réglages
    log.warn(`Adresse invalide "${url}" :`, e.message);
    setStatus('error', `Adresse du serveur invalide (${url}). Corrige-la dans les réglages.`);
    return;
  }
  ws = sock;
  log.info(`Connexion à ${url} en tant que ${config.name}…`);

  let welcomed = false;
  let lastError = null;

  sock.on('open', () => {
    sock.send(JSON.stringify({ type: 'hello', name: config.name, room: config.room, dnd: config.dnd, caps: ['duel'] }));
    helloTimer = setTimeout(() => {
      lastError = "Le serveur n'a pas répondu à la demande d'entrée dans le salon.";
      log.warn('Pas de réponse au hello, on coupe');
      sock.terminate();
    }, HELLO_TIMEOUT_MS);
  });

  sock.on('pong', () => (sock.isAlive = true));

  sock.on('message', (raw) => {
    if (ws !== sock) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'welcome':
        welcomed = true;
        clearTimeout(helloTimer);
        reconnectDelay = 1000;
        // Côté client aussi on vérifie que le serveur répond : sinon on resterait "Connecté" dans le vide
        sock.isAlive = true;
        pingTimer = setInterval(() => {
          if (!sock.isAlive) {
            lastError = 'Le serveur ne répond plus.';
            log.warn('Pas de pong du serveur, on coupe');
            return sock.terminate();
          }
          sock.isAlive = false;
          try { sock.ping(); } catch {}
        }, PING_EVERY_MS);
        log.info('Connecté au salon');
        setStatus('connected');
        break;
      case 'replaced':
        stopReconnect = true;
        log.warn('Remplacé par une autre connexion avec le même pseudo');
        setStatus('error', `${msg.message} Clique sur « Réessayer » pour reprendre la main.`);
        break;
      case 'presence':
        presence = msg.users;
        toControl('presence', { users: msg.users, refreshed: !!msg.refreshed });
        break;
      case 'error':
        if (!welcomed) lastError = msg.message;
        log.warn('Erreur du serveur :', msg.message);
        toControl('toast', { kind: 'error', text: msg.message });
        break;
      case 'sent': {
        let text = 'Envoyé !';
        if (msg.total === 0) text = "Personne d'autre n'est connecté.";
        else if (msg.delivered === 0) text = 'Pas envoyé : mode Ne pas déranger activé chez eux.';
        else if (msg.delivered < msg.total) text = `Envoyé à ${msg.delivered}/${msg.total} (les autres sont en Ne pas déranger).`;
        toControl('toast', { kind: msg.delivered > 0 ? 'ok' : 'error', text });
        toControl('sent', { id: msg.id, clientId: msg.clientId, recipients: msg.recipients || [] });
        break;
      }
      case 'ack':
        toControl('ack', { id: msg.id, by: msg.by, status: msg.status });
        break;
      // Duel de clics : l'overlay affiche le jeu, la fenêtre affiche le résultat
      case 'duel':
        keepOverlayInFront(30000);
        toOverlay('duel', msg);
        toControl('toast', { kind: 'ok', text: msg.you === 'a' ? `⚔ Duel lancé contre ${msg.b} !` : `⚔ ${msg.a} te défie en duel !` });
        break;
      case 'duel-pos':
        toOverlay('duel-pos', msg);
        break;
      case 'duel-end': {
        toOverlay('duel-end', msg);
        const me = config.name;
        const text = msg.winner === me ? '🏆 Duel gagné !' : msg.winner ? `💀 Duel perdu contre ${msg.winner}…` : '🤝 Égalité : tout le monde se mange le média !';
        toControl('toast', { kind: msg.winner === me ? 'ok' : 'error', text });
        log.info(`Duel terminé : ${msg.winner || 'égalité'} (${msg.ca}-${msg.cb}, ${msg.reason})`);
        break;
      }
      case 'media':
        if (config.dnd) {
          wsSend({ type: 'ack', id: msg.id, status: 'skipped' });
          return;
        }
        wsSend({ type: 'ack', id: msg.id, status: 'received' });
        keepOverlayInFront();
        toOverlay('media', msg);
        toControl('received', { from: msg.from, kind: msg.kind, text: msg.text, source: msg.source, at: Date.now() });
        break;
    }
  });

  sock.on('error', (e) => {
    lastError = friendlyError(e);
    log.warn(`Erreur de connexion (${e.code || '-'}) : ${e.message}`);
  });

  sock.on('close', (code) => {
    if (ws !== sock) return; // connexion déjà remplacée par une plus récente
    ws = null;
    clearTimeout(helloTimer);
    clearInterval(pingTimer);
    presence = [];
    toControl('presence', { users: [] });
    log.info(`Connexion fermée (code ${code})${welcomed ? '' : ' avant d’entrer dans le salon'}`);
    if (stopReconnect) return; // statut déjà affiché ("remplacé")
    scheduleReconnect(lastError || (welcomed ? 'Connexion perdue, reconnexion…' : 'Connexion impossible, nouvel essai…'));
  });
}

// Réessayer tout de suite (bouton "Réessayer", sortie de veille…)
function reconnectNow(reason) {
  if (reason) log.info(reason);
  reconnectDelay = 1000;
  if (config.host && !relay) startHosting(connect);
  else connect();
}

// ---------- Diagnostic de connexion ----------
function tcpCheck(host, port, timeout = 6000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const s = net.connect({ host, port });
    const done = (err) => {
      s.removeAllListeners();
      s.on('error', () => {});
      s.destroy();
      resolve(err ? { ok: false, err } : { ok: true, ms: Date.now() - started });
    };
    s.setTimeout(timeout, () => done({ code: 'ETIMEDOUT' }));
    s.once('connect', () => done(null));
    s.once('error', (e) => done(e));
  });
}

function wsCheck(url, timeout = 8000) {
  return new Promise((resolve) => {
    const t = new WebSocket(url, { handshakeTimeout: timeout });
    const done = (err) => {
      t.removeAllListeners();
      t.on('error', () => {});
      try { t.terminate(); } catch {}
      resolve(err ? { ok: false, err } : { ok: true });
    };
    t.once('open', () => done(null));
    t.once('error', (e) => done(e));
  });
}

// Vérifie une adresse étape par étape : nom → port → serveur LiveChat
async function checkAddress(url, label, steps) {
  let u;
  try {
    u = new URL(url);
    if (!/^wss?:$/.test(u.protocol)) throw new Error('protocole');
  } catch {
    steps.push({ ok: false, label: `${label} : adresse invalide`, hint: `« ${url} » doit ressembler à ws://exemple.ply.gg:1234` });
    return false;
  }
  const port = Number(u.port) || (u.protocol === 'wss:' ? 443 : 80);
  try {
    const { address } = await dns.lookup(u.hostname);
    steps.push({ ok: true, label: `${label} : ${u.hostname} trouvé (${address})` });
  } catch (e) {
    steps.push({ ok: false, label: `${label} : ${u.hostname} introuvable`, hint: friendlyError(e) });
    return false;
  }
  const tcp = await tcpCheck(u.hostname, port);
  if (!tcp.ok) {
    steps.push({ ok: false, label: `${label} : port ${port} injoignable`, hint: friendlyError(tcp.err) });
    return false;
  }
  steps.push({ ok: true, label: `${label} : port ${port} joignable (${tcp.ms} ms)` });
  const w = await wsCheck(url);
  if (!w.ok) {
    steps.push({ ok: false, label: `${label} : pas de serveur LiveChat derrière`, hint: friendlyError(w.err) });
    return false;
  }
  steps.push({ ok: true, label: `${label} : serveur LiveChat OK` });
  return true;
}

async function diagnose() {
  const steps = [];
  if (!config.name || !config.room) steps.push({ ok: false, label: 'Pseudo ou code du salon manquant', hint: 'Remplis-les dans les réglages.' });
  else steps.push({ ok: true, label: `Pseudo « ${config.name} » et code du salon renseignés` });

  if (config.host) {
    steps.push(relay ? { ok: true, label: `Salon hébergé sur ce PC (port ${config.hostPort})` } : { ok: false, label: 'Hébergement arrêté', hint: hostError || 'Le serveur intégré ne tourne pas.' });
    await ensurePlayit();
    if (playitState === 'running') steps.push({ ok: true, label: 'Tunnel playit actif' });
    else if (playitState === 'absent') steps.push({ ok: false, label: 'playit n’est pas installé', hint: 'Sans tunnel, tes potes ne peuvent pas te joindre depuis Internet.' });
    else steps.push({ ok: false, label: 'Tunnel playit arrêté', hint: 'Impossible de le démarrer automatiquement : lance « playit » depuis le menu Démarrer.' });
    // Ce que voient les potes : l'adresse publique (tunnel)
    if (config.serverUrl && !/localhost|127\.0\.0\.1/.test(config.serverUrl)) await checkAddress(config.serverUrl, 'Depuis Internet', steps);
  } else {
    await checkAddress(config.serverUrl, 'Serveur', steps);
  }

  const labels = { connected: 'connecté au salon', connecting: 'connexion en cours', disconnected: 'déconnecté', error: 'erreur' };
  steps.push({ ok: status === 'connected', label: `Ma connexion : ${labels[status] || status}`, hint: status === 'connected' ? '' : statusDetail });
  log.info('Diagnostic :', steps.map((s) => `${s.ok ? 'OK' : 'KO'} ${s.label}${s.hint ? ` (${s.hint})` : ''}`).join(' | '));
  return steps;
}

// ---------- IPC ----------
ipcMain.handle('get-state', () => ({
  config: publicConfig(),
  status,
  statusDetail,
  retryAt,
  presence,
  version: app.getVersion(),
  packaged: app.isPackaged,
  update: updateState,
  mouseCaptured,
}));

ipcMain.handle('reconnect-now', () => reconnectNow('Réessai demandé par l’utilisateur'));
ipcMain.handle('diagnose', () => diagnose());
ipcMain.handle('open-log', () => shell.openPath(log.file));

// Rapport à coller sur Discord pour qu'on puisse aider (sans le code du salon)
ipcMain.handle('copy-report', async () => {
  const steps = await diagnose();
  const report = [
    `LiveChat Potes ${app.getVersion()} (${app.isPackaged ? 'installé' : 'dev'}) - Windows ${process.getSystemVersion()}`,
    `Pseudo: ${config.name || '-'} | hébergeur: ${config.host ? 'oui' : 'non'} | serveur: ${config.serverUrl}`,
    '',
    ...steps.map((s) => `${s.ok ? '✅' : '❌'} ${s.label}${s.hint ? `\n    → ${s.hint}` : ''}`),
    '',
    '--- Journal (fin) ---',
    log.tail(60),
  ]
    .join('\n')
    .split(config.room || '\u0000')
    .join('[code du salon]');
  clipboard.writeText(report);
  return { ok: true };
});

// Erreurs JavaScript des fenêtres : notées dans le journal
ipcMain.on('renderer-error', (_e, { where, message }) => log.error(`Erreur dans ${where} :`, String(message).slice(0, 2000)));

ipcMain.handle('check-updates', () => checkForUpdates());
ipcMain.on('install-update', installUpdateNow);

ipcMain.handle('save-connection', (_e, { serverUrl, name, room, host }) => {
  if (serverUrl !== undefined) config.serverUrl = String(serverUrl || '').trim();
  if (name !== undefined) config.name = String(name || '').trim().slice(0, 24);
  if (room !== undefined) config.room = String(room || '').trim().slice(0, 64);
  if (host !== undefined) config.host = !!host;
  saveConfig();
  if (config.host) {
    startHosting(connect);
    ensurePlayit();
  } else {
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

ipcMain.handle('duel-start', (_e, { to, media }) => {
  const ok = wsSend({ type: 'duel-start', to, media });
  return ok ? { ok: true } : { ok: false, error: 'Pas connecté au serveur.' };
});
ipcMain.on('duel-click', (_e, id) => wsSend({ type: 'duel-click', id }));

ipcMain.handle('preview-self', (_e, payload) => {
  // Test local : affiche le média sur ton propre écran
  keepOverlayInFront();
  toOverlay('media', { ...payload, id: `local-${Date.now()}`, from: `${config.name || 'Moi'} (test)` });
  return { ok: true };
});

// L'overlay signale ce qu'il a fait du média : affiché, échec, ou ignoré (écran effacé)
ipcMain.on('overlay-ack', (_e, { id, status }) => {
  if (!id || String(id).startsWith('local-')) return;
  wsSend({ type: 'ack', id, status });
});

ipcMain.on('clear-overlay', clearOverlay);

// Mode combat : l'overlay laisse passer la souris partout, sauf au-dessus du média affiché (pour pouvoir le frapper).
// On surveille la position du curseur tant qu'un média est à l'écran : plus fiable que les événements "forward".
let hitbox = null;
let hitTimer = null;
let mouseCaptured = false;

function setMouseCapture(v) {
  if (v === mouseCaptured || !overlayWin || overlayWin.isDestroyed()) return;
  mouseCaptured = v;
  overlayWin.setIgnoreMouseEvents(!v, { forward: true });
}

ipcMain.on('overlay-hitbox', (_e, box) => {
  hitbox = box;
  clearInterval(hitTimer);
  if (!box) return setMouseCapture(false);
  hitTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !hitbox) return;
    const p = screen.getCursorScreenPoint();
    const b = overlayWin.getBounds();
    const x = p.x - b.x;
    const y = p.y - b.y;
    const pad = 8; // la carte tremble un peu quand on la frappe
    setMouseCapture(x >= hitbox.x - pad && x <= hitbox.x + hitbox.w + pad && y >= hitbox.y - pad && y <= hitbox.y + hitbox.h + pad);
  }, 40);
});
ipcMain.on('quit-app', quitApp);

// ---------- Démarrage ----------
app.on('second-instance', showControl);

app.whenReady().then(() => {
  if (process.platform === 'win32') app.setAppUserModelId('fr.potes.livechat');
  createOverlay();
  createControl();
  createTray();

  // Un raccourci déjà pris par une autre appli n'est pas grave : on le note simplement
  if (!globalShortcut.register('CommandOrControl+Shift+X', clearOverlay)) log.warn('Raccourci Ctrl+Maj+X déjà utilisé par une autre appli');
  if (!globalShortcut.register('CommandOrControl+Shift+D', () => setDnd(!config.dnd))) log.warn('Raccourci Ctrl+Maj+D déjà utilisé par une autre appli');

  // Si l'écran change (résolution, écran principal…), on recale l'overlay
  const fitOverlay = () => {
    if (overlayWin && !overlayWin.isDestroyed()) overlayWin.setBounds(screen.getPrimaryDisplay().bounds);
    bringOverlayToFront();
  };
  screen.on('display-metrics-changed', fitOverlay);
  screen.on('display-added', fitOverlay);
  screen.on('display-removed', fitOverlay);

  // Après une veille, la connexion est morte : on reconnecte sans attendre le prochain essai
  powerMonitor.on('resume', () => setTimeout(() => { bringOverlayToFront(); ensurePlayit(); reconnectNow('Sortie de veille : reconnexion'); }, 2000));
  // Filet de sécurité : on revérifie le premier plan toutes les 30 s même sans média
  setInterval(bringOverlayToFront, 30000);
  powerMonitor.on('unlock-screen', () => status !== 'connected' && reconnectNow('Session déverrouillée : reconnexion'));

  if (config.host) startHosting(connect);
  else connect();
  ensurePlayit();
  setInterval(ensurePlayit, PLAYIT_CHECK_EVERY_MS);

  setupUpdates();
});

app.on('before-quit', () => {
  quitting = true;
  clearTimeout(reconnectTimer);
  discardSocket();
  stopHosting();
  log.info('Fermeture de l’appli');
});
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', (e) => e.preventDefault());
