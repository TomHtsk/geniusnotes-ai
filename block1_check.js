  function toggleTheme() {
    const isLight = document.documentElement.classList.toggle('light');
    document.getElementById('theme-icon').textContent = isLight ? '🌙' : '☀️';
    document.getElementById('theme-label').textContent = isLight ? 'Dark' : 'Light';
    localStorage.setItem('theme', isLight ? 'light' : 'dark');
  }
  if (localStorage.getItem('theme') === 'light') {
    document.documentElement.classList.add('light');
    document.getElementById('theme-icon').textContent = '🌙';
    document.getElementById('theme-label').textContent = 'Dark';
  }

  const modeMap = {
    'with Summary':    'summarize',
    'with Transcription': 'transcribe',
    'with Notes':      'notes',
    'with Quizzes':    'quizzes'
  };
  let currentMode = 'summarize';

  function isLocked(chipText) {
    if (chipText === 'Summarize' || chipText === 'Transcribe')
      return !isSignedIn && parseInt(localStorage.getItem('gn-free-uses') || '0') >= 3;
    return !isSignedIn;
  }

  function showSignupWall() {
    document.getElementById('firewall-popup').classList.add('active');
  }

  function tryLockedMode(el, label) {
    setYtMode(el, label);
  }

  function navSetMode(chipText, label, navEl) {
    if (false) { showSignupWall(); return false; }
    document.querySelectorAll('.yt-chip').forEach(chip => {
      if (chip.textContent.replace('🔒 ','').trim() === chipText) setYtMode(chip, label);
    });
    document.querySelectorAll('.nav-mode-link').forEach(l => l.classList.remove('nav-mode-active'));
    navEl.classList.add('nav-mode-active');
    document.getElementById('youtube-summarizer').scrollIntoView({ behavior: 'smooth' });
  }

  function setYtMode(el, label) {
    document.querySelectorAll('.yt-chip').forEach(c => c.classList.remove('yt-chip-active'));
    el.classList.add('yt-chip-active');
    document.getElementById('yt-mode-label').textContent = label;
    currentMode = modeMap[label] || 'summarize';
    document.getElementById('yt-url').placeholder = '▶ Paste YouTube video link here...';
    const box = document.getElementById('summary-box');
    box.className = 'summary-box';
    document.getElementById('summary-text').textContent = '';
    document.getElementById('summary-label').textContent = 'AI Summary';
    const chipText = el.textContent.replace('🔒 ', '').trim();
    document.querySelectorAll('.nav-mode-link').forEach(l => {
      const lt = l.textContent.replace('🔒 ', '').trim();
      l.classList.toggle('nav-mode-active', lt === chipText);
    });
  }


  function copyResult() {
    const text = document.getElementById('summary-text').textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById('copy-btn');
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; btn.classList.remove('copied'); }, 2000);
    });
  }

  function useVideo(url) {
    document.getElementById('yt-url').value = url;
    const lyricsInput = document.getElementById('music-yt-url');
    if (lyricsInput) {
      lyricsInput.value = url;
      document.getElementById('music-fetch-btn').disabled = false;
    }
    if (currentPanel === 6) {
      document.getElementById('youtube-summarizer').scrollIntoView({ behavior: 'smooth', block: 'start' });
      fetchSongLyrics();
    } else {
      document.getElementById('youtube-summarizer').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function summarize() {
    if ((currentMode === 'notes' || currentMode === 'quizzes') && !isSignedIn) {
      document.getElementById('firewall-popup').classList.add('active');
      return;
    }
    if (!isPro && !_adConvBypass) {
      showHwAdGated(() => { _adConvBypass = true; summarize(); }); return;
    }
    _adConvBypass = false;
    const url = document.getElementById('yt-url').value.trim();
    const box = document.getElementById('summary-box');
    const label = document.getElementById('summary-label');
    const text = document.getElementById('summary-text');
    const btn = document.getElementById('yt-btn');
    if (!url || (!url.includes('youtube.com') && !url.includes('youtu.be'))) {
      text.textContent = 'Please enter a valid YouTube URL.';
      label.textContent = 'Error';
      box.className = 'summary-box visible';
      return;
    }
    btn.disabled = true;
    label.textContent = 'Analyzing video';
    text.innerHTML = 'Loading<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
    box.className = 'summary-box visible loading';
    const ytBadge = document.getElementById('yt-saved-badge');
    if (ytBadge) ytBadge.classList.remove('show');
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, mode: currentMode })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to summarize');
      const labelMap = { summarize: 'AI Summary', transcribe: 'Transcript', keypoints: 'Key Points', notes: 'Study Notes', quizzes: 'Quiz Questions' };
      label.textContent = labelMap[currentMode] || 'AI Summary';
      if (currentMode === 'notes') {
        box.className = 'summary-box visible rn-mode';
        await renderRichNotes(text, data.summary);
      } else {
        text.textContent = data.summary;
        box.className = 'summary-box visible';
      }
      if (['notes','quizzes','summarize'].includes(currentMode)) {
        getVideoTitle(url).then(title => {
          saveToHistory(currentMode, 'YouTube', title, data.summary);
          showSavedBadge('yt-saved-badge');
        });
      }
      if (!isSignedIn && (currentMode === 'summarize' || currentMode === 'transcribe')) {
        const newUses = parseInt(localStorage.getItem('gn-free-uses') || '0') + 1;
        localStorage.setItem('gn-free-uses', newUses);
        updateUsesBanner();
        if (newUses >= 3) {
          setTimeout(() => document.getElementById('firewall-popup').classList.add('active'), 800);
        }
      }
    } catch (err) {
      label.textContent = 'Error';
      text.textContent = err.message;
      box.className = 'summary-box visible';
    } finally {
      btn.disabled = false;
    }
  }

  // ── RICH NOTES RENDERER ──
  async function renderRichNotes(container, raw) {
    let data = null;
    try {
      const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
      if (s !== -1 && e > s) data = JSON.parse(raw.slice(s, e + 1));
    } catch {}

    container.style.whiteSpace = 'normal';
    if (!data) { container.innerHTML = fmtRnMd(raw); return; }

    function _e(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    const SC = {biology:'#22c55e',chemistry:'#3b82f6',physics:'#f97316',math:'#8b5cf6',history:'#eab308',economics:'#06b6d4',literature:'#ec4899',cs:'#6366f1',other:'#6b7280'};
    const sc = SC[data.subject] || SC.other;

    // Route non-detailed styles
    if (data.style && data.style !== 'detailed') {
      container.innerHTML = _rnStyled(data, _e, sc);
      if (window.mermaid && data.style === 'mindmap') {
        try { if (!window._mermaidInited){mermaid.initialize({startOnLoad:false,theme:'dark'});window._mermaidInited=true;} mermaid.run({nodes:container.querySelectorAll('.mermaid')}); } catch {}
      }
      const doK = () => { if(window.renderMathInElement) try{renderMathInElement(container,{delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}],throwOnError:false});}catch{} };
      if (window._katexReady) doK(); else setTimeout(doK, 700);
      return;
    }

    let h = '<div class="rn-wrap">';
    // Quote (above header)
    if (data.quote?.text) h += `<div class="rn-quote"><span class="rn-quote-mark">"</span><span class="rn-quote-text">${_e(data.quote.text)}</span><span class="rn-quote-author">— ${_e(data.quote.author||'')}</span></div>`;

    h += `<div class="rn-header"><span class="rn-emoji">${_e(data.emoji||'📚')}</span><div><h1 class="rn-title">${_e(data.title||'Study Notes')}</h1><span class="rn-stag" style="background:${sc}20;color:${sc};border:1px solid ${sc}40">${_e(data.subject||'general')}</span></div></div>`;
    if (data.overview) h += `<p class="rn-overview">${_e(data.overview)}</p>`;

    if (data.visuals?.length) {
      h += '<div class="rn-visuals">';
      data.visuals.forEach(v => { h += `<div class="rn-vis" data-query="${_e(v.query)}"><div class="rn-vis-img"><span class="rn-vis-load">Finding diagram…</span></div><div class="rn-vis-cap">${_e(v.caption)}</div></div>`; });
      h += '</div>';
    }

    (data.sections||[]).forEach(s => { h += `<div class="rn-sec"><h2 class="rn-sh">${_e(s.heading)}</h2><div class="rn-sc">${fmtRnMd(s.content)}</div></div>`; });

    if (data.comparisonTable?.headers?.length) {
      const t = data.comparisonTable;
      h += `<div class="rn-sec"><h2 class="rn-sh">Comparison</h2><div class="rn-tbl-wrap"><table class="rn-tbl"><thead><tr>${t.headers.map(x=>`<th>${_e(x)}</th>`).join('')}</tr></thead><tbody>${(t.rows||[]).map(r=>`<tr>${r.map(c=>`<td>${_e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
    }

    if (data.processFlow?.steps?.length) {
      const steps = data.processFlow.steps;
      const mc = 'graph TD\n' + steps.map((s,i) => i < steps.length-1 ? `  N${i}["${s.replace(/"/g,"'")}"] --> N${i+1}["${steps[i+1].replace(/"/g,"'")}"]` : '').filter(Boolean).join('\n');
      h += `<div class="rn-sec"><h2 class="rn-sh">${_e(data.processFlow.title||'Process Flow')}</h2><div class="rn-mermaid"><pre class="mermaid">${mc}</pre></div></div>`;
    }

    if (data.graphs?.length) {
      h += '<div class="rn-sec"><h2 class="rn-sh">Function Graphs</h2><div class="rn-graphs">';
      data.graphs.forEach(expr => { h += `<div class="rn-graph-card"><div class="rn-graph-expr">${_e(expr)}</div><div class="rn-graph-elt" data-desmos-expr="${_e(expr)}"></div></div>`; });
      h += '</div></div>';
    }

    if (data.formulas?.length) {
      h += '<div class="rn-sec"><h2 class="rn-sh">Formulas &amp; Equations</h2><div class="rn-formulas">';
      data.formulas.forEach(f => { h += `<div class="rn-fc"><div class="rn-fl">${_e(f.label)}</div><div class="rn-fe">$$${_e(f.latex)}$$</div>${f.note?`<div class="rn-fn">${_e(f.note)}</div>`:''}</div>`; });
      h += '</div></div>';
    }

    if (data.keyTerms?.length) {
      h += '<div class="rn-sec"><h2 class="rn-sh">Key Terms</h2><div class="rn-terms">';
      data.keyTerms.forEach(t => { h += `<div class="rn-tc"><div class="rn-tn">${_e(t.term)}</div><div class="rn-td">${_e(t.definition)}</div>${t.example&&t.example!=='null'?`<div class="rn-te">e.g. ${_e(t.example)}</div>`:''}</div>`; });
      h += '</div></div>';
    }

    if (data.keyTakeaways?.length) {
      h += `<div class="rn-sec rn-tka"><h2 class="rn-sh">Key Takeaways</h2><ul class="rn-tklist">${data.keyTakeaways.map(t=>`<li>${_e(t)}</li>`).join('')}</ul></div>`;
    }

    h += '</div>';
    container.innerHTML = h;

    container.querySelectorAll('.rn-vis[data-query]').forEach(async card => {
      try {
        const img = await rnWikiImg(card.dataset.query);
        const wrap = card.querySelector('.rn-vis-img');
        if (img) wrap.innerHTML = `<img src="${img.src}" alt="${img.alt.replace(/"/g,'&quot;')}" class="rn-vimg">`;
        else card.style.display = 'none';
      } catch { card.style.display = 'none'; }
    });

    if (window.mermaid) {
      try {
        if (!window._mermaidInited) { mermaid.initialize({ startOnLoad:false, theme:'dark' }); window._mermaidInited=true; }
        mermaid.run({ nodes: container.querySelectorAll('.mermaid') });
      } catch {}
    }

    initDesmosGraphs(container);

    const doKatex = () => { if (window.renderMathInElement) try { renderMathInElement(container, { delimiters:[{left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false}], throwOnError:false }); } catch {} };
    if (window._katexReady) doKatex(); else setTimeout(doKatex, 700);
  }

  function initDesmosGraphs(container) {
    if (!window.Desmos) return;
    container.querySelectorAll('[data-desmos-expr]').forEach(el => {
      if (el.dataset.desmosInit) return;
      el.dataset.desmosInit = '1';
      const expr = el.dataset.desmosExpr;
      try {
        const calc = Desmos.GraphingCalculator(el, {
          settingsMenu: false, expressions: false, zoomButtons: true,
          lockViewport: false, keypad: false, border: false
        });
        calc.setExpression({ id: 'f1', latex: expr });
      } catch {}
    });
  }

  async function rnWikiImg(query) {
    const r = await fetch(`https://en.wikipedia.org/w/api.php?action=query&generator=search&gsrsearch=${encodeURIComponent(query)}&prop=pageimages&format=json&pithumbsize=400&origin=*&gsrlimit=3`);
    const d = await r.json();
    const pages = Object.values(d.query?.pages||{});
    const p = pages.find(x => x.thumbnail);
    return p?.thumbnail ? { src: p.thumbnail.source, alt: p.title } : null;
  }

  function _rnStyled(data, _e, sc) {
    const hdr = () => {
      let h = '<div class="rn-wrap">';
      if (data.quote?.text) h += `<div class="rn-quote"><span class="rn-quote-mark">"</span><span class="rn-quote-text">${_e(data.quote.text)}</span><span class="rn-quote-author">— ${_e(data.quote.author||'')}</span></div>`;
      h += `<div class="rn-header"><span class="rn-emoji">${_e(data.emoji||'📚')}</span><div><h1 class="rn-title">${_e(data.title||'Notes')}</h1><span class="rn-stag" style="background:${sc}20;color:${sc};border:1px solid ${sc}40">${_e(data.subject||'general')}</span></div></div>`;
      return h;
    };

    switch (data.style) {
      case 'outline': {
        let h = hdr(), lvl1 = 0;
        h += '<ul class="rn-outline">';
        (data.items||[]).forEach(item => {
          if (item.level===1) lvl1++;
          const idx = item.level===1 ? ' data-idx="'+lvl1+'"' : '';
          h += '<li class="rn-ol-'+item.level+'"'+idx+'>'+_e(item.text)+'</li>';
        });
        return h + '</ul></div>';
      }
      case 'cornell': {
        let h = hdr();
        h += '<div class="rn-cornell"><div class="rn-cornell-head"><div class="rn-ch-cue">Cues / Keywords</div><div class="rn-ch-notes">Notes</div></div>';
        (data.rows||[]).forEach(r => { h += `<div class="rn-cornell-row"><div class="rn-cr-cue">${_e(r.cue)}</div><div class="rn-cr-notes">${_e(r.notes)}</div></div>`; });
        if (data.summary) h += `<div class="rn-cornell-summary"><div class="rn-cs-label">Summary</div><div style="font-size:.83rem;color:var(--text);line-height:1.6;margin-top:4px">${_e(data.summary)}</div></div>`;
        return h + '</div></div>';
      }
      case 'mindmap': {
        let h = hdr();
        h += `<div class="rn-mermaid"><pre class="mermaid">${data.mermaid||''}</pre></div>`;
        return h + '</div>';
      }
      case 'summary': {
        let h = hdr();
        if (data.overview) h += `<p class="rn-overview">${_e(data.overview)}</p>`;
        if (data.keyPoints?.length) {
          h += '<div class="rn-sec"><h2 class="rn-sh">Key Points</h2><div class="rn-terms">';
          data.keyPoints.forEach((p,i) => { h += `<div class="rn-tc"><div class="rn-tn" style="font-weight:normal;">${_e(p)}</div></div>`; });
          h += '</div></div>';
        }
        if (data.keyTakeaways?.length) h += `<div class="rn-sec rn-tka"><h2 class="rn-sh">Key Takeaways</h2><ul class="rn-tklist">${data.keyTakeaways.map(t=>`<li>${_e(t)}</li>`).join('')}</ul></div>`;
        return h + '</div>';
      }
      case 'problem': {
        let h = hdr();
        if (data.intro) h += `<p class="rn-overview">${_e(data.intro)}</p>`;
        (data.problems||[]).forEach((p,i) => {
          h += `<div class="rn-problem-card"><div class="rn-prob-q">${i+1}. ${_e(p.question)}</div>`;
          if (p.steps?.length) { h += '<div class="rn-prob-steps">'; p.steps.forEach((s,j)=>{ h+=`<div class="rn-prob-step"><div class="rn-prob-num">${j+1}</div><div>${fmtRnMd(s)}</div></div>`; }); h+='</div>'; }
          if (p.answer) h += `<div class="rn-prob-ans">✓ ${_e(p.answer)}</div>`;
          if (p.formula) h += `<div class="rn-formula-card" style="margin-top:8px"><div class="rn-fl">Formula</div><div class="rn-fe">$$${_e(p.formula)}$$</div></div>`;
          h += '</div>';
        });
        return h + '</div>';
      }
      case 'exam': {
        let h = hdr();
        if (data.mustKnow?.length) { h += '<div class="rn-sec"><h2 class="rn-sh">Must Know</h2><ul class="rn-exam-must">'; data.mustKnow.forEach(f=>{ h+=`<li>${_e(f)}</li>`; }); h+='</ul></div>'; }
        if (data.keyTerms?.length) { h += '<div class="rn-sec"><h2 class="rn-sh">Key Terms</h2><div class="rn-terms">'; data.keyTerms.forEach(t=>{ h+=`<div class="rn-tc"><div class="rn-tn">${_e(t.term)}</div><div class="rn-td">${_e(t.definition)}</div></div>`; }); h+='</div></div>'; }
        if (data.practiceQA?.length) { h += '<div class="rn-sec"><h2 class="rn-sh">Practice Q&amp;A</h2><div class="rn-exam-qa">'; data.practiceQA.forEach(qa=>{ h+=`<div class="rn-qa-card"><div class="rn-qa-q">Q: ${_e(qa.q)}</div><div class="rn-qa-a">A: ${_e(qa.a)}</div></div>`; }); h+='</div></div>'; }
        if (data.formulas?.length) { h += '<div class="rn-sec"><h2 class="rn-sh">Formulas</h2><div class="rn-formulas">'; data.formulas.forEach(f=>{ h+=`<div class="rn-fc"><div class="rn-fl">${_e(f.label)}</div><div class="rn-fe">$$${_e(f.latex)}$$</div></div>`; }); h+='</div></div>'; }
        if (data.tips?.length) { h += '<div class="rn-sec rn-tka"><h2 class="rn-sh">Exam Tips</h2><ul class="rn-exam-tips">'; data.tips.forEach(t=>{ h+=`<li class="rn-exam-tip">${_e(t)}</li>`; }); h+='</ul></div>'; }
        return h + '</div>';
      }
      case 'comparison': {
        let h = hdr();
        if (data.overview) h += `<p class="rn-overview">${_e(data.overview)}</p>`;
        (data.tables||[]).forEach(t => {
          h += `<div class="rn-sec"><h2 class="rn-sh">${_e(t.title||'Comparison')}</h2><div class="rn-tbl-wrap"><table class="rn-tbl"><thead><tr>${(t.headers||[]).map(h=>`<th>${_e(h)}</th>`).join('')}</tr></thead><tbody>${(t.rows||[]).map(r=>`<tr>${r.map(c=>`<td>${_e(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></div>`;
        });
        return h + '</div>';
      }
      case 'boxing': {
        let h = hdr();
        h += '<div class="rn-boxes">';
        (data.boxes||[]).forEach(b => {
          const tagColors = {Definition:'var(--purple)',Process:'var(--cyan)',Example:'#4ade80',Formula:'var(--gold,#F5C842)',Warning:'#f87171'};
          const tc = tagColors[b.tag] || 'var(--purple)';
          h += `<div class="rn-box" style="border-color:${tc}30">`;
          if (b.tag) h += `<div class="rn-box-tag" style="background:${tc}">${_e(b.tag)}</div>`;
          h += `<div class="rn-box-title">${_e(b.title)}</div><div class="rn-box-content">${_e(b.content)}</div></div>`;
        });
        return h + '</div></div>';
      }
      case 'charting': {
        let h = hdr();
        if (data.overview) h += `<p class="rn-overview">${_e(data.overview)}</p>`;
        h += '<div class="rn-chart-wrap"><table class="rn-chart"><thead><tr>';
        (data.headers||[]).forEach(hd => { h += `<th>${_e(hd)}</th>`; });
        h += '</tr></thead><tbody>';
        (data.rows||[]).forEach(row => {
          h += '<tr>';
          row.forEach((cell,i) => { h += `<td${i===0?' style="font-weight:700;color:var(--text)"':''}>${_e(cell)}</td>`; });
          h += '</tr>';
        });
        return h + '</tbody></table></div></div>';
      }
      case 'mapping': {
        let h = hdr();
        h += '<div class="rn-map">';
        if (data.center) h += `<div class="rn-map-center">${_e(data.center)}</div>`;
        h += '<div class="rn-map-branches">';
        (data.branches||[]).forEach(b => {
          h += `<div class="rn-map-branch"><div class="rn-map-blabel">${_e(b.label)}</div>`;
          if (b.connection) h += `<div class="rn-map-conn">${_e(b.connection)}</div>`;
          h += '<ul class="rn-map-children">';
          (b.children||[]).forEach(c => { h += `<li>${_e(c)}</li>`; });
          h += '</ul></div>';
        });
        return h + '</div></div></div>';
      }
      case 'qec': {
        let h = hdr();
        h += '<div class="rn-qec">';
        (data.items||[]).forEach(item => {
          h += `<div class="rn-qec-card"><div class="rn-qec-q">${_e(item.question)}</div><div class="rn-qec-body">`;
          if (item.evidence?.length) {
            h += `<div class="rn-qec-evid-label">Evidence</div><ul class="rn-qec-evid">`;
            item.evidence.forEach(e => { h += `<li>${_e(e)}</li>`; });
            h += '</ul>';
          }
          if (item.conclusion) h += `<div class="rn-qec-conc">${_e(item.conclusion)}</div>`;
          h += '</div></div>';
        });
        return h + '</div></div>';
      }
      default: return '<div class="rn-wrap">' + fmtRnMd(JSON.stringify(data)) + '</div>';
    }
  }

  function fmtRnMd(raw) {
    if (!raw) return '';
    let s = String(raw).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    s = s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>').replace(/`(.+?)`/g,'<code class="rn-code">$1</code>');
    const lines = s.split('\n');
    let out = '', ul = false;
    for (const ln of lines) {
      const t = ln.trim();
      if (!t) { if (ul) { out+='</ul>'; ul=false; } continue; }
      if (t.startsWith('- ') || t.startsWith('• ')) { if (!ul){out+='<ul class="rn-list">';ul=true;} out+=`<li>${t.slice(2)}</li>`; }
      else { if(ul){out+='</ul>';ul=false;} out+=`<p>${t}</p>`; }
    }
    if (ul) out += '</ul>';
    return out;
  }
