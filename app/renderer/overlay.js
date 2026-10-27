const api = window.livechat;

window.addEventListener('error', (e) => api.reportError('overlay', `${e.message} (${e.filename?.split('/').pop()}:${e.lineno})\n${e.error?.stack || ''}`));
window.addEventListener('unhandledrejection', (e) => api.reportError('overlay', `Promesse rejetée : ${e.reason?.stack || e.reason}`));
const settings = { volume: 0.6, imageSeconds: 6, maxVideoSeconds: 15 };
const queue = [];
const LOAD_TIMEOUT_MS = 15000;
let current = null; // { msg, el, timers, objectUrl, media }

api.onSettings((s) => {
  Object.assign(settings, s);
  window.Combat.setVolume(settings.volume);
  if (current?.media) current.media.volume = settings.volume;
});

api.onMedia((msg) => {
  if (queue.length >= 20) api.ack(queue.shift().id, 'skipped'); // évite une file infinie si quelqu'un spamme
  queue.push(msg);
  if (!current) next();
});

api.onClear(() => {
  while (queue.length) api.ack(queue.shift().id, 'skipped');
  finish('skipped', true);
});

// Même couleur pour un même pseudo, partout dans l'appli
function colorFor(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `hsl(${h} 70% 48%)`;
}

function srcFor(msg) {
  if (msg.data) {
    const bin = atob(msg.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const url = URL.createObjectURL(new Blob([bytes], { type: msg.mime || '' }));
    return { url, objectUrl: url };
  }
  if (msg.url && /^https?:\/\//i.test(msg.url)) return { url: msg.url, objectUrl: null };
  return null;
}

function buildCaption(msg) {
  const caption = document.createElement('div');
  caption.className = 'caption';

  const name = String(msg.from || '?');
  const avatar = document.createElement('div');
  avatar.className = 'avatar';
  avatar.style.background = colorFor(name.replace(/ \(test\)$/, ''));
  avatar.textContent = name.charAt(0).toUpperCase();
  caption.appendChild(avatar);

  // textContent uniquement : jamais de HTML venant des autres
  const body = document.createElement('div');
  body.className = 'body';
  const from = document.createElement('span');
  from.className = 'from';
  from.textContent = name;
  body.appendChild(from);
  if (msg.text) body.appendChild(document.createTextNode(msg.text));
  if (msg.source === 'x') {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = '𝕏';
    body.appendChild(badge);
  }
  caption.appendChild(body);
  return caption;
}

function startProgress(seconds) {
  const bar = current?.el.querySelector('.progress > div');
  if (!bar) return;
  bar.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: seconds * 1000, easing: 'linear', fill: 'forwards' });
}

function place(card) {
  const w = card.offsetWidth || 300;
  const h = card.offsetHeight || 300;
  const margin = 40;
  const x = margin + Math.random() * Math.max(0, window.innerWidth - w - margin * 2);
  const y = margin + Math.random() * Math.max(0, window.innerHeight - h - margin * 2);
  card.style.left = `${x}px`;
  card.style.top = `${y}px`;
  card.style.visibility = 'visible';
}

function next() {
  const msg = queue.shift();
  if (!msg) return;

  const src = srcFor(msg);
  if (!src) {
    api.ack(msg.id, 'failed');
    return next();
  }

  const card = document.createElement('div');
  card.className = 'card';
  card.style.visibility = 'hidden';

  let media = null;
  let visual = null;
  if (msg.kind === 'video') {
    media = visual = document.createElement('video');
    media.playsInline = true;
    media.preload = 'auto';
    media.volume = settings.volume;
    media.src = src.url;
  } else if (msg.kind === 'audio') {
    visual = document.createElement('div');
    visual.className = 'audio-bubble';
    visual.innerHTML = '<span>🔊</span>';
    media = new Audio();
    media.volume = settings.volume;
    media.src = src.url;
  } else {
    visual = document.createElement('img');
    visual.src = src.url;
  }
  card.appendChild(visual);

  const progress = document.createElement('div');
  progress.className = 'progress';
  progress.appendChild(document.createElement('div'));
  card.appendChild(progress);
  card.appendChild(buildCaption(msg));
  document.body.appendChild(card);

  current = { msg, el: card, timers: [], objectUrl: src.objectUrl, media, shown: false };
  const self = current;
  const later = (fn, ms) => self.timers.push(setTimeout(fn, ms));

  // Si rien ne charge, on abandonne et on prévient l'expéditeur
  later(() => current === self && !self.shown && finish('failed'), LOAD_TIMEOUT_MS);

  const onShown = (seconds) => {
    if (current !== self || self.shown) return;
    self.shown = true;
    // Mode combat : à force de cliquer dessus, le média est détruit
    place(card);
    window.Combat.attach(card, () => current === self && finish('killed', true));
    api.ack(msg.id, 'shown');
    startProgress(seconds);
    later(() => current === self && finish(), seconds * 1000);
  };

  if (media) {
    const start = Math.max(0, Number(msg.start) || 0);
    media.addEventListener('error', () => current === self && finish('failed'), { once: true });
    media.addEventListener('ended', () => current === self && finish(), { once: true });
    media.addEventListener(
      'loadedmetadata',
      () => {
        if (start > 0 && Number.isFinite(media.duration)) media.currentTime = Math.min(start, Math.max(0, media.duration - 1));
        media.play().catch(() => current === self && finish('failed'));
      },
      { once: true }
    );
    media.addEventListener(
      'playing',
      () => {
        const remaining = Number.isFinite(media.duration) ? media.duration - media.currentTime : settings.maxVideoSeconds;
        onShown(Math.max(1, Math.min(settings.maxVideoSeconds, remaining)));
      },
      { once: true }
    );
  } else {
    visual.addEventListener('load', () => onShown(settings.imageSeconds), { once: true });
    visual.addEventListener('error', () => current === self && finish('failed'), { once: true });
  }
}

function finish(status, immediate = false) {
  if (!current) return;
  const { msg, el, timers, objectUrl, media, shown } = current;
  current = null;
  timers.forEach(clearTimeout);
  // Effacé avant d'avoir pu s'afficher → "ignoré" ; erreur → "échec" ; détruit à coups de clics → "killed"
  if (status === 'failed' || status === 'killed' || (status === 'skipped' && !shown)) api.ack(msg.id, status);
  window.Combat.release(); // le média disparaît : la souris doit de nouveau traverser l'overlay
  if (media) {
    media.pause();
    media.removeAttribute('src');
    media.load();
  }
  const cleanup = () => {
    el.remove();
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  };
  if (immediate || !shown) cleanup();
  else {
    el.classList.add('leaving');
    setTimeout(cleanup, 230);
  }
  setTimeout(next, immediate ? 0 : 300);
}
