// Mode combat : clique sur un média reçu pour lui faire des dégâts (10 cœurs façon Minecraft).
// À 0 cœur, il explose en fumée et disparaît.
(() => {
  const api = window.livechat;
  const MAX_HP = 20; // 10 cœurs, 2 PV par cœur
  const HIT = 2;
  const CRIT = 4;
  const CRIT_CHANCE = 0.15;
  let volume = 0.6;

  // ---------- Cœurs en pixel art ----------
  const SHAPE = ['.XX.XX.', 'XXXXXXX', 'XXXXXXX', '.XXXXX.', '..XXX..', '...X...'];
  const RED = '#e8182f';
  const EMPTY = '#3a3a3a';
  const inner = (x, y) => y >= 1 && y <= 6 && x >= 1 && x <= 7 && SHAPE[y - 1][x - 1] === 'X';

  function heartSvg(kind) {
    let rects = '';
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 9; x++) {
        let color = null;
        if (inner(x, y)) {
          const filled = kind === 'full' || (kind === 'half' && x <= 4);
          color = filled ? RED : EMPTY;
          if (filled && x === 2 && y === 2) color = '#ffb3bd'; // petit reflet
        } else if (inner(x - 1, y) || inner(x + 1, y) || inner(x, y - 1) || inner(x, y + 1)) {
          color = '#000';
        }
        if (color) rects += `<rect x="${x}" y="${y}" width="1" height="1" fill="${color}"/>`;
      }
    }
    return `<svg viewBox="0 0 9 8" width="18" height="16" shape-rendering="crispEdges">${rects}</svg>`;
  }
  const HEARTS = { full: heartSvg('full'), half: heartSvg('half'), empty: heartSvg('empty') };

  function renderHearts(box, hp) {
    let html = '';
    for (let i = 0; i < MAX_HP / 2; i++) {
      const v = hp - i * 2;
      html += HEARTS[v >= 2 ? 'full' : v === 1 ? 'half' : 'empty'];
    }
    box.innerHTML = html;
  }

  // ---------- Sons (générés, pas de fichier) ----------
  let ctx = null;
  function audio() {
    if (!ctx) ctx = new AudioContext();
    return ctx;
  }

  function noise(ac, seconds) {
    const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * seconds), ac.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const src = ac.createBufferSource();
    src.buffer = buf;
    return src;
  }

  // Petit utilitaire : une note avec enveloppe rapide
  function tone(ac, out, { type = 'sine', from, to = from, start = 0, dur, gain = 1 }) {
    const t = ac.currentTime + start;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    g.connect(out);
    const o = ac.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(to, t + dur);
    o.connect(g);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  function burst(ac, out, { start = 0, dur, filter = 'lowpass', from, to = from, q = 1, gain = 1 }) {
    const t = ac.currentTime + start;
    const n = noise(ac, dur);
    const f = ac.createBiquadFilter();
    f.type = filter;
    f.Q.value = q;
    f.frequency.setValueAtTime(from, t);
    if (to !== from) f.frequency.exponentialRampToValueAtTime(to, t + dur);
    const g = ac.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    n.connect(f).connect(g).connect(out);
    n.start(t);
  }

  function master() {
    const ac = audio();
    const out = ac.createGain();
    out.gain.value = Math.max(0.15, volume); // toujours audible, même avec un volume vidéo bas
    // un compresseur pour que ça claque sans saturer
    const comp = ac.createDynamicsCompressor();
    out.connect(comp).connect(ac.destination);
    return { ac, out };
  }

  // Coup : impact sourd + craquement ; critique : en plus un "ting" métallique
  function playHit(crit) {
    if (volume <= 0) return;
    const { ac, out } = master();
    tone(ac, out, { type: 'sine', from: 160, to: 55, dur: 0.16, gain: 0.9 });
    tone(ac, out, { type: 'square', from: crit ? 330 : 240, to: crit ? 140 : 100, dur: 0.09, gain: 0.25 });
    burst(ac, out, { dur: 0.08, filter: 'bandpass', from: crit ? 3200 : 2000, q: 0.9, gain: 0.8 });
    if (crit) {
      tone(ac, out, { type: 'triangle', from: 1760, dur: 0.25, start: 0.02, gain: 0.35 });
      tone(ac, out, { type: 'triangle', from: 2637, dur: 0.2, start: 0.05, gain: 0.25 });
    }
  }

  // Destruction : "pouf" de fumée puis petit carillon de récompense (façon orbe d'XP)
  function playDeath() {
    if (volume <= 0) return;
    const { ac, out } = master();
    burst(ac, out, { dur: 0.45, filter: 'bandpass', from: 2400, to: 180, q: 0.7, gain: 1 });
    tone(ac, out, { type: 'sine', from: 300, to: 50, dur: 0.35, gain: 0.8 });
    [1047, 1319, 1568, 2093].forEach((f, i) => tone(ac, out, { type: 'triangle', from: f, dur: 0.18, start: 0.22 + i * 0.07, gain: 0.3 }));
  }

  // ---------- Effets ----------
  function shake(card, strong) {
    const a = strong ? 14 : 8;
    const r = () => (Math.random() * 2 - 1) * a;
    card.animate(
      [
        { translate: '0 0', rotate: '0deg' },
        { translate: `${r()}px ${r()}px`, rotate: `${r() / 3}deg` },
        { translate: `${r()}px ${r()}px`, rotate: `${r() / 3}deg` },
        { translate: `${r() / 2}px ${r() / 2}px`, rotate: '0deg' },
        { translate: '0 0', rotate: '0deg' },
      ],
      { duration: strong ? 320 : 240, easing: 'ease-out' }
    );
  }

  function damageNumber(card, x, y, dmg, crit) {
    const d = document.createElement('div');
    d.className = `dmg${crit ? ' crit' : ''}`;
    d.textContent = crit ? `CRITIQUE ! -${dmg}` : `-${dmg}`;
    d.style.left = `${x}px`;
    d.style.top = `${y}px`;
    card.appendChild(d);
    const dx = (Math.random() * 2 - 1) * 40;
    d.animate(
      [
        { transform: 'translate(-50%, -50%) scale(.6)', opacity: 1 },
        { transform: `translate(calc(-50% + ${dx / 2}px), -120%) scale(1.15)`, opacity: 1, offset: 0.3 },
        { transform: `translate(calc(-50% + ${dx}px), -260%) scale(1)`, opacity: 0 },
      ],
      { duration: 750, easing: 'cubic-bezier(.2,.8,.3,1)' }
    ).onfinish = () => d.remove();
  }

  // Nuage de fumée pixelisé façon mob qui meurt
  function smoke(rect) {
    for (let i = 0; i < 26; i++) {
      const p = document.createElement('div');
      p.className = 'smoke';
      const size = 8 + Math.random() * 14;
      const x = rect.left + Math.random() * rect.width;
      const y = rect.top + Math.random() * rect.height;
      p.style.cssText = `left:${x}px;top:${y}px;width:${size}px;height:${size}px;background:hsl(0 0% ${70 + Math.random() * 25}%)`;
      document.body.appendChild(p);
      const dx = (x - (rect.left + rect.width / 2)) * (0.3 + Math.random() * 0.5);
      const dy = -40 - Math.random() * 90;
      p.animate(
        [
          { transform: 'translate(-50%, -50%) scale(.4)', opacity: 0.95 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1.4)`, opacity: 0 },
        ],
        { duration: 550 + Math.random() * 450, easing: 'ease-out' }
      ).onfinish = () => p.remove();
    }
  }

  // ---------- Clics : l'overlay laisse passer la souris sauf au-dessus du média ----------
  // Le processus principal surveille le curseur et ne capte la souris que dans cette zone.
  let activeCard = null;
  let suspended = false;
  function setHitbox(card) {
    activeCard = card;
    if (suspended) return; // un duel occupe la souris ; on réappliquera la carte à la fin
    if (!card) return api.setHitbox(null);
    const r = card.getBoundingClientRect();
    api.setHitbox({ x: r.left, y: r.top, w: r.width, h: r.height });
  }

  // ---------- API utilisée par overlay.js ----------
  window.Combat = {
    setVolume(v) {
      volume = v;
    },

    // Libère la souris (le média vient de disparaître sous le curseur)
    release() {
      setHitbox(null);
    },

    // Explosion en fumée réutilisable (duel) : sons optionnels pour ne pas en jouer 20 d'un coup
    explode(el, { sound = true, onDone } = {}) {
      if (sound) playDeath();
      smoke(el.getBoundingClientRect());
      // "scale"/"rotate" (et pas "transform") : se combinent avec le positionnement existant de l'élément
      el.animate(
        [
          { scale: '1', opacity: 1, filter: 'brightness(1)' },
          { scale: '1.08', opacity: 1, filter: 'brightness(2.5) saturate(0)', offset: 0.25 },
          { scale: '.2', rotate: '8deg', opacity: 0, filter: 'brightness(2.5) saturate(0)' },
        ],
        { duration: 380, easing: 'ease-in', fill: 'forwards' }
      );
      // minuterie plutôt que onfinish : Windows peut mettre en pause les animations d'une fenêtre masquée
      if (onDone) setTimeout(onDone, 420);
    },

    // Le duel prend la main sur la zone cliquable, puis la rend
    suspend() {
      suspended = true;
    },
    resume() {
      suspended = false;
      setHitbox(activeCard && activeCard.isConnected && activeCard.classList.contains('fightable') ? activeCard : null);
    },

    attach(card, onKill) {
      let hp = MAX_HP;
      let dead = false;

      const hearts = document.createElement('div');
      hearts.className = 'hearts';
      renderHearts(hearts, hp);
      const hurt = document.createElement('div');
      hurt.className = 'hurt';
      card.prepend(hurt);
      card.prepend(hearts);
      card.classList.add('fightable');
      card.querySelectorAll('img, video').forEach((m) => (m.draggable = false));

      setHitbox(card);

      card.addEventListener('pointerdown', (e) => {
        if (dead || e.button !== 0) return;
        e.preventDefault();
        const crit = Math.random() < CRIT_CHANCE;
        const dmg = crit ? CRIT : HIT;
        hp = Math.max(0, hp - dmg);
        renderHearts(hearts, hp);
        hearts.animate([{ filter: 'brightness(3)' }, { filter: 'brightness(1)' }], { duration: 250 });
        hurt.animate([{ opacity: 0.55 }, { opacity: 0 }], { duration: 280, easing: 'ease-out' });
        const box = card.getBoundingClientRect();
        damageNumber(card, e.clientX - box.left, e.clientY - box.top, dmg, crit);
        shake(card, crit);
        playHit(crit);

        if (hp === 0) {
          dead = true;
          card.classList.remove('fightable');
          setHitbox(null);
          playDeath();
          smoke(card.getBoundingClientRect());
          card.animate(
            [
              { transform: 'scale(1)', opacity: 1, filter: 'brightness(1)' },
              { transform: 'scale(1.08)', opacity: 1, filter: 'brightness(2.5) saturate(0)', offset: 0.25 },
              { transform: 'scale(.2) rotate(8deg)', opacity: 0, filter: 'brightness(2.5) saturate(0)' },
            ],
            { duration: 380, easing: 'ease-in', fill: 'forwards' }
          ).onfinish = onKill;
        }
      });
    },
  };
})();
