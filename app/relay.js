// Serveur relais : il ne stocke rien, il transmet juste les médias
// entre les potes connectés au même "salon".
// Utilisé par l'appli (mode "Héberger") et par server/server.js.
const http = require('http');
const { WebSocketServer } = require('ws');

function startRelay({ port = 8080, maxMb = 25, cooldownMs = 2000, log = console.log, onListening, onError } = {}) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('LiveChat entre potes : serveur OK\n');
  });

  const wss = new WebSocketServer({ server, maxPayload: maxMb * 1024 * 1024 * 1.4 });

  // room -> Map(name -> ws)
  const rooms = new Map();
  // id du média -> { sender, room, at } : pour renvoyer les accusés de réception à l'expéditeur
  const sentIndex = new Map();
  const ACK_TTL_MS = 5 * 60 * 1000;

  function send(ws, obj) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  }

  function presenceOf(room) {
    const members = rooms.get(room);
    if (!members) return [];
    return [...members.values()].map((c) => ({ name: c.name, dnd: c.dnd, since: c.joinedAt, duel: !!c.caps?.includes('duel') }));
  }

  function broadcastPresence(room) {
    const members = rooms.get(room);
    if (!members) return;
    const users = presenceOf(room);
    for (const c of members.values()) send(c, { type: 'presence', users });
  }

  function leave(ws) {
    if (!ws.room) return;
    const members = rooms.get(ws.room);
    if (members && members.get(ws.name) === ws) {
      members.delete(ws.name);
      if (members.size === 0) rooms.delete(ws.room);
      else broadcastPresence(ws.room);
    }
    log(`- ${ws.name} a quitté [${ws.room}]`);
    ws.room = null;
  }

  // Champs d'un média envoyé (commun aux envois classiques et aux duels)
  function mediaPayload(msg, from, now = Date.now()) {
    return {
      type: 'media',
      id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
      from,
      kind: ['video', 'image', 'audio'].includes(msg.kind) ? msg.kind : 'image',
      mime: msg.mime,
      data: msg.data,
      url: msg.url,
      text: String(msg.text || '').slice(0, 200),
      // Début de l'extrait vidéo (en secondes), la durée max est imposée côté receveur
      start: Math.min(Math.max(Number(msg.start) || 0, 0), 36000),
      source: msg.source === 'x' ? 'x' : undefined,
    };
  }

  // ---------- Duel de clics (tir à la corde) ----------
  // Le serveur compte les clics : c'est lui qui décide du gagnant, pas de triche possible côté client.
  const DUEL_TARGET = 30; // écart de clics à atteindre pour tirer la corde jusqu'à son camp
  const DUEL_MS = 20000; // sinon, celui qui mène au bout de 20 s gagne
  const DUEL_INTRO_MS = 5000; // annonce + 3, 2, 1
  const DUEL_MAX_CPS = 20; // au-delà, c'est un autoclicker : les clics en trop sont ignorés
  const DUEL_RESULT_MS = 2800; // le temps d'afficher le résultat avant d'envoyer la vidéo au perdant
  let duelSeq = 0;

  function duelError(ws, message) {
    send(ws, { type: 'error', message });
  }

  function startDuel(ws, msg) {
    const members = rooms.get(ws.room) || new Map();
    const opp = members.get(msg.to);
    const media = msg.media || {};
    if (!opp || opp === ws) return duelError(ws, "Ce pote n'est pas connecté.");
    if (!opp.caps?.includes('duel')) return duelError(ws, `${opp.name} doit mettre à jour LiveChat pour jouer aux duels.`);
    if (opp.dnd) return duelError(ws, `${opp.name} est en mode Ne pas déranger.`);
    if (ws.duel || opp.duel) return duelError(ws, 'Un duel est déjà en cours.');
    if (!media.data && !(media.url && /^https?:\/\//i.test(media.url))) return duelError(ws, 'Choisis une vidéo ou un GIF comme enjeu du duel.');
    const now = Date.now();
    if (now - ws.lastSend < cooldownMs) return duelError(ws, 'Doucement ! Attends un peu entre deux envois.');
    ws.lastSend = now;

    const duel = { id: `d${now}-${++duelSeq}`, a: ws, b: opp, pos: 0, ca: 0, cb: 0, state: 'intro', media, timers: [], bcTimer: null };
    ws.duel = opp.duel = duel;
    log(`⚔ duel ${ws.name} contre ${opp.name} [${ws.room}]`);
    const intro = {
      type: 'duel',
      phase: 'intro',
      id: duel.id,
      a: ws.name,
      b: opp.name,
      target: DUEL_TARGET,
      durationMs: DUEL_MS,
      startsIn: DUEL_INTRO_MS,
      mediaKind: media.kind,
    };
    send(ws, { ...intro, you: 'a' });
    send(opp, { ...intro, you: 'b' });
    duel.timers.push(
      setTimeout(() => {
        if (duel.state !== 'intro') return;
        duel.state = 'fight';
        duel.timers.push(setTimeout(() => endDuel(duel, 'time'), DUEL_MS));
      }, DUEL_INTRO_MS)
    );
  }

  function duelBroadcast(duel) {
    if (duel.bcTimer) return;
    // regroupe les clics : 20 mises à jour par seconde maximum
    duel.bcTimer = setTimeout(() => {
      duel.bcTimer = null;
      const pos = { type: 'duel-pos', id: duel.id, pos: duel.pos, ca: duel.ca, cb: duel.cb };
      send(duel.a, pos);
      send(duel.b, pos);
    }, 50);
  }

  function duelClick(ws, msg) {
    const duel = ws.duel;
    if (!duel || duel.id !== msg.id || duel.state !== 'fight') return;
    const now = Date.now();
    ws.clicks = (ws.clicks || []).filter((t) => now - t < 1000);
    if (ws.clicks.length >= DUEL_MAX_CPS) return;
    ws.clicks.push(now);
    if (ws === duel.a) {
      duel.ca++;
      duel.pos++;
    } else {
      duel.cb++;
      duel.pos--;
    }
    if (Math.abs(duel.pos) >= DUEL_TARGET) return endDuel(duel, 'rope');
    duelBroadcast(duel);
  }

  // forfeiter : joueur parti en plein duel (déconnexion) → l'autre gagne
  function endDuel(duel, reason, forfeiter = null) {
    if (duel.state === 'over') return;
    duel.state = 'over';
    duel.timers.forEach(clearTimeout);
    clearTimeout(duel.bcTimer);
    duel.a.duel = duel.b.duel = null;

    let winner = null;
    if (forfeiter) winner = forfeiter === duel.a ? duel.b : duel.a;
    else if (duel.pos > 0) winner = duel.a;
    else if (duel.pos < 0) winner = duel.b;
    const losers = winner ? [winner === duel.a ? duel.b : duel.a] : [duel.a, duel.b]; // égalité : tout le monde la mange
    log(`⚔ fin du duel ${duel.a.name}/${duel.b.name} : ${winner ? `${winner.name} gagne` : 'égalité'} (${duel.ca}-${duel.cb}, ${reason})`);

    const end = { type: 'duel-end', id: duel.id, winner: winner?.name || null, pos: duel.pos, ca: duel.ca, cb: duel.cb, reason: forfeiter ? 'forfeit' : reason };
    send(duel.a, end);
    send(duel.b, end);

    // La vidéo en jeu arrive chez le(s) perdant(s) une fois le résultat affiché
    setTimeout(() => {
      for (const loser of losers) {
        if (loser === forfeiter || loser.readyState !== loser.OPEN || !loser.room) continue;
        const backfire = loser === duel.a;
        const label = backfire ? `💥 Retour à l'envoyeur ! Duel perdu contre ${duel.b.name}` : `💥 Duel perdu contre ${duel.a.name}`;
        const payload = mediaPayload({ ...duel.media, text: [label, duel.media.text].filter(Boolean).join(' · ') }, backfire ? duel.b.name : duel.a.name);
        sentIndex.set(payload.id, { sender: duel.a, room: duel.a.room, at: Date.now() });
        send(loser, payload);
      }
    }, DUEL_RESULT_MS);
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.lastSend = 0;
    ws.on('pong', () => (ws.isAlive = true));

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'hello') {
        const name = String(msg.name || '').trim().slice(0, 24);
        const room = String(msg.room || '').trim().slice(0, 64);
        if (!name || !room) return send(ws, { type: 'error', message: 'Pseudo et code du salon obligatoires.' });

        leave(ws);
        if (!rooms.has(room)) rooms.set(room, new Map());
        const members = rooms.get(room);
        const existing = members.get(name);
        if (existing && existing !== ws) {
          // Le plus souvent c'est la même personne qui revient après une coupure réseau (Wi-Fi, veille) :
          // son ancienne connexion est morte mais pas encore détectée. La nouvelle prend sa place.
          log(`~ ${name} remplace son ancienne connexion [${room}]`);
          send(existing, { type: 'replaced', message: `Ton pseudo "${name}" vient de se connecter depuis un autre endroit.` });
          members.delete(name);
          if (existing.duel) endDuel(existing.duel, 'forfeit', existing);
          existing.room = null;
          existing.terminate();
        }
        ws.name = name;
        ws.room = room;
        ws.dnd = !!msg.dnd;
        ws.caps = Array.isArray(msg.caps) ? msg.caps.slice(0, 10).map(String) : [];
        ws.joinedAt = Date.now();
        members.set(name, ws);
        log(`+ ${name} a rejoint [${room}] (${req.socket.remoteAddress})`);
        send(ws, { type: 'welcome', name });
        return broadcastPresence(room);
      }

      if (!ws.room) return;

      if (msg.type === 'status') {
        ws.dnd = !!msg.dnd;
        return broadcastPresence(ws.room);
      }

      if (msg.type === 'duel-start') return startDuel(ws, msg);
      if (msg.type === 'duel-click') return duelClick(ws, msg);

      // Bouton "Actualiser" : on vérifie qui répond encore, puis on renvoie la liste
      if (msg.type === 'who') {
        const members = rooms.get(ws.room) || new Map();
        const checks = [...members.values()].filter((c) => c !== ws).map(
          (c) =>
            new Promise((resolve) => {
              if (c.readyState !== c.OPEN) return resolve(c.terminate());
              const timer = setTimeout(() => resolve(c.terminate()), 3000);
              c.once('pong', () => {
                clearTimeout(timer);
                resolve();
              });
              c.ping();
            })
        );
        // petit délai : les connexions coupées doivent d'abord quitter le salon
        return Promise.all(checks).then(() =>
          setTimeout(() => ws.room && send(ws, { type: 'presence', users: presenceOf(ws.room), refreshed: true }), 100)
        );
      }

      if (msg.type === 'media') {
        const now = Date.now();
        if (now - ws.lastSend < cooldownMs) {
          return send(ws, { type: 'error', message: 'Doucement ! Attends un peu entre deux envois.' });
        }
        ws.lastSend = now;

        const payload = {
          type: 'media',
          id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
          from: ws.name,
          kind: msg.kind,
          mime: msg.mime,
          data: msg.data,
          url: msg.url,
          text: String(msg.text || '').slice(0, 200),
          // Début de l'extrait vidéo (en secondes), la durée max est imposée côté receveur
          start: Math.min(Math.max(Number(msg.start) || 0, 0), 36000),
          source: msg.source === 'x' ? 'x' : undefined,
        };

        const members = rooms.get(ws.room) || new Map();
        const targets = msg.to === '*' ? [...members.values()].filter((c) => c !== ws) : [members.get(msg.to)].filter(Boolean);

        sentIndex.set(payload.id, { sender: ws, room: ws.room, at: now });

        let delivered = 0;
        const recipients = [];
        for (const c of targets) {
          if (c.dnd) {
            recipients.push({ name: c.name, status: 'dnd' });
            continue;
          }
          send(c, payload);
          recipients.push({ name: c.name, status: 'sent' });
          delivered++;
        }
        return send(ws, {
          type: 'sent',
          id: payload.id,
          clientId: msg.clientId,
          delivered,
          total: targets.length,
          recipients,
        });
      }

      // Accusé de réception d'un receveur : "received" (arrivé), "shown" (affiché), "failed", "skipped", "killed" (détruit à coups de clics)
      if (msg.type === 'ack') {
        const entry = sentIndex.get(msg.id);
        if (!entry || entry.room !== ws.room) return;
        const status = ['received', 'shown', 'failed', 'skipped', 'killed'].includes(msg.status) ? msg.status : null;
        if (status) send(entry.sender, { type: 'ack', id: msg.id, by: ws.name, status });
      }
    });

    ws.on('close', () => {
      if (ws.duel) endDuel(ws.duel, 'forfeit', ws);
      leave(ws);
    });
    ws.on('error', () => leave(ws));
  });

  // Coupe les connexions mortes (≤ 30 s) + oublie les vieux envois
  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [id, entry] of sentIndex) if (now - entry.at > ACK_TTL_MS) sentIndex.delete(id);
    for (const ws of wss.clients) {
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 15000);

  // ws ré-émet les erreurs du serveur HTTP sur wss : sans écouteur, Node les transforme en exception
  // (ex. port déjà utilisé) avant même que server.on('error') ne soit appelé.
  wss.on('error', () => {});
  let failed = false;
  server.on('error', (e) => {
    if (failed) return;
    failed = true;
    clearInterval(heartbeat);
    if (onError) onError(e);
    else log(`Erreur du serveur : ${e.message}`);
  });

  server.listen(port, () => {
    log(`Serveur LiveChat entre potes lancé sur le port ${port}`);
    log(`Taille max par média : ${maxMb} Mo`);
    onListening?.();
  });

  return {
    close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      wss.close();
      server.close();
    },
  };
}

module.exports = { startRelay };
