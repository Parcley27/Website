/* theme for every board page.
   mode: 'auto' (dark between sunset and sunrise, worked out on the device), 'light' or 'dark'
   accent: the signed-in person's own colour, remembered so the first paint is already right */
(function () {
  'use strict';
  var LAT = 49.2606, LON = -123.2460, DEFAULT_ACCENT = '#6fa3ee';
  var de = document.documentElement, listeners = [];

  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- sunrise and sunset (NOAA almanac method, no network needed) ---------- */
  function sunEvent(date, rising) {
    var rad = Math.PI / 180, deg = 180 / Math.PI, zenith = 90.833;
    var y = date.getFullYear(), mo = date.getMonth() + 1, d = date.getDate();
    var n1 = Math.floor(275 * mo / 9), n2 = Math.floor((mo + 9) / 12), n3 = 1 + Math.floor((y - 4 * Math.floor(y / 4) + 2) / 3);
    var n = n1 - n2 * n3 + d - 30, lngHour = LON / 15;
    var t = n + ((rising ? 6 : 18) - lngHour) / 24;
    var m = 0.9856 * t - 3.289;
    var l = (m + 1.916 * Math.sin(m * rad) + 0.02 * Math.sin(2 * m * rad) + 282.634 + 360) % 360;
    var ra = (Math.atan(0.91764 * Math.tan(l * rad)) * deg + 360) % 360;
    ra += Math.floor(l / 90) * 90 - Math.floor(ra / 90) * 90;
    ra /= 15;
    var sinDec = 0.39782 * Math.sin(l * rad), cosDec = Math.cos(Math.asin(sinDec));
    var cosH = (Math.cos(zenith * rad) - sinDec * Math.sin(LAT * rad)) / (cosDec * Math.cos(LAT * rad));
    if (cosH > 1 || cosH < -1) return null;
    var h = (rising ? 360 - Math.acos(cosH) * deg : Math.acos(cosH) * deg) / 15;
    var ut = (h + ra - 0.06571 * t - 6.622 - lngHour + 48) % 24;
    return Date.UTC(y, mo - 1, d) + ut * 3600000;
  }
  function sunToday(date) {
    var rise = sunEvent(date, true), set = sunEvent(date, false);
    if (rise == null || set == null) return null;
    if (set < rise) set += 86400000;     // Vancouver sunset lands after 00:00 UTC
    return { rise: rise, set: set };
  }
  function isNight(ms) {
    var d = new Date(ms), prev = new Date(ms - 86400000), s = sunToday(d), p = sunToday(prev);
    if (!s) return false;
    if (ms >= s.rise && ms < s.set) return false;
    if (p && ms >= p.rise && ms < p.set) return false;
    return true;
  }

  /* ---------- colour helpers ---------- */
  function rgb(hex) { var n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; }
  function lum(c) {
    var a = c.map(function (v) { v /= 255; return v <= .03928 ? v / 12.92 : Math.pow((v + .055) / 1.055, 2.4); });
    return .2126 * a[0] + .7152 * a[1] + .0722 * a[2];
  }
  function contrast(a, b) { var x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); }
  function hex(c) { return '#' + c.map(function (v) { return ('0' + Math.max(0, Math.min(255, Math.round(v))).toString(16)).slice(-2); }).join(''); }
  function mix(a, b, t) { return [0, 1, 2].map(function (i) { return a[i] + (b[i] - a[i]) * t; }); }
  // readable text colour on a solid fill of this colour
  function inkOn(h) { return contrast(rgb(h), [26, 26, 26]) >= contrast(rgb(h), [255, 255, 255]) ? '#1a1a1a' : '#ffffff'; }
  // the colour itself, nudged until it can be used as text on the page background
  function textOn(h, dark) {
    var c = rgb(h), bg = dark ? [0, 0, 0] : [255, 255, 255], toward = dark ? [255, 255, 255] : [0, 0, 0], t = 0;
    while (contrast(mix(c, toward, t), bg) < 4.5 && t < 1) t += .05;
    return hex(mix(c, toward, t));
  }

  /* ---------- state ---------- */
  var accent = DEFAULT_ACCENT;

  function mode() { var m = get('board.themeMode'); return m === 'light' || m === 'dark' ? m : 'auto'; }
  function effective() { var m = mode(); return m === 'auto' ? (isNight(Date.now()) ? 'dark' : 'light') : m; }
  function paintAccent() {
    var s = de.style;
    s.setProperty('--accent', accent);
    s.setProperty('--accent-dim', accent + '99');
    s.setProperty('--ink', inkOn(accent));
    s.setProperty('--accent-text', textOn(accent, effective() === 'dark'));
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', accent);
  }
  function apply(notify) {
    var t = effective(), changed = de.getAttribute('data-theme') !== t;
    de.setAttribute('data-theme', t);
    paintAccent();
    if (notify && changed) listeners.forEach(function (fn) { fn(t); });
  }

  window.BoardTheme = {
    mode: mode,
    isDark: function () { return de.getAttribute('data-theme') === 'dark'; },
    setMode: function (m) { set('board.themeMode', m === 'light' || m === 'dark' ? m : null); apply(false); listeners.forEach(function (fn) { fn(effective()); }); },
    setAccent: function (h) {
      accent = /^#[0-9a-f]{6}$/i.test(h || '') ? h.toLowerCase() : DEFAULT_ACCENT;
      set('board.accent', accent === DEFAULT_ACCENT ? null : accent);
      paintAccent();
    },
    inkOn: inkOn,
    textOn: textOn,
    onChange: function (fn) { listeners.push(fn); },
    sun: function () { return sunToday(new Date()); }
  };

  var saved = get('board.accent');
  if (/^#[0-9a-f]{6}$/i.test(saved || '')) accent = saved;
  apply(false);
  setInterval(function () { apply(true); }, 30000);   // auto mode flips at sunrise and sunset
})();
