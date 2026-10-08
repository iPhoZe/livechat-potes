// Serveur relais autonome (sans l'appli), par ex. pour un hébergement 24/7.
// Le code du relais est partagé avec l'appli : voir app/relay.js
// (nécessite `npm install` dans app/ pour la dépendance ws).
const { startRelay } = require('../app/relay');

startRelay({
  port: Number(process.env.PORT) || 8080,
  maxMb: Number(process.env.MAX_MB) || 25,
  cooldownMs: Number(process.env.COOLDOWN_MS) || 2000,
});
