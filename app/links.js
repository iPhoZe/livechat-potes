// Transforme un lien collé (X/Twitter ou lien direct) en média affichable.
const UA = { 'User-Agent': 'LiveChatPotes/1.1 (+entre potes)' };

const TWEET_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter\.com|x\.com|fxtwitter\.com|vxtwitter\.com|fixupx\.com|fixvx\.com)\/(?:[^/]+|i(?:\/web)?)\/status(?:es)?\/(\d+)/i;

function kindFromUrl(url) {
  const path = url.split(/[?#]/)[0].toLowerCase();
  if (/\.(mp4|webm|mov|m4v|ogv)$/.test(path)) return 'video';
  if (/\.(mp3|ogg|wav|m4a|aac|opus)$/.test(path)) return 'audio';
  return 'image';
}

// Choisit un MP4 léger (≈720p) pour que ça charge vite chez les potes
function pickMp4(video) {
  const mp4s = (video.formats || []).filter((f) => f.container === 'mp4' && f.url);
  if (!mp4s.length) return video.url;
  mp4s.sort((a, b) => (a.bitrate || 0) - (b.bitrate || 0));
  const light = mp4s.filter((f) => (f.bitrate || 0) <= 2_500_000);
  return (light.length ? light[light.length - 1] : mp4s[0]).url;
}

async function fromFxTwitter(id) {
  const res = await fetch(`https://api.fxtwitter.com/status/${id}`, { headers: UA });
  if (!res.ok) throw new Error(`FxTwitter ${res.status}`);
  const { tweet } = await res.json();
  const media = tweet?.media || {};
  const video = (media.videos || [])[0];
  if (video) {
    return {
      kind: 'video',
      url: pickMp4(video),
      thumbnail: video.thumbnail_url,
      duration: video.duration || null,
      gif: video.type === 'gif',
      author: tweet.author?.screen_name,
    };
  }
  const photo = (media.photos || [])[0];
  if (photo) return { kind: 'image', url: photo.url, author: tweet.author?.screen_name };
  return null;
}

async function fromVxTwitter(id) {
  const res = await fetch(`https://api.vxtwitter.com/Twitter/status/${id}`, { headers: UA });
  if (!res.ok) throw new Error(`vxTwitter ${res.status}`);
  const data = await res.json();
  const m = (data.media_extended || [])[0];
  if (!m) return null;
  if (m.type === 'video' || m.type === 'gif') {
    return {
      kind: 'video',
      url: m.url,
      thumbnail: m.thumbnail_url,
      duration: m.duration_millis ? m.duration_millis / 1000 : null,
      gif: m.type === 'gif',
      author: data.user_screen_name,
    };
  }
  return { kind: 'image', url: m.url, author: data.user_screen_name };
}

async function resolveLink(raw) {
  const url = String(raw || '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: 'Ce n’est pas un lien.' };

  const tweet = url.match(TWEET_RE);
  if (!tweet) return { ok: true, source: 'direct', kind: kindFromUrl(url), url };

  const id = tweet[1];
  let lastError;
  for (const provider of [fromFxTwitter, fromVxTwitter]) {
    try {
      const media = await provider(id);
      if (media) return { ok: true, source: 'x', ...media };
      return { ok: false, error: 'Ce post X ne contient ni vidéo ni image.' };
    } catch (e) {
      lastError = e;
    }
  }
  return { ok: false, error: `Impossible de lire ce lien X (${lastError?.message || 'erreur inconnue'}).` };
}

module.exports = { resolveLink, kindFromUrl };
