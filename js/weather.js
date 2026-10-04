// Small weather widget for the homepage footer (next to the NoteCaptain logo).
//
// Data comes straight from Open-Meteo in the browser — no API key, no server code.
//   Forecast: https://api.open-meteo.com/v1/forecast
// Weather data by Open-Meteo.com (CC BY 4.0) — the credit link in the card is required.
//
// Signed-in users only: the widget is completely hidden for a signed-out visitor (no chip, no
// lock, no prompt). It appears once a real account is signed in. No location is asked for and no
// forecast is fetched until then.
//
// Privacy: nothing is requested until the visitor clicks the chip. Clicking it makes the BROWSER
// ask for the location (its own permission pop-up). That is the only way a place is chosen:
// there is no city search and no picker of ours. The place is remembered in this browser only
// (localStorage) and is sent only to Open-Meteo.
// Usage: put <div id="gn-weather"></div> where the chip should appear and load this file.
(function () {
  'use strict';

  var KEY_PLACE = 'gn-weather-place';   // { name, lat, lon }
  var KEY_UNITS = 'gn-weather-units';   // 'us' | 'metric'
  var KEY_CACHE = 'gn-weather-cache';   // { lat, lon, at, data }
  var TTL = 15 * 60 * 1000;             // refetch at most every 15 minutes

  function lsGet(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (e) { return null; } }
  function lsSet(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function lsDel(key) { try { localStorage.removeItem(key); } catch (e) {} }

  var mount, chip, card;
  var state = {
    place: null,       // chosen place, or null
    units: 'metric',
    data: null,        // last forecast (always metric; converted when shown)
    fetchedAt: 0,
    loading: false,
    error: false,
    open: false,
    locating: false,   // true while the browser is being asked for the location
    denied: false,     // the browser did not share a location
    note: '',          // quiet status line in the card
    authed: false      // a real (non-anonymous) account is signed in
  };

  // ── Units ──────────────────────────────────────────────────────────────────
  function defaultUnits() {
    var lang = (navigator.language || 'en-US').toUpperCase();
    return /-(US|LR|MM)$/.test(lang) ? 'us' : 'metric';
  }
  function temp(c) {
    if (c == null || isNaN(c)) return '–';
    return Math.round(state.units === 'us' ? c * 9 / 5 + 32 : c) + '°';
  }
  function wind(kmh) {
    if (kmh == null || isNaN(kmh)) return '–';
    return state.units === 'us' ? Math.round(kmh * 0.621371) + ' mph' : Math.round(kmh) + ' km/h';
  }

  // ── Icons: simple line drawings, mapped from the WMO weather_code ───────────
  var CLOUD = '<path d="M7 16h10a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 6.2 10.3 3 3 0 0 0 7 16z"/>';
  var CLOUD_LOW = '<path d="M8.5 18H17a3 3 0 0 0 .3-5.98A4.8 4.8 0 0 0 8 13.2 2.5 2.5 0 0 0 8.5 18z"/>';
  var ICONS = {
    'clear-day': '<circle cx="12" cy="12" r="4"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4"/>',
    'clear-night': '<path d="M19.5 14.2A8 8 0 1 1 9.8 4.5a6.3 6.3 0 0 0 9.7 9.7z"/>',
    'partly-day': '<circle cx="8" cy="8" r="3"/><path d="M8 2.5v1.3M2.5 8h1.3M4.1 4.1l.9.9M11.9 4.1l-.9.9"/>' + CLOUD_LOW,
    'partly-night': '<path d="M12.5 7.6A4.6 4.6 0 1 1 7 3a3.6 3.6 0 0 0 5.5 4.6z"/>' + CLOUD_LOW,
    'cloudy': '<path d="M7 18h10a4 4 0 0 0 .5-7.97A6 6 0 0 0 6 11.5 3.5 3.5 0 0 0 7 18z"/>',
    'fog': '<path d="M7 13h10a3.5 3.5 0 0 0 .4-6.98A5.5 5.5 0 0 0 6.2 7.3 3 3 0 0 0 7 13z"/><path d="M5 17h14M7 20.5h10"/>',
    'drizzle': CLOUD + '<path d="M9 19v.6M12 19v.6M15 19v.6"/>',
    'rain': CLOUD + '<path d="M9 18.5l-1 2.5M12.5 18.5l-1 2.5M16 18.5l-1 2.5"/>',
    'snow': CLOUD + '<path d="M9 19.5h.01M12 21h.01M15 19.5h.01M12 18.5h.01"/>',
    'thunder': CLOUD + '<path d="M12.5 17l-2 3h3l-1.5 2.5"/>'
  };
  function kind(code, isDay) {
    if (code === 0) return isDay ? 'clear-day' : 'clear-night';
    if (code === 1 || code === 2) return isDay ? 'partly-day' : 'partly-night';
    if (code === 3) return 'cloudy';
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 57) return 'drizzle';
    if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
    if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
    if (code >= 95) return 'thunder';
    return 'cloudy';
  }
  var LABELS = {
    'clear-day': 'Clear', 'clear-night': 'Clear', 'partly-day': 'Partly cloudy', 'partly-night': 'Partly cloudy',
    'cloudy': 'Cloudy', 'fog': 'Fog', 'drizzle': 'Drizzle', 'rain': 'Rain', 'snow': 'Snow', 'thunder': 'Thunderstorm'
  };
  function icon(k, size) {
    return '<svg class="gn-wx-icon" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICONS[k] || ICONS.cloudy) + '</svg>';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Styles (the page's logbook variables, with light-theme fallbacks) ───────
  function injectStyles() {
    if (document.getElementById('gn-weather-styles')) return;
    var s = document.createElement('style');
    s.id = 'gn-weather-styles';
    s.textContent =
      '#gn-weather { position:relative; display:inline-block; font-family:Inter,system-ui,sans-serif; }' +
      '.gn-wx-chip { display:inline-flex; align-items:center; gap:6px; height:34px; padding:0 12px; border-radius:10px; border:1px solid var(--border,#DCE1E6); background:none; color:var(--text,#0B0F14); font-family:inherit; font-size:0.8rem; font-weight:600; cursor:pointer; white-space:nowrap; max-width:230px; }' +
      '.gn-wx-chip:hover { background:var(--surface2,#EDF0F3); }' +
      '.gn-wx-chip .gn-wx-icon { color:var(--accent,#0F6E7A); flex-shrink:0; }' +
      '.gn-wx-chip-city { overflow:hidden; text-overflow:ellipsis; color:var(--muted,#55606B); font-weight:500; }' +
      '.gn-wx-card { position:absolute; left:0; bottom:calc(100% + 10px); z-index:300; width:320px; max-width:calc(100vw - 32px); padding:16px; background:var(--surface,#fff); color:var(--text,#0B0F14); border:1px solid var(--border,#DCE1E6); border-radius:12px; box-shadow:0 1px 2px rgba(11,15,20,0.06), 0 12px 32px rgba(11,15,20,0.18); text-align:left; font-size:0.84rem; line-height:1.45; }' +
      '.gn-wx-card[hidden] { display:none; }' +
      '.gn-wx-hd { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-bottom:10px; }' +
      '.gn-wx-place { font-family:var(--serif,Georgia,serif); font-size:1.02rem; font-weight:700; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }' +
      '.gn-wx-x { width:28px; height:28px; border:none; background:none; color:var(--muted,#55606B); font-size:1.1rem; line-height:1; border-radius:8px; cursor:pointer; flex-shrink:0; }' +
      '.gn-wx-x:hover { background:var(--surface2,#EDF0F3); color:var(--text,#0B0F14); }' +
      '.gn-wx-now { display:flex; align-items:center; gap:12px; }' +
      '.gn-wx-now .gn-wx-icon { color:var(--accent,#0F6E7A); flex-shrink:0; }' +
      '.gn-wx-temp { font-family:var(--serif,Georgia,serif); font-size:2.3rem; font-weight:700; line-height:1; }' +
      '.gn-wx-cond { font-weight:600; }' +
      '.gn-wx-sub { color:var(--muted,#55606B); font-size:0.8rem; }' +
      '.gn-wx-days { display:grid; grid-template-columns:repeat(5,1fr); gap:4px; margin:14px 0 12px; padding-top:12px; border-top:1px solid var(--border,#DCE1E6); text-align:center; }' +
      '.gn-wx-day { display:flex; flex-direction:column; align-items:center; gap:3px; font-size:0.74rem; }' +
      '.gn-wx-day .gn-wx-icon { color:var(--accent,#0F6E7A); }' +
      '.gn-wx-dname { font-weight:600; }' +
      '.gn-wx-hl { color:var(--text,#0B0F14); }' +
      '.gn-wx-hl span { color:var(--muted,#55606B); }' +
      '.gn-wx-rain { color:var(--muted,#55606B); font-size:0.7rem; }' +
      '.gn-wx-actions { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:10px; }' +
      '.gn-wx-btn { height:30px; padding:0 10px; border-radius:8px; border:1px solid var(--border,#DCE1E6); background:none; color:var(--text,#0B0F14); font-family:inherit; font-size:0.76rem; font-weight:600; cursor:pointer; }' +
      '.gn-wx-btn:hover { background:var(--surface2,#EDF0F3); }' +
      '.gn-wx-btn-primary, .gn-wx-btn-primary:hover { background:var(--primary-bg,#0B0F14); border-color:var(--primary-bg,#0B0F14); color:var(--primary-text,#fff); }' +
      '.gn-wx-btn-primary:hover { opacity:0.88; }' +
      '.gn-wx-note { color:var(--muted,#55606B); font-size:0.78rem; margin-top:8px; min-height:1em; }' +
      '.gn-wx-credit { color:var(--muted,#55606B); font-size:0.7rem; }' +
      '.gn-wx-credit a { color:var(--accent,#0F6E7A); }' +
      // Phones: icon + temperature only, and the card lines up with the left edge of the footer
      // (its positioned parent there) instead of the chip, so it can never run off the screen.
      '@media (max-width:600px) { .gn-wx-chip-city { display:none; } #gn-weather { position:static; } }';
    document.head.appendChild(s);
  }

  // ── Data ────────────────────────────────────────────────────────────────────
  function fresh() { return state.data && (Date.now() - state.fetchedAt) < TTL; }

  // True only for a real account. Works with either Firebase SDK style used on the site.
  function signedIn() {
    try {
      var u = window._fauth ? window._fauth.currentUser : null;
      if (!u && typeof firebase !== 'undefined' && firebase.apps && firebase.apps.length) u = firebase.auth().currentUser;
      return !!(u && !u.isAnonymous);
    } catch (e) { return false; }
  }
  // Re-checks sign-in and updates the widget when it changed.
  function syncAuth() {
    var a = signedIn();
    if (a === state.authed) return;
    state.authed = a;
    if (!a) { state.open = false; state.locating = false; }
    render();
    if (a && state.place && !fresh()) fetchForecast();
  }

  function fetchForecast() {
    if (!state.authed || !state.place || state.loading) return;
    state.loading = true; state.error = false;
    render();
    var p = state.place;
    var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + encodeURIComponent(p.lat) + '&longitude=' + encodeURIComponent(p.lon) +
      '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,is_day' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max&timezone=auto&forecast_days=5';
    fetch(url).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (d) {
      if (!d || !d.current || !d.daily) throw new Error('unexpected response');
      state.data = d; state.fetchedAt = Date.now(); state.loading = false; state.error = false;
      lsSet(KEY_CACHE, { lat: p.lat, lon: p.lon, at: state.fetchedAt, data: d });
      render();
    }).catch(function () {
      state.loading = false; state.error = true;
      render();
    });
  }

  function setPlace(place) {
    state.place = place; state.data = null; state.fetchedAt = 0; state.denied = false; state.note = '';
    lsSet(KEY_PLACE, place);
    lsDel(KEY_CACHE);
    fetchForecast();
  }

  // Asks the browser for the location. This is what shows the browser's own permission pop-up.
  function useMyLocation() {
    if (state.locating) return;
    function fail() {
      state.locating = false;
      if (state.place) { state.note = 'Your browser did not share a location, so this one was kept.'; }
      else { state.denied = true; state.open = true; }
      render();
    }
    if (!navigator.geolocation) { fail(); return; }
    state.locating = true; state.note = '';
    render();
    navigator.geolocation.getCurrentPosition(function (pos) {
      state.locating = false; state.denied = false; state.open = true;
      // Two decimals (~1 km) is plenty for a forecast and keeps the request less precise.
      setPlace({ name: 'My location', lat: Math.round(pos.coords.latitude * 100) / 100, lon: Math.round(pos.coords.longitude * 100) / 100 });
    }, fail, { timeout: 15000, maximumAge: 10 * 60 * 1000 });
  }

  // ── Rendering ───────────────────────────────────────────────────────────────
  function renderChip() {
    var html, label;
    if (state.locating) {
      html = icon('partly-day', 16) + '<span>Locating…</span>';
      label = 'Weather: waiting for your browser to share a location';
    } else if (!state.place) {
      html = icon('partly-day', 16) + '<span>Weather</span>';
      label = state.denied ? 'Weather: your browser did not share a location. Open to try again'
                           : 'Weather: your browser will ask to share your location';
    } else if (state.data && !state.error) {
      var c = state.data.current;
      var k = kind(c.weather_code, c.is_day !== 0);
      html = icon(k, 16) + '<span>' + temp(c.temperature_2m) + '</span><span class="gn-wx-chip-city">' + esc(state.place.name) + '</span>';
      label = 'Weather in ' + state.place.name + ': ' + temp(c.temperature_2m) + ', ' + LABELS[k] + '. Open forecast';
    } else if (state.error) {
      html = icon('cloudy', 16) + '<span>Weather unavailable</span>';
      label = 'Weather unavailable. Open to retry';
    } else {
      html = icon('cloudy', 16) + '<span>Loading…</span>';
      label = 'Loading weather';
    }
    chip.innerHTML = html;
    chip.setAttribute('aria-label', label);
    chip.setAttribute('aria-expanded', state.open ? 'true' : 'false');
  }

  // Shown only when the browser did not share a location.
  function deniedHtml() {
    return '<div class="gn-wx-hd"><div class="gn-wx-place">Weather</div><button type="button" class="gn-wx-x" data-wx="close" aria-label="Close weather">×</button></div>' +
      '<div class="gn-wx-sub" style="margin-bottom:12px;">Your browser did not share a location. Allow location for this site in your browser, then try again.</div>' +
      '<div class="gn-wx-actions">' +
        '<button type="button" class="gn-wx-btn gn-wx-btn-primary" data-wx="geo">Try again</button>' +
      '</div>' + creditHtml();
  }

  function creditHtml() {
    return '<div class="gn-wx-credit"><a href="https://open-meteo.com/" target="_blank" rel="noopener">Weather data by Open-Meteo.com</a> (CC BY 4.0)</div>';
  }

  function forecastHtml() {
    var d = state.data, c = d.current, dy = d.daily;
    var k = kind(c.weather_code, c.is_day !== 0);
    var days = '';
    for (var i = 0; i < dy.time.length && i < 5; i++) {
      var name = i === 0 ? 'Today' : new Date(dy.time[i] + 'T12:00:00').toLocaleDateString(undefined, { weekday: 'short' });
      var rain = dy.precipitation_probability_max ? dy.precipitation_probability_max[i] : null;
      days += '<div class="gn-wx-day"><span class="gn-wx-dname">' + esc(name) + '</span>' + icon(kind(dy.weather_code[i], true), 20) +
        '<span class="gn-wx-hl">' + temp(dy.temperature_2m_max[i]) + ' <span>' + temp(dy.temperature_2m_min[i]) + '</span></span>' +
        '<span class="gn-wx-rain">' + (rain == null ? '–' : Math.round(rain) + '% rain') + '</span></div>';
    }
    return '<div class="gn-wx-hd"><div class="gn-wx-place">' + esc(state.place.name) + '</div><button type="button" class="gn-wx-x" data-wx="close" aria-label="Close weather">×</button></div>' +
      '<div class="gn-wx-now">' + icon(k, 44) + '<div><div class="gn-wx-temp">' + temp(c.temperature_2m) + '</div></div>' +
      '<div><div class="gn-wx-cond">' + LABELS[k] + '</div>' +
      '<div class="gn-wx-sub">Feels like ' + temp(c.apparent_temperature) + ' · Wind ' + wind(c.wind_speed_10m) + '</div>' +
      '<div class="gn-wx-sub">Today: high ' + temp(dy.temperature_2m_max[0]) + ', low ' + temp(dy.temperature_2m_min[0]) + '</div></div></div>' +
      '<div class="gn-wx-days">' + days + '</div>' +
      '<div class="gn-wx-actions">' +
        '<button type="button" class="gn-wx-btn" data-wx="units" aria-label="Switch temperature units">' + (state.units === 'us' ? 'Show °C' : 'Show °F') + '</button>' +
        '<button type="button" class="gn-wx-btn" data-wx="geo">Update location</button>' +
        '<button type="button" class="gn-wx-btn" data-wx="remove">Remove</button>' +
      '</div>' + (state.note ? '<div class="gn-wx-note" style="margin:0 0 8px;" aria-live="polite">' + esc(state.note) + '</div>' : '') + creditHtml();
  }

  function unavailableHtml() {
    return '<div class="gn-wx-hd"><div class="gn-wx-place">' + esc(state.place ? state.place.name : 'Weather') + '</div><button type="button" class="gn-wx-x" data-wx="close" aria-label="Close weather">×</button></div>' +
      '<div class="gn-wx-sub" style="margin-bottom:12px;">' + (state.loading ? 'Loading the forecast…' : 'Weather unavailable right now.') + '</div>' +
      '<div class="gn-wx-actions">' +
        (state.loading ? '' : '<button type="button" class="gn-wx-btn gn-wx-btn-primary" data-wx="retry">Retry</button>') +
        '<button type="button" class="gn-wx-btn" data-wx="geo">Update location</button>' +
        '<button type="button" class="gn-wx-btn" data-wx="remove">Remove</button>' +
      '</div>' + creditHtml();
  }

  function renderCard() {
    card.hidden = !state.open;
    if (!state.open) return;
    if (!state.place) card.innerHTML = deniedHtml();
    else if (state.data && !state.error) card.innerHTML = forecastHtml();
    else card.innerHTML = unavailableHtml();
  }

  function render() {
    if (!chip) return;
    // Hidden entirely while signed out.
    mount.style.display = state.authed ? '' : 'none';
    if (!state.authed) { card.hidden = true; return; }
    renderChip(); renderCard();
  }

  // ── Open / close ────────────────────────────────────────────────────────────
  function open() {
    // No place yet: let the browser ask (its own pop-up). Our card only opens afterwards.
    if (!state.place && !state.denied) { useMyLocation(); return; }
    state.open = true;
    if (state.place && !fresh()) fetchForecast();
    render();
  }
  function close(returnFocus) {
    if (!state.open) return;
    state.open = false; state.note = '';
    render();
    if (returnFocus) chip.focus();
  }

  function onCardClick(e) {
    var b = e.target.closest('[data-wx]');
    if (!b) return;
    var act = b.getAttribute('data-wx');
    if (act === 'close') close(true);
    else if (act === 'geo') useMyLocation();
    else if (act === 'units') { state.units = state.units === 'us' ? 'metric' : 'us'; lsSet(KEY_UNITS, state.units); render(); }
    else if (act === 'remove') { state.place = null; state.data = null; state.error = false; state.denied = false; state.open = false; lsDel(KEY_PLACE); lsDel(KEY_CACHE); render(); }
    else if (act === 'retry') fetchForecast();
  }

  function init() {
    mount = document.getElementById('gn-weather');
    if (!mount) return;
    injectStyles();

    var u = lsGet(KEY_UNITS);
    state.units = (u === 'us' || u === 'metric') ? u : defaultUnits();
    var p = lsGet(KEY_PLACE);
    if (p && typeof p.lat === 'number' && typeof p.lon === 'number') state.place = { name: String(p.name || 'My location'), lat: p.lat, lon: p.lon };
    var c = lsGet(KEY_CACHE);
    if (state.place && c && c.data && c.lat === state.place.lat && c.lon === state.place.lon) { state.data = c.data; state.fetchedAt = c.at || 0; }

    chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'gn-wx-chip';
    chip.setAttribute('aria-haspopup', 'dialog');
    card = document.createElement('div');
    card.className = 'gn-wx-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Weather forecast');
    card.hidden = true;
    mount.appendChild(chip);
    mount.appendChild(card);

    chip.addEventListener('click', function () {
      syncAuth();
      if (!state.authed) return; // cannot normally happen: the chip is hidden while signed out
      if (state.open) close(false); else open();
    });
    card.addEventListener('click', onCardClick);
    document.addEventListener('click', function (e) {
      if (!state.open) return;
      // composedPath(), not mount.contains(): a click inside the card usually re-renders it, so by
      // the time this runs the clicked button is no longer in the page.
      var path = e.composedPath ? e.composedPath() : [];
      if (path.indexOf(mount) > -1 || mount.contains(e.target)) return;
      close(false);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && state.open) close(true); });

    state.authed = signedIn();
    // Follow sign-in / sign-out. index.html calls window._gnOnAuthChange(user) on every change;
    // the timed checks cover the case where that fired before this hook was in place.
    var prevHook = window._gnOnAuthChange;
    window._gnOnAuthChange = function (user) {
      if (typeof prevHook === 'function') prevHook(user);
      syncAuth();
    };
    setTimeout(syncAuth, 1500);
    setTimeout(syncAuth, 4000);

    render();
    // A remembered place shows automatically for a signed-in user; the cache keeps this to one
    // request per 15 minutes.
    if (state.authed && state.place && !fresh()) fetchForecast();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
