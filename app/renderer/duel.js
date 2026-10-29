// Duel de clics façon tir à la corde : 3, 2, 1, GO ! puis chaque clic tire la corde de ton côté.
// Le serveur compte les clics et décide du gagnant ; le perdant reçoit la vidéo en jeu.
(() => {
  const api = window.livechat;
  let volume = 0.6;
  let duel = null; // { id, you, me, them, target, durationMs, startAt, el, state, myClicks, ticker, lastCount }

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
  };

  // ---------- Construction du panneau ----------
  function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function player(name, side) {
    const p = el('div', `duel-player ${side}`);
    const av = el('div', 'duel-avatar', name.charAt(0).toUpperCase());
    av.style.background = colorFor(name);
    const info = el('div', 'duel-pinfo');
    info.append(el('div', 'duel-name', side === 'me' ? `${name} (toi)` : name), el('div', 'duel-count', '0 clic'));
    p.append(av, info);
    return p;
  }

  function build(msg) {
    const panel = el('div', 'duel');
    const head = el('div', 'duel-head');
    head.append(el('div', 'duel-title', '⚔ DUEL DE CLICS'), el('div', 'duel-sub', `L'enjeu : ${msg.mediaKind === 'video' ? 'une vidéo' : msg.mediaKind === 'audio' ? 'un son' : 'une image'} qui s'affichera chez le perdant`));

    const players = el('div', 'duel-players');
    players.append(player(duel.me, 'me'), el('div', 'duel-vs', 'VS'), player(duel.them, 'them'));

    const rope = el('div', 'duel-rope');
    rope.append(el('div', 'duel-zone me'), el('div', 'duel-zone them'), el('div', 'duel-line'), el('div', 'duel-center'), el('div', 'duel-knot'));

    const big = el('div', 'duel-big', duel.you === 'a' ? 'Duel lancé !' : `${duel.them} te défie !`);
    const timer = el('div', 'duel-timer');
    timer.append(el('div'));
    const hint = el('div', 'duel-hint', 'Prépare ton doigt… clique dans ce cadre dès le GO !');

    panel.append(head, players, rope, big, timer, hint);
    panel.addEventListener('pointerdown', onClick);
    document.body.appendChild(panel);
    return panel;
  }

  function q(sel) {
    return duel.el.querySelector(sel);
  }

  function setHitbox() {
    const r = duel.el.getBoundingClientRect();
    window.Combat.suspend();
    api.setHitbox({ x: r.left, y: r.top, w: r.width, h: r.height });
  }

  function bigText(text, cls = '') {
    const b = q('.duel-big');
    b.className = `duel-big ${cls}`;
    b.textContent = text;
    b.animate([{ transform: 'scale(1.8)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.2,1.4,.4,1)' });
  }

  // Corde : de ton point de vue, tu tires toujours vers la gauche
  function renderPos(pos, ca, cb) {
    const mine = duel.you === 'a' ? pos : -pos;
    const pct = 50 - Math.max(-1, Math.min(1, mine / duel.target)) * 50;
    q('.duel-knot').style.left = `${pct}%`;
    q('.duel-zone.me').style.opacity = mine > 0 ? 0.35 + (0.6 * mine) / duel.target : 0.25;
    q('.duel-zone.them').style.opacity = mine < 0 ? 0.35 + (0.6 * -mine) / duel.target : 0.25;
    const [myClicks, theirClicks] = duel.you === 'a' ? [ca, cb] : [cb, ca];
    if (myClicks != null) {
      q('.duel-player.me .duel-count').textContent = `${myClicks} clic${myClicks > 1 ? 's' : ''}`;
      q('.duel-player.them .duel-count').textContent = `${theirClicks} clic${theirClicks > 1 ? 's' : ''}`;
    }
  }

  // ---------- Déroulé ----------
  function onClick(e) {
    if (!duel || duel.state !== 'fight' || e.button !== 0) return;
    e.preventDefault();
    api.duelClick(duel.id);
    duel.myClicks++;
    sfx.click();
    // petit "+1" qui saute là où on a cliqué
    const r = duel.el.getBoundingClientRect();
    const plus = el('div', 'duel-plus', '+1');
    plus.style.left = `${e.clientX - r.left}px`;
    plus.style.top = `${e.clientY - r.top}px`;
    duel.el.appendChild(plus);
    plus.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 1 }, { transform: 'translate(-50%,-180%) scale(1.3)', opacity: 0 }], { duration: 450, easing: 'ease-out' }).onfinish = () => plus.remove();
    q('.duel-knot').animate([{ transform: 'translate(-50%,-50%) scale(1.25)' }, { transform: 'translate(-50%,-50%) scale(1)' }], { duration: 120 });
  }

  function tick() {
    if (!duel) return;
    const left = duel.startAt - Date.now();
    if (duel.state === 'intro') {
      const n = Math.ceil(left / 1000);
      if (left <= 0) {
        duel.state = 'fight';
        bigText('GO !', 'go');
        sfx.go();
        q('.duel-hint').textContent = 'CLIQUE ! CLIQUE ! CLIQUE !';
        duel.el.classList.add('fighting');
        q('.duel-timer > div').animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: duel.durationMs, easing: 'linear', fill: 'forwards' });
        setTimeout(() => duel?.state === 'fight' && bigText('CLIQUE !!!', 'go pulse'), 700);
      } else if (n <= 3 && n !== duel.lastCount) {
        duel.lastCount = n;
        bigText(String(n), 'count');
        sfx.count();
      }
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
      durationMs: msg.durationMs,
      stake: msg.mediaKind === 'video' ? 'la vidéo' : msg.mediaKind === 'audio' ? 'le son' : "l'image",
      startAt: Date.now() + msg.startsIn,
      state: 'intro',
      myClicks: 0,
      lastCount: null,
    };
    duel.el = build(msg);
    duel.el.animate([{ transform: 'translate(-50%, -40px) scale(.9)', opacity: 0 }, { transform: 'translate(-50%, 0) scale(1)', opacity: 1 }], { duration: 300, easing: 'cubic-bezier(.2,1.3,.4,1)' });
    renderPos(0, 0, 0);
    requestAnimationFrame(setHitbox);
    duel.ticker = setInterval(tick, 50);
  }

  function end(msg) {
    if (!duel || duel.id !== msg.id) return;
    duel.state = 'over';
    clearInterval(duel.ticker);
    renderPos(msg.pos, msg.ca, msg.cb);
    duel.el.classList.remove('fighting');
    const won = msg.winner === duel.me;
    if (!msg.winner) bigText('ÉGALITÉ !', 'tie');
    else bigText(won ? '🏆 VICTOIRE !' : '💀 DÉFAITE…', won ? 'win' : 'lose');
    q('.duel-hint').textContent =
      msg.reason === 'forfeit'
        ? won
          ? `${duel.them} a quitté le duel. Victoire par forfait !`
          : 'Duel abandonné.'
        : !msg.winner
          ? `Tout le monde se mange ${duel.stake} 😅`
          : won
            ? `${duel.stake.charAt(0).toUpperCase() + duel.stake.slice(1)} part chez ${duel.them} 😈`
            : duel.you === 'a'
              ? `Retour à l'envoyeur : ${duel.stake} arrive chez toi !`
              : `Prépare-toi à subir ${duel.stake}…`;
    if (won) sfx.win();
    else sfx.lose();
    if (!won) duel.el.animate([{ translate: '0 0' }, { translate: '-10px 4px' }, { translate: '9px -4px' }, { translate: '-6px 2px' }, { translate: '0 0' }], { duration: 400 });
    const finished = duel;
    setTimeout(() => {
      if (duel !== finished) return;
      finished.el.animate([{ opacity: 1 }, { opacity: 0, transform: 'translate(-50%, -30px) scale(.95)' }], { duration: 300, fill: 'forwards' }).onfinish = cleanup;
    }, 2600);
  }

  function cleanup() {
    if (!duel) return;
    clearInterval(duel.ticker);
    duel.el.remove();
    duel = null;
    api.setHitbox(null);
    window.Combat.resume();
  }

  api.onDuel((msg) => msg.phase === 'intro' && start(msg));
  api.onDuelPos((msg) => duel && duel.id === msg.id && renderPos(msg.pos, msg.ca, msg.cb));
  api.onDuelEnd(end);

  window.Duel = {
    setVolume(v) {
      volume = v;
    },
  };
})();
