function getVideoId(url) {
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/)([^&\n?#]+)/);
  return m ? m[1] : null;
}

async function fetchVideoContent(videoId, url) {
  try {
    const jinaRes = await fetch(`https://r.jina.ai/https://www.youtube.com/watch?v=${videoId}`, {
      headers: { 'Accept': 'application/json', 'X-No-Cache': 'true' }
    });
    if (jinaRes.ok) {
      const jinaData = await jinaRes.json();
      const content = jinaData?.data?.content || jinaData?.data?.description || '';
      if (content.length > 100) return content.slice(0, 12000);
    }
  } catch (_) {}

  try {
    const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (oembedRes.ok) {
      const data = await oembedRes.json();
      if (data.title) return `Video title: "${data.title}" by ${data.author_name}. Note: full transcript unavailable, summarizing from title only.`;
    }
  } catch (_) {}

  throw new Error('Could not extract content from this video. Please try a different video.');
}

function getPrompt(mode, transcript) {
  const t = transcript.slice(0, 12000);
  switch (mode) {
    case 'keypoints':
      return `Extract the key points from the following YouTube video transcript. Format your response as:\n\nKey Points:\n1. point one\n2. point two\n3. ...\n\n(List at least 5 specific, actionable key points.)\n\nTranscript:\n${t}`;
    case 'notes':
      return `Generate structured study notes from the following YouTube video transcript. Format your response as:\n\n# Topic\n\n## Section 1\n- note\n- note\n\n## Section 2\n- note\n- note\n\n(Organize into clear sections with bullet points, suitable for studying.)\n\nTranscript:\n${t}`;
    case 'quizzes':
      return `Generate 5 quiz questions with answers from the following YouTube video transcript. Format your response as:\n\nQ1: [question]\nA: [answer]\n\nQ2: [question]\nA: [answer]\n\n...\n\n(Make questions specific and educational, covering the main concepts.)\n\nTranscript:\n${t}`;
    default:
      return `Summarize the following YouTube video transcript. Structure your response as:\n\nOverview: One sentence.\n\nKey Points:\n• point 1\n• point 2\n• ...\n\nTakeaway: One sentence conclusion.\n\nTranscript:\n${t}`;
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { url, mode = 'summarize' } = req.body || {};
    if (!url) return res.status(400).json({ error: 'Missing YouTube URL' });

    const videoId = getVideoId(url);
    if (!videoId) return res.status(400).json({ error: 'Invalid YouTube URL' });

    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'API key not configured' });

    const transcript = await fetchVideoContent(videoId, url);
    if (!transcript || transcript.length < 50) throw new Error('Could not extract enough content from this video.');

    const prompt = getPrompt(mode, transcript);

    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 1000,
        temperature: 0.3
      })
    });

    const data = await groqRes.json();
    if (!groqRes.ok) return res.status(500).json({ error: data.error?.message || 'Groq error' });

    const summary = data.choices?.[0]?.message?.content;
    if (!summary) return res.status(500).json({ error: 'No result returned' });

    return res.status(200).json({ summary });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
