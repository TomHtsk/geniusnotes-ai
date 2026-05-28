  firebase.initializeApp({
    apiKey: "AIzaSyAwbZkiZR8NRgrFYCL041FHfGquHyeEJUI",
    authDomain: "geniusnotes-ai.firebaseapp.com",
    projectId: "geniusnotes-ai",
    storageBucket: "geniusnotes-ai.firebasestorage.app",
    messagingSenderId: "1041746856723",
    appId: "1:1041746856723:web:fae9072e0292c3946068e6"
  });
  let isSignedIn = false;
  let currentUid = null;
  let isPro = false;

  // ── AD CONVERSION TRACKING ──
  // Guest: 3 ad-uses per 24h then locked. Signed-in free: unlimited with ads. Pro: no ads.
  function getAdConvState() {
    if (isSignedIn) return { used: 0, remaining: 999 };
    const now = Date.now();
    const reset = parseInt(localStorage.getItem('gn-ad-conv-reset') || '0');
    if (now - reset > 86400000) {
      localStorage.setItem('gn-ad-conv-used', '0');
      localStorage.setItem('gn-ad-conv-reset', now.toString());
      return { used: 0, remaining: 3 };
    }
    const used = parseInt(localStorage.getItem('gn-ad-conv-used') || '0');
    return { used, remaining: Math.max(0, 3 - used) };
  }
  function consumeAdConv() {
    if (isSignedIn) return;
    const s = getAdConvState();
    localStorage.setItem('gn-ad-conv-used', (s.used + 1).toString());
  }
  let _adConvBypass = false;

  async function checkProStatus(uid, email) {
    try {
      const r = await fetch('/api/subscription?email=' + encodeURIComponent(email || ''));
      const data = await r.json();
      isPro = data.pro === true;
      if (isPro) {
        document.querySelectorAll('.upgrade-prompt').forEach(el => el.style.display = 'none');
        const btn = document.getElementById('upgrade-btn');
        if (btn) { btn.textContent = '✓ Pro Active'; btn.style.background = '#34D399'; btn.style.cursor = 'default'; btn.onclick = null; }
        const pricingSection = document.getElementById('pricing');
        if (pricingSection) pricingSection.style.display = 'none';
        const badge = document.getElementById('pro-badge-logo');
        if (badge) badge.style.display = '';
        const hwBtn = document.getElementById('hw-btn');
        if (hwBtn) hwBtn.textContent = '🧠 Solve Homework →';
        const hlBtn = document.getElementById('hl-panel-btn');
        if (hlBtn) hlBtn.textContent = '✨ AI Highlight →';
        const wBtn = document.getElementById('writing-btn');
        if (wBtn) wBtn.textContent = '✍️ Enhance Writing →';
        const ytBtn = document.getElementById('yt-btn');
        if (ytBtn) ytBtn.textContent = 'Convert →';
        const upBtn = document.getElementById('upload-btn');
        if (upBtn) upBtn.textContent = 'Convert →';
        const audBtn = document.getElementById('audio-btn');
        if (audBtn) audBtn.textContent = 'Process →';
        const chkBtn = document.getElementById('checker-btn');
        if (chkBtn) chkBtn.textContent = 'Analyze →';
        const lyrBtn = document.getElementById('music-fetch-btn');
        if (lyrBtn) lyrBtn.textContent = 'Get Lyrics →';
      }
    } catch { isPro = false; }
  }

  let billingPlan = 'monthly';
  function toggleBilling() {
    billingPlan = billingPlan === 'monthly' ? 'yearly' : 'monthly';
    const knob = document.getElementById('billing-knob');
    const mLabel = document.getElementById('billing-monthly-label');
    const yLabel = document.getElementById('billing-yearly-label');
    const amt = document.getElementById('price-amount');
    const sub = document.getElementById('price-sub');
    if (billingPlan === 'yearly') {
      knob.style.left = '25px';
      mLabel.style.color = 'var(--muted)';
      yLabel.style.color = 'var(--text)';
      amt.innerHTML = '$8.33<span style="font-size:1rem;font-weight:500;color:var(--muted);">/mo</span>';
      sub.textContent = 'Billed $99.99/year — save $55.89';
    } else {
      knob.style.left = '3px';
      mLabel.style.color = 'var(--text)';
      yLabel.style.color = 'var(--muted)';
      amt.innerHTML = '$12.99<span style="font-size:1rem;font-weight:500;color:var(--muted);">/mo</span>';
      sub.textContent = 'Cancel anytime';
    }
  }

  async function startCheckout() {
    alert('🚧 Pro subscriptions are not yet available — we\'re still finishing up. Check back soon!');
  }
  let fwTimer = null;

  function updateUsesBanner() {
    const banner = document.getElementById('free-uses-banner');
    const textEl = document.getElementById('free-uses-text');
    if (!banner) return;
    if (isSignedIn) {
      banner.style.display = 'flex';
      textEl.textContent = '▶ Watch an ad per use · Upgrade to Pro for no ads';
      const lnk = document.getElementById('free-uses-link');
      if (lnk) { lnk.href = '/#pricing'; lnk.textContent = 'Upgrade →'; }
      // Unlock all nav links
      const navLabels = ['Transcribe','Summarize','Generate Notes','Create Quizzes'];
      document.querySelectorAll('.nav-mode-link').forEach((a, i) => {
        a.classList.remove('nav-mode-locked');
        a.textContent = navLabels[i];
      });
      // Unlock YouTube chips
      const chipData = [
        { text: 'Transcribe',     mode: 'with Transcription' },
        { text: 'Summarize',      mode: 'with Summary' },
        { text: 'Generate Notes', mode: 'with Notes' },
        { text: 'Create Quizzes', mode: 'with Quizzes' }
      ];
      document.querySelectorAll('#yt-chips-container .yt-chip').forEach((chip, i) => {
        chip.classList.remove('yt-chip-locked');
        chip.textContent = chipData[i].text;
        const m = chipData[i].mode;
        chip.onclick = function() { setYtMode(this, m); };
      });
      // Unlock upload chips
      document.querySelectorAll('#upload-chips .yt-chip').forEach(chip => {
        chip.classList.remove('yt-chip-locked');
        if (chip.textContent.includes('Summarize'))      { chip.textContent = 'Summarize';         chip.onclick = function(){ setUpMode(this,'with Summary'); }; }
        if (chip.textContent.includes('Generate Notes')) { chip.textContent = 'Generate Notes';    chip.onclick = function(){ setUpMode(this,'with Notes'); }; }
        if (chip.textContent.includes('Create Quizzes')) { chip.textContent = 'Create Quizzes';    chip.onclick = function(){ setUpMode(this,'with Quizzes'); }; }
        if (chip.textContent.includes('Flashcards'))     { chip.textContent = 'Flashcards';        chip.onclick = function(){ setUpMode(this,'with Flashcards'); }; }
      });
      const upBanner = document.getElementById('upload-free-uses-banner');
      if (upBanner) upBanner.style.display = 'none';
      // Unlock audio chips
      document.querySelectorAll('#audio-chips .yt-chip').forEach(chip => {
        chip.classList.remove('yt-chip-locked');
        if (chip.textContent.includes('Generate Notes')){ chip.textContent = 'Generate Notes'; chip.onclick = function(){ setAudioMode(this,'notes'); }; }
        if (chip.textContent.includes('Create Quizzes')){ chip.textContent = 'Create Quizzes'; chip.onclick = function(){ setAudioMode(this,'quizzes'); }; }
      });
      initFlashcardPanel();
      return;
    }
    const used = parseInt(localStorage.getItem('gn-free-uses') || '0');
    const left = Math.max(0, 3 - used);
    const { remaining } = getAdConvState();
    if (remaining <= 0) {
      textEl.textContent = `▶ Daily limit reached — Sign in for unlimited free access`;
    } else {
      textEl.textContent = `▶ Guests: ${remaining} free use${remaining !== 1 ? 's' : ''} left today · Sign in for unlimited`;
    }
    banner.style.display = 'flex';
    const transcribeNav  = document.querySelector('.nav-mode-link:first-child');
    const transcribeChip = document.querySelector('#yt-chips-container .yt-chip:first-child');
    const summarizeNav   = document.querySelector('.nav-mode-link:nth-child(2)');
    const summarizeChip  = document.querySelector('#yt-chips-container .yt-chip:nth-child(2)');
    if (left === 0) {
      const { remaining } = getAdConvState();
      if (remaining > 0) {
        // Ad slot available — unlock chips so user can pick a mode then click Convert
        if (transcribeNav)  { transcribeNav.classList.remove('nav-mode-locked');  transcribeNav.textContent  = 'Transcribe'; }
        if (transcribeChip) { transcribeChip.classList.remove('yt-chip-locked');  transcribeChip.textContent = 'Transcribe'; transcribeChip.onclick = function(){ setYtMode(this,'with Transcription'); }; }
        if (summarizeNav)   { summarizeNav.classList.remove('nav-mode-locked');   summarizeNav.textContent   = 'Summarize'; }
        if (summarizeChip)  { summarizeChip.classList.remove('yt-chip-locked');   summarizeChip.textContent  = 'Summarize'; summarizeChip.onclick = function(){ setYtMode(this,'with Summary'); }; }
      } else {
        if (transcribeNav)  { transcribeNav.classList.add('nav-mode-locked');  transcribeNav.textContent  = '🔒 Transcribe'; }
        if (transcribeChip) { transcribeChip.classList.add('yt-chip-locked');  transcribeChip.textContent = '🔒 Transcribe'; transcribeChip.onclick = () => showSignupWall(); }
        if (summarizeNav)   { summarizeNav.classList.add('nav-mode-locked');   summarizeNav.textContent   = '🔒 Summarize'; }
        if (summarizeChip)  { summarizeChip.classList.add('yt-chip-locked');   summarizeChip.textContent  = '🔒 Summarize'; summarizeChip.onclick = () => showSignupWall(); }
      }
    } else {
      if (transcribeNav)  { transcribeNav.classList.remove('nav-mode-locked');  transcribeNav.textContent  = 'Transcribe'; }
      if (transcribeChip) { transcribeChip.classList.remove('yt-chip-locked');  transcribeChip.textContent = 'Transcribe'; transcribeChip.onclick = function(){ setYtMode(this,'with Transcription'); }; }
      if (summarizeNav)   { summarizeNav.classList.remove('nav-mode-locked');   summarizeNav.textContent   = 'Summarize'; }
      if (summarizeChip)  { summarizeChip.classList.remove('yt-chip-locked');   summarizeChip.textContent  = 'Summarize'; summarizeChip.onclick = function(){ setYtMode(this,'with Summary'); }; }
    }
    // Upload panel banner + Summarize chip
    const upBanner = document.getElementById('upload-free-uses-banner');
    const upTextEl = document.getElementById('upload-free-uses-text');
    const upSumChip = document.querySelector('#upload-chips .yt-chip:first-child');
    if (upBanner && upTextEl) {
      if (left === 0) {
        const { remaining } = getAdConvState();
        upTextEl.textContent = `▶ Watch an ad for unlimited tokens`;
      } else {
        upTextEl.textContent = `${left} ${left === 1 ? 'token' : 'tokens'} left — Sign up to continue`;
      }
      upBanner.style.display = 'flex';
    }
    if (upSumChip) {
      if (left === 0) {
        const { remaining } = getAdConvState();
        if (remaining > 0) {
          upSumChip.classList.remove('yt-chip-locked');
          upSumChip.textContent = 'Summarize';
          upSumChip.onclick = function(){ setUpMode(this,'with Summary'); };
        } else {
          upSumChip.classList.add('yt-chip-locked');
          upSumChip.textContent = '🔒 Summarize';
          upSumChip.onclick = () => showSignupWall();
        }
      } else {
        upSumChip.classList.remove('yt-chip-locked');
        upSumChip.textContent = 'Summarize';
        upSumChip.onclick = function(){ setUpMode(this,'with Summary'); };
      }
    }
  }

  // Fallback: if Firebase hasn't resolved auth within 5s, treat as signed out
  const authTimeout = setTimeout(() => {
    const dashboard = document.getElementById('nav-dashboard');
    const signoutBtn = document.getElementById('nav-signout');
    if (dashboard && dashboard.style.display === 'none') {
      // Auth still pending — show nav in signed-out state
      const signinBtn = document.getElementById('nav-signin');
      if (signinBtn) signinBtn.style.display = '';
    }
  }, 5000);

  firebase.auth().onAuthStateChanged(user => {
    clearTimeout(authTimeout);
    const dashboard  = document.getElementById('nav-dashboard');
    const signoutBtn = document.getElementById('nav-signout');
    const signinBtn  = document.getElementById('nav-signin');
    const mSignin  = document.getElementById('nav-mobile-signin');
    const mDash    = document.getElementById('nav-mobile-dashboard');
    const mSignout = document.getElementById('nav-mobile-signout');
    if (user) {
      isSignedIn = true;
      currentUid = user.uid;
      checkProStatus(user.uid, user.email);
      if (signinBtn) signinBtn.style.display = 'none';
      if (mSignin) mSignin.style.display = 'none';
      if (mDash) mDash.style.display = '';
      if (mSignout) mSignout.style.display = '';
      ['hero-signup-cta','hero-free-note','cta-bar-signup','cta-bar-sub'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
      dashboard.style.display = '';
      if (signoutBtn) signoutBtn.style.display = '';
      clearTimeout(fwTimer);
      updateUsesBanner();
      initChatPanel();
      initCheckerPanel();
      initAudioPanel();
      initHwPanel();
    } else {
      isSignedIn = false;
      initCheckerPanel();
      initAudioPanel();
      initHwPanel();
      currentUid = null;
      if (signoutBtn) signoutBtn.style.display = 'none';
      if (mDash) mDash.style.display = 'none';
      if (mSignout) mSignout.style.display = 'none';
      dashboard.style.display = 'none';
      updateUsesBanner();
      if (!sessionStorage.getItem('fw-dismissed')) {
        fwTimer = setTimeout(() => {
          document.getElementById('firewall-popup').classList.add('active');
        }, 15000);
      }
    }
  });

  function toggleProductsMenu() {
    document.getElementById('products-dropdown').classList.toggle('open');
  }
  function closeProductsMenu() {
    document.getElementById('products-dropdown').classList.remove('open');
  }
  document.addEventListener('click', e => {
    if (!document.getElementById('products-dropdown').contains(e.target)) closeProductsMenu();
  });

  function toggleSideNav() {
    const panel = document.getElementById('sidenav-panel');
    const overlay = document.getElementById('sidenav-overlay');
    const open = panel.style.transform === 'translateX(0%)' || panel.style.transform === 'translateX(0px)' || panel.style.transform === 'translateX(0)';
    panel.style.transform = open ? 'translateX(-100%)' : 'translateX(0)';
    overlay.style.display = open ? 'none' : 'block';
  }
  function closeSideNav() {
    document.getElementById('sidenav-panel').style.transform = 'translateX(-100%)';
    document.getElementById('sidenav-overlay').style.display = 'none';
  }

  function toggleMobileMenu() {
    const m = document.getElementById('nav-mobile-menu');
    m.classList.toggle('open');
    document.body.style.overflow = m.classList.contains('open') ? 'hidden' : '';
  }
  function closeMobileMenu() {
    document.getElementById('nav-mobile-menu').classList.remove('open');
    document.body.style.overflow = '';
  }
  function scrollToConverter() {
    const el = document.getElementById('youtube-summarizer');
    if (el) el.scrollIntoView({ behavior: 'smooth' });
  }

  function signOut() {
    firebase.auth().signOut().then(() => { window.location.href = 'index.html'; });
  }

  function dismissFirewall() {
    sessionStorage.setItem('fw-dismissed', '1');
    document.getElementById('firewall-popup').classList.remove('active');
  }

  // ── HISTORY ──
  function saveToHistory(type, source, title, content) {
    if (!isSignedIn || !currentUid) return;
    try {
      const key = 'gn-history-' + currentUid;
      const arr = JSON.parse(localStorage.getItem(key) || '[]');
      arr.push({ id: Date.now() + '_' + Math.random().toString(36).slice(2,6), type, source, title, content, date: new Date().toISOString() });
      localStorage.setItem(key, JSON.stringify(arr));
    } catch {}
  }

  async function getVideoTitle(url) {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      if (res.ok) { const d = await res.json(); return d.title || url; }
    } catch {}
    return url;
  }

  function showSavedBadge(id) {
    const badge = document.getElementById(id);
    if (!badge) return;
    badge.classList.add('show');
  }

  // ── AI TUTOR CHAT ──
  let chatOpen = false;
  let chatHistory = [];

  // drag chat window
  (function() {
    let dragging = false, ox = 0, oy = 0;
    document.addEventListener('mousedown', function(e) {
      const hdr = e.target.closest('.chat-header');
      if (!hdr || e.target.closest('button')) return;
      const win = document.getElementById('chat-window');
      const rect = win.getBoundingClientRect();
      // switch to top/left positioning
      win.style.bottom = 'auto';
      win.style.top = rect.top + 'px';
      win.style.left = rect.left + 'px';
      ox = e.clientX - rect.left;
      oy = e.clientY - rect.top;
      dragging = true;
      hdr.classList.add('dragging');
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      const win = document.getElementById('chat-window');
      const hdr = win.querySelector('.chat-header');
      let newLeft = e.clientX - ox;
      let newTop  = e.clientY - oy;
      newLeft = Math.max(0, Math.min(newLeft, window.innerWidth  - win.offsetWidth));
      newTop  = Math.max(0, Math.min(newTop,  window.innerHeight - win.offsetHeight));
      win.style.left = newLeft + 'px';
      win.style.top  = newTop  + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (!dragging) return;
      dragging = false;
      const hdr = document.querySelector('.chat-header');
      if (hdr) hdr.classList.remove('dragging');
    });
  })();

  // resize chat window
  (function() {
    let resizing = false, startX, startY, startW, startH;
    document.addEventListener('mousedown', function(e) {
      if (!e.target.closest('#chat-resize')) return;
      const win = document.getElementById('chat-window');
      resizing = true;
      startX = e.clientX; startY = e.clientY;
      startW = win.offsetWidth; startH = win.offsetHeight;
      e.preventDefault();
    });
    document.addEventListener('mousemove', function(e) {
      if (!resizing) return;
      const win = document.getElementById('chat-window');
      const newW = Math.max(300, Math.min(startW + (e.clientX - startX), 520));
      const newH = Math.max(380, Math.min(startH + (e.clientY - startY), 680));
      win.style.width  = newW + 'px';
      win.style.height = newH + 'px';
    });
    document.addEventListener('mouseup', function() { resizing = false; });
  })();

  let chatCollapsed = false;
  function toggleChatCollapse() {
    const win = document.getElementById('chat-window');
    chatCollapsed = !chatCollapsed;
    win.classList.toggle('collapsed', chatCollapsed);
    const poly = document.querySelector('#chat-collapse-icon polyline');
    if (poly) poly.setAttribute('points', chatCollapsed ? '6 9 12 15 18 9' : '18 15 12 9 6 15');
  }

  function toggleChat() {
    chatOpen = !chatOpen;
    const win = document.getElementById('chat-window');
    win.classList.toggle('open', chatOpen);
    if (chatOpen) {
      initChatPanel();
      if (isSignedIn) setTimeout(() => document.getElementById('chat-input').focus(), 50);
    }
  }

  function initChatPanel() {
    const locked   = document.getElementById('chat-locked');
    const messages = document.getElementById('chat-messages');
    const inputRow = document.getElementById('chat-input-row');
    locked.style.display   = 'none';
    messages.style.display = '';
    inputRow.style.display = '';
  }

  function clearChat() {
    chatHistory = [];
    const msgs = document.getElementById('chat-messages');
    msgs.innerHTML = '<div class="chat-msg ai"><div class="chat-msg-av">🧠</div><div class="chat-bubble">Hi! I\'m your AI study tutor. Ask me anything — concepts, homework help, exam prep, or tough topics. I\'m here to help! 📚</div></div>';
  }

  function chatKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  }

  function chatAutoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  }

  function appendMsg(role, html) {
    const msgs = document.getElementById('chat-messages');
    const wrap = document.createElement('div');
    wrap.className = `chat-msg ${role}`;
    wrap.innerHTML = role === 'ai'
      ? `<div class="chat-msg-av">🧠</div><div class="chat-bubble">${html}</div>`
      : `<div class="chat-bubble">${html}</div>`;
    msgs.appendChild(wrap);
    msgs.scrollTop = msgs.scrollHeight;
    return wrap;
  }

  let _chatAdUnlocked = false;
  async function sendChat() {
    if (!isPro && !_chatAdUnlocked) {
      showHwAdGated(() => { _chatAdUnlocked = true; sendChat(); });
      return;
    }
    const input = document.getElementById('chat-input');
    const text = input.value.trim();
    if (!text) return;
    const btn = document.getElementById('chat-send-btn');
    input.value = ''; input.style.height = 'auto'; btn.disabled = true;
    appendMsg('user', text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n/g,'<br>'));
    chatHistory.push({ role: 'user', content: text });
    if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
    const typingWrap = appendMsg('ai', '<div class="typing-dots"><div class="typing-dot"></div><div class="typing-dot"></div><div class="typing-dot"></div></div>');
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: chatHistory })
      });
      const data = await res.json();
      typingWrap.remove();
      if (!res.ok) throw new Error(data.error || 'Something went wrong.');
      const reply = data.reply;
      chatHistory.push({ role: 'assistant', content: reply });
      appendMsg('ai', reply.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/\n\n/g,'</p><p>').replace(/\n/g,'<br>').replace(/\*\*(.*?)\*\*/g,'<strong>$1</strong>'));
    } catch (e) {
      typingWrap.remove();
      chatHistory.pop(); // remove the failed user message so they can retry
      appendMsg('ai', '⚠ ' + (e.message.includes('fetch') ? 'Connection error — please try again.' : e.message));
    } finally {
      btn.disabled = false;
      input.focus();
    }
  }

  // ── CAROUSEL ──
  let currentPanel = 0;
  const PANEL_COUNT = 9; // 0:YT 1:Lyrics 2:Highlighter 3:Homework 4:Citation 5:Writing 6:Upload 7:Voice 8:Checker
  function goToPanel(n) {
    currentPanel = Math.max(0, Math.min(PANEL_COUNT - 1, n));
    document.getElementById('conv-track').style.transform = `translateX(-${currentPanel * 100}%)`;
    document.querySelectorAll('.panel-pill').forEach((p, i) => p.classList.toggle('active', i === currentPanel));
    document.getElementById('panel-arrow-left').disabled  = currentPanel === 0;
    document.getElementById('panel-arrow-right').disabled = currentPanel === PANEL_COUNT - 1;
    const activePill = document.querySelectorAll('.panel-pill')[currentPanel];
    if (activePill) activePill.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    document.querySelectorAll('#tool-grid .tool-card').forEach(c => c.classList.toggle('tcard-active', parseInt(c.dataset.panel) === currentPanel));
    resizeCarousel();
  }

  function resizeCarousel() {
    // Filter out display:none panels (e.g. hidden flashcard-panel) so index matches flex position
    const panels = Array.from(document.querySelectorAll('#conv-track > .conv-panel'))
      .filter(p => p.style.display !== 'none');
    const active = panels[currentPanel];
    if (!active) return;
    document.querySelector('.conv-carousel').style.height = active.scrollHeight + 'px';
  }

  // ── UPLOAD PANEL ──
  let uploadedText = '';
  let uploadCurrentMode = 'summarize';
  let uploadNoteStyle = 'auto';
  let whwMode = 'image';
  let whwImageB64 = null;
  let whwImageMime = null;

  function setWhwTab(mode) {
    whwMode = mode;
    document.getElementById('whw-tab-image').classList.toggle('hw-tab-active', mode === 'image');
    document.getElementById('whw-tab-text').classList.toggle('hw-tab-active', mode === 'text');
    document.getElementById('whw-dropzone').style.display = mode === 'image' ? '' : 'none';
    document.getElementById('whw-preview').style.display = mode === 'image' && whwImageB64 ? '' : 'none';
    document.getElementById('whw-text-area').style.display = mode === 'text' ? '' : 'none';
    const btn = document.getElementById('writing-btn');
    if (btn) btn.disabled = mode === 'image' ? !whwImageB64 : (document.getElementById('whw-text-input').value.trim().length < 5);
  }

  function whwLoadImage(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = e => {
      whwImageB64 = e.target.result.split(',')[1];
      whwImageMime = file.type;
      document.getElementById('whw-preview-img').src = e.target.result;
      document.getElementById('whw-preview').style.display = '';
      document.getElementById('whw-dropzone').style.display = 'none';
      const btn = document.getElementById('writing-btn');
      if (btn) btn.disabled = false;
    };
    reader.readAsDataURL(file);
  }

  const NSP_STYLES = [
    {key:'detailed',label:'📋 Detailed'},{key:'outline',label:'📑 Outline'},{key:'cornell',label:'🗂️ Cornell'},
    {key:'mindmap',label:'🧠 Mind Map'},{key:'summary',label:'📄 Summary'},{key:'problem',label:'🔬 Problem-Solving'},
    {key:'exam',label:'📝 Exam Review'},{key:'comparison',label:'📊 Comparison'},{key:'boxing',label:'📦 Boxing'},
    {key:'charting',label:'📈 Charting'},{key:'mapping',label:'🗺️ Mapping'},{key:'qec',label:'❓ Q/E/C'}
  ];

  function nspSearch(q) {
    const dd = document.getElementById('nsp-dropdown');
    const list = q.trim() === ''
      ? NSP_STYLES
      : NSP_STYLES.filter(s => s.label.toLowerCase().includes(q.toLowerCase()) || s.key.toLowerCase().includes(q.toLowerCase()));
    if (!list.length) { dd.style.display = 'none'; return; }
    dd.innerHTML = list.map(s => '<div class="nsp-drop-item" onmousedown="nspSelect(\''+s.key+'\',\''+s.label+'\')">'+s.label+'</div>').join('');
    dd.style.display = '';
  }

  function nspSelect(key, label) {
    uploadNoteStyle = key;
    const inp = document.getElementById('nsp-search');
    if (inp) inp.value = label;
    const dd = document.getElementById('nsp-dropdown');
    if (dd) dd.style.display = 'none';
  }

  document.addEventListener('click', function(e) {
    if (!e.target.closest('#notes-style-picker')) {
      const dd = document.getElementById('nsp-dropdown');
      if (dd) dd.style.display = 'none';
    }
  });

  function setNoteStyle(style, el) {
    uploadNoteStyle = style;
  }

  function setUpMode(chip, label) {
    document.querySelectorAll('#upload-chips .yt-chip').forEach(c => c.classList.remove('yt-chip-active'));
    chip.classList.add('yt-chip-active');
    document.getElementById('up-mode-label').textContent = label;
    const modeMap = { 'with Summary':'summarize','with Notes':'notes','with Quizzes':'quizzes','with Flashcards':'flashcards' };
    uploadCurrentMode = modeMap[label] || 'summarize';
    document.getElementById('upload-summary-box').className = 'summary-box';
    document.getElementById('upload-fc-result').style.display = 'none';
    const upBadge = document.getElementById('upload-saved-badge'); if (upBadge) upBadge.classList.remove('show');
    const picker = document.getElementById('notes-style-picker');
    if (picker) picker.style.display = uploadCurrentMode === 'notes' ? '' : 'none';
    if (uploadCurrentMode === 'notes') {
      uploadNoteStyle = 'auto';
      const inp = document.getElementById('nsp-search');
      if (inp) inp.value = '';
      const dd = document.getElementById('nsp-dropdown');
      if (dd) dd.style.display = 'none';
    }
    const spacer = document.getElementById('upload-spacer');
    if (spacer) spacer.style.display = uploadCurrentMode === 'notes' ? 'none' : '';
    const btn = document.getElementById('upload-btn');
    if (btn) btn.textContent = isPro ? 'Convert →' : '▶ Convert with Ads →';
  }

  function saveNotesToNotepad(panel) {
    const textEl = document.getElementById(panel === 'upload' ? 'upload-summary-text' : 'summary-text');
    const titleEl = textEl?.querySelector('.rn-title');
    const title = titleEl?.textContent || document.getElementById(panel === 'upload' ? 'upload-summary-label' : 'summary-label')?.textContent || 'AI Notes';
    const content = '<h2>' + (titleEl?.textContent || title) + '</h2>' + (textEl?.innerHTML || '');
    const btn = document.getElementById(panel === 'upload' ? 'upload-save-notes-btn' : 'yt-save-notes-btn');
    try {
      let notes = [];
      try { notes = JSON.parse(localStorage.getItem('gn-notepad-notes') || '[]'); } catch {}
      const newNote = { id: Date.now().toString(36) + Math.random().toString(36).slice(2,7), title, content, created: Date.now(), updated: Date.now() };
      notes.unshift(newNote);
      localStorage.setItem('gn-notepad-notes', JSON.stringify(notes));
      if (btn) { btn.textContent = '✓ Saved!'; btn.classList.add('saved'); setTimeout(() => { btn.textContent = '📝 Save to Notes'; btn.classList.remove('saved'); }, 2500); }
      window.open('notepad.html', '_blank');
    } catch(e) { alert('Could not save: ' + e.message); }
  }

  function tryLockedUpMode(chip, label) {
    setUpMode(chip, label);
  }

  const VIDEO_EXTS = ['mp4','mov','webm','mkv'];

  async function handleFileSelect(file) {
    if (!file) return;
    const ext = file.name.split('.').pop().toLowerCase();
    const isVideo = VIDEO_EXTS.includes(ext);
    if (!['pdf','docx','pptx','txt'].includes(ext) && !isVideo) {
      alert('Please upload a PDF, DOCX, PPTX, TXT, MP4, MOV, or WebM file.');
      return;
    }
    const icons = { pdf: '📕', docx: '📘', pptx: '📊', txt: '📄', mp4: '🎬', mov: '🎬', webm: '🎬', mkv: '🎬' };
    document.getElementById('file-chosen-icon').textContent = icons[ext] || '📄';
    document.getElementById('file-chosen-name').textContent = file.name;
    const sizeMB = file.size / 1024 / 1024;
    document.getElementById('file-chosen-size').textContent = sizeMB >= 1
      ? sizeMB.toFixed(1) + ' MB'
      : (file.size / 1024).toFixed(1) + ' KB';
    document.getElementById('file-chosen').classList.add('show');
    document.getElementById('upload-zone').style.display = 'none';
    const btn = document.getElementById('upload-btn');

    if (isVideo) {
      if (file.size > 25 * 1024 * 1024) {
        alert('Video must be under 25 MB. Please trim or compress it first.');
        removeFile();
        return;
      }
      btn.textContent = '🎬 Transcribing video…';
      btn.disabled = true;
      try {
        const base64 = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = e => resolve(e.target.result.split(',')[1]);
          reader.onerror = () => reject(new Error('Could not read file.'));
          reader.readAsDataURL(file);
        });
        const mimeType = file.type || 'video/mp4';
        const r = await fetch('/api/transcribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ audio: base64, mimeType })
        });
        const data = await r.json();
        if (!r.ok || !data.transcript) throw new Error(data.error || 'Transcription failed');
        uploadedText = data.transcript;
        btn.textContent = 'Convert →';
        btn.disabled = false;
      } catch (e) {
        btn.textContent = 'Convert →';
        btn.disabled = false;
        alert('Could not transcribe video: ' + e.message);
        removeFile();
      }
    } else {
      btn.textContent = ext === 'docx' ? 'Running OCR… (may take ~30s)' : ext === 'pptx' ? 'Extracting slides…' : 'Reading file…';
      btn.disabled = true;
      try {
        uploadedText = await readFile(file, ext);
        btn.textContent = 'Convert →';
        btn.disabled = false;
      } catch (e) {
        btn.textContent = 'Convert →';
        btn.disabled = false;
        alert('Could not read file: ' + e.message);
        removeFile();
      }
    }
  }

  function removeFile() {
    uploadedText = '';
    document.getElementById('file-chosen').classList.remove('show');
    document.getElementById('upload-zone').style.display = '';
    document.getElementById('file-input').value = '';
    document.getElementById('upload-summary-box').className = 'summary-box';
  }

  async function readFile(file, ext) {
    if (ext === 'txt') {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Could not read file.'));
        reader.readAsText(file);
      });
    }
    if (ext === 'pdf') {
      if (typeof pdfjsLib === 'undefined') throw new Error('PDF reader not loaded. Please refresh the page.');
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      const buf = await file.arrayBuffer();
      const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
      let text = '';
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        text += content.items.map(s => s.str).join(' ') + '\n';
      }
      if (!text.trim()) throw new Error('This PDF appears to be image-based. Only text PDFs are supported.');
      return text;
    }
    if (ext === 'docx') {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let binary = '';
      for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
      const base64 = btoa(binary);
      const res = await fetch('/api/extract', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: base64 })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not extract text from this DOCX file.');
      return data.text;
    }
    if (ext === 'pptx') {
      if (typeof JSZip === 'undefined') throw new Error('ZIP reader not loaded. Please refresh the page.');
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      const slideNames = Object.keys(zip.files)
        .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => {
          const na = parseInt(a.match(/\d+/)[0]), nb = parseInt(b.match(/\d+/)[0]);
          return na - nb;
        });
      let text = '';
      for (const name of slideNames) {
        const xml = await zip.files[name].async('text');
        const matches = xml.match(/<a:t[^>]*>([^<]+)<\/a:t>/g) || [];
        const slideText = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ').trim();
        if (slideText) text += slideText + '\n\n';
      }
      if (!text.trim()) throw new Error('Could not extract text from this PowerPoint. Make sure it contains text (not just images).');
      return text;
    }
    throw new Error('Unsupported file type.');
  }

  let ufcCards = [];
  let ufcIdx = 0;

  async function uploadConvert() {
    if (!uploadedText) { alert('Please select a file first.'); return; }
    if (!isPro && !_adConvBypass) {
      showHwAdGated(() => { _adConvBypass = true; uploadConvert(); }); return;
    }
    _adConvBypass = false;
    const box = document.getElementById('upload-summary-box');
    const textEl = document.getElementById('upload-summary-text');
    const labelEl = document.getElementById('upload-summary-label');
    const fcResult = document.getElementById('upload-fc-result');
    const btn = document.getElementById('upload-btn');

    if (uploadCurrentMode === 'flashcards') {
      fcResult.style.display = 'none';
      box.className = 'summary-box visible loading';
      textEl.innerHTML = 'Generating flashcards<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
      labelEl.textContent = 'Flashcards';
      btn.disabled = true;
      btn.textContent = 'Generating…';
      try {
        const res = await fetch('/api/summarize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: uploadedText.slice(0, 12000), mode: 'flashcards' })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Server error');
        let cards;
        try { cards = JSON.parse(data.summary); } catch { throw new Error('Invalid flashcard data'); }
        ufcCards = cards;
        ufcIdx = 0;
        box.className = 'summary-box';
        fcResult.style.display = '';
        const card = document.getElementById('ufc-card');
        card.classList.remove('flipped');
        document.getElementById('ufc-front-text').textContent = ufcCards[0].front;
        document.getElementById('ufc-back-text').textContent = ufcCards[0].back;
        document.getElementById('ufc-counter').textContent = `1 / ${ufcCards.length}`;
        document.getElementById('ufc-prev').disabled = true;
        document.getElementById('ufc-next').disabled = ufcCards.length <= 1;
        const uploadedFileName = document.getElementById('file-chosen-name').textContent || 'Document';
        saveToHistory('flashcards', 'Upload', uploadedFileName, data.summary);
      } catch (e) {
        box.className = 'summary-box visible';
        textEl.textContent = '⚠ ' + e.message;
      } finally {
        btn.disabled = false;
        btn.textContent = 'Convert →';
      }
      return;
    }

    box.className = 'summary-box visible loading';
    textEl.innerHTML = 'Processing<span class="dots"><span>.</span><span>.</span><span>.</span></span>';
    btn.disabled = true;
    btn.textContent = 'Converting…';
    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: uploadedText.slice(0, 12000), mode: uploadCurrentMode, noteStyle: uploadCurrentMode === 'notes' ? uploadNoteStyle : undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');
      const labels = { summarize: 'AI Summary', notes: 'AI Notes', quizzes: 'Quiz Questions' };
      labelEl.textContent = labels[uploadCurrentMode] || 'Result';
      if (uploadCurrentMode === 'notes') {
        box.className = 'summary-box visible rn-mode';
        await renderRichNotes(textEl, data.summary);
        const saveBtn = document.getElementById('upload-save-notes-btn');
        if (saveBtn) saveBtn.style.display = '';
      } else {
        textEl.textContent = data.summary;
        box.className = 'summary-box visible';
        const saveBtn = document.getElementById('upload-save-notes-btn');
        if (saveBtn) saveBtn.style.display = 'none';
      }
      const uploadedFileName = document.getElementById('file-chosen-name').textContent || 'Document';
      if (['notes','quizzes','summarize'].includes(uploadCurrentMode)) {
        saveToHistory(uploadCurrentMode, 'Upload', uploadedFileName, data.summary);
        showSavedBadge('upload-saved-badge');
      }
      if (!isSignedIn && uploadCurrentMode === 'summarize') {
        const newUses = parseInt(localStorage.getItem('gn-free-uses') || '0') + 1;
        localStorage.setItem('gn-free-uses', newUses);
        updateUsesBanner();
      }
    } catch (e) {
      box.className = 'summary-box visible';
      textEl.textContent = '⚠ ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Convert →';
    }
  }

  function ufcFlip() {
    document.getElementById('ufc-card').classList.toggle('flipped');
  }

  function ufcNav(dir) {
    if (!ufcCards.length) return;
    ufcIdx = Math.max(0, Math.min(ufcCards.length - 1, ufcIdx + dir));
    const card = document.getElementById('ufc-card');
    card.classList.remove('flipped');
    document.getElementById('ufc-front-text').textContent = ufcCards[ufcIdx].front;
    document.getElementById('ufc-back-text').textContent = ufcCards[ufcIdx].back;
    document.getElementById('ufc-counter').textContent = `${ufcIdx + 1} / ${ufcCards.length}`;
    document.getElementById('ufc-prev').disabled = ufcIdx === 0;
    document.getElementById('ufc-next').disabled = ufcIdx === ufcCards.length - 1;
  }

  function copyUploadResult(e) {
    const text = document.getElementById('upload-summary-text').textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = e.target;
      btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; btn.classList.remove('copied'); }, 2000);
    });
  }

  // ── FLASHCARDS ──
  let fcCards = [];
  let fcIndex = 0;

  function initFlashcardPanel() {
    const locked = document.getElementById('fc-locked');
    const inputArea = document.getElementById('fc-input-area');
    if (!isSignedIn) {
      locked.style.display = '';
      inputArea.style.display = 'none';
      document.getElementById('fc-result').style.display = 'none';
    } else {
      locked.style.display = 'none';
      inputArea.style.display = '';
    }
  }

  function fcCharCount(el) {
    document.getElementById('fc-char-num').textContent = el.value.length;
  }

  async function generateFlashcards() {
    if (!isSignedIn) { document.getElementById('firewall-popup').classList.add('active'); return; }
    const text = document.getElementById('fc-text').value.trim();
    if (!text) { alert('Please paste some text first.'); return; }

    const btn = document.getElementById('fc-btn');
    btn.disabled = true;
    btn.textContent = 'Generating…';
    document.getElementById('fc-result').style.display = 'none';

    try {
      const res = await fetch('/api/summarize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.slice(0, 5000), mode: 'flashcards' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Server error');

      // Parse JSON – strip possible markdown fences
      const raw = data.summary.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim();
      fcCards = JSON.parse(raw);
      if (!Array.isArray(fcCards) || fcCards.length === 0) throw new Error('No cards returned.');
      saveToHistory('flashcards', 'text', 'Flashcard deck · ' + new Date().toLocaleDateString(), JSON.stringify(fcCards));

      fcIndex = 0;
      renderFcCard();
      document.getElementById('fc-result').style.display = '';
    } catch (e) {
      alert('Error: ' + e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Generate Flashcards ✦';
    }
  }

  function renderFcCard() {
    const card = document.getElementById('fc-card');
    card.classList.remove('flipped');
    document.getElementById('fc-front-text').textContent = fcCards[fcIndex].front;
    document.getElementById('fc-back-text').textContent  = fcCards[fcIndex].back;
    document.getElementById('fc-counter').textContent = `${fcIndex + 1} / ${fcCards.length}`;
    document.getElementById('fc-prev').disabled = fcIndex === 0;
    document.getElementById('fc-next').disabled = fcIndex === fcCards.length - 1;
  }

  function flipCard() { document.getElementById('fc-card').classList.toggle('flipped'); }

  function fcNav(dir) {
    fcIndex = Math.max(0, Math.min(fcCards.length - 1, fcIndex + dir));
    renderFcCard();
  }

  // Drag & drop for upload zone
  (function() {
    const zone = document.getElementById('upload-zone');
    if (!zone) return;
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
    zone.addEventListener('drop', e => {
      e.preventDefault(); zone.classList.remove('drag-over');
      const file = e.dataTransfer && e.dataTransfer.files[0];
      if (file) handleFileSelect(file);
    });
  })();

  // ── YOUTUBE SEARCH ──
  async function ytSearch() {
    const q = document.getElementById('yts-input').value.trim();
    if (!q) return;
    const btn    = document.getElementById('yts-btn');
    const status = document.getElementById('yts-status');
    const grid   = document.getElementById('yts-grid');
    btn.disabled = true;
    btn.textContent = '⏳';
    status.style.color = 'var(--muted)';
    status.textContent = 'Searching…';
    grid.innerHTML = '';

    try {
      const r = await fetch('/api/ytsearch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q })
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'Search failed');
      if (!data.videos.length) throw new Error('No results found.');

      status.textContent = '';
      grid.innerHTML = data.videos.map(v => `
        <div class="yts-card" data-vid="${v.id}">
          <div class="yts-thumb">
            <img src="${v.thumb}" alt="" loading="lazy">
            <div class="yts-play-icon">
              <svg width="48" height="48" viewBox="0 0 48 48" fill="none"><circle cx="24" cy="24" r="24" fill="rgba(0,0,0,0.55)"/><polygon points="19,14 38,24 19,34" fill="white"/></svg>
            </div>
            ${v.duration ? `<span class="yts-duration">${v.duration}</span>` : ''}
          </div>
          <div class="yts-info">
            <div class="yts-title">${esc2(v.title)}</div>
            <div class="yts-meta">${esc2(v.channel)}${v.views ? ' · ' + v.views : ''}</div>
            <button class="yts-use-btn">Use this →</button>
          </div>
        </div>`).join('');

      grid.querySelectorAll('.yts-card').forEach(card => {
        const vid = card.dataset.vid;
        const url = 'https://www.youtube.com/watch?v=' + vid;
        card.querySelector('.yts-thumb').addEventListener('click', () => openVidModal(vid));
        card.querySelector('.yts-use-btn').addEventListener('click', () => useVideo(url));
      });
    } catch (e) {
      status.style.color = '#F87171';
      status.textContent = '⚠ ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Search';
    }
  }

  function openVidModal(videoId) {
    document.getElementById('vid-modal-iframe').src =
      'https://www.youtube.com/embed/' + videoId + '?autoplay=1&rel=0';
    document.getElementById('vid-modal').classList.add('open');
  }

  function closeVidModal(e) {
    if (e && document.getElementById('vid-modal-inner').contains(e.target)) return;
    document.getElementById('vid-modal').classList.remove('open');
    document.getElementById('vid-modal-iframe').src = '';
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeVidModal(null);
  });

  // Close search results when clicking outside the search section
  document.addEventListener('click', function(e) {
    const section = document.getElementById('yt-search-section');
    if (section && !section.contains(e.target)) {
      document.getElementById('yts-grid').innerHTML = '';
      document.getElementById('yts-status').textContent = '';
    }
  });

  // ── LYRICS EXTRACTOR ──
  async function fetchSongLyrics() {
    const url    = document.getElementById('music-yt-url').value.trim();
    if (!url) return;
    if (!isPro) { showHwAdGated(() => fetchSongLyrics()); return; }
    const btn    = document.getElementById('music-fetch-btn');
    const status = document.getElementById('music-fetch-status');
    btn.disabled = true;
    btn.textContent = '⏳ Extracting…';
    status.style.display = '';
    status.style.color = 'var(--muted)';
    status.textContent = 'Looking up lyrics…';
    document.getElementById('music-lyrics-result').style.display = 'none';
    try {
      const r = await fetch('/api/lyrics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const raw = await r.text();
      let data;
      try { data = JSON.parse(raw); } catch { throw new Error('Server error. Please try again.'); }
      if (!r.ok) throw new Error(data.error || 'Could not fetch lyrics');
      if (!data.lyrics) throw new Error('No lyrics found. Try a different search or URL.');
      document.getElementById('music-lyrics-text').textContent = data.lyrics;
      document.getElementById('music-lyrics-result').style.display = '';
      const _lyricsTitle = data.songTitle ? (data.artist ? `${data.songTitle} — ${data.artist}` : data.songTitle) : url;
      saveToHistory('lyrics', 'Lyrics', _lyricsTitle, data.lyrics);
      const label = data.artist
        ? `✓ ${data.songTitle} — ${data.artist}`
        : data.songTitle ? `✓ ${data.songTitle}` : '✓ Lyrics extracted.';
      status.style.color = '#4ade80';
      status.textContent = label;
    } catch (e) {
      status.style.color = '#F87171';
      status.textContent = '⚠ ' + e.message;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Extract Lyrics →';
    }
  }

  function copyLyrics() {
    const text = document.getElementById('music-lyrics-text').textContent;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = event.target;
      btn.textContent = '✓ Copied';
      setTimeout(() => btn.textContent = '📋 Copy', 2000);
    });
  }

// ── HASH NAV (from dashboard links) ──
  (function handleHash() {
    const hash = window.location.hash;
    if (!hash) return;
    history.replaceState(null, '', window.location.pathname);
    const section = document.getElementById('youtube-summarizer');
    if (section) section.scrollIntoView({ behavior: 'smooth' });
    if (hash === '#lyrics') setTimeout(() => goToPanel(1), 300);
    else if (hash === '#highlighter') setTimeout(() => goToPanel(2), 300);
    else if (hash === '#homework') setTimeout(() => goToPanel(3), 300);
    else if (hash === '#highlighter') setTimeout(() => goToPanel(1), 300);
    else if (hash === '#homework') setTimeout(() => goToPanel(2), 300);
    else if (hash === '#citation') setTimeout(() => goToPanel(3), 300);
    else if (hash === '#writing') setTimeout(() => goToPanel(4), 300);
    else if (hash === '#upload') setTimeout(() => goToPanel(5), 300);
    else if (hash === '#flashcards') setTimeout(() => goToPanel(5), 300);
    else if (hash === '#voice') setTimeout(() => goToPanel(6), 300);
    else if (hash === '#checker') setTimeout(() => goToPanel(7), 300);
    else if (hash === '#lyrics') setTimeout(() => goToPanel(8), 300);
    else if (hash === '#chat') setTimeout(() => { if (!chatOpen) toggleChat(); }, 400);
  })();

  window.addEventListener('load', () => setTimeout(resizeCarousel, 100));
  window.addEventListener('resize', resizeCarousel);

  // ── SCROLL FADE-IN ──────────────────────────────────────────────
  (function() {
    const io = new IntersectionObserver((entries) => {
      entries.forEach(e => {
        if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
      });
    }, { threshold: 0.12 });
    document.querySelectorAll('.fade-up').forEach(el => io.observe(el));
  })();

  // Re-measure whenever any panel content changes (results appearing, etc.)
  const _carouselObs = new MutationObserver(() => resizeCarousel());
  document.addEventListener('DOMContentLoaded', () => {
    const track = document.getElementById('conv-track');
    if (track) _carouselObs.observe(track, { childList: true, subtree: true, attributes: true, characterData: false });
  });
  // Fallback if DOMContentLoaded already fired
  if (document.readyState !== 'loading') {
    const track = document.getElementById('conv-track');
    if (track) _carouselObs.observe(track, { childList: true, subtree: true, attributes: true, characterData: false });
  }
