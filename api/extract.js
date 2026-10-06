const mammoth = require('mammoth');
const JSZip = require('jszip');
const { applyCors, verifyAuth, checkRateLimit, chargeCredits, creditsForSize, LIMITS } = require('./_lib/auth');
const { MODEL_VISION, FRIENDLY_AI_ERROR, isModelUnavailableError, userError, sendServerError } = require('./_lib/models');

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

  // Credits are charged only where AI runs: each scanned page / image read by the vision
  // model (PAGES_PER_CREDIT pages per credit). Reading text from Word and PowerPoint files
  // uses no AI and is free. At most LIMITS.MAX_OCR_PAGES pages per request.
  try {
    const { content, ocrImages } = req.body || {};

    // OCR path: scanned PDF pages rendered client-side to JPEG data URLs
    if (ocrImages && Array.isArray(ocrImages) && ocrImages.length > 0) {
      if (ocrImages.length > LIMITS.MAX_OCR_PAGES) {
        return res.status(413).json({ code: 'too_long', error: `This file has ${ocrImages.length} scanned pages. Up to ${LIMITS.MAX_OCR_PAGES} can be read at once — please split it.` });
      }
      if (ocrImages.some(u => typeof u !== 'string' || !u.startsWith('data:image/') || u.length > LIMITS.MAX_IMAGE_CHARS)) {
        return res.status(413).json({ code: 'too_long', error: 'One of the pages is too large or not an image. Please try a smaller file.' });
      }
      if (!(await chargeCredits(req, res, uid, creditsForSize({ pages: ocrImages.length }), { reason: 'ocr-pages' }))) return;
      const apiKey = process.env.GROQ_API_KEY;
      if (!apiKey) throw new Error('GROQ_API_KEY is not set');
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
      if (slideFiles.length === 0) throw userError('No slides found in this PowerPoint file.');
      const slideTexts = [];
      for (let i = 0; i < slideFiles.length; i++) {
        const xml = await zip.files[slideFiles[i]].async('string');
        // Extract all <a:t> text nodes
        const matches = [...xml.matchAll(/<a:t[^>]*>([^<]*)<\/a:t>/g)].map(m => m[1]);
        const slideText = matches.join(' ').replace(/\s+/g, ' ').trim();
        if (slideText) slideTexts.push(`[Slide ${i + 1}]\n${slideText}`);
      }
      if (slideTexts.length === 0) throw userError('No text found in these slides.');
      return res.status(200).json({ text: slideTexts.join('\n\n'), slides: slideTexts.length });
    }

    // 1. Try mammoth text extraction first (fast, no API cost)
    const mammothResult = await mammoth.extractRawText({ buffer });
    if (mammothResult.value.trim().length > 0) {
      return res.status(200).json({ text: mammothResult.value });
    }

    // 2. Fallback: OCR images embedded in DOCX (cap at 4 to avoid timeout)
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) throw new Error('GROQ_API_KEY is not set');

    const zip = await JSZip.loadAsync(buffer);
    const mimeMap = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };

    const imageEntries = Object.values(zip.files).filter(f =>
      !f.dir && f.name.startsWith('word/media/') && /\.(png|jpe?g|gif|bmp)$/i.test(f.name)
    ).slice(0, 4);

    if (imageEntries.length === 0) {
      throw userError('No readable text or pictures found in this Word file.');
    }
    if (!(await chargeCredits(req, res, uid, creditsForSize({ pages: imageEntries.length }), { reason: 'ocr-docx-images' }))) return;

    const texts = [];
    for (const entry of imageEntries) {
      const ext = entry.name.split('.').pop().toLowerCase();
      const mime = mimeMap[ext] || 'image/png';
      const b64 = await entry.async('base64');
      const text = await ocrImage(b64, mime, apiKey);
      if (text) texts.push(text);
    }

    if (texts.length === 0) throw userError('Could not read any text from the pictures in this file.');
    return res.status(200).json({ text: texts.join('\n\n'), method: 'ocr', pages: texts.length });

  } catch (err) {
    console.error('Groq error (extract):', err.message);
    if (isModelUnavailableError(err)) return res.status(502).json({ error: FRIENDLY_AI_ERROR });
    return sendServerError(res, err, 'extract', "We couldn't read this file. It may be damaged or in a format we can't open. Please try another file.");
  }
};
