// ── AI Highlight ──────────────────────────────────────────────
async function aiHighlight(textId, btnId) {
  const el = document.getElementById(textId);
  const btn = document.getElementById(btnId);
  if (!el || !el.textContent.trim()) return;
  btn.textContent = '⏳ Highlighting…';
  btn.disabled = true;
  try {
    const r = await fetch('/api/summarize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: el.textContent.slice(0, 8000), mode: 'highlight' })
    });
    const data = await r.json();
    let phrases = [];
    try { phrases = JSON.parse(data.summary); } catch { phrases = []; }
    if (phrases.length) {
      applyAiHighlights(el, phrases);
      btn.textContent = '✨ Done!';
    } else {
      btn.textContent = '✨ Magic Highlight';
      btn.disabled = false;
    }
  } catch {
    btn.textContent = '✨ Magic Highlight';
    btn.disabled = false;
  }
}

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function formatTextForDisplay(raw) {
  // Normalise line endings and whitespace
  let t = raw.replace(/\r\n/g,'\n').replace(/\r/g,'\n');
  t = t.replace(/\n{3,}/g,'\n\n');
  t = t.split('\n').map(l => l.trimEnd()).join('\n');

  function renderInline(s) {
    // HTML-escape
    let out = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    // Bold: **text**
    out = out.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    // Italic: *text*
    out = out.replace(/\*([^*\n]+?)\*/g, '<em>$1</em>');
    return out;
  }

  function classifyLine(s) {
    const trimmed = s.trim();
    if (!trimmed) return '';
    // Numbered list item: 1. or 1)
    if (/^\d+[.)]\s/.test(trimmed)) return 'hl-list-item';
    // Explicit markdown bold heading: **...**
    if (/^\*\*[^*]+\*\*$/.test(trimmed)) return 'hl-heading';
    // ALL CAPS line (e.g. "LEARNING PORTFOLIO", "KEY TERMS")
    if (trimmed.length <= 70 && /[A-Z]/.test(trimmed) && trimmed === trimmed.toUpperCase() && !/\d/.test(trimmed)) return 'hl-heading';
    return '';
  }

  function classifyBlock(s) {
    const cls = classifyLine(s);
    if (cls) return cls;
    const trimmed = s.trim();
    const words = trimmed.split(/\s+/);
    // Short line with no trailing sentence punctuation → likely a heading/title
    if (words.length >= 1 && words.length <= 7 && trimmed.length <= 60 && !/[.!?,;:]$/.test(trimmed) && !/^\d/.test(trimmed)) return 'hl-heading';
    return '';
  }

  const blocks = t.split('\n\n').filter(b => b.trim());

  if (blocks.length <= 1) {
    const lines = t.split('\n').filter(l => l.trim());
    return lines.map(l => {
      const cls = classifyLine(l);
      const rendered = renderInline(l);
      return cls ? `<p class="${cls}">${rendered}</p>` : `<p>${rendered}</p>`;
    }).join('');
  }

  return blocks.map(block => {
    const lines = block.split('\n');
    if (lines.length === 1) {
      const cls = classifyBlock(lines[0]);
      const rendered = renderInline(lines[0]);
      return cls ? `<p class="${cls}">${rendered}</p>` : `<p>${rendered}</p>`;
    }
    // Multi-line block: check if first line is an explicit heading
    const firstCls = classifyLine(lines[0]);
    const renderedLines = lines.map(l => renderInline(l));
    if (firstCls === 'hl-heading') {
      return `<p class="hl-heading">${renderedLines[0]}</p>` + `<p>${renderedLines.slice(1).join('<br>')}</p>`;
    }
    return `<p>${renderedLines.join('<br>')}</p>`;
  }).join('');
}

function applyAiHighlights(el, phrases) {
  let html = el.innerHTML;
  // Longest first: "sedative-hypnotic" must match before "sedative" splits the compound
  const sorted = [...phrases].sort((a, b) => b.length - a.length);
  sorted.forEach(phrase => {
    if (!phrase || phrase.length < 2) return;
    const re = new RegExp(`\\b(${escRe(phrase)}\\w*)(?![^<]*>)`, 'gi');
    html = html.replace(re, '<mark class="hl-ai">$1</mark>');
  });
  el.innerHTML = html;
}

// ── Manual Highlight ──────────────────────────────────────────
const hlToolbar = document.getElementById('hl-toolbar');
const hlTargets = ['summary-text', 'upload-summary-text', 'hl-panel-output'];
let hlMousePos = { x: 0, y: 0 };
let savedRange = null;

document.addEventListener('mousemove', e => { hlMousePos.x = e.clientX; hlMousePos.y = e.clientY; });

// Save selection before it's lost when clicking a swatch
document.addEventListener('mousedown', e => {
  const isSwatch = e.target.closest('#hl-toolbar, #hl-panel-result-area .hl-swatch');
  if (isSwatch) {
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.rangeCount) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
    e.preventDefault(); // prevent focus loss
    return;
  }
  if (!e.target.closest('#hl-toolbar')) hlToolbar.style.display = 'none';
}, true);

document.addEventListener('mouseup', e => {
  if (e.target.closest('#hl-toolbar, #hl-panel-result-area .hl-swatch')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      hlToolbar.style.display = 'none';
      return;
    }
    const anchor = sel.anchorNode?.parentElement;
    const inTarget = hlTargets.some(id => document.getElementById(id)?.contains(anchor));
    // Don't show floating toolbar for hl-panel-output (has static toolbar instead)
    if (!inTarget || anchor?.closest('#hl-panel-output')) {
      if (!inTarget) hlToolbar.style.display = 'none';
      return;
    }
    hlToolbar.style.display = 'flex';
    const tw = 200, th = 40;
    let x = hlMousePos.x - tw / 2;
    let y = hlMousePos.y - th - 10;
    if (x < 8) x = 8;
    if (x + tw > window.innerWidth - 8) x = window.innerWidth - tw - 8;
    if (y < 8) y = hlMousePos.y + 20;
    hlToolbar.style.left = x + 'px';
    hlToolbar.style.top  = y + 'px';
  }, 10);
});

// ── Flashcard file upload ─────────────────────────────────────
async function fcLoadFile(file) {
  if (!file) return;
  document.getElementById('fc-file-name').textContent = file.name;
  const ext = file.name.split('.').pop().toLowerCase();
  const ta = document.getElementById('fc-text');
  ta.value = 'Extracting text…';
  document.getElementById('fc-char-num').textContent = 0;
  try {
    if (ext === 'txt') {
      const text = await file.text();
      ta.value = text.slice(0, 5000);
    } else if (ext === 'pdf') {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(s => s.str).join(' ') + '\n';
      }
      ta.value = text.trim().slice(0, 5000);
    } else if (ext === 'docx') {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: b64 })
      });
      const data = await r.json();
      ta.value = (data.text || data.error || 'Could not extract text.').slice(0, 5000);
    } else {
      ta.value = 'Unsupported file type.';
    }
    document.getElementById('fc-char-num').textContent = ta.value.length;
  } catch (err) {
    ta.value = 'Error reading file: ' + err.message;
  }
}

// ── Magic Highlighter Panel ───────────────────────────────────
async function hlLoadFile(file) {
  if (!file) return;
  document.getElementById('hl-file-name').textContent = file.name;
  const ext = file.name.split('.').pop().toLowerCase();
  const ta = document.getElementById('hl-panel-text');
  const charNum = document.getElementById('hl-char-num');
  ta.value = 'Extracting text…';

  try {
    if (ext === 'txt') {
      const text = await file.text();
      ta.value = text;
      charNum.textContent = text.length;

    } else if (ext === 'pdf') {
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader not loaded — please refresh the page.');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        ta.value = `Extracting… page ${i} of ${pdf.numPages}`;
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(s => s.str).join(' ') + '\n';
      }
      const extracted = text.trim();
      if (!extracted) {
        // Scanned PDF — fall back to OCR via Groq vision
        const MAX_OCR = 10;
        const pageCount = Math.min(pdf.numPages, MAX_OCR);
        const ocrImages = [];
        for (let i = 1; i <= pageCount; i++) {
          ta.value = `🔍 OCR scanning page ${i} of ${pageCount}…`;
          const pg = await pdf.getPage(i);
          const viewport = pg.getViewport({ scale: 1.5 });
          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          await pg.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
          ocrImages.push(canvas.toDataURL('image/jpeg', 0.8));
        }
        ta.value = '⏳ Extracting text from scanned pages…';
        try {
          const r = await fetch('/api/extract', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ocrImages })
          });
          const d = await r.json();
          if (d.text && d.text.trim()) {
            ta.value = d.text.trim();
            if (pdf.numPages > MAX_OCR) ta.value += `\n\n[Note: OCR limited to first ${MAX_OCR} of ${pdf.numPages} pages]`;
          } else {
            ta.value = '⚠️ Could not extract text. The PDF may be too low quality for OCR.';
          }
        } catch(e) {
          ta.value = '⚠️ OCR failed: ' + e.message;
        }
      } else {
        ta.value = extracted;
      }
      charNum.textContent = ta.value.length;

    } else if (ext === 'docx') {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: b64 })
      });
      const data = await r.json();
      ta.value = data.text || data.error || 'Could not extract text from this file.';
      charNum.textContent = ta.value.length;

    } else {
      ta.value = 'Unsupported file type.';
    }
  } catch (err) {
    ta.value = 'Error reading file: ' + err.message;
  }
}

let hlCurrentTerms = [];
let hlCameFromTerms = false;
let hlLastPrompt = '';

function hlSetPrompt(text, btn) {
  document.getElementById('hl-custom-prompt').value = text;
  document.querySelectorAll('.hl-preset').forEach(b => b.classList.remove('hl-preset-active'));
  if (btn) btn.classList.add('hl-preset-active');
  hlUpdateBtnLabel();
}

function hlUpdateBtnLabel() {
  const btn = document.getElementById('hl-panel-btn');
  if (!btn) return;
  const hasPrompt = document.getElementById('hl-custom-prompt')?.value.trim();
  if (isPro) {
    btn.textContent = hasPrompt ? '✨ Generate Terms →' : '✨ AI Highlight →';
  } else {
    btn.textContent = hasPrompt ? '▶ Generate Terms →' : '▶ Watch Ad & Highlight →';
  }
}

async function hlPanelRun() {
  const text = document.getElementById('hl-panel-text').value.trim();
  if (!text) return;
  if (!isPro) { showHwAdGated(() => _runHlPanel()); return; }
  _runHlPanel();
}

async function _runHlPanel() {
  const text = document.getElementById('hl-panel-text').value.trim();
  if (!text) return;
  const customPrompt = document.getElementById('hl-custom-prompt')?.value.trim();
  const btn = document.getElementById('hl-panel-btn');
  btn.disabled = true;

  if (customPrompt) {
    // Structural shortcut: "questions" prompt + numbered list → highlight full paragraphs instantly
    if (/\bquestion[s]?\b|\bdiscussion\s*question/i.test(customPrompt)) {
      const output = document.getElementById('hl-panel-output');
      output.innerHTML = formatTextForDisplay(text);
      const items = output.querySelectorAll('p.hl-list-item');
      if (items.length > 0) {
        items.forEach(p => { p.innerHTML = '<mark class="hl-ai">' + p.innerHTML + '</mark>'; });
        hlLastPrompt = customPrompt;
        hlCameFromTerms = false;
        document.getElementById('hl-panel-input-area').style.display = 'none';
        document.getElementById('hl-panel-result-area').style.display = 'block';
        hlUpdateBtnLabel();
        btn.disabled = false;
        setTimeout(resizeCarousel, 50);
        return;
      }
      // No numbered items found — fall through to AI
    }

    // Two-step: generate term list → show editor → user applies
    btn.textContent = '⏳ Generating terms…';
    try {
      const r = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 8000), mode: 'highlight', highlightPrompt: customPrompt })
      });
      const data = await r.json();
      let terms = [];
      try { terms = JSON.parse(data.summary); } catch {}
      if (terms.length) {
        hlCurrentTerms = terms.map(t => String(t).toLowerCase().trim()).filter(Boolean);
        hlLastPrompt = customPrompt;
        hlShowTermsEditor();
      }
    } catch {}
    hlUpdateBtnLabel();
    btn.disabled = false;
  } else {
    // Direct: auto-highlight without prompt
    btn.textContent = '⏳ Highlighting…';
    const output = document.getElementById('hl-panel-output');
    output.innerHTML = formatTextForDisplay(text);
    document.getElementById('hl-panel-input-area').style.display = 'none';
    document.getElementById('hl-panel-result-area').style.display = 'block';
    hlCameFromTerms = false;
    try {
      const r = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 8000), mode: 'highlight' })
      });
      const data = await r.json();
      let phrases = [];
      try { phrases = JSON.parse(data.summary); } catch {}
      if (phrases.length) applyAiHighlights(output, phrases);
    } catch {}
    hlUpdateBtnLabel();
    btn.disabled = false;
    setTimeout(resizeCarousel, 50);
  }
}

function hlShowTermsEditor() {
  document.getElementById('hl-panel-input-area').style.display = 'none';
  document.getElementById('hl-terms-area').style.display = 'block';
  hlRenderTags();
  setTimeout(resizeCarousel, 80);
}

function hlRenderTags() {
  const container = document.getElementById('hl-terms-tags');
  if (!hlCurrentTerms.length) {
    container.innerHTML = '<span style="font-size:0.78rem;color:var(--muted);font-style:italic;">No terms — add some below.</span>';
    return;
  }
  container.innerHTML = hlCurrentTerms.map((term, i) =>
    `<span class="hl-term-tag">${term}<button class="hl-term-remove" onclick="hlRemoveTerm(${i})" title="Remove">✕</button></span>`
  ).join('');
}

function hlRemoveTerm(i) {
  hlCurrentTerms.splice(i, 1);
  hlRenderTags();
}

function hlAddTerm() {
  const input = document.getElementById('hl-add-term');
  const val = input.value.trim().toLowerCase();
  if (!val) return;
  if (!hlCurrentTerms.includes(val)) {
    hlCurrentTerms.push(val);
    hlRenderTags();
  }
  input.value = '';
}

function hlApplyTerms() {
  if (!hlCurrentTerms.length) return;
  const text = document.getElementById('hl-panel-text').value;
  const output = document.getElementById('hl-panel-output');
  output.innerHTML = formatTextForDisplay(text);
  document.getElementById('hl-terms-area').style.display = 'none';
  document.getElementById('hl-panel-result-area').style.display = 'block';
  hlCameFromTerms = true;
  applyAiHighlights(output, hlCurrentTerms);
  // Structural fallback: for question prompts, highlight first ~10 words of any numbered item the AI missed
  if (/question|discussion\s+q/i.test(hlLastPrompt)) {
    hlHighlightMissedQuestions(output);
  }
  setTimeout(resizeCarousel, 50);
}

function hlHighlightMissedQuestions(el) {
  el.querySelectorAll('p.hl-list-item').forEach(p => {
    if (p.querySelector('mark')) return; // already highlighted
    // Find first text node and highlight its first 10 words
    let html = p.innerHTML;
    // Capture and highlight the opening N words (after the number. prefix)
    html = html.replace(/^((?:\S+\s+){0,10})/, (match) => {
      if (!match.trim()) return match;
      return `<mark class="hl-ai">${match}</mark>`;
    });
    p.innerHTML = html;
  });
}

function hlTermsBack() {
  document.getElementById('hl-terms-area').style.display = 'none';
  document.getElementById('hl-panel-input-area').style.display = 'block';
  setTimeout(resizeCarousel, 50);
}

function hlResultBack() {
  document.getElementById('hl-panel-result-area').style.display = 'none';
  if (hlCameFromTerms) {
    document.getElementById('hl-terms-area').style.display = 'block';
    hlRenderTags();
  } else {
    document.getElementById('hl-panel-input-area').style.display = 'block';
  }
  setTimeout(resizeCarousel, 50);
}

function hlPanelClearMarks() {
  const el = document.getElementById('hl-panel-output');
  el.querySelectorAll('mark').forEach(m => m.replaceWith(...m.childNodes));
}

function hlDeleteAll() {
  document.getElementById('hl-panel-output').innerHTML = '';
  document.getElementById('hl-panel-text').value = '';
  document.getElementById('hl-char-num').textContent = '0';
  document.getElementById('hl-file-name').textContent = '';
  hlCurrentTerms = [];
  document.getElementById('hl-panel-result-area').style.display = 'none';
  document.getElementById('hl-terms-area').style.display = 'none';
  document.getElementById('hl-panel-input-area').style.display = 'block';
  setTimeout(resizeCarousel, 50);
}

// ── Highlighter mode toggle ───────────────────────────────────────────────────
function setHlMode(mode) {
  document.getElementById('hl-tab-normal').classList.toggle('active', mode === 'normal');
  document.getElementById('hl-tab-textbook').classList.toggle('active', mode === 'textbook');
  document.getElementById('hl-normal-mode').style.display = mode === 'normal' ? '' : 'none';
  document.getElementById('hl-textbook-mode').style.display = mode === 'textbook' ? '' : 'none';
  setTimeout(resizeCarousel, 50);
}

// ── Textbook feature ──────────────────────────────────────────────────────────
const TB_COLORS = ['#FFE566','#6EE7B7','#7DD3FC','#F9A8D4','#FCA5A1','#C4B5FD','#FCD34D','#86EFAC'];
const TB_BG = [
  'rgba(255,229,102,0.5)','rgba(110,231,183,0.45)','rgba(125,211,252,0.45)',
  'rgba(249,168,212,0.45)','rgba(252,165,161,0.45)','rgba(196,181,253,0.5)',
  'rgba(252,211,77,0.5)','rgba(134,239,172,0.45)'
];

let tbQuestionsText = '';
let tbQuestionsImage = null;
let tbQuestionsMime = '';
let tbChapterText = '';

async function tbLoadQuestions(file) {
  if (!file) return;
  const zone = document.getElementById('tb-q-zone');
  const status = document.getElementById('tb-q-status');
  zone.classList.remove('loaded');
  status.textContent = '⏳ Loading…';
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    if (file.type.startsWith('image/')) {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      tbQuestionsImage = b64;
      tbQuestionsMime = file.type;
      tbQuestionsText = '';
      status.textContent = '✓ ' + file.name;
    } else {
      tbQuestionsText = await tbExtractText(file, ext);
      tbQuestionsImage = null;
      status.textContent = '✓ ' + file.name;
    }
    zone.classList.add('loaded');
    tbCheckReady();
  } catch (e) {
    status.textContent = '⚠ ' + e.message;
  }
}

async function tbLoadChapter(file) {
  if (!file) return;
  const zone = document.getElementById('tb-c-zone');
  const status = document.getElementById('tb-c-status');
  zone.classList.remove('loaded');
  status.textContent = '⏳ Loading…';
  try {
    const ext = file.name.split('.').pop().toLowerCase();
    tbChapterText = await tbExtractText(file, ext);
    status.textContent = '✓ ' + file.name;
    zone.classList.add('loaded');
    tbCheckReady();
  } catch (e) {
    status.textContent = '⚠ ' + e.message;
  }
}

async function tbExtractText(file, ext) {
  if (ext === 'txt') return await file.text();
  if (ext === 'pdf') {
    if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader not loaded. Please refresh.');
    pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let text = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(s => s.str).join(' ') + '\n';
    }
    if (!text.trim()) throw new Error('This PDF appears image-based. Try a text PDF.');
    return text;
  }
  if (ext === 'docx') {
    const buf = await file.arrayBuffer();
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const r = await fetch('/api/extract', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ content: b64 }) });
    const d = await r.json();
    if (d.error) throw new Error(d.error);
    return d.text || '';
  }
  throw new Error('Unsupported file type.');
}

function tbCheckReady() {
  const hasQ = tbQuestionsText.trim() || tbQuestionsImage;
  const hasC = tbChapterText.trim();
  document.getElementById('tb-find-btn').disabled = !(hasQ && hasC);
}

async function tbFindAnswers() {
  const btn = document.getElementById('tb-find-btn');
  const statusEl = document.getElementById('tb-status');
  const resultEl = document.getElementById('tb-result');
  btn.disabled = true;
  btn.textContent = '⏳ Analyzing…';
  statusEl.style.display = '';
  statusEl.style.color = 'var(--muted)';
  statusEl.textContent = 'AI is reading your questions and chapter…';
  resultEl.style.display = 'none';

  try {
    const body = { chapter: tbChapterText };
    if (tbQuestionsImage) {
      body.questionsImage = tbQuestionsImage;
      body.questionsMime = tbQuestionsMime;
    } else {
      body.questionsText = tbQuestionsText;
    }

    const r = await fetch('/api/textbook', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Failed');

    const matches = data.matches || [];
    if (!matches.length) throw new Error('No matches found. Try a more detailed chapter.');

    // Build legend
    const legendEl = document.getElementById('tb-legend');
    legendEl.innerHTML = matches.map((m, i) => {
      const bg = TB_BG[i % TB_BG.length];
      const hex = TB_COLORS[i % TB_COLORS.length];
      const qShort = m.question.length > 60 ? m.question.slice(0, 57) + '…' : m.question;
      return `<div class="tb-legend-item" style="background:${bg};"><div class="tb-legend-dot" style="background:${hex};"></div><span>Q${i+1}: ${escTb(qShort)}</span></div>`;
    }).join('');

    // Build highlighted chapter
    document.getElementById('tb-chapter-out').innerHTML = tbHighlight(tbChapterText, matches);

    statusEl.style.color = '#4ade80';
    statusEl.textContent = `✓ Found highlights for ${matches.length} question${matches.length !== 1 ? 's' : ''}.`;
    resultEl.style.display = '';
    setTimeout(resizeCarousel, 100);
  } catch (e) {
    statusEl.style.color = '#F87171';
    statusEl.textContent = '⚠ ' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '🔍 Find Answers in Chapter →';
  }
}

function tbHighlight(text, matches) {
  // Build flat list of ranges
  const ranges = [];
  matches.forEach((m, qi) => {
    const bg = TB_BG[qi % TB_BG.length];
    (m.phrases || []).forEach(phrase => {
      if (!phrase || phrase.length < 3) return;
      const lower = text.toLowerCase();
      const pLow = phrase.toLowerCase();
      let idx = 0;
      while ((idx = lower.indexOf(pLow, idx)) !== -1) {
        ranges.push({ start: idx, end: idx + phrase.length, bg, qNum: qi + 1 });
        idx += phrase.length;
      }
    });
  });
  if (!ranges.length) return '<em style="color:var(--muted)">No matching phrases found in the chapter text. The AI may have paraphrased — try scrolling through the text manually.</em>\n\n' + escTb(text);

  ranges.sort((a, b) => a.start - b.start);

  let html = '', pos = 0;
  for (const rng of ranges) {
    if (rng.start < pos) continue; // skip overlaps
    html += escTb(text.slice(pos, rng.start));
    html += `<mark style="background:${rng.bg};border-radius:3px;padding:0 2px;" title="Q${rng.qNum}">`;
    html += escTb(text.slice(rng.start, rng.end));
    html += '</mark>';
    pos = rng.end;
  }
  html += escTb(text.slice(pos));
  return html;
}

function escTb(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function applyManualHighlight(cls) {
  let sel = window.getSelection();
  // Restore saved range if selection was lost (e.g. after clicking static swatch)
  if (savedRange && (!sel || sel.isCollapsed)) {
    sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(savedRange);
  }
  savedRange = null;
  if (!sel || sel.isCollapsed) { hlToolbar.style.display = 'none'; return; }
  const range = sel.getRangeAt(0);
  if (cls === null) {
    // Remove highlights inside selection
    const frag = range.cloneContents();
    frag.querySelectorAll('mark').forEach(m => m.replaceWith(...m.childNodes));
    range.deleteContents();
    range.insertNode(frag);
  } else {
    const mark = document.createElement('mark');
    mark.className = cls;
    try {
      range.surroundContents(mark);
    } catch {
      const frag = range.extractContents();
      mark.appendChild(frag);
      range.insertNode(mark);
    }
  }
  sel.removeAllRanges();
  hlToolbar.style.display = 'none';
}

// ── VOICE & AUDIO ──────────────────────────────────────────────
function initAudioPanel() {
  const locked = document.getElementById('audio-locked');
  const inputArea = document.getElementById('audio-input-area');
  if (!locked || !inputArea) return;
  locked.style.display = 'none';
  inputArea.style.display = '';
}

function initHwPanel() {
  const locked    = document.getElementById('hw-locked');
  const inputArea = document.getElementById('hw-input-area');
  if (!locked || !inputArea) return;
  locked.style.display    = 'none';
  inputArea.style.display = '';
  const btn = document.getElementById('hw-btn');
  if (btn && !isPro) btn.textContent = '▶ Watch Ad & Solve →';
}

let mediaRecorder = null, audioChunks = [], recordingTimer = null, recordingSeconds = 0;
let audioBlob = null, audioCurrentMode = 'transcribe';

function setAudioMode(chip, mode) {
  audioCurrentMode = mode;
  document.querySelectorAll('#audio-chips .yt-chip').forEach(c => c.classList.remove('yt-chip-active'));
  chip.classList.add('yt-chip-active');
  document.getElementById('audio-translate-opts').style.display = mode === 'translate' ? '' : 'none';
}

function tryLockedAudioMode(chip, mode) {
  setAudioMode(chip, mode);
}

async function toggleRecording() {
  const btn = document.getElementById('audio-record-btn');
  const timerEl = document.getElementById('audio-timer');
  const waveEl = document.getElementById('audio-waveform');
  const labelEl = document.getElementById('audio-record-label');

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm', audioBitsPerSecond: 32000 });
    mediaRecorder.ondataavailable = e => { if (e.data.size > 0) audioChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimer);
      audioBlob = new Blob(audioChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
      btn.classList.remove('recording');
      btn.textContent = '🎙';
      btn.title = 'Start recording';
      waveEl.classList.remove('active');
      timerEl.classList.remove('active');
      document.getElementById('audio-file-name').textContent = '';
      const mins = String(Math.floor(recordingSeconds/60)).padStart(2,'0');
      const secs = String(recordingSeconds%60).padStart(2,'0');
      labelEl.textContent = `Recording saved (${mins}:${secs}) — click Process to continue`;
    };
    mediaRecorder.start(200);
    recordingSeconds = 0;
    timerEl.textContent = '00:00';
    timerEl.classList.add('active');
    waveEl.classList.add('active');
    btn.classList.add('recording');
    btn.textContent = '⏹';
    btn.title = 'Stop recording';
    labelEl.textContent = 'Recording… click to stop';
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = String(Math.floor(recordingSeconds/60)).padStart(2,'0');
      const s = String(recordingSeconds%60).padStart(2,'0');
      timerEl.textContent = `${m}:${s}`;
    }, 1000);
  } catch (e) {
    alert('Microphone access denied. Please allow microphone access and try again.');
  }
}

function audioLoadFile(file) {
  if (!file) return;
  audioBlob = file;
  document.getElementById('audio-file-name').textContent = file.name;
  document.getElementById('audio-record-label').textContent = 'File loaded — click Process to continue';
  document.getElementById('audio-timer').textContent = '00:00';
}

async function processAudio() {
  // If still recording, stop first and wait for the blob to be ready
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    await new Promise(resolve => {
      const orig = mediaRecorder.onstop;
      mediaRecorder.onstop = (e) => { if (orig) orig(e); resolve(); };
      mediaRecorder.stop();
    });
  }
  if (!audioBlob) { alert('Please record audio or upload a file first.'); return; }
  if (!isPro) { showHwAdGated(() => _processAudio()); return; }
  _processAudio();
}
async function _processAudio() {
  const btn = document.getElementById('audio-btn');
  const wrap = document.getElementById('audio-result-wrap');
  const textEl = document.getElementById('audio-result-text');
  const labelEl = document.getElementById('audio-result-label');
  btn.disabled = true; btn.textContent = 'Transcribing…';
  wrap.style.display = 'none';

  try {
    const reader = new FileReader();
    const b64 = await new Promise((res, rej) => {
      reader.onload = e => res(e.target.result.split(',')[1]);
      reader.onerror = rej;
      reader.readAsDataURL(audioBlob);
    });
    const mimeType = audioBlob.type || 'audio/webm';

    // Step 1: transcribe
    const tRes = await fetch('/api/transcribe', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ audio: b64, mimeType })
    });
    const tData = await tRes.json();
    if (!tRes.ok) throw new Error(tData.error || 'Transcription failed');
    const transcript = tData.transcript;

    if (audioCurrentMode === 'transcribe') {
      labelEl.textContent = 'Transcript';
      textEl.textContent = transcript;
      wrap.style.display = '';
      saveToHistory('notes', 'Audio', 'Voice Recording', transcript);
      return;
    }

    if (audioCurrentMode === 'translate') {
      btn.textContent = 'Translating…';
      const sourceLang = document.getElementById('audio-source-lang').value;
      const targetLang = document.getElementById('audio-target-lang').value;
      const trRes = await fetch('/api/translate', {
        method: 'POST', headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ text: transcript, sourceLang, targetLang })
      });
      const trData = await trRes.json();
      if (!trRes.ok) throw new Error(trData.error || 'Translation failed');
      const fromLabel = sourceLang === 'Auto-detect' ? 'Auto' : sourceLang;
      labelEl.textContent = `${fromLabel} → ${targetLang}`;
      textEl.textContent = trData.translation;
      wrap.style.display = '';
      saveToHistory('notes', 'Audio', 'Voice Recording', trData.translation);
      return;
    }

    // Step 2: summarize / notes / quizzes
    btn.textContent = 'Processing…';
    const sRes = await fetch('/api/summarize', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ text: transcript.slice(0,12000), mode: audioCurrentMode })
    });
    const sData = await sRes.json();
    if (!sRes.ok) throw new Error(sData.error || 'Processing failed');
    const labels = { summarize:'AI Summary', notes:'AI Notes', quizzes:'Quiz Questions' };
    labelEl.textContent = labels[audioCurrentMode] || 'Result';
    textEl.textContent = sData.summary;
    wrap.style.display = '';
    saveToHistory(audioCurrentMode, 'Audio', 'Voice Recording', sData.summary);
  } catch(e) {
    textEl.textContent = '⚠ ' + e.message;
    labelEl.textContent = 'Error';
    wrap.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = 'Process →';
  }
}

function copyAudioResult(btnEl) {
  const text = document.getElementById('audio-result-text').textContent;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
    btnEl.classList.add('copied');
    setTimeout(() => { btnEl.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; btnEl.classList.remove('copied'); }, 2000);
  });
}

// ── HOMEWORK AD ─────────────────────────────────────────────────
let _hwAdCallback = null, _hwAdTimer = null;

function showHwAdGated(cb) {
  const { remaining } = getAdConvState();
  if (!isSignedIn && remaining <= 0) {
    const ms = 86400000 - (Date.now() - parseInt(localStorage.getItem('gn-ad-conv-reset') || '0'));
    const hrs = Math.ceil(ms / 3600000);
    document.getElementById('limit-msg').textContent = `You've used your 3 free uses for today. Come back in ~${hrs} hour${hrs !== 1 ? 's' : ''}, or upgrade to Pro for unlimited access.`;
    const m = document.getElementById('limit-modal');
    m.style.display = 'flex';
    return;
  }
  showHwAd(() => { consumeAdConv(); cb(); });
}

function showHwAd(cb) {
  _hwAdCallback = cb;
  const overlay  = document.getElementById('hw-ad-overlay');
  const skipBtn  = document.getElementById('hw-ad-skip-btn');
  const countdown = document.getElementById('hw-ad-countdown');
  overlay.classList.add('active');
  skipBtn.disabled = true;
  let secs = 5;
  countdown.textContent = `⏳ Skip in ${secs}s`;
  _hwAdTimer = setInterval(() => {
    secs--;
    if (secs > 0) {
      countdown.textContent = `⏳ Skip in ${secs}s`;
    } else {
      clearInterval(_hwAdTimer);
      countdown.textContent = '';
      skipBtn.disabled = false;
    }
  }, 1000);
}

function closeHwAd() {
  clearInterval(_hwAdTimer);
  document.getElementById('hw-ad-overlay').classList.remove('active');
  updateUsesBanner();
  if (_hwAdCallback) { const fn = _hwAdCallback; _hwAdCallback = null; fn(); }
}

// ── HOMEWORK SOLVER ─────────────────────────────────────────────
let hwImageB64 = null, hwImageMime = 'image/jpeg', hwMode = 'image';

function setHwTab(mode) {
  hwMode = mode;
  document.getElementById('hw-tab-image').classList.toggle('hw-tab-active', mode === 'image');
  document.getElementById('hw-tab-text').classList.toggle('hw-tab-active', mode === 'text');
  document.getElementById('hw-dropzone').style.display = mode === 'image' ? '' : 'none';
  document.getElementById('hw-preview').style.display = 'none';
  document.getElementById('hw-text-area').style.display = mode === 'text' ? '' : 'none';
  document.getElementById('hw-result').style.display = 'none';
  if (mode === 'image') {
    document.getElementById('hw-btn').disabled = !hwImageB64;
  } else {
    const txt = (document.getElementById('hw-text-input').value || '').trim();
    document.getElementById('hw-btn').disabled = txt.length < 5;
  }
}

function hwLoadImage(file) {
  if (!file) return;
  hwImageMime = file.type || 'image/jpeg';
  const reader = new FileReader();
  reader.onload = e => {
    const dataUrl = e.target.result;
    // Compress if > 3MB
    if (dataUrl.length > 4 * 1024 * 1024) {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let w = img.width, h = img.height;
        const max = 1600;
        if (w > max || h > max) { const r = Math.min(max/w, max/h); w = Math.round(w*r); h = Math.round(h*r); }
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const compressed = canvas.toDataURL('image/jpeg', 0.8);
        hwImageB64 = compressed.split(',')[1];
        hwImageMime = 'image/jpeg';
        showHwPreview(compressed);
      };
      img.src = dataUrl;
    } else {
      hwImageB64 = dataUrl.split(',')[1];
      showHwPreview(dataUrl);
    }
  };
  reader.readAsDataURL(file);
}

function showHwPreview(dataUrl) {
  const preview = document.getElementById('hw-preview');
  const img = document.getElementById('hw-preview-img');
  img.src = dataUrl;
  preview.style.display = '';
  document.getElementById('hw-btn').disabled = false;
  document.getElementById('hw-dropzone').style.borderColor = 'rgba(139,92,246,0.5)';
}

async function solveHomework() {
  if (!isPro) { showHwAdGated(() => _runSolveHomework()); return; }
  _runSolveHomework();
}

async function _runSolveHomework() {
  const btn = document.getElementById('hw-btn');
  const result = document.getElementById('hw-result');
  const subject = document.getElementById('hw-subject').value.trim();

  let body;
  if (hwMode === 'text') {
    const text = (document.getElementById('hw-text-input').value || '').trim();
    if (!text) { alert('Please enter a homework problem.'); return; }
    body = { text, subject };
  } else {
    if (!hwImageB64) { alert('Please upload a homework image first.'); return; }
    body = { image: hwImageB64, mimeType: hwImageMime, subject };
  }

  btn.disabled = true; btn.textContent = '🧠 Solving…';
  result.style.display = 'none';

  try {
    const r = await fetch('/api/homework', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) { const err = new Error(data.error || 'Server error'); err.raw = data.raw; throw err; }
    _lastHwData = data;
    if (data.subject) document.getElementById('hw-subject').value = data.subject;
    result.innerHTML = renderHomeworkResult(data);
    result.style.display = '';
    initDesmosGraphs(result);
    const _hwTitle = (data.subject ? data.subject + ' — ' : '') + (data.problem || 'Homework').slice(0, 60);
    const _hwText = (data.steps || []).map((s,i) => `Step ${i+1}: ${s}`).join('\n') + (data.answer ? '\n\nAnswer: ' + data.answer : '');
    saveToHistory('homework', 'Homework', _hwTitle, _hwText);
    // Render LaTeX with KaTeX — call now or wait for deferred script
    const doKatex = () => {
      if (window.renderMathInElement) {
        renderMathInElement(result, {
          delimiters: [
            {left:'$$',right:'$$',display:true},
            {left:'$',right:'$',display:false}
          ],
          throwOnError: false
        });
      }
    };
    if (window._katexReady) doKatex();
    else setTimeout(doKatex, 1200);
  } catch(e) {
    result.innerHTML = `<div class="checker-summary-box" style="color:#F87171;">⚠ ${e.message}</div>`;
    result.style.display = '';
  } finally {
    btn.disabled = false; btn.textContent = '🧠 Solve Homework →';
  }
}

function renderHomeworkResult(d) {
  const steps = (d.steps || []).map((s, i) => `
    <div class="hw-step">
      <div class="hw-step-left">
        <div class="hw-step-num">${i+1}</div>
        <div class="hw-step-line"></div>
      </div>
      <div class="hw-step-body">
        <div class="hw-step-text">${fmtHw(s)}</div>
      </div>
    </div>`).join('');

  const formula = d.formula ? `<div class="hw-formula-box">📐 ${fmtHw(d.formula)}</div>` : '';
  const tip = d.tip ? `<div class="hw-tip"><span>💡</span><span>${esc2(d.tip)}</span></div>` : '';
  const graph = d.graph ? `<div class="hw-graph-wrap"><div class="hw-graph-label">📈 ${esc2(d.graph)}</div><div class="hw-graph-elt" data-desmos-expr="${esc2(d.graph)}"></div></div>` : '';

  return `
    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:6px;">
      <span class="hw-subject-badge" style="margin-bottom:0;">${esc2(d.subject || 'General')}</span>
      <button onclick="copyHwSolution()" id="hw-copy-btn" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--text);font-size:0.78rem;font-weight:600;cursor:pointer;">
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy
      </button>
    </div>
    ${d.problem ? `<div class="hw-problem-title">${esc2(d.problem)}</div>` : ''}
    ${steps ? `<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;"><div class="checker-section-title" style="margin-bottom:0;">Step-by-step solution</div><button onclick="copyHwSteps()" id="hw-copy-steps-btn" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:var(--surface2);border:1px solid var(--border);border-radius:8px;color:var(--muted);font-size:0.75rem;font-weight:600;cursor:pointer;">📋 Copy steps</button></div><div class="hw-steps">${steps}</div>` : ''}
    ${d.answer ? `<div class="hw-answer-box"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:4px;"><div class="hw-answer-label" style="margin-bottom:0;">Answer</div><button onclick="copyHwAnswer()" id="hw-copy-ans-btn" style="display:inline-flex;align-items:center;gap:5px;padding:5px 12px;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:8px;color:inherit;font-size:0.75rem;font-weight:600;cursor:pointer;opacity:0.8;">📋 Copy</button></div><div class="hw-answer-text">${fmtHw(d.answer)}</div></div>` : ''}
    ${formula}
    ${graph}
    ${tip}`;
}

let _lastHwData = null;

function _hwCopyFlash(btnId, text) {
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

function copyHwSteps() {
  if (!_lastHwData || !_lastHwData.steps) return;
  const lines = (_lastHwData.steps || []).map((s, i) => `${i + 1}. ${s}`);
  _hwCopyFlash('hw-copy-steps-btn', lines.join('\n'));
}

function copyHwAnswer() {
  if (!_lastHwData || !_lastHwData.answer) return;
  _hwCopyFlash('hw-copy-ans-btn', _lastHwData.answer);
}

function copyHwSolution() {
  if (!_lastHwData) return;
  const d = _lastHwData;
  const lines = [];
  if (d.subject) lines.push(`[${d.subject}]`);
  if (d.problem) lines.push(d.problem, '');
  if (d.steps && d.steps.length) {
    lines.push('Step-by-step solution:');
    d.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push('');
  }
  if (d.answer) lines.push(`Answer: ${d.answer}`);
  if (d.formula) lines.push(`Formula: ${d.formula}`);
  if (d.tip) lines.push(`Tip: ${d.tip}`);
  navigator.clipboard.writeText(lines.join('\n')).then(() => {
    const btn = document.getElementById('hw-copy-btn');
    if (!btn) return;
    btn.textContent = '✓ Copied';
    setTimeout(() => {
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg> Copy';
    }, 2000);
  });
}

function fmtHw(s) {
  return String(s||'')
    .replace(/^#+\s*/gm, '')                          // strip ### headers
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') // HTML escape
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>'); // bold (safe after escaping)
}

function esc2(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── AI CHECKER ──────────────────────────────────────────────────
function initCheckerPanel() {
  const locked = document.getElementById('checker-locked');
  const inputArea = document.getElementById('checker-input-area');
  if (!locked || !inputArea) return;
  locked.style.display = 'none';
  inputArea.style.display = '';
}

let checkerMode = 'aidetect';
let checkerText = '';

function setCheckerMode(mode, el) {
  checkerMode = mode;
  document.querySelectorAll('.checker-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}

async function checkerLoadFile(file) {
  if (!file) return;
  document.getElementById('checker-file-name').textContent = file.name;
  const ext = file.name.split('.').pop().toLowerCase();
  const textarea = document.getElementById('checker-text');
  if (ext === 'txt') {
    checkerText = await file.text();
    textarea.value = checkerText;
    document.getElementById('checker-char-num').textContent = checkerText.length;
    return;
  }
  if (ext === 'pdf') {
    try {
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let out = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const pg = await pdf.getPage(i);
        const tc = await pg.getTextContent();
        out += tc.items.map(s => s.str).join(' ') + '\n';
      }
      checkerText = out.trim();
      textarea.value = checkerText;
      document.getElementById('checker-char-num').textContent = checkerText.length;
    } catch { alert('Could not read PDF.'); }
    return;
  }
  if (ext === 'docx') {
    try {
      const buf = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const r = await fetch('/api/extract', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ content: b64, filename: file.name }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error);
      checkerText = d.text || '';
      textarea.value = checkerText;
      document.getElementById('checker-char-num').textContent = checkerText.length;
    } catch (e) { alert('Could not read DOCX: ' + e.message); }
  }
}

function checkerScoreColor(score, invert) {
  // invert=true: low score = good (e.g. plagiarism risk)
  const v = invert ? 100 - score : score;
  if (v >= 80) return '#34D399';
  if (v >= 60) return '#FBBF24';
  return '#F87171';
}

function renderCheckerRing(score, label, sub, invert) {
  const r = 38, circ = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score));
  const dash = (pct / 100) * circ;
  const color = checkerScoreColor(score, invert);
  return `<div class="checker-score-ring">
    <div class="checker-ring-wrap">
      <svg width="90" height="90" viewBox="0 0 90 90">
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="8"/>
        <circle cx="45" cy="45" r="${r}" fill="none" stroke="${color}" stroke-width="8"
          stroke-dasharray="${dash.toFixed(1)} ${circ.toFixed(1)}" stroke-linecap="round"/>
      </svg>
      <div class="checker-ring-num" style="color:${color}">${pct}%</div>
    </div>
    <div class="checker-ring-info">
      <div class="checker-ring-label" style="color:${color}">${label}</div>
      <div class="checker-ring-sub">${sub}</div>
    </div>
  </div>`;
}

function renderAiDetect(d) {
  const iconMap = type => type.toLowerCase().includes('ai') ? '🤖' : '✍️';
  const signals = (d.signals || []).map(s =>
    `<div class="checker-signal"><span class="checker-signal-icon">${iconMap(s.type)}</span><div><strong style="font-size:0.78rem;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;">${s.type}</strong><div class="checker-signal-text">${s.detail}</div></div></div>`
  ).join('');
  return renderCheckerRing(d.score || 0, d.label || '', `Confidence: ${d.confidence || 'Medium'}`, false)
    + `<div class="checker-section-title">Signals detected</div>${signals}`
    + `<div class="checker-summary-box">${d.summary || ''}</div>`;
}

function renderGrammar(d) {
  const sevClass = { Error: 'badge-error', Warning: 'badge-warning', Suggestion: 'badge-suggestion' };
  const typeClass = t => ({ Grammar:'badge-grammar', Spelling:'badge-spelling', Style:'badge-style', Clarity:'badge-clarity' })[t] || 'badge-suggestion';
  const issues = (d.issues || []).map(i => `
    <div class="checker-issue">
      <div class="checker-issue-header">
        <span class="checker-badge ${sevClass[i.severity] || 'badge-suggestion'}">${i.severity}</span>
        <span class="checker-badge ${typeClass(i.type)}">${i.type}</span>
      </div>
      <div class="checker-issue-original">"${i.original}"</div>
      <div class="checker-issue-fix">→ ${i.suggestion}</div>
      ${i.explanation ? `<div class="checker-issue-why">${i.explanation}</div>` : ''}
    </div>`).join('');
  const strengths = (d.strengths || []).map(s => `<div class="checker-strength">✓ ${s}</div>`).join('');
  const gradeColor = { A:'#34D399', B:'#34D399', C:'#FBBF24', D:'#F87171', F:'#F87171' }[d.grade] || 'var(--purple2)';
  return renderCheckerRing(d.score || 0, `Grade ${d.grade || '?'}`, 'Writing quality score', false)
    + (strengths ? `<div class="checker-section-title">Strengths</div><div class="checker-strengths">${strengths}</div>` : '')
    + (issues ? `<div class="checker-section-title">Issues found (${d.issues.length})</div>${issues}` : '<div class="checker-summary-box">No significant issues found. Great writing!</div>')
    + `<div class="checker-summary-box">${d.summary || ''}</div>`;
}

function renderPlagiarism(d) {
  const riskColors = { 'Very Low':'#34D399', Low:'#34D399', Medium:'#FBBF24', High:'#F87171', 'Very High':'#F87171' };
  const color = riskColors[d.risk] || '#FBBF24';
  const flags = (d.flags || []).map(f => {
    const fc = riskColors[f.risk] || '#FBBF24';
    return `<div class="checker-issue">
      <div class="checker-issue-header"><span class="checker-badge" style="background:rgba(255,255,255,0.05);color:${fc};">${f.risk} Risk</span></div>
      <div class="checker-issue-original">"${f.text}"</div>
      <div class="checker-issue-why">${f.reason}</div>
    </div>`;
  }).join('');
  return renderCheckerRing(d.score || 0, `${d.risk || 'Unknown'} Risk`, `Originality: ${d.originalityScore || '?'}%`, true)
    + (flags ? `<div class="checker-section-title">Flagged passages (${d.flags.length})</div>${flags}` : '<div class="checker-summary-box">No suspicious passages detected.</div>')
    + `<div class="checker-summary-box">${d.summary || ''}</div>`;
}

function renderFactCheck(d) {
  const verdictClass = {
    'Accurate':'verdict-accurate','Likely Accurate':'verdict-likely',
    'Uncertain':'verdict-uncertain','Needs Verification':'verdict-verify',
    'Questionable':'verdict-questionable','Inaccurate':'verdict-inaccurate'
  };
  const verdictIcon = {
    'Accurate':'✅','Likely Accurate':'✅','Uncertain':'⚠️',
    'Needs Verification':'⚠️','Questionable':'❌','Inaccurate':'❌'
  };
  const relColor = { High:'#34D399', Medium:'#FBBF24', Low:'#F87171', 'Very Low':'#F87171' };
  const color = relColor[d.overallReliability] || '#FBBF24';
  const claims = (d.claims || []).map(c => `
    <div class="checker-claim">
      <div class="checker-claim-text">"${c.claim}"</div>
      <div class="checker-claim-verdict ${verdictClass[c.verdict] || 'verdict-uncertain'}">
        ${verdictIcon[c.verdict] || '⚠️'} ${c.verdict} <span style="font-weight:400;color:var(--muted);font-size:0.74rem;">(${c.confidence} confidence)</span>
      </div>
      ${c.explanation ? `<div class="checker-issue-why" style="margin-top:4px;">${c.explanation}</div>` : ''}
    </div>`).join('');

  const claimsFound = d.claimsFound ?? (d.claims || []).length;
  return `<div class="checker-score-ring" style="margin-bottom:16px;">
    <div style="font-size:2rem;">📋</div>
    <div class="checker-ring-info">
      <div class="checker-ring-label" style="color:${color}">${d.overallReliability || '?'} Reliability</div>
      <div class="checker-ring-sub">${claimsFound} claim${claimsFound !== 1 ? 's' : ''} analyzed</div>
    </div>
  </div>`
    + (claims ? `<div class="checker-section-title">Claims assessed</div>${claims}` : '')
    + `<div class="checker-summary-box">${d.summary || ''}</div>`;
}

async function runChecker() {
  const textarea = document.getElementById('checker-text');
  const text = textarea.value.trim();
  if (!text) { alert('Please paste or upload text to analyze.'); return; }
  if (!isPro) { showHwAdGated(() => runChecker()); return; }

  const btn = document.getElementById('checker-btn');
  const result = document.getElementById('checker-result');
  btn.disabled = true;
  btn.textContent = 'Analyzing…';
  result.style.display = 'none';

  try {
    const r = await fetch('/api/checker', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: checkerMode })
    });
    const data = await r.json();
    if (!r.ok) { const err = new Error(data.error || 'Server error'); err.raw = data.raw; throw err; }

    const renderers = { aidetect: renderAiDetect, grammar: renderGrammar, plagiarism: renderPlagiarism, factcheck: renderFactCheck };
    result.innerHTML = (renderers[checkerMode] || (() => '<p>No result.</p>'))(data);
    result.style.display = 'block';
    const _checkerLabels = {aidetect:'AI Detection',grammar:'Grammar Check',plagiarism:'Plagiarism Check',factcheck:'Fact Check'};
    const _checkerSnippet = document.getElementById('checker-text').value.slice(0,80) + '…';
    saveToHistory('checker', _checkerLabels[checkerMode] || 'Checker', _checkerSnippet, JSON.stringify(data));
  } catch (e) {
    const rawSnippet = e.raw ? `<div style="font-size:0.72rem;color:var(--muted);margin-top:8px;word-break:break-all;">${e.raw}</div>` : '';
    result.innerHTML = `<div class="checker-summary-box" style="color:#F87171;">⚠ ${e.message}${rawSnippet}</div>`;
    result.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Analyze →';
  }
}

// ── WRITING TOOL ─────────────────────────────────────────────────
let writingMode = 'improve';
const WRITING_MODE_LABELS = {
  improve: 'Improved Writing', grammar: 'Grammar Fixed',
  tone: 'Tone Adjusted', paraphrase: 'Paraphrased',
  shorten: 'Shortened', expand: 'Expanded'
};

function setWritingMode(mode, el) {
  writingMode = mode;
  document.querySelectorAll('[id^="wtab-"]').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  document.getElementById('writing-tone-row').style.display = mode === 'tone' ? '' : 'none';
  const isHw = mode === 'homework';
  document.getElementById('writing-hw-input').style.display = isHw ? '' : 'none';
  document.getElementById('writing-hw-result').style.display = 'none';
  document.getElementById('writing-input-area').style.display = isHw ? 'none' : '';
  document.getElementById('writing-result-area').style.display = 'none';
  const btn = document.getElementById('writing-btn');
  if (btn) {
    if (isHw) {
      btn.textContent = isPro ? '🧠 Solve Homework →' : '▶ Solve with Ads →';
      btn.disabled = true;
      whwImageB64 = null; whwImageMime = null; whwMode = 'image';
      document.getElementById('whw-preview').style.display = 'none';
      document.getElementById('whw-dropzone').style.display = '';
      document.getElementById('whw-text-area').style.display = 'none';
      document.getElementById('whw-tab-image').classList.add('hw-tab-active');
      document.getElementById('whw-tab-text').classList.remove('hw-tab-active');
      document.getElementById('whw-subject').value = '';
    } else {
      btn.textContent = isPro ? '✍️ Enhance Writing →' : '▶ Watch Ad & Enhance →';
      const ta = document.getElementById('writing-text');
      btn.disabled = !ta || ta.value.trim().length < 10;
    }
  }
  setTimeout(resizeCarousel, 50);
}

function writingOnInput() {
  const ta = document.getElementById('writing-text');
  const val = ta.value;
  document.getElementById('writing-char-num').textContent = val.length;
  const words = val.trim() ? val.trim().split(/\s+/).length : 0;
  document.getElementById('writing-word-count').textContent = words;
  document.getElementById('writing-btn').disabled = val.trim().length < 10;
}

async function writingLoadFile(file) {
  if (!file) return;
  document.getElementById('writing-file-name').textContent = file.name;
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'txt') {
    document.getElementById('writing-text').value = await file.text();
    writingOnInput();
    return;
  }
  if (ext === 'pdf') {
    try {
      const arrayBuf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: arrayBuf }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(s => s.str).join(' ') + '\n';
      }
      document.getElementById('writing-text').value = text.trim();
      writingOnInput();
    } catch (e) { alert('Could not read PDF: ' + e.message); }
    return;
  }
  if (ext === 'docx') {
    try {
      const ab = await file.arrayBuffer();
      const b64 = btoa(String.fromCharCode(...new Uint8Array(ab)));
      const r = await fetch('/api/extract', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fileData: b64, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }) });
      const d = await r.json();
      document.getElementById('writing-text').value = d.text || '';
      writingOnInput();
    } catch (e) { alert('Could not read DOCX: ' + e.message); }
  }
}

async function runWritingTool() {
  if (writingMode === 'homework') {
    if (!isPro) { showHwAdGated(() => _runWritingHW()); return; }
    _runWritingHW(); return;
  }
  if (!isPro) { showHwAdGated(() => _runWritingTool()); return; }
  _runWritingTool();
}

async function _runWritingTool() {
  const text = document.getElementById('writing-text').value.trim();
  if (!text || text.length < 10) return;
  const btn = document.getElementById('writing-btn');
  btn.disabled = true;
  btn.textContent = '⏳ Enhancing…';

  try {
    const tone = document.getElementById('writing-tone-select').value;
    const r = await fetch('/api/writing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, mode: writingMode, tone })
    });
    const data = await r.json();
    if (!r.ok || !data.result) throw new Error(data.error || 'No result returned');

    const originalWords = text.trim().split(/\s+/).length;
    const resultWords   = data.result.trim().split(/\s+/).length;
    const diff = resultWords - originalWords;
    const diffStr = diff === 0 ? '' : diff > 0 ? `+${diff} words` : `${diff} words`;

    document.getElementById('writing-result-label').textContent = WRITING_MODE_LABELS[writingMode] || 'Result';
    document.getElementById('writing-stats').textContent = diffStr ? `${originalWords} → ${resultWords} words (${diffStr})` : `${resultWords} words`;
    document.getElementById('writing-output').textContent = data.result;
    document.getElementById('writing-input-area').style.display = 'none';
    document.getElementById('writing-result-area').style.display = '';
    saveToHistory('writing', WRITING_MODE_LABELS[writingMode] || 'Writing', (WRITING_MODE_LABELS[writingMode] || 'Writing') + ' · ' + new Date().toLocaleDateString(), data.result);
    setTimeout(resizeCarousel, 80);
  } catch (e) {
    alert('Error: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = isPro ? '✍️ Enhance Writing →' : '▶ Watch Ad & Enhance →';
  }
}

async function _runWritingHW() {
  const hwRes = document.getElementById('writing-hw-result');
  let hwBody;
  if (whwMode === 'text') {
    const txt = (document.getElementById('whw-text-input').value || '').trim();
    if (!txt) { alert('Please enter a homework problem.'); return; }
    hwBody = { text: txt };
  } else {
    if (!whwImageB64) { alert('Please upload a homework photo first.'); return; }
    hwBody = { image: whwImageB64, mimeType: whwImageMime };
  }
  const btn = document.getElementById('writing-btn');
  btn.disabled = true; btn.textContent = '⏳ Solving…';
  hwRes.style.display = 'none'; hwRes.innerHTML = '';
  try {
    const r = await fetch('/api/homework', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(hwBody) });
    const d = await r.json();
    if (!r.ok || d.error) throw new Error(d.error || 'Solver error');
    const subj = document.getElementById('whw-subject');
    if (subj && d.subject) subj.value = d.subject;
    hwRes.innerHTML = renderHomeworkResult(d);
    hwRes.style.display = '';
    initDesmosGraphs(hwRes);
    const doKatex = () => { if (window.renderMathInElement) try { renderMathInElement(hwRes, {delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false}); } catch {} };
    if (window._katexReady) doKatex(); else setTimeout(doKatex, 700);
    const hwTitle = (d.subject ? d.subject + ' — ' : '') + (d.problem || 'Homework').slice(0, 60);
    const hwText = (d.steps||[]).map((s,i) => 'Step '+(i+1)+': '+s).join('\n') + (d.answer ? '\n\nAnswer: '+d.answer : '');
    saveToHistory('homework', 'Writing', hwTitle, hwText);
    setTimeout(resizeCarousel, 80);
  } catch(e) { alert('Error: ' + e.message); }
  finally { btn.disabled = false; btn.textContent = isPro ? '🧠 Solve Homework →' : '▶ Solve with Ads →'; }
}

function writingBack() {
  document.getElementById('writing-result-area').style.display = 'none';
  document.getElementById('writing-input-area').style.display = '';
  setTimeout(resizeCarousel, 50);
}

function copyWritingResult() {
  const text = document.getElementById('writing-output').textContent;
  navigator.clipboard.writeText(text).then(() => {
    const btn = event.target;
    const orig = btn.textContent;
    btn.textContent = '✓ Copied';
    setTimeout(() => btn.textContent = orig, 1500);
  });
}
