const mammoth = require('mammoth');
const JSZip = require('jszip');

async function ocrImage(base64, mime, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'meta-llama/llama-4-scout-17b-16e-instruct',
      messages: [{
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
          { type: 'text', text: 'Extract ALL text from this image exactly as it appears. Include every word, number, and symbol. If there is no text, reply with an empty string only.' }
        ]
      }],
      max_tokens: 2048,
      temperature: 0.1
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || `Groq vision error ${res.status}`);
  return (data.choices?.[0]?.message?.content || '').trim();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { content, ocrImages } = req.body || {};

    // OCR path: scanned PDF pages rendered client-side to JPEG data URLs
    if (ocrImages && Array.isArray(ocrImages) && ocrImages.length > 0) {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('OCR service not configured.');
      const texts = [];
      for (const dataUrl of ocrImages) {
        const comma = dataUrl.indexOf(',');
        const mime = dataUrl.slice(5, dataUrl.indexOf(';'));
        const b64 = dataUrl.slice(comma + 1);
        const text = await ocrImage(b64, mime, apiKey);
        if (text) texts.push(text);
      }
      return res.status(200).json({ text: texts.join('\n\n'), pages: texts.length });
    }

    const { fileType } = req.body || {};
    if (!content) return res.status(400).json({ error: 'Missing file content' });

    const buffer = Buffer.from(content, 'base64');

    // PPTX path: extract text from slide XML
    if (fileType === 'pptx') {
      const zip = await JSZip.loadAsync(buffer);
      const slideFiles = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
        .sort((a, b) => {
          const na = parseInt(a.match(/\d+/)?.[0] || 0);
          const nb = parseInt(b.match(/\d+/)?.[0] || 0);
          return na - nb;
        });
      if (slideFiles.length === 0) throw new Error('No slides found in this PPTX file.');
      const slideTexts = [];
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async('string');
        // Extract all <a:t> text nodes
        const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1]);
        const slideText = matches.join(' ').replace(/\s+/g, ' ').trim();
        if (slideText) slideTexts.push(`[Slide ${i + 1}]\n${slideText}`);
      }
      if (slideTexts.length === 0) throw new Error('No text found in slides.');
      return res.status(200).json({ text: slideTexts.join('\n\n'), slides: slideTexts.length });
    }

    // 1. Try mammoth text extraction first (fast, no API cost)
    const mammothResult = await mammoth.extractRawText({ buffer });
    if (mammothResult.value.trim().length > 0) {
      return res.status(200).json({ text: mammothResult.value });
    }

    // 2. Fallback: OCR images embedded in DOCX (cap at 4 to avoid timeout)
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('OCR service not configured.');

    const zip = await JSZip.loadAsync(buffer);
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

    const imageEntries = Object.values(zip.files).filter(f =>
      !f.dir && f.name.startsWith('word/media/') && /\.(png|jpe?g|gif|bmp)$/i.test(f.name)
    ).slice(0, 4);

    if (imageEntries.length === 0) {
      throw new Error('No readable text or images found in this DOCX file.');
    }

    const texts = [];
    for (const entry of imageEntries) {
      const ext = entry.name.split('.').pop().toLowerCase();
      const mime = mimeMap[ext] || 'image/png';
      const b64 = await entry.async('base64');
      const text = await ocrImage(b64, mime, apiKey);
      if (text) texts.push(text);
    }

    if (texts.length === 0) throw new Error('Could not extract text from images in this file.');
    return res.status(200).json({ text: texts.join('\n\n'), method: 'ocr', pages: texts.length });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
