const MAX_MB = 25;
const CLIP_SECONDS = 15;
const api = window.livechat;
const $ = (id) => document.getElementById(id);

// Toute erreur JavaScript de cette fenêtre part dans le journal de l'appli
window.addEventListener('error', (e) => api.reportError('fenêtre', `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})\n${e.error?.stack || ''}`));
window.addEventListener('unhandledrejection', (e) => api.reportError('fenêtre', `Promesse rejetée : ${e.reason?.stack || e.reason}`));

let cfg = {};
let packaged = false;
let status = 'disconnected';
let users = [];
let selectedTo = '*';
let selection = null; // { type: 'file'|'link', kind, url, ... }
let resolving = false;
const sentItems = [];
const receivedItems = [];

// ---------- Utilitaires ----------
function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 48%)`;
}

function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function clock(ts) {
  return new Date(ts).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c != null) node.append(c);
  return node;
}

let toastTimer;
function toast(text, kind = 'ok') {
  const t = $('toast');
  t.textContent = text;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), 3200);
}

// ---------- Vues ----------
function showView(name) {
  for (const v of ['onboarding', 'home', 'settings']) $(`view-${v}`).hidden = v !== name;
  $('settingsBtn').hidden = name === 'onboarding';
  $('dndBtn').hidden = name === 'onboarding';
}

$('settingsBtn').addEventListener('click', () => {
  fillSettings();
  showView('settings');
});
$('backBtn').addEventListener('click', () => showView('home'));
$('quitBtn').addEventListener('click', () => api.quit());
$('quitBtn2').addEventListener('click', () => api.quit());

// ---------- Statut ----------
const STATUS_LABEL = { connected: 'Connecté', connecting: 'Connexion…', disconnected: 'Déconnecté', error: 'Pas connecté' };
let statusDetail = '';
let retryAt = null;

function renderStatus({ status: s, detail, retryAt: at }) {
  status = s;
  statusDetail = detail || '';
  retryAt = at || null;
  const box = $('status');
  box.className = `status ${s}`;
  box.title = statusDetail;
  renderConnection();
}

// Bandeau "pas connecté" : ce qui se passe, quand on réessaie, et un bouton pour réessayer tout de suite
function renderConnection() {
  const secs = retryAt ? Math.max(0, Math.ceil((retryAt - Date.now()) / 1000)) : null;
  const label = $('status').querySelector('.label');
  label.textContent = status === 'disconnected' && secs ? `Reconnexion dans ${secs} s` : STATUS_LABEL[status] || status;

  const box = $('connBox');
  box.hidden = status === 'connected' || !cfg.name;
  if (box.hidden) return;
  box.className = `conn-box ${status === 'connecting' ? 'connecting' : ''}`;
  const msg = $('connMsg');
  msg.innerHTML = '';
  if (status === 'connecting') msg.append('Connexion au serveur…');
  else {
    msg.append(statusDetail || 'Pas connecté au serveur.');
    if (secs) msg.append(el('small', {}, `Nouvel essai automatique dans ${secs} s.`));
  }
  $('retryBtn').disabled = status === 'connecting';
}
setInterval(() => retryAt && renderConnection(), 1000);

$('retryBtn').addEventListener('click', () => api.reconnectNow());
$('diagLink').addEventListener('click', () => {
  fillSettings();
  showView('settings');
  $('troubleshoot').scrollIntoView({ behavior: 'smooth' });
  runDiagnose();
});

// ---------- Dépannage ----------
async function runDiagnose() {
  const list = $('diagList');
  list.hidden = false;
  list.innerHTML = '';
  list.append(el('li', { class: 'running' }, '⏳ Test en cours… (jusqu’à 20 s)'));
  $('diagBtn').disabled = true;
  try {
    const steps = await api.diagnose();
    list.innerHTML = '';
    for (const s of steps) list.append(el('li', { class: s.ok ? 'ok' : 'ko' }, `${s.ok ? '✅' : '❌'} ${s.label}`, s.hint ? el('small', {}, s.hint) : null));
  } catch (e) {
    list.innerHTML = '';
    list.append(el('li', { class: 'ko' }, `❌ Le test a échoué : ${e.message}`));
  } finally {
    $('diagBtn').disabled = false;
  }
}
$('diagBtn').addEventListener('click', runDiagnose);
$('openLog').addEventListener('click', () => api.openLog());
$('copyReport').addEventListener('click', async () => {
  $('copyReport').disabled = true;
  toast('Préparation du rapport…');
  try {
    await api.copyReport();
    toast('Rapport copié : colle-le sur Discord (Ctrl+V).');
  } finally {
    $('copyReport').disabled = false;
  }
});

// ---------- Ne pas déranger ----------
function renderDnd() {
  const on = !!cfg.dnd;
  $('dndBanner').hidden = !on || !$('view-onboarding').hidden;
  const btn = $('dndBtn');
  btn.classList.toggle('active', on);
  btn.querySelector('use').setAttribute('href', on ? '#i-bell-off' : '#i-bell');
  btn.title = on ? 'Ne pas déranger activé, cliquer pour recevoir à nouveau' : 'Ne pas déranger (Ctrl+Maj+D)';
}

$('dndBtn').addEventListener('click', async () => {
  cfg = await api.setDnd(!cfg.dnd);
  renderDnd();
  toast(cfg.dnd ? 'Ne pas déranger activé : tu ne reçois plus rien.' : 'Tu peux de nouveau recevoir.');
});
$('dndOff').addEventListener('click', async () => {
  cfg = await api.setDnd(false);
  renderDnd();
});

// ---------- Premier lancement ----------
function fillOnboarding() {
  $('obName').value = cfg.name || '';
  $('obServer').value = cfg.serverUrl || '';
  $('obRoom').value = cfg.room || '';
  $('obHost').checked = !!cfg.host;
  $('obAutostartRow').hidden = !packaged;
}

$('obGo').addEventListener('click', async () => {
  const name = $('obName').value.trim();
  if (!name) {
    $('obName').focus();
    return toast('Choisis un pseudo pour que tes potes te reconnaissent.', 'error');
  }
  const room = $('obRoom').value.trim();
  if (!room) {
    $('obRoom').focus();
    return toast('Il faut le code du salon : demande-le à celui qui héberge.', 'error');
  }
  cfg = await api.saveConnection({ name, serverUrl: $('obServer').value, room, host: $('obHost').checked });
  if (packaged) cfg = await api.setAutostart($('obAutostart').checked);
  showView('home');
  renderDnd();
  renderPeople();
  renderConnection();
});
$('obName').addEventListener('keydown', (e) => e.key === 'Enter' && $('obGo').click());

// ---------- Réglages ----------
function fillSettings() {
  $('name').value = cfg.name || '';
  $('serverUrl').value = cfg.serverUrl || '';
  $('room').value = cfg.room || '';
  $('host').checked = !!cfg.host;
  syncHostField();
  $('volume').value = cfg.volume;
  $('volumeVal').textContent = `${Math.round(cfg.volume * 100)} %`;
  $('imageSeconds').value = cfg.imageSeconds;
  $('imageSecondsVal').textContent = `${cfg.imageSeconds} s`;
  $('dnd').checked = !!cfg.dnd;
  $('autostart').checked = !!cfg.autostart;
  $('autostart').disabled = !packaged;
  $('autostartRow').classList.toggle('disabled', !packaged);
  $('autostartRow').title = packaged ? '' : "Disponible uniquement avec l'appli installée.";
  $('closeBehavior').value = cfg.closeBehavior || 'ask';
}

function syncHostField() {
  $('serverUrl').disabled = $('host').checked;
}
$('host').addEventListener('change', syncHostField);

$('connect').addEventListener('click', async () => {
  const name = $('name').value.trim();
  if (!name) return toast('Le pseudo ne peut pas être vide.', 'error');
  cfg = await api.saveConnection({ name, serverUrl: $('serverUrl').value, room: $('room').value, host: $('host').checked });
  toast('Enregistré, reconnexion…');
  showView('home');
});

$('volume').addEventListener('input', async (e) => {
  $('volumeVal').textContent = `${Math.round(e.target.value * 100)} %`;
  cfg = await api.savePrefs({ volume: Number(e.target.value) });
});
$('imageSeconds').addEventListener('input', async (e) => {
  $('imageSecondsVal').textContent = `${e.target.value} s`;
  cfg = await api.savePrefs({ imageSeconds: Number(e.target.value) });
});
$('dnd').addEventListener('change', async (e) => {
  cfg = await api.setDnd(e.target.checked);
  renderDnd();
});
$('autostart').addEventListener('change', async (e) => {
  cfg = await api.setAutostart(e.target.checked);
  e.target.checked = !!cfg.autostart;
});
$('closeBehavior').addEventListener('change', async (e) => {
  cfg = await api.savePrefs({ closeBehavior: e.target.value });
});
$('clear').addEventListener('click', () => {
  api.clearOverlay();
  toast("Écran effacé.");
});

// ---------- Gens en ligne ----------
function avatar(name, dotClass) {
  const a = el('span', { class: 'avatar', style: `background:${colorFor(name)}` }, name.charAt(0).toUpperCase());
  if (dotClass) a.append(el('span', { class: `dot ${dotClass}` }));
  return a;
}

function renderPeople() {
  const box = $('people');
  box.innerHTML = '';
  const others = users.filter((u) => u.name !== cfg.name);
  const canReceive = others.filter((u) => !u.dnd).length;

  if (selectedTo !== '*' && !others.some((u) => u.name === selectedTo)) selectedTo = '*';

  if (status !== 'connected') {
    box.append(el('div', { class: 'empty' }, 'La liste s’affichera une fois connecté.'));
    $('onlineCount').textContent = '';
  } else {
    const everyone = el(
      'button',
      { class: `person everyone${selectedTo === '*' ? ' selected' : ''}`, onclick: () => selectRecipient('*') },
      el('span', { class: 'avatar' }, '★'),
      'Tout le monde'
    );
    box.append(everyone);
    for (const u of users) {
      const isMe = u.name === cfg.name;
      const classes = ['person', isMe && 'me', u.dnd && 'dnd', selectedTo === u.name && 'selected'].filter(Boolean).join(' ');
      const chip = el('button', { class: classes, title: u.dnd ? 'En mode Ne pas déranger : ne reçoit rien' : 'Peut recevoir' }, avatar(u.name, u.dnd ? 'off' : 'ok'), isMe ? `${u.name} (toi)` : u.name);
      if (!isMe) chip.addEventListener('click', () => selectRecipient(u.name));
      box.append(chip);
    }
    $('onlineCount').textContent = others.length
      ? `· ${others.length} pote${others.length > 1 ? 's' : ''}, ${canReceive} peu${canReceive > 1 ? 'vent' : 't'} recevoir`
      : '· personne d’autre pour l’instant';
  }
  renderSendLabel();
}

function selectRecipient(name) {
  selectedTo = name;
  renderPeople();
}

function renderSendLabel() {
  $('sendLabel').textContent = selectedTo === '*' ? 'Envoyer à tout le monde' : `Envoyer à ${selectedTo}`;
}

let refreshTimeout;
$('refreshBtn').addEventListener('click', async () => {
  if (status !== 'connected') return toast('Pas connecté au serveur.', 'error');
  $('refreshBtn').classList.add('spinning');
  await api.refreshPresence();
  clearTimeout(refreshTimeout);
  refreshTimeout = setTimeout(() => $('refreshBtn').classList.remove('spinning'), 6000);
});

// ---------- Choix du média ----------
function kindFromMime(mime) {
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

function clearSelection() {
  if (selection?.objectUrl) URL.revokeObjectURL(selection.objectUrl);
  selection = null;
  $('drop').classList.remove('has-media');
  $('drop').querySelector('.drop-empty').hidden = false;
  $('drop').querySelector('.drop-preview').hidden = true;
  $('drop').querySelector('.preview-media').innerHTML = '';
  $('clipRow').hidden = true;
}

function selectFile(file) {
  if (!file) return;
  const kind = kindFromMime(file.type || '');
  if (!kind) return toast('Format non supporté : images, GIFs, vidéos ou sons uniquement.', 'error');
  if (file.size > MAX_MB * 1024 * 1024) return toast(`Fichier trop lourd (max ${MAX_MB} Mo).`, 'error');
  clearSelection();
  $('url').value = '';
  setLinkState('');
  selection = { type: 'file', file, kind, mime: file.type, objectUrl: URL.createObjectURL(file), label: file.name };
  renderPreview();
}

function renderPreview() {
  const drop = $('drop');
  const holder = drop.querySelector('.preview-media');
  holder.innerHTML = '';
  drop.classList.add('has-media');
  drop.querySelector('.drop-empty').hidden = true;
  drop.querySelector('.drop-preview').hidden = false;

  const src = selection.objectUrl || selection.url;
  if (selection.kind === 'video') {
    const v = el('video', { muted: '', autoplay: '', loop: '', playsinline: '' });
    v.muted = true;
    if (selection.thumbnail) v.poster = selection.thumbnail;
    v.src = src;
    v.addEventListener('loadedmetadata', () => {
      if (!selection) return;
      if (!selection.duration && Number.isFinite(v.duration)) selection.duration = v.duration;
      setupClip();
      renderMeta();
    }, { once: true });
    v.addEventListener('error', () => toast('Impossible de lire cette vidéo en aperçu.', 'error'), { once: true });
    holder.append(v);
  } else if (selection.kind === 'audio') {
    holder.append(el('div', { class: 'audio' }, '🔊'));
  } else {
    const img = el('img');
    img.src = src;
    img.addEventListener('error', () => toast("Impossible d'afficher cette image.", 'error'), { once: true });
    holder.append(img);
  }
  setupClip();
  renderMeta();
}

function renderMeta() {
  const meta = $('previewMeta');
  meta.innerHTML = '';
  if (!selection) return;
  if (selection.source === 'x') meta.append(el('span', { class: 'chip x' }, '𝕏'), selection.author ? `@${selection.author}` : 'Post X');
  else meta.append(el('span', { class: 'chip' }, { video: 'Vidéo', audio: 'Son', image: 'Image' }[selection.kind]), selection.label || '');
  if (selection.kind === 'video' && selection.duration) {
    meta.append(
      el('span', {}, `· ${fmtTime(selection.duration)}`),
      selection.duration > CLIP_SECONDS ? el('span', {}, `→ extrait de ${CLIP_SECONDS} s`) : null
    );
  }
}

// Choix du passage de 15 s pour les vidéos plus longues
function setupClip() {
  const d = selection?.kind === 'video' ? selection.duration : 0;
  if (!d || d <= CLIP_SECONDS) {
    $('clipRow').hidden = true;
    if (selection) selection.start = 0;
    return;
  }
  $('clipRow').hidden = false;
  const slider = $('clipStart');
  slider.max = Math.max(0, Math.floor(d - 1));
  slider.value = Math.min(Number(slider.value) || 0, slider.max);
  updateClip();
}

function updateClip() {
  if (!selection) return;
  const start = Number($('clipStart').value);
  const len = Math.min(CLIP_SECONDS, selection.duration - start);
  selection.start = start;
  $('clipLen').textContent = `${Math.round(len)} s`;
  $('clipRange').textContent = `${fmtTime(start)} → ${fmtTime(start + len)}`;
}

$('clipStart').addEventListener('input', () => {
  updateClip();
  const v = $('drop').querySelector('video');
  if (v) {
    v.currentTime = selection.start;
    v.play().catch(() => {});
  }
});

// L'aperçu boucle sur l'extrait choisi
setInterval(() => {
  const v = $('drop').querySelector('video');
  if (!v || !selection?.duration || selection.duration <= CLIP_SECONDS) return;
  const start = selection.start || 0;
  if (v.currentTime < start - 0.5 || v.currentTime > start + CLIP_SECONDS) v.currentTime = start;
}, 250);

// ---------- Liens (X / Twitter ou direct) ----------
function setLinkState(state) {
  const s = $('linkState');
  s.className = `link-state ${state === 'loading' ? 'loading' : ''}`;
  s.textContent = state === 'ok' ? '✅' : state === 'error' ? '⚠️' : '';
}

let linkTimer;
let linkSeq = 0;
function onUrlInput() {
  clearTimeout(linkTimer);
  const url = $('url').value.trim();
  if (!url) {
    setLinkState('');
    if (selection?.type === 'link') clearSelection();
    return;
  }
  if (!/^https?:\/\//i.test(url)) return setLinkState('error');
  linkTimer = setTimeout(() => resolveUrl(url), 350);
}

async function resolveUrl(url) {
  const seq = ++linkSeq;
  resolving = true;
  setLinkState('loading');
  const res = await api.resolveLink(url);
  if (seq !== linkSeq) return; // un autre lien a été collé entre temps
  resolving = false;
  if (!res.ok) {
    setLinkState('error');
    return toast(res.error, 'error');
  }
  setLinkState('ok');
  clearSelection();
  selection = { type: 'link', ...res, label: res.source === 'direct' ? url.split('/').pop().split('?')[0] : '' };
  renderPreview();
}

$('url').addEventListener('input', onUrlInput);

// ---------- Glisser / coller / cliquer ----------
const drop = $('drop');
drop.addEventListener('click', (e) => {
  if (!selection && !e.target.closest('button')) $('file').click();
});
drop.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && !selection && $('file').click());
$('file').addEventListener('change', (e) => {
  selectFile(e.target.files[0]);
  e.target.value = '';
});
$('clearSel').addEventListener('click', (e) => {
  e.stopPropagation();
  clearSelection();
  $('url').value = '';
  setLinkState('');
});
drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  drop.classList.add('hover');
});
drop.addEventListener('dragleave', () => drop.classList.remove('hover'));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  drop.classList.remove('hover');
  if (e.dataTransfer.files.length) return selectFile(e.dataTransfer.files[0]);
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (url) {
    $('url').value = url.trim().split('\n')[0];
    onUrlInput();
  }
});
document.addEventListener('paste', (e) => {
  if ($('view-home').hidden) return;
  const file = [...(e.clipboardData?.files || [])][0];
  if (file) {
    e.preventDefault();
    return selectFile(file);
  }
  // Un lien collé n'importe où (hors champ texte) va dans le champ lien
  const text = e.clipboardData?.getData('text/plain')?.trim();
  const inField = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (text && /^https?:\/\//i.test(text) && !inField) {
    e.preventDefault();
    $('url').value = text;
    onUrlInput();
  }
});

// ---------- Envoi ----------
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

async function buildPayload() {
  if (resolving) return toast('Lien en cours de lecture, une seconde…', 'error');
  if (!selection) return toast('Choisis un fichier ou colle un lien d’abord.', 'error');
  const base = { kind: selection.kind, text: $('text').value.trim(), start: selection.start || 0, source: selection.source };
  if (selection.type === 'file') return { ...base, mime: selection.mime, data: await fileToBase64(selection.file) };
  return { ...base, url: selection.url };
}

function describe(sel, text) {
  const icon = { video: '🎬', audio: '🔊', image: '🖼️' }[sel.kind] || '📎';
  const what = sel.source === 'x' ? `Post X${sel.author ? ` de @${sel.author}` : ''}` : sel.label || { video: 'Vidéo', audio: 'Son', image: 'Image' }[sel.kind];
  return `${icon} ${what}${text ? ` · « ${text} »` : ''}`;
}

$('send').addEventListener('click', async () => {
  if (status !== 'connected') return toast('Pas connecté au serveur.', 'error');
  const payload = await buildPayload();
  if (!payload) return;

  const clientId = `c${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const item = { clientId, label: describe(selection, payload.text), to: selectedTo, at: Date.now(), recipients: null };
  sentItems.unshift(item);
  sentItems.length = Math.min(sentItems.length, 30);
  showTab('sent');
  renderSent();

  $('send').disabled = true;
  try {
    const res = await api.sendMedia({ ...payload, to: selectedTo, clientId });
    if (!res.ok) {
      item.error = res.error;
      renderSent();
      return toast(res.error, 'error');
    }
    $('text').value = '';
    $('url').value = '';
    setLinkState('');
    clearSelection();
  } finally {
    setTimeout(() => ($('send').disabled = false), 1500);
  }
});

$('test').addEventListener('click', async () => {
  const payload = await buildPayload();
  if (payload) api.previewSelf(payload);
});
$('text').addEventListener('keydown', (e) => e.key === 'Enter' && $('send').click());

// ---------- Accusés de réception ----------
const RECEIPT = {
  sent: { label: 'en route', icon: '⏳', rank: 0 },
  received: { label: 'reçu', icon: '✓', rank: 1 },
  shown: { label: 'vu', icon: '✓✓', rank: 2 },
  failed: { label: 'échec', icon: '✗', rank: 3 },
  skipped: { label: 'ignoré', icon: '⏭', rank: 3 },
  dnd: { label: 'ne pas déranger', icon: '🔕', rank: 3 },
};

api.onSent(({ id, clientId, recipients }) => {
  const item = sentItems.find((i) => i.clientId === clientId);
  if (!item) return;
  item.id = id;
  item.recipients = Object.fromEntries(recipients.map((r) => [r.name, r.status]));
  renderSent();
});

api.onAck(({ id, by, status: st }) => {
  const item = sentItems.find((i) => i.id === id);
  if (!item?.recipients || !(by in item.recipients)) return;
  const current = item.recipients[by];
  // "vu" est définitif ; sinon on ne revient jamais en arrière
  if (!RECEIPT[st] || current === 'shown' || RECEIPT[st].rank < (RECEIPT[current]?.rank ?? 0)) return;
  item.recipients[by] = st;
  renderSent();
});

function renderSent() {
  const list = $('sentList');
  list.innerHTML = '';
  if (!sentItems.length) return list.append(el('li', { class: 'empty' }, "Rien envoyé pour l'instant"));
  for (const item of sentItems) {
    const receipts = el('div', { class: 'receipts' });
    if (item.error) receipts.append(el('span', { class: 'receipt failed' }, `✗ ${item.error}`));
    else if (!item.recipients) receipts.append(el('span', { class: 'receipt' }, '⏳ envoi…'));
    else if (!Object.keys(item.recipients).length) receipts.append(el('span', { class: 'receipt' }, "personne d'autre en ligne"));
    else
      for (const [name, st] of Object.entries(item.recipients)) {
        const r = RECEIPT[st] || RECEIPT.sent;
        receipts.append(el('span', { class: `receipt ${st}`, title: r.label }, `${r.icon} ${name} · ${r.label}`));
      }
    list.append(
      el(
        'li',
        {},
        el('div', { class: 'row' }, el('span', { class: 'what' }, item.label), el('span', { class: 'time' }, `${item.to === '*' ? 'à tous' : `à ${item.to}`} · ${clock(item.at)}`)),
        receipts
      )
    );
  }
}

// ---------- Reçus ----------
function renderReceived() {
  const list = $('receivedList');
  list.innerHTML = '';
  if (!receivedItems.length) return list.append(el('li', { class: 'empty' }, "Rien reçu pour l'instant"));
  for (const r of receivedItems) {
    const icon = { video: '🎬', audio: '🔊', image: '🖼️' }[r.kind] || '📎';
    list.append(
      el(
        'li',
        {},
        el(
          'div',
          { class: 'row' },
          el('span', { class: 'what' }, el('b', { style: `color:${colorFor(r.from)}` }, r.from), ` ${icon}${r.source === 'x' ? ' 𝕏' : ''}${r.text ? ` « ${r.text} »` : ''}`),
          el('span', { class: 'time' }, clock(r.at))
        )
      )
    );
  }
}

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $('sentList').hidden = name !== 'sent';
  $('receivedList').hidden = name !== 'received';
}
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

// ---------- Événements du processus principal ----------
api.onStatus((s) => {
  renderStatus(s);
  renderPeople();
});
api.onPresence(({ users: list, refreshed }) => {
  users = list;
  renderPeople();
  if (refreshed) {
    clearTimeout(refreshTimeout);
    $('refreshBtn').classList.remove('spinning');
    toast('Liste actualisée.');
  }
});
api.onToast(({ kind, text }) => toast(text, kind));
api.onReceived((r) => {
  receivedItems.unshift(r);
  receivedItems.length = Math.min(receivedItems.length, 30);
  renderReceived();
});
api.onConfig((c) => {
  cfg = c;
  renderDnd();
  renderConnection();
});

// ---------- Mises à jour ----------
function renderUpdate(u = {}) {
  const text = {
    dev: 'Version de développement : pas de mise à jour automatique.',
    idle: 'Vérification au démarrage puis toutes les 4 h.',
    checking: 'Recherche en cours…',
    none: "Tu as la dernière version.",
    downloading: `Téléchargement de la ${u.version || 'nouvelle version'}… ${u.percent || 0} %`,
    ready: `Version ${u.version} prête : elle s'installera à la fermeture.`,
    error: `Impossible de vérifier (${u.message || 'erreur'}).`,
  }[u.status] || '';
  $('updateStatus').textContent = text;
  $('checkUpdates').disabled = ['dev', 'checking', 'downloading', 'ready'].includes(u.status);
  $('updateBanner').hidden = u.status !== 'ready';
  $('updateVersion').textContent = u.version || '';
}

$('checkUpdates').addEventListener('click', () => api.checkUpdates());
$('updateNow').addEventListener('click', () => api.installUpdate());
api.onUpdate(renderUpdate);

// ---------- Démarrage ----------
api.getState().then((state) => {
  renderUpdate(state.update);
  cfg = state.config;
  packaged = state.packaged;
  users = state.presence || [];
  $('version').textContent = state.version;
  renderStatus({ status: state.status, detail: state.statusDetail, retryAt: state.retryAt });
  if (!cfg.name) {
    fillOnboarding();
    showView('onboarding');
    $('obName').focus();
  } else {
    showView('home');
  }
  renderDnd();
  renderPeople();
});
