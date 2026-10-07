/* NoteCaptain — Floating Recorder Widget */
(function () {
  'use strict';
  const SRApi = window.SpeechRecognition || window.webkitSpeechRecognition;
  let going = false, secs = 0, timer = null;
  let stream = null, mr = null, mrChunks = [], mime = '';
  let recognition = null, liveText = '';
  let audioCtx = null, analyser = null, raf = null;
  let _diarize = false, _spkNames = '';
  let _lastBlob = null;
  let _sessionText = '';
  let _periodicId = null;

  // Attaches the signed-in user's Firebase ID token to same-origin /api/* calls.
  // Reuses a page-level _authFetch if the host page already defines one (most do);
  // otherwise falls back to checking firebase.auth() directly.
  async function _recAuthFetch(url, opts) {
    if (typeof window._authFetch === 'function') return window._authFetch(url, opts);
    opts = opts || {};
    const user = (typeof firebase !== 'undefined' && firebase.auth) ? firebase.auth().currentUser : null;
    if (user) {
      const token = await user.getIdToken();
      opts.headers = Object.assign({}, opts.headers, { Authorization: 'Bearer ' + token });
    }
    const resp = await fetch(url, opts);
    return window.gnAfterFetch ? window.gnAfterFetch(resp, url, opts, _recAuthFetch) : resp;
  }

  // ── Polishing a long lecture in pieces (server side: api/transcribe.js) ──
  // The transcript is cut at sentence ends into pieces of about TIDY_PIECE characters
  // (~8 minutes of speech) and tidied one at a time; each request also sends the end of the
  // previous edited piece so speaker labels stay the same. A piece the server couldn't tidy
  // stays exactly as spoken, so no words are ever lost. When the free AI allowance is busy
  // the piece is retried a few times; when the hourly/monthly limit is reached the rest
  // simply stays as spoken.
  const TIDY_PIECE = 7000;
  const TIDY_RETRY_WAIT_MS = 25000, TIDY_ATTEMPTS = 4;
  let _tidyRun = 0;

  function splitForTidy(text) {
    const pieces = [];
    let rest = String(text).trim();
    while (rest.length > TIDY_PIECE) {
      const win = rest.slice(0, TIDY_PIECE);
      let cut = -1;
      const re = /[.!?]["')\]]?\s+/g;
      let m;
      while ((m = re.exec(win))) cut = m.index + m[0].length;  // end of the last full sentence
      if (cut < TIDY_PIECE * 0.5) { const sp = win.lastIndexOf(' '); cut = sp > TIDY_PIECE * 0.5 ? sp + 1 : TIDY_PIECE; }
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) pieces.push(rest);
    return pieces;
  }

  // onProgress(textSoFar, done, part, parts); cancelled() -> true to stop early.
  async function tidyTranscript(text, onProgress, cancelled) {
    const pieces = splitForTidy(text);
    const out = pieces.slice(), tidied = pieces.map(() => false);
    const joined = () => out.reduce((acc, p, i) => i === 0 ? p : acc + ((tidied[i - 1] || tidied[i]) ? '\n' : ' ') + p, '');
    const wait = ms => new Promise(r => setTimeout(r, ms));
    let context = '', stop = false;
    for (let i = 0; i < pieces.length && !stop; i++) {
      if (cancelled()) return;
      onProgress(joined(), false, i + 1, pieces.length);
      for (let attempt = 1; attempt <= TIDY_ATTEMPTS; attempt++) {
        let r = null, d = null;
        try {
          r = await _recAuthFetch('/api/transcribe', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: pieces[i], context, diarize: _diarize, spkNames: _spkNames })
          });
          d = await r.json().catch(() => null);
        } catch { r = null; }
        if (cancelled()) return;
        if (r && r.ok && d && d.tidied && d.transcript && d.transcript.trim()) {
          out[i] = d.transcript.trim(); tidied[i] = true;
          context = out[i].slice(-1200);
          break;
        }
        // Signed out, or hourly / monthly limit reached: waiting won't help.
        if (r && (r.status === 401 || r.status === 429)) { stop = true; break; }
        // Answered but not usable (AI cut it short, etc.): keep this piece as spoken.
        if (r && r.ok && d && !d.busy) break;
        // AI busy, network error, or allowance check unavailable: wait and try again.
        if (attempt < TIDY_ATTEMPTS) { await wait(TIDY_RETRY_WAIT_MS); if (cancelled()) return; }
      }
    }
    onProgress(joined(), true, pieces.length, pieces.length);
  }
  window.frTidyTranscript = tidyTranscript; // used by tests

  function inject() {
    if (document.getElementById('fr-widget')) return;
    const el = document.createElement('div');
    el.id = 'fr-widget';
    el.innerHTML = `
<style>
#fr-widget *{box-sizing:border-box;font-family:'Inter',system-ui,sans-serif;}
#fr-panels{position:fixed;bottom:22px;right:22px;z-index:9999;}
#fr-ready{display:none;background:#18212A;border:1.5px solid rgba(92,196,208,0.7);border-radius:16px;padding:16px 18px;width:260px;box-shadow:0 0 0 1px rgba(92,196,208,0.15),0 12px 40px rgba(0,0,0,0.7);overflow:hidden;}
#fr-ready.on{display:block;}
#fr-ready-title{font-size:0.82rem;font-weight:700;color:#7FD4DD;margin-bottom:14px;cursor:grab;user-select:none;}
#fr-ready-title:active{cursor:grabbing;}
#fr-spk-toggle{display:flex;align-items:center;gap:8px;margin-bottom:10px;cursor:pointer;}
#fr-spk-toggle input{accent-color:#5CC4D0;width:14px;height:14px;cursor:pointer;flex-shrink:0;}
#fr-spk-label{font-size:0.78rem;color:#C0C0E0;font-weight:500;}
#fr-names{margin-bottom:12px;display:none;flex-direction:column;gap:6px;}
#fr-names.on{display:flex;}
#fr-names-lbl{font-size:0.7rem;color:#8888BB;margin-bottom:2px;}
.fr-spk-row{display:flex;align-items:center;gap:6px;min-width:0;}
.fr-spk-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.fr-spk-label{font-size:0.72rem;color:#9090C0;width:62px;flex-shrink:0;font-weight:600;white-space:nowrap;}
.fr-spk-input{flex:1;min-width:0;background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.15);border-radius:7px;padding:5px 8px;font-size:0.76rem;color:#E8E8FF;font-family:inherit;outline:none;width:100%;}
.fr-spk-input:focus{border-color:rgba(92,196,208,0.6);}
.fr-spk-input::placeholder{color:#55557A;}
#fr-start-btn{width:100%;background:#F87171;color:#fff;border:none;border-radius:10px;padding:9px;font-size:0.82rem;font-weight:700;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center;gap:7px;margin-top:4px;}
#fr-start-btn:hover{background:#ef4444;}
#fr-start-btn svg{width:14px;height:14px;stroke:#fff;flex-shrink:0;}
#fr-rec{display:none;background:#18212A;border:1.5px solid rgba(239,68,68,0.6);border-radius:16px;padding:12px 14px;width:290px;box-shadow:0 0 0 1px rgba(239,68,68,0.12),0 12px 40px rgba(0,0,0,0.7);}
#fr-rec.on{display:block;}
#fr-rec-bar{display:flex;align-items:center;gap:8px;margin-bottom:9px;}
#fr-dot{width:8px;height:8px;border-radius:50%;background:#F87171;flex-shrink:0;animation:frpulse 1.2s ease-in-out infinite;}
@keyframes frpulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:0.35;transform:scale(0.75)}}
#fr-time{font-size:0.82rem;font-weight:700;color:#E0E0F0;font-variant-numeric:tabular-nums;min-width:34px;}
#fr-wave{height:22px;width:56px;border-radius:4px;flex-shrink:0;}
#fr-stop-btn{margin-left:auto;background:rgba(239,68,68,0.14);border:1px solid rgba(239,68,68,0.4);border-radius:20px;color:#F87171;font-size:0.72rem;font-weight:700;padding:4px 12px;cursor:pointer;white-space:nowrap;font-family:inherit;}
#fr-stop-btn:hover{background:rgba(239,68,68,0.28);}
#fr-live-box{background:rgba(0,0,0,0.3);border-radius:10px;padding:8px 10px;min-height:58px;max-height:130px;overflow-y:auto;scroll-behavior:smooth;}
#fr-live-placeholder{font-size:0.72rem;color:#44445A;font-style:italic;}
#fr-live-final{font-size:0.74rem;color:#C8C8E8;line-height:1.65;white-space:pre-wrap;word-break:break-word;}
#fr-live-interim{font-size:0.74rem;color:#66668A;line-height:1.65;font-style:italic;word-break:break-word;}
#fr-proc{display:none;align-items:center;gap:10px;background:#1A232C;border:1.5px solid rgba(92,196,208,0.6);border-radius:50px;padding:9px 18px;box-shadow:0 0 0 1px rgba(92,196,208,0.1),0 8px 32px rgba(0,0,0,0.6);}
#fr-proc.on{display:flex;}
#fr-spin{width:14px;height:14px;border:2px solid rgba(92,196,208,0.18);border-top-color:#7FD4DD;border-radius:50%;animation:frspin 0.7s linear infinite;flex-shrink:0;}
@keyframes frspin{to{transform:rotate(360deg)}}
#fr-proc span{font-size:0.78rem;color:#8888AA;}
#fr-done{display:none;background:#18212A;border:1.5px solid rgba(92,196,208,0.7);border-radius:16px;padding:16px 18px;width:320px;min-width:220px;min-height:180px;max-width:96vw;max-height:92vh;resize:both;overflow:auto;box-shadow:0 0 0 1px rgba(92,196,208,0.15),0 12px 40px rgba(0,0,0,0.7);}
#fr-done.on{display:flex;flex-direction:column;}
#fr-done-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;gap:6px;flex-shrink:0;}
#fr-done-title{font-size:0.82rem;font-weight:700;color:#7FD4DD;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#fr-hd-right{display:flex;align-items:center;gap:5px;flex-shrink:0;}
#fr-sz-row{display:flex;gap:2px;}
.fr-sz{background:none;border:1px solid rgba(255,255,255,0.1);border-radius:5px;color:#555577;font-size:0.62rem;font-weight:700;cursor:pointer;padding:2px 6px;font-family:inherit;line-height:1.4;transition:color 0.12s,border-color 0.12s;}
.fr-sz:hover,.fr-sz.on{color:#7FD4DD;border-color:rgba(92,196,208,0.55);}
#fr-x-btn{background:none;border:none;color:#555577;cursor:pointer;font-size:1rem;padding:0;line-height:1;}
#fr-preview{font-size:0.74rem;color:#C0C0E0;line-height:1.65;flex:1;min-height:60px;overflow-y:auto;margin-bottom:10px;white-space:pre-wrap;border:1px solid rgba(92,196,208,0.3);border-radius:8px;padding:8px 10px;background:rgba(0,0,0,0.25);resize:none;width:100%;font-family:'Inter',system-ui,sans-serif;outline:none;display:block;}
#fr-preview:focus{border-color:rgba(92,196,208,0.6);}
#fr-btns{display:flex;gap:8px;flex-wrap:wrap;}
#fr-open-btn{flex:1;background:#5CC4D0;color:#0B0F14;border:none;border-radius:9px;padding:8px 10px;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit;}
#fr-open-btn:hover{background:#49B3BF;}
#fr-mp3-btn{background:rgba(79,195,247,0.12);border:1px solid rgba(79,195,247,0.35);border-radius:9px;padding:8px 11px;color:#4FC3F7;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit;white-space:nowrap;}
#fr-mp3-btn:hover{background:rgba(79,195,247,0.22);}
#fr-discard-btn{width:100%;background:none;border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:7px 12px;color:#555577;font-size:0.75rem;cursor:pointer;font-family:inherit;margin-top:2px;}
#fr-discard-btn:hover{color:#A0A0C0;}
#fr-cont-btn{width:100%;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);border-radius:9px;padding:8px 10px;color:#F87171;font-size:0.78rem;font-weight:700;cursor:pointer;font-family:inherit;margin-top:4px;display:flex;align-items:center;justify-content:center;gap:5px;}
#fr-cont-btn:hover{background:rgba(239,68,68,0.22);}
#fr-polish-status{font-size:0.68rem;color:#6655AA;margin-bottom:8px;display:none;}
</style>
<div id="fr-panels">
<div id="fr-ready">
  <div id="fr-ready-title">🎙️ Record Meeting/Lecture</div>
  <label id="fr-spk-toggle">
    <input type="checkbox" id="fr-spk-check" onchange="frToggleNames(this.checked)">
    <span id="fr-spk-label">Identify Speakers</span>
  </label>
  <div id="fr-names">
    <div id="fr-names-lbl">Name each speaker (optional)</div>
    <div class="fr-spk-row"><div class="fr-spk-dot" style="background:#7FD4DD"></div><span class="fr-spk-label">Speaker 1</span><input class="fr-spk-input" id="fr-spk-1" type="text" placeholder="e.g. John"></div>
    <div class="fr-spk-row"><div class="fr-spk-dot" style="background:#4FC3F7"></div><span class="fr-spk-label">Speaker 2</span><input class="fr-spk-input" id="fr-spk-2" type="text" placeholder="e.g. Sarah"></div>
    <div class="fr-spk-row"><div class="fr-spk-dot" style="background:#34D399"></div><span class="fr-spk-label">Speaker 3</span><input class="fr-spk-input" id="fr-spk-3" type="text" placeholder="e.g. Mike"></div>
    <div class="fr-spk-row"><div class="fr-spk-dot" style="background:#F5C842"></div><span class="fr-spk-label">Speaker 4</span><input class="fr-spk-input" id="fr-spk-4" type="text" placeholder="e.g. Lisa"></div>
  </div>
  <button id="fr-start-btn" onclick="frStartFromReady()">
    <svg viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 1 3 3v8a3 3 0 0 1-6 0V4a3 3 0 0 1 3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
    Start Recording
  </button>
</div>
<div id="fr-rec">
  <div id="fr-rec-bar">
    <div id="fr-dot"></div>
    <span id="fr-time">0:00</span>
    <canvas id="fr-wave" width="56" height="22"></canvas>
    <button id="fr-stop-btn" onclick="frStop()">&#9632; Stop</button>
  </div>
  <div id="fr-live-box">
    <div id="fr-live-placeholder">Listening&#8230; speak now</div>
    <div id="fr-live-final"></div>
    <div id="fr-live-interim"></div>
  </div>
</div>
<div id="fr-proc">
  <div id="fr-spin"></div>
  <span id="fr-proc-lbl">Polishing with AI&#8230;</span>
</div>
<div id="fr-done">
  <div id="fr-done-hd">
    <span id="fr-done-title">&#127897;&#65039; Recording complete</span>
    <div id="fr-hd-right">
      <div id="fr-sz-row">
        <button class="fr-sz on" data-sz="md" onclick="frSetSize('md')">M</button>
        <button class="fr-sz" data-sz="lg" onclick="frSetSize('lg')">L</button>
        <button class="fr-sz" data-sz="fs" onclick="frSetSize('fs')">&#x26F6;</button>
      </div>
      <button id="fr-x-btn" onclick="frDismiss()">&#10005;</button>
    </div>
  </div>
  <div id="fr-polish-status">&#10024; Polishing grammar &amp; labeling speakers&#8230;</div>
  <textarea id="fr-preview" spellcheck="false"></textarea>
  <div id="fr-btns">
    <button id="fr-open-btn" onclick="frOpenNotepad()">&#128221; Send to Notepad &#8594;</button>
    <button id="fr-mp3-btn" onclick="frDownloadMp3()">&#11015; MP3</button>
  </div>
  <button id="fr-cont-btn" onclick="frContinueRecording()">&#128308; Keep Recording</button>
  <button id="fr-discard-btn" onclick="frDismiss()">Discard</button>
</div>
</div>`;
    document.body.appendChild(el);
    initDrag();
  }

  function initDrag() {
    const panels = document.getElementById('fr-panels');
    if (!panels || panels._dragInit) return;
    panels._dragInit = true;
    let dragging = false, ox = 0, oy = 0;
    function toTopLeft() {
      if (panels.style.top) return;
      const r = panels.getBoundingClientRect();
      panels.style.top = r.top + 'px';
      panels.style.left = r.left + 'px';
      panels.style.bottom = 'auto';
      panels.style.right = 'auto';
    }
    panels.addEventListener('mousedown', e => {
      if (e.target.closest('button,input,label,a,textarea')) return;
      toTopLeft();
      dragging = true;
      ox = e.clientX - panels.getBoundingClientRect().left;
      oy = e.clientY - panels.getBoundingClientRect().top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!dragging) return;
      panels.style.left = (e.clientX - ox) + 'px';
      panels.style.top  = (e.clientY - oy) + 'px';
    });
    document.addEventListener('mouseup', () => { dragging = false; });
  }

  function $(id) { return document.getElementById(id); }

  function showState(s) {
    ['fr-ready','fr-rec','fr-proc','fr-done'].forEach(id => {
      const el = $(id); if (el) el.className = id === s ? 'on' : '';
    });
  }

  function hideAll() {
    ['fr-ready','fr-rec','fr-proc','fr-done'].forEach(id => { const el=$(id); if(el) el.className=''; });
  }

  function updateLiveDisplay(interim) {
    const placeholder = $('fr-live-placeholder');
    const finalEl     = $('fr-live-final');
    const interimEl   = $('fr-live-interim');
    if (!finalEl) return;
    const hasText = liveText.trim().length > 0 || (interim || '').trim().length > 0;
    if (placeholder) placeholder.style.display = hasText ? 'none' : '';
    finalEl.textContent = liveText;
    if (interimEl) interimEl.textContent = interim || '';
    const lb = $('fr-live-box');
    if (lb) lb.scrollTop = lb.scrollHeight;
  }

  function toB64(blob) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => { try { res(r.result.split(',')[1]); } catch(e) { rej(e); } };
      r.onerror = () => rej(new Error('FileReader error'));
      r.readAsDataURL(blob);
    });
  }

  function withTimeout(p, ms) {
    return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
  }

  function frToggleNames(on) {
    const el = $('fr-names'); if (el) el.className = on ? 'on' : '';
  }

  async function frStart() {
    inject();
    showState('fr-ready');
  }

  async function frStartFromReady() {
    _tidyRun++; // a new recording stops polishing the previous one (its text is already saved)
    _diarize = !!($('fr-spk-check') && $('fr-spk-check').checked);
    _spkNames = [1,2,3,4].map(i => $('fr-spk-'+i) ? $('fr-spk-'+i).value.trim() : '').filter(Boolean).join(',');
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { alert('Microphone access denied. Please allow microphone access and try again.'); return; }

    mime = ['audio/webm;codecs=opus','audio/webm','audio/ogg;codecs=opus','audio/ogg','audio/mp4;codecs=mp4a.40.2','audio/mp4'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    going = true; liveText = ''; mrChunks = []; secs = 0; _lastBlob = null;
    if (_periodicId) { clearInterval(_periodicId); _periodicId = null; }

    const placeholder = $('fr-live-placeholder');
    const finalEl     = $('fr-live-final');
    const interimEl   = $('fr-live-interim');
    if (placeholder) placeholder.style.display = '';
    if (finalEl)     finalEl.textContent = '';
    if (interimEl)   interimEl.textContent = '';

    showState('fr-rec');

    timer = setInterval(() => {
      secs++;
      const m = Math.floor(secs/60), s = secs % 60;
      const el = $('fr-time'); if (el) el.textContent = m+':'+String(s).padStart(2,'0');
    }, 1000);

    try {
      audioCtx = new (window.AudioContext||window.webkitAudioContext)();
      analyser = audioCtx.createAnalyser(); analyser.fftSize = 64;
      audioCtx.createMediaStreamSource(stream).connect(analyser);
      drawWave();
    } catch {}

    try { mr = new MediaRecorder(stream, mime ? {mimeType:mime} : {}); }
    catch { mr = new MediaRecorder(stream); }
    mr.ondataavailable = e => { if (e.data.size > 0) mrChunks.push(e.data); };
    mr.start(500);

    // Periodic Whisper transcription — every 15s up to 2 min, then stops to save API costs
    _periodicId = setInterval(async () => {
      if (!going || mrChunks.length < 4) return;
      if (secs > 120) { clearInterval(_periodicId); _periodicId = null; return; }
      try {
        const pMime = (mr && mr.mimeType ? mr.mimeType.split(';')[0] : null) || (mime ? mime.split(';')[0] : null) || 'audio/webm';
        const pBlob = new Blob(mrChunks, { type: pMime });
        if (pBlob.size < 3000) return;
        const pB64 = await toB64(pBlob);
        if (!going) return;
        const pRes = await _recAuthFetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: pB64, mimeType: pMime, diarize: false, realtime: true })
        });
        if (!going || !pRes.ok) return;
        const pD = await pRes.json();
        if (!going || !pD || !pD.transcript || !pD.transcript.trim()) return;
        // Update live display with latest Whisper transcript
        liveText = pD.transcript.trim() + ' ';
        updateLiveDisplay('');
      } catch {}
    }, 15000);

    {
      const p = $('fr-live-placeholder');
      if (p) { p.style.display = ''; p.textContent = 'Transcribing… first update in ~10s'; }
    }

    if (SRApi) {
      const sr = new SRApi();
      recognition = sr;
      sr.continuous = true;
      sr.interimResults = true;
      sr.lang = 'en-US';
      sr.onresult = evt => {
        let interim = '';
        for (let i = evt.resultIndex; i < evt.results.length; i++) {
          if (evt.results[i].isFinal) {
            let seg = evt.results[i][0].transcript.trim();
            if (!seg) continue;
            seg = seg.charAt(0).toUpperCase() + seg.slice(1);
            seg = seg.replace(/\bi\b/g, 'I')
                     .replace(/\bi'm\b/gi, "I'm")
                     .replace(/\bi've\b/gi, "I've")
                     .replace(/\bi'll\b/gi, "I'll")
                     .replace(/\bi'd\b/gi, "I'd");
            seg = seg.replace(/\b(\w+) \1\b/gi, '$1');
            seg = seg.replace(/,\s+([a-z])/g, (m, c) => {
              if (/^(i|we|they|he|she|it|you|this|that|there|here|so|but|and|however|also|now|well|then)\b/i.test(c)) {
                return '. ' + c.toUpperCase();
              }
              return m;
            });
            if (!/[.!?,;:]$/.test(seg)) seg += '.';
            liveText += seg + ' ';
          } else {
            interim = evt.results[i][0].transcript;
          }
        }
        // Use 'sr' not 'recognition' — recognition may be null after stop()
        sr._lastInterim = interim || sr._lastInterim || '';
        updateLiveDisplay(interim);
      };
      sr.onend = () => { if (going) { try { sr.start(); } catch {} } };
      try { sr.start(); } catch {}
    }

    window._frNavWarn = e => {
      if (!going) return;
      e.preventDefault();
      e.returnValue = 'Recording is in progress — stop before leaving?';
      return e.returnValue;
    };
    window.addEventListener('beforeunload', window._frNavWarn);
  }


  async function frStop() {
    if (!going) return;
    going = false;
    clearInterval(timer);
    clearWave();

    if (_periodicId) { clearInterval(_periodicId); _periodicId = null; }
    const rec = recognition;
    const pendingInterim = (rec && rec._lastInterim) ? rec._lastInterim.trim() : '';
    if (rec) { try { rec.stop(); } catch {} recognition = null; }
    window.removeEventListener('beforeunload', window._frNavWarn);

    // Stop MediaRecorder and await its 'stop' event — this guarantees all
    // ondataavailable chunks have fired before we read mrChunks.
    // Stream tracks stop AFTER to prevent Edge from killing the recorder early.
    await new Promise(resolve => {
      if (!mr || mr.state === 'inactive') { resolve(); return; }
      mr.addEventListener('stop', resolve, { once: true });
      mr.stop();
    });
    try { if (stream) stream.getTracks().forEach(t => t.stop()); } catch {}

    const capturedText = (liveText + (pendingInterim ? ' ' + pendingInterim : '')).trim();

    function showDone(text, polishing) {
      const newPart = text.trim() || '(no speech detected)';
      const final = _sessionText ? _sessionText + '\n\n' + newPart : newPart;
      localStorage.setItem('gn-notepad-pending', final);
      const prev = $('fr-preview');
      if (prev) { prev.value = final; prev.readOnly = !!polishing; } // edits made mid-polish would be overwritten
      const ps = $('fr-polish-status');
      if (ps) ps.style.display = polishing ? '' : 'none';
      showState('fr-done');
    }

    if (capturedText.length > 0) {
      const needsPolish = capturedText.length >= 20;
      showDone(capturedText, needsPolish);
      if (mrChunks.length > 0) _lastBlob = new Blob(mrChunks, { type: (mr && mr.mimeType) || mime || 'audio/webm' });
      if (needsPolish) {
        const run = ++_tidyRun;
        tidyTranscript(capturedText, (soFar, done, part, parts) => {
          if (run !== _tidyRun) return;
          showDone(soFar, !done);
          const ps = $('fr-polish-status');
          if (ps && !done) ps.textContent = '✨ Polishing grammar & labeling speakers…' + (parts > 1 ? ' part ' + part + ' of ' + parts : '');
        }, () => run !== _tidyRun);
      }
      return;
    }

    // No SR text — send audio to Whisper
    showState('fr-proc');
    const lbl = $('fr-proc-lbl'); if (lbl) lbl.textContent = 'Transcribing…';
    const safetyTimer = setTimeout(() => showDone('(no speech detected)', false), 25000);

    try {
      const rawMime = (mr && mr.mimeType) || mime || 'audio/webm';
      // Strip codec params — some Whisper endpoints reject 'audio/webm;codecs=opus'
      const mimeType = rawMime.split(';')[0].trim() || 'audio/webm';
      const blob = new Blob(mrChunks, { type: mimeType });
      _lastBlob = blob;
      if (blob.size <= 500) {
        clearTimeout(safetyTimer);
        showDone('(mic check: no audio captured — check browser mic permissions)', false);
        return;
      }
      const b64 = await withTimeout(toB64(blob), 8000);
      const res = await withTimeout(_recAuthFetch('/api/transcribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: b64, mimeType, diarize: _diarize, spkNames: _spkNames,
          prompt: 'Lecture, classroom, university, professor, student, question, answer.' })
      }), 20000);
      const d = await withTimeout(res.json(), 8000);
      clearTimeout(safetyTimer);
      if (!res.ok) {
        if (d && d.code === 'limit_reached') {
          if (window.gnShowLimitNotice) window.gnShowLimitNotice(d.error);
          showDone('(' + d.error + ')', false);
          return;
        }
        showDone('(API error ' + res.status + ': ' + (d && d.error ? d.error : 'unknown') + ' — ' + Math.round(blob.size/1024) + 'KB)', false);
        return;
      }
      if (d && d.transcript && d.transcript.trim()) {
        showDone(d.transcript.trim(), false);
      } else {
        showDone('(no speech detected — ' + Math.round(blob.size/1024) + 'KB recorded, format: ' + mimeType + ')', false);
      }
    } catch (e) {
      clearTimeout(safetyTimer);
      showDone('(error: ' + (e.message || 'unknown') + ')', false);
    }
  }

  function drawWave() {
    if (!analyser) return;
    const cv = $('fr-wave'); if (!cv) return;
    const cx = cv.getContext('2d'), W = cv.width, H = cv.height;
    const buf = new Uint8Array(analyser.frequencyBinCount);
    function frame() {
      raf = requestAnimationFrame(frame);
      if (!analyser) return;
      analyser.getByteFrequencyData(buf);
      cx.clearRect(0, 0, W, H);
      const bw = W / buf.length * 2;
      buf.forEach((v, i) => {
        if (v < 5) return;
        cx.fillStyle = 'rgba(248,113,113,' + (0.3 + (v / 255) * 0.7) + ')';
        cx.fillRect(i * bw, H - (v / 255) * H, Math.max(1, bw - 1), (v / 255) * H);
      });
    }
    frame();
  }

  function clearWave() {
    cancelAnimationFrame(raf); raf = null; analyser = null;
    const cv = $('fr-wave');
    if (cv) cv.getContext('2d').clearRect(0, 0, cv.width, cv.height);
  }

  function frOpenNotepad() {
    const prev = $('fr-preview');
    if (prev && prev.value.trim()) localStorage.setItem('gn-notepad-pending', prev.value.trim());
    _sessionText = '';
    window.location.href = 'notepad.html';
  }

  function frSetSize(sz) {
    const panel = $('fr-done');
    if (!panel) return;
    document.querySelectorAll('#fr-widget .fr-sz').forEach(b => b.classList.toggle('on', b.dataset.sz === sz));
    // Clear previous overrides
    ['position','top','left','right','bottom','maxWidth','maxHeight','borderRadius','resize','zIndex'].forEach(p => panel.style[p] = '');
    panel.style.width = ''; panel.style.height = '';
    if (sz === 'fs') {
      Object.assign(panel.style, {
        position:'fixed', top:'0', left:'0', right:'0', bottom:'0',
        width:'100vw', height:'100vh', maxWidth:'none', maxHeight:'none',
        borderRadius:'0', resize:'none', zIndex:'99999'
      });
    } else {
      const w = {sm:'230px', md:'320px', lg:'540px'}[sz] || '320px';
      const h = {sm:'200px', md:'320px', lg:'520px'}[sz] || '320px';
      panel.style.width = w; panel.style.height = h;
    }
  }

  async function frContinueRecording() {
    const prev = $('fr-preview');
    const current = (prev && prev.value.trim()) || localStorage.getItem('gn-notepad-pending') || '';
    if (current && current !== '(no speech detected)') {
      _sessionText = current.trim();
    }
    await frStartFromReady();
  }

  function frDownloadMp3() {
    if (!_lastBlob || _lastBlob.size === 0) {
      setTimeout(() => { if (_lastBlob && _lastBlob.size > 0) frDownloadMp3(); }, 1500);
      return;
    }
    const ts = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(_lastBlob);
    a.download = 'recording-' + ts + '.webm';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }

  function frDismiss() {
    _tidyRun++;
    hideAll();
    localStorage.removeItem('gn-notepad-pending');
    _sessionText = '';
  }

  function checkPending() {
    const p = localStorage.getItem('gn-notepad-pending');
    if (p && !going && !window.location.pathname.includes('notepad')) {
      inject();
      const prev = $('fr-preview');
      if (prev) prev.value = p;
      const ps = $('fr-polish-status');
      if (ps) ps.style.display = 'none';
      showState('fr-done');
    }
  }

  window.launchFloatingRecorder = function () { inject(); frStart(); };
  window.frStop = frStop;
  window.frStartFromReady = frStartFromReady;
  window.frContinueRecording = frContinueRecording;
  window.frSetSize = frSetSize;
  window.frToggleNames = frToggleNames;
  window.frDismiss = frDismiss;
  window.frOpenNotepad = frOpenNotepad;
  window.frDownloadMp3 = frDownloadMp3;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', checkPending);
  } else {
    checkPending();
  }
})();
