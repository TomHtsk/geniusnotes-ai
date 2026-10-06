const mammoth = require('mammoth');
const JSZip = require('jszip');
const { applyCors, verifyAuth, checkRateLimit, checkAndIncrementUsage, INPUT_LIMITS } = require('./_lib/auth');

// One page to read: a data:image/...;base64 URL (homepage) or { data, type } (Notebooks).
// Returns { mime, b64 }, or null if it is not an image or is too large.
function _ocrPage(p) {
  let mime, b64;
  if (typeof p === 'string') {
    const m = p.match(/^data:(image\/[a-z0-9.+-]+);base64,/i);
    if (!m) return null;
    mime = m[1]; b64 = p.slice(m[0].length);
  } else if (p && typeof p.data === 'string' && /^image\/[a-z0-9.+-]+$/i.test(String(p.type || ''))) {
    mime = p.type; b64 = p.data;
  } else return null;
  return b64 && b64.length <= INPUT_LIMITS.IMAGE_CHARS ? { mime, b64 } : null;
}
const { MODEL_VISION, FRIENDLY_AI_ERROR, isModelUnavailableError } = require('./_lib/models');

async function ocrImage(base64, mime, apiKey) {
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_VISION,
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
  if (!res.ok) {
    console.error('Groq error (extract/OCR):', data.error?.message);
    const e = new Error(data.error?.message || `Groq vision error ${res.status}`);
    e.code = data.error?.code;
    throw e;
  }
  return (data.choices?.[0]?.message?.content || '').trim();
}

module.exports = async function handler(req, res) {
  applyCors(res, req);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const uid = await verifyAuth(req, res);
  if (!uid) return;
  if (!(await checkRateLimit(uid, res))) return;
  // Size limits for scanned pages / pictures, before charging.
  let ocrPages = null;
  const ocrIn = (req.body || {}).ocrImages;
  if (Array.isArray(ocrIn) && ocrIn.length > 0) {
    if (ocrIn.length > INPUT_LIMITS.OCR_PAGES) {
      return res.status(413).json({ code: 'too_long', error: `This file has ${ocrIn.length} scanned pages. Up to ${INPUT_LIMITS.OCR_PAGES} can be read at once - please split it.` });
    }
    ocrPages = ocrIn.map(_ocrPage);
    if (ocrPages.some(p => !p)) {
      return res.status(413).json({ code: 'too_long', error: 'One of the pages is too large or is not a picture. Please try a smaller file, or a PDF, Word or PowerPoint file.' });
    }
  }
  if (!(await checkAndIncrementUsage(uid, res, 'ai'))) return;

  try {
    const { content } = req.body || {};

    // OCR path: scanned PDF pages rendered client-side to JPEG data URLs (checked above)
    if (ocrPages) {
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('OCR service not configured.');
      const texts = [];
      for (const { b64, mime } of ocrPages) {
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
    console.error('Groq error (extract):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return res.status(500).json({ error: err.message });
  }
};
