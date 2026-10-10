// Petit journal texte (livechat.log dans le dossier de l'appli) pour comprendre les problèmes après coup.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024; // au-delà, l'ancien journal devient livechat.log.old

function createLogger(dir, { echo = false } = {}) {
  const file = path.join(dir, 'livechat.log');

  function write(level, parts) {
    const text = parts.map((p) => (p instanceof Error ? p.stack || p.message : typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    const line = `${new Date().toISOString()} [${level}] ${text}\n`;
    if (echo) process.stdout.write(line);
    try {
      fs.mkdirSync(dir, { recursive: true });
      try {
        if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, `${file}.old`);
      } catch {}
      fs.appendFileSync(file, line);
    } catch {
      // le journal ne doit jamais faire planter l'appli
    }
  }

  function tail(lines = 80) {
    try {
      return fs.readFileSync(file, 'utf8').trimEnd().split('\n').slice(-lines).join('\n');
    } catch {
      return '(journal vide)';
    }
  }

  return {
    file,
    tail,
    info: (...p) => write('INFO', p),
    warn: (...p) => write('WARN', p),
    error: (...p) => write('ERREUR', p),
  };
}

module.exports = { createLogger };
