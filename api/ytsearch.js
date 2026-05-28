const PIPED = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.leptons.xyz',
  'https://piped-api.garudalinux.org',
];

const INVIDIOUS = [
  'https://inv.nadeko.net',
  'https://iv.datura.network',
  'https://invidious.lunar.icu',
  'https://y.com.sb',
  'https://yt.cdaut.de',
];

function fmtDuration(s) {
  if (!s || s < 0) return '';
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h) return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}`;
  return `${m}:${String(sec).padStart(2,'0')}`;
}

function fmtViews(v) {
  if (!v) return '';
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B views';
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M views';
  if (v >= 1e3) return Math.floor(v / 1e3) + 'K views';
  return v + ' views';
}

async function searchPiped(q) {
  for (const base of PIPED) {
    try {
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) continue;
      const data = await r.json();
      const items = (data.items || []).filter(v => v.type === 'stream' && v.url);
      if (!items.length) continue;
      return items.slice(0, 6).map(v => {
        const id = (v.url || '').replace('/watch?v=', '');
        return { id, title: v.title || '', channel: v.uploaderName || '',
          duration: fmtDuration(v.duration), views: fmtViews(v.views),
          ago: v.uploadedDate || '', thumb: v.thumbnail || `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
      });
    } catch (_) { continue; }
  }
  return null;
}

async function searchInvidious(q) {
  for (const base of INVIDIOUS) {
    try {
      const r = await fetch(
        `${base}/api/v1/search?q=${encodeURIComponent(q)}&type=video&fields=videoId,title,author,lengthSeconds,viewCount,publishedText`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (!r.ok) continue;
      const data = await r.json();
      if (!Array.isArray(data) || !data.length) continue;
      return data.filter(v => v.videoId).slice(0, 6).map(v => ({
        id: v.videoId, title: v.title || '', channel: v.author || '',
        duration: fmtDuration(v.lengthSeconds), views: fmtViews(v.viewCount),
        ago: v.publishedText || '', thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
      }));
    } catch (_) { continue; }
  }
  return null;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const { q } = req.body || {};
  if (!q?.trim()) return res.status(400).json({ error: 'No query provided' });

  // Race Piped and Invidious in parallel — first success wins
  const videos = await Promise.race([
    searchPiped(q.trim()),
    searchInvidious(q.trim()),
  ]).catch(() => null) || await searchPiped(q.trim()).catch(() => null) || await searchInvidious(q.trim()).catch(() => null);

  if (videos) return res.status(200).json({ videos });
  return res.status(502).json({ error: 'Search temporarily unavailable. Please try again.' });
}
