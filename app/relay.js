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
    return [...members.values()].map((c) => ({ name: c.name, dnd: c.dnd, since: c.joinedAt }));
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
          existing.room = null;
          existing.terminate();
        }
        ws.name = name;
        ws.room = room;
        ws.dnd = !!msg.dnd;
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

    ws.on('close', () => leave(ws));
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
