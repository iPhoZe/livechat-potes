// Duel de clics : le jeu se passe sur le média lui-même.
// 3, 2, 1, GO ! puis chaque clic sur le média tire la barre (sous le média) de ton côté.
// Le gagnant voit le média exploser ; chez le perdant il se duplique partout pendant 5 s, puis tout explose.
(() => {
  const api = window.livechat;
  const DUPLICATE_MS = 5000;
  const MAX_CLONES = 26;
  let volume = 0.6;
  let duel = null;

  const colorFor = (name) => {
    let h = 0;
    for (const ch of String(name)) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return `hsl(${h} 70% 48%)`;
  };

  // ---------- Sons ----------
  let ctx = null;
  function beep(freq, dur, { type = 'square', gain = 0.35, delay = 0, to } = {}) {
    if (volume <= 0) return;
    ctx = ctx || new AudioContext();
    const t = ctx.currentTime + delay;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain * Math.max(0.15, volume), t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(ctx.destination);
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }
  const sfx = {
    count: () => beep(660, 0.15),
    go: () => {
      beep(880, 0.35, { type: 'sawtooth', gain: 0.3 });
      beep(1320, 0.35, { type: 'square', gain: 0.2 });
    },
    click: () => beep(300 + Math.random() * 120, 0.04, { type: 'triangle', gain: 0.18 }),
    win: () => [523, 659, 784, 1047].forEach((f, i) => beep(f, 0.22, { type: 'square', gain: 0.25, delay: i * 0.11 })),
    lose: () => [392, 370, 349, 262].forEach((f, i) => beep(f, i === 3 ? 0.6 : 0.25, { type: 'sawtooth', gain: 0.2, delay: i * 0.28 })),
    pop: () => beep(500 + Math.random() * 700, 0.06, { type: 'square', gain: 0.12 }),
  };

  // ---------- Construction ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function mediaSrc(m) {
    if (m.data) {
      const bin = atob(m.data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: m.mime || '' }));
      return { url, objectUrl: url };
    }
    return { url: m.url, objectUrl: null };
  }

  // Élément affichant le média (réutilisé pour les clones)
  function mediaElement(kind, url, { muted = false, start = 0 } = {}) {
    if (kind === 'video') {
      const v = el('video', 'duel-visual');
      v.src = url;
      v.loop = true;
      v.playsInline = true;
      v.muted = muted;
      v.volume = volume;
      v.addEventListener('loadedmetadata', () => {
        if (start > 0 && Number.isFinite(v.duration)) v.currentTime = Math.min(start, Math.max(0, v.duration - 1));
      }, { once: true });
      return v;
    }
    if (kind === 'audio') {
      const b = el('div', 'duel-visual duel-audio', '🔊');
      return b;
    }
    const img = el('img', 'duel-visual');
    img.src = url;
    img.draggable = false;
    return img;
  }

  function side(name, cls) {
    const s = el('div', `duel-side ${cls}`);
    const av = el('div', 'duel-avatar', name.charAt(0).toUpperCase());
    av.style.background = colorFor(name);
    const info = el('div', 'duel-info');
    info.append(el('div', 'duel-name', cls === 'me' ? 'Toi' : name), el('div', 'duel-count', '0'));
    s.append(av, info);
    return s;
  }

  function build(msg) {
    const card = el('div', 'duel-card');
    const stage = el('div', 'duel-stage');
    const src = mediaSrc(msg.media);
    duel.src = src;
    const visual = mediaElement(msg.media.kind, src.url, { start: msg.media.start });
    duel.visual = visual;
    if (msg.media.kind === 'audio') {
      duel.audio = new Audio(src.url);
      duel.audio.loop = true;
      duel.audio.volume = volume;
    }
    const veil = el('div', 'duel-veil');
    veil.append(el('div', 'duel-big', duel.you === 'a' ? '⚔ Duel !' : `⚔ ${duel.them} te défie !`), el('div', 'duel-small', 'Clique sur le média dès le GO !'));
    stage.append(visual, veil);

    const bar = el('div', 'duel-bar');
    const track = el('div', 'duel-track');
    track.append(el('div', 'duel-fill me'), el('div', 'duel-fill them'), el('div', 'duel-center'), el('div', 'duel-knot'));
    bar.append(side(duel.me, 'me'), track, side(duel.them, 'them'));

    card.append(stage, bar);
    card.addEventListener('pointerdown', onClick);
    document.body.appendChild(card);

    // la zone cliquable suit la taille du média une fois chargé
    const refresh = () => duel && duel.card === card && setHitbox();
    visual.addEventListener('load', refresh);
    visual.addEventListener('loadedmetadata', refresh);
    return card;
  }

  const q = (sel) => duel.card.querySelector(sel);

  function setHitbox() {
    const r = duel.card.getBoundingClientRect();
    window.Combat.suspend();
    api.setHitbox({ x: r.left, y: r.top, w: r.width, h: r.height });
  }

  function veilText(big, small, cls = '') {
    const veil = q('.duel-veil');
    veil.className = `duel-veil ${cls}`;
    const b = q('.duel-big');
    b.textContent = big;
    q('.duel-small').textContent = small || '';
    b.animate([{ transform: 'scale(1.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  // Barre : ta couleur (à gauche) gagne du terrain quand tu mènes, celle du pote (à droite) quand il mène
  function renderPos(pos, ca, cb) {
    const mine = duel.you === 'a' ? pos : -pos;
    const pct = 50 + Math.max(-1, Math.min(1, mine / duel.target)) * 50;
    q('.duel-knot').style.left = `${pct}%`;
    q('.duel-fill.me').style.width = `${pct}%`;
    q('.duel-fill.them').style.width = `${100 - pct}%`;
    const [mc, tc] = duel.you === 'a' ? [ca, cb] : [cb, ca];
    if (mc != null) {
      q('.duel-side.me .duel-count').textContent = mc;
      q('.duel-side.them .duel-count').textContent = tc;
    }
  }

  // ---------- Déroulé ----------
  function onClick(e) {
    if (!duel || duel.state !== 'fight' || e.button !== 0) return;
    e.preventDefault();
    api.duelClick(duel.id);
    sfx.click();
    const r = duel.card.getBoundingClientRect();
    const plus = el('div', 'duel-plus', '+1');
    plus.style.left = `${e.clientX - r.left}px`;
    plus.style.top = `${e.clientY - r.top}px`;
    duel.card.appendChild(plus);
    plus.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%,-180%) scale(1.3)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => plus.remove();
    q('.duel-stage').animate([{ transform: 'scale(.97)' }, { transform: 'scale(1)' }], { duration: 90 });
  }

  function tick() {
    if (!duel || duel.state !== 'intro') return;
    const left = duel.startAt - Date.now();
    const n = Math.ceil(left / 1000);
    if (left <= 0) {
      duel.state = 'fight';
      veilText('GO !', 'CLIQUE ! CLIQUE ! CLIQUE !', 'go');
      sfx.go();
      duel.card.classList.add('fighting');
      if (duel.visual.tagName === 'VIDEO') duel.visual.play().catch(() => {});
      duel.audio?.play().catch(() => {});
      setTimeout(() => duel?.state === 'fight' && q('.duel-veil').classList.add('gone'), 600);
    } else if (n <= 3 && n !== duel.lastCount) {
      duel.lastCount = n;
      veilText(String(n), 'Prépare ton doigt…', 'count');
      sfx.count();
    }
  }

  function start(msg) {
    if (duel) cleanup();
    duel = {
      id: msg.id,
      you: msg.you,
      me: msg.you === 'a' ? msg.a : msg.b,
      them: msg.you === 'a' ? msg.b : msg.a,
      target: msg.target,
      startAt: Date.now() + msg.startsIn,
      state: 'intro',
      lastCount: null,
      clones: [],
    };
    duel.card = build(msg);
    duel.card.animate([{ transform: 'translate(-50%, -50%) scale(.6)', opacity: 0 }, { transform: 'translate(-50%, -50%) scale(1)', opacity: 1 }], { duration: 320, easing: 'cubic-bezier(.2,1.3,.4,1)' });
    renderPos(0, 0, 0);
    requestAnimationFrame(setHitbox);
    duel.ticker = setInterval(tick, 50);
  }

  function end(msg) {
    if (!duel || duel.id !== msg.id) return;
    const d = duel;
    d.state = 'over';
    clearInterval(d.ticker);
    renderPos(msg.pos, msg.ca, msg.cb);
    d.card.classList.remove('fighting');
    const won = msg.winner === d.me;

    if (won) {
      sfx.win();
      veilText('🏆 VICTOIRE !', msg.reason === 'forfeit' ? `${d.them} a abandonné` : `${d.them} se mange le média 😈`, 'win');
      setTimeout(() => d === duel && window.Combat.explode(d.card, { onDone: cleanup }), 1200);
      return;
    }

    // Perdu (ou égalité) : tampon PERDU, puis le média se duplique partout pendant 5 s et tout explose
    sfx.lose();
    veilText(msg.winner ? '💀 PERDU' : '🤝 ÉGALITÉ', msg.winner ? `${msg.winner} gagne le duel` : 'Tout le monde se le mange !', 'lose');
    api.setHitbox(null); // plus moyen d'y échapper en cliquant
    d.card.animate([{ translate: '0 0' }, { translate: '-12px 5px' }, { translate: '10px -5px' }, { translate: '-6px 2px' }, { translate: '0 0' }], { duration: 400 });
    setTimeout(() => d === duel && duplicate(d), 900);
  }

  function duplicate(d) {
    const until = Date.now() + DUPLICATE_MS;
    const spawn = setInterval(() => {
      if (d !== duel) return clearInterval(spawn);
      if (Date.now() > until || d.clones.length >= MAX_CLONES) {
        clearInterval(spawn);
        if (Date.now() <= until) setTimeout(() => d === duel && blowUp(d), until - Date.now());
        else blowUp(d);
        return;
      }
      const kind = d.visual.tagName === 'VIDEO' ? 'video' : d.visual.tagName === 'IMG' ? 'image' : 'audio';
      const clone = el('div', 'duel-clone');
      const v = mediaElement(kind, d.src.url, { muted: true });
      clone.append(v);
      const size = 14 + Math.random() * 18; // en % de la largeur de l'écran
      clone.style.width = `${size}vw`;
      clone.style.left = `${Math.random() * (100 - size)}vw`;
      clone.style.top = `${Math.random() * 75}vh`;
      clone.style.rotate = `${(Math.random() * 2 - 1) * 25}deg`;
      document.body.appendChild(clone);
      if (kind === 'video') {
        v.addEventListener('loadedmetadata', () => {
          if (Number.isFinite(v.duration)) v.currentTime = Math.random() * v.duration;
          v.play().catch(() => {});
        }, { once: true });
      }
      clone.animate([{ transform: 'scale(0)' }, { transform: 'scale(1.15)', offset: 0.7 }, { transform: 'scale(1)' }], { duration: 260, easing: 'ease-out' });
      sfx.pop();
      d.clones.push(clone);
    }, 190);
  }

  // Tout explose : les clones en cascade, puis le média d'origine
  function blowUp(d) {
    d.clones.forEach((c, i) => setTimeout(() => window.Combat.explode(c, { sound: i % 6 === 0 }), i * 40));
    setTimeout(() => d === duel && window.Combat.explode(d.card, { onDone: cleanup }), d.clones.length * 40 + 80);
  }

  function cleanup() {
    if (!duel) return;
    const d = duel;
    duel = null;
    clearInterval(d.ticker);
    d.audio?.pause();
    d.card.remove();
    d.clones.forEach((c) => c.remove());
    // laisse le temps aux clones d'exploser avant de libérer le fichier
    if (d.src?.objectUrl) setTimeout(() => URL.revokeObjectURL(d.src.objectUrl), 2000);
    api.setHitbox(null);
    window.Combat.resume();
  }

  api.onDuel((msg) => msg.phase === 'intro' && start(msg));
  api.onDuelPos((msg) => duel && duel.id === msg.id && renderPos(msg.pos, msg.ca, msg.cb));
  api.onDuelEnd(end);
  api.onClear(() => duel && cleanup()); // Ctrl+Maj+X efface aussi un duel

  window.Duel = {
    setVolume(v) {
      volume = v;
      if (duel?.visual?.tagName === 'VIDEO') duel.visual.volume = v;
      if (duel?.audio) duel.audio.volume = v;
    },
  };
})();
