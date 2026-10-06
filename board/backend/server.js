// Runs as board-backend.service on 127.0.0.1:4033
//
// - Login by name + password (signed cookie). Members edit their own schedule; the "board" user only views.
// - Serves the merged calendar for everyone: hand-entered events + (optionally) each person's public iCloud
//   calendar, fetched server-side so the feed links never reach a browser.
// - Users live in users.json, events in data/events.json. Both are gitignored.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ical = require('node-ical');
const { RRule } = require('rrule');

const PORT = process.env.PORT || 4033;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const USERS_FILE = process.env.USERS_FILE || path.join(DATA_DIR, 'users.json');
const FEEDS_FILE = process.env.FEEDS_FILE || path.join(__dirname, 'feeds.json');   // optional
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const HOUSE_FILE = path.join(DATA_DIR, 'house.json');     // ticker messages, chores, extra days off (edited by the board login)
const SECRET_FILE = path.join(DATA_DIR, 'secret.key');
const STATIC_DIR = process.env.BOARD_STATIC ? path.resolve(process.env.BOARD_STATIC) : '';   // dev only: also serve the pages from here
const FEED_TTL = 5 * 60 * 1000;                      // how long a fetched feed is reused
const DEFAULT_CLASS = /\b[A-Z]{2,4}[ _-]?\d{3}[A-Z]?\b/;
const TZ_DEFAULT = 'America/Vancouver';

const pad = n => String(n).padStart(2, '0');
const DAY = 86400000;

// ======================================================================
// time
// ======================================================================
// Everything is compared as *wall-clock* time in the board's timezone. Expanding a recurrence in real
// instants drifts an hour across daylight saving (a 9:00 class would land at 8:00 in November), so
// we convert to wall-clock first, expand there, and never convert back.
const fmtCache = {};
function wallParts(date, tz) {
    const f = fmtCache[tz] || (fmtCache[tz] = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'
    }));
    const o = {};
    f.formatToParts(date).forEach(p => { o[p.type] = p.value; });
    return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute };
}
// a wall-clock moment stored as a UTC-fielded number, so plain arithmetic works
const wallMs = (date, tz, dateOnly) => {
    if (dateOnly) return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());   // node-ical builds all-day dates in local time
    const p = wallParts(date, tz);
    return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi);
};
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const hm = ms => { const d = new Date(ms); return pad(d.getUTCHours()) + ':' + pad(d.getUTCMinutes()); };
const text = v => String((v && v.val) || v || '').trim();

// ======================================================================
// iCloud feeds -> per-day events
// ======================================================================
function expand(ics, fromKey, toKey, opts) {
    opts = opts || {};
    const tz = opts.tz || TZ_DEFAULT;
    const classRe = opts.classPattern ? new RegExp(opts.classPattern) : DEFAULT_CLASS;
    const from = Date.parse(fromKey + 'T00:00:00Z'), to = Date.parse(toKey + 'T00:00:00Z') + DAY;   // [from, to)
    const timed = {}, allDay = [];

    const put = (startMs, endMs, title, where) => {
        // one entry per day the event touches; clip at midnight
        for (let day = Math.floor(startMs / DAY) * DAY; day < endMs && day < to; day += DAY) {
            if (day + DAY <= from) continue;
            const s = Math.max(startMs, day), e = Math.min(endMs, day + DAY);
            const item = { start: hm(s), end: e === day + DAY ? '24:00' : hm(e), title, where };
            if (classRe.test(title + ' ' + where)) item.ubc = true;
            (timed[dayKey(day)] = timed[dayKey(day)] || []).push(item);
        }
    };

    const data = ical.sync.parseICS(ics);
    Object.keys(data).forEach(id => {
        const ev = data[id];
        if (!ev || ev.type !== 'VEVENT' || !ev.start || ev.status === 'CANCELLED') return;
        const dateOnly = ev.datetype === 'date';
        const title = text(ev.summary) || '(busy)';
        const where = text(ev.location).split('\n')[0];
        const s0 = wallMs(ev.start, tz, dateOnly);
        const e0 = ev.end ? wallMs(ev.end, tz, dateOnly) : s0 + (dateOnly ? DAY : 0);
        const len = Math.max(e0 - s0, 0);

        const emit = (s, e, t, w) => {
            if (dateOnly) { for (let d = s; d < Math.max(e, s + DAY); d += DAY) if (d >= from && d < to) allDay.push({ date: dayKey(d), name: t }); }
            else if (e >= from && s < to) put(s, e === s ? s + 15 * 60000 : e, t, w);
        };

        if (!ev.rrule) { emit(s0, e0, title, where); return; }

        // recurring: re-run the rule on floating wall-clock time
        const o = Object.assign({}, ev.rrule.origOptions);
        delete o.tzid;
        o.dtstart = new Date(s0);
        if (o.until) o.until = new Date(wallMs(o.until, tz, false));
        const rule = new RRule(o);
        const skip = {};
        Object.values(ev.exdate || {}).forEach(x => { skip[dayKey(wallMs(x, tz, dateOnly))] = 1; });
        const moved = {};
        Object.values(ev.recurrences || {}).forEach(r => { if (r.recurrenceid) moved[dayKey(wallMs(r.recurrenceid, tz, dateOnly))] = r; });

        rule.between(new Date(from - len - DAY), new Date(to), true).forEach(d => {
            const s = d.getTime(), k = dayKey(s);
            if (moved[k] || skip[k]) return;     // moved ones are emitted below at their new time
            emit(s, s + len, title, where);
        });
        Object.values(ev.recurrences || {}).forEach(r => {
            if (r.status === 'CANCELLED' || !r.start) return;
            const rs = wallMs(r.start, tz, dateOnly), re = r.end ? wallMs(r.end, tz, dateOnly) : rs;
            emit(rs, re, text(r.summary) || title, text(r.location).split('\n')[0] || where);
        });
    });

    const sorted = {};
    Object.keys(timed).sort().forEach(k => { sorted[k] = timed[k].sort((a, b) => a.start.localeCompare(b.start)); });
    return { timed: sorted, allDay: allDay.sort((a, b) => a.date.localeCompare(b.date)) };
}

const feedCache = {};   // url -> { at, text }
async function getFeed(url) {
    const u = url.replace(/^webcal/i, 'https');
    const hit = feedCache[u];
    if (hit && Date.now() - hit.at < FEED_TTL) return hit.text;
    try {
        const r = await fetch(u, { headers: { 'User-Agent': 'house-board/1.0' }, signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const body = await r.text();
        feedCache[u] = { at: Date.now(), text: body };
        return body;
    } catch (e) {
        if (hit) return hit.text;   // stale beats nothing
        throw e;
    }
}

// ======================================================================
// hand-entered events
// ======================================================================
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const toMin = s => +s.slice(0, 2) * 60 + +s.slice(3);

// returns { ev } or { error }. Only known fields are kept.
function validateEvent(b) {
    if (!b || typeof b !== 'object') return { error: 'Bad request' };
    const title = String(b.title || '').trim(), where = String(b.where || '').trim();
    if (!title || title.length > 60) return { error: 'Give the event a name (60 characters max)' };
    if (where.length > 60) return { error: 'Location is too long (60 characters max)' };
    if (!TIME.test(b.start || '')) return { error: 'Pick a start time' };
    if (!(TIME.test(b.end || '') || b.end === '24:00')) return { error: 'Pick an end time' };
    if (toMin(b.end) <= toMin(b.start)) return { error: 'The end time has to be after the start' };
    const ev = { title, where, start: b.start, end: b.end };
    if (b.ubc) ev.ubc = true;
    if (b.date) {
        const d = DATE.test(b.date) && new Date(b.date + 'T00:00:00Z');
        if (!d || isNaN(d) || d.toISOString().slice(0, 10) !== b.date) return { error: 'Pick a valid date' };   // rejects 2026-02-31, which Date would roll over
        ev.date = b.date;
    } else {
        const days = Array.isArray(b.days) ? b.days.map(Number) : [];
        if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'Pick at least one day' };
        ev.days = Array.from(new Set(days)).sort();
    }
    return { ev };
}

// one person's hand-entered events, as { 'YYYY-MM-DD': [...] } for fromKey..toKey
function manualByDay(events, fromKey, toKey) {
    const out = {};
    for (let ms = Date.parse(fromKey + 'T00:00:00Z'); ms <= Date.parse(toKey + 'T00:00:00Z'); ms += DAY) {
        const k = dayKey(ms), dow = new Date(ms).getUTCDay();
        const today = events.filter(e => e.date ? e.date === k : (e.days || []).indexOf(dow) > -1)
            .map(e => { const o = { start: e.start, end: e.end, title: e.title, where: e.where || '' }; if (e.ubc) o.ubc = true; return o; });
        if (today.length) out[k] = today;
    }
    return out;
}

// ======================================================================
// house-wide settings (edited by the board login)
// ======================================================================
const EMPTY_HOUSE = { notices: [], chores: [], closures: [] };
const validDate = v => { const d = DATE.test(v || '') && new Date(v + 'T00:00:00Z'); return !!d && !isNaN(d) && d.toISOString().slice(0, 10) === v; };
const newId = () => crypto.randomBytes(6).toString('hex');

// returns { house } or { error }. Only known fields are kept; ids are kept if valid, else minted.
function validateHouse(b) {
    if (!b || typeof b !== 'object') return { error: 'Bad request' };
    const list = k => Array.isArray(b[k]) ? b[k] : [];
    if (list('notices').length > 100 || list('chores').length > 100 || list('closures').length > 100) return { error: 'Too many entries. Delete a few first.' };
    const idOf = x => /^[0-9a-f]{12}$/.test(x.id || '') ? x.id : newId();
    const house = { notices: [], chores: [], closures: [] };

    for (const n of list('notices')) {
        const text = String(n.text || '').trim(), tag = String(n.tag || 'INFO').trim().toUpperCase();
        if (!text || text.length > 140) return { error: 'Each ticker message needs text (140 characters max)' };
        if (!/^[A-Z]{2,6}$/.test(tag)) return { error: 'Tag must be 2 to 6 letters' };
        const o = { id: idOf(n), tag, text };
        if (n.date) {
            if (!validDate(n.date)) return { error: 'Pick a valid date for "' + text.slice(0, 30) + '"' };
            o.date = n.date;
            if (n.from || n.to) {
                if (!TIME.test(n.from || '') || !TIME.test(n.to || '')) return { error: 'Give both a start and an end time, or neither' };
                if (toMin(n.to) <= toMin(n.from)) return { error: 'The end time has to be after the start' };
                o.from = n.from; o.to = n.to;
            }
            const ahead = Number(n.ahead || 0);
            if (!Number.isInteger(ahead) || ahead < 0 || ahead > 14) return { error: '"Show ahead" is 0 to 14 days' };
            if (ahead) o.ahead = ahead;
        }
        house.notices.push(o);
    }
    for (const c of list('chores')) {
        const text = String(c.text || '').trim(), days = Array.isArray(c.days) ? c.days.map(Number) : [];
        if (!text || text.length > 100) return { error: 'Each chore needs text (100 characters max)' };
        if (!days.length || days.some(d => !Number.isInteger(d) || d < 0 || d > 6)) return { error: 'Pick at least one day for "' + text.slice(0, 30) + '"' };
        house.chores.push({ id: idOf(c), text, days: Array.from(new Set(days)).sort() });
    }
    for (const c of list('closures')) {
        const name = String(c.name || '').trim();
        if (!name || name.length > 60) return { error: 'Each day off needs a name (60 characters max)' };
        if (!validDate(c.date)) return { error: 'Pick a valid date for "' + name.slice(0, 30) + '"' };
        house.closures.push({ id: idOf(c), date: c.date, name, ubc: !!c.ubc });
    }
    return { house };
}

// what the board needs: notices carry a computed showFrom, sorted by date
function houseForBoard(h) {
    const notices = (h.notices || []).map(n => {
        const o = { tag: n.tag, text: n.text };
        if (n.date) {
            o.date = n.date; if (n.from) { o.from = n.from; o.to = n.to; }
            if (n.ahead) o.showFrom = dayKey(Date.parse(n.date + 'T00:00:00Z') - n.ahead * DAY);
        }
        return o;
    });
    return { notices, chores: h.chores || [], closures: h.closures || [] };
}

// ======================================================================
// users, passwords, sessions
// ======================================================================
function hashPassword(pw) {
    const salt = crypto.randomBytes(16);
    return 'scrypt$' + salt.toString('hex') + '$' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
const DUMMY_HASH = hashPassword('not-a-real-password');
function checkPassword(pw, stored) {
    const p = String(stored || DUMMY_HASH).split('$');
    const calc = crypto.scryptSync(pw, Buffer.from(p[1], 'hex'), 32), want = Buffer.from(p[2], 'hex');
    return crypto.timingSafeEqual(calc, want) && !!stored;
}

function readJson(file, fallback) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
function writeJson(file, obj) {   // write-then-rename so a crash never leaves half a file
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
}
const loadUsers = () => readJson(USERS_FILE, { users: [] });
const isMember = u => u.role !== 'board';
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');

let SECRET;
function secret() {
    if (SECRET) return SECRET;
    try { SECRET = fs.readFileSync(SECRET_FILE); }
    catch (e) {
        SECRET = crypto.randomBytes(32);
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(SECRET_FILE, SECRET, { mode: 0o600 });
    }
    return SECRET;
}
const sign = b => crypto.createHmac('sha256', secret()).update(b).digest('base64url');
function makeToken(user) {
    const days = isMember(user) ? 30 : 180;   // the wall display stays signed in for months
    const body = Buffer.from(JSON.stringify({ u: user.id, exp: Date.now() + days * DAY })).toString('base64url');
    return { value: body + '.' + sign(body), maxAge: days * 86400 };
}
function readToken(tok) {
    const [body, sig] = String(tok || '').split('.');
    if (!body || !sig) return null;
    const a = Buffer.from(sig), b = Buffer.from(sign(body));
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); return p.exp > Date.now() ? p : null; } catch (e) { return null; }
}
const cookieOf = req => { const m = /(?:^|;\s*)hb=([^;]+)/.exec(req.headers.cookie || ''); return m ? m[1] : ''; };
function setSession(req, res, user) {
    const t = makeToken(user), secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
    res.setHeader('Set-Cookie', 'hb=' + t.value + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + t.maxAge + secure);
}
function clearSession(res) { res.setHeader('Set-Cookie', 'hb=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0'); }
function currentUser(req) {
    const p = readToken(cookieOf(req));
    return p ? loadUsers().users.filter(u => u.id === p.u)[0] || null : null;
}

// slow down password guessing: 10 misses per 15 minutes per address
const misses = {};
const clientIp = req => (req.socket.remoteAddress === '127.0.0.1' || req.socket.remoteAddress === '::1') && req.headers['x-real-ip'] || req.socket.remoteAddress;
function tooMany(ip) { const m = misses[ip]; return !!m && m.until > Date.now() && m.n >= 10; }
function miss(ip) { const m = misses[ip]; if (!m || m.until < Date.now()) misses[ip] = { n: 1, until: Date.now() + 15 * 60000 }; else m.n++; }

const publicUser = u => ({ id: u.id, name: u.name, role: isMember(u) ? 'member' : 'board', color: u.color || '', birthday: u.birthday || '' });

// ======================================================================
// the merged calendar
// ======================================================================
let built = { at: 0, days: 0, body: null };
const invalidate = () => { built.body = null; };

async function build(days) {
    if (built.body && built.days === days && Date.now() - built.at < 60000) return built.body;
    const feeds = readJson(FEEDS_FILE, {});
    const tz = feeds.tz || TZ_DEFAULT;
    const today = wallMs(new Date(), tz, false);
    const fromKey = dayKey(today), toKey = dayKey(today + (days - 1) * DAY);
    const members = loadUsers().users.filter(isMember).sort((a, b) => a.name.localeCompare(b.name));   // alphabetical, always
    const manual = readJson(EVENTS_FILE, {});
    const out = { updated: new Date().toISOString(), tz, from: fromKey, to: toKey, meta: members.map(publicUser), people: {}, holidays: [], house: houseForBoard(readJson(HOUSE_FILE, EMPTY_HOUSE)), errors: {} };

    await Promise.all(members.map(async u => {
        const merged = manualByDay(manual[u.id] || [], fromKey, toKey);
        const url = (feeds.people || {})[u.id];
        if (url) {
            try {
                const fromFeed = expand(await getFeed(url), fromKey, toKey, { tz, classPattern: feeds.classPattern }).timed;
                Object.keys(fromFeed).forEach(k => { merged[k] = (merged[k] || []).concat(fromFeed[k]).sort((a, b) => a.start.localeCompare(b.start)); });
            } catch (e) { out.errors[u.id] = e.message; }
        }
        out.people[u.id] = merged;
    }));
    if (feeds.holidays) {
        try {
            // Apple's list mixes in every province; keep national + BC
            out.holidays = expand(await getFeed(feeds.holidays), fromKey, dayKey(today + 60 * DAY), { tz }).allDay
                .filter(h => !/\((?!BC\))[A-Z]{2}\)\s*$/.test(h.name))
                .map(h => ({ date: h.date, name: h.name.replace(/\s*\(BC\)$/, '') }));
        } catch (e) { out.errors.holidays = e.message; }
    }
    built = { at: Date.now(), days, body: JSON.stringify(out) };
    return built.body;
}

// ======================================================================
// http
// ======================================================================
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
function serveStatic(res, pathname) {
    const file = path.join(STATIC_DIR, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(STATIC_DIR) || /[\\/](backend|node_modules)[\\/]/.test(file.slice(STATIC_DIR.length))) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
        res.end(buf);
    });
}

const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };

function readBody(req) {
    return new Promise((resolve, reject) => {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return reject(Object.assign(new Error('Bad request'), { code: 415 }));
        let size = 0; const chunks = [];
        req.on('data', c => { size += c.length; if (size > 32768) { reject(Object.assign(new Error('Too large'), { code: 413 })); req.destroy(); } else chunks.push(c); });
        req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString() || '{}')); } catch (e) { reject(Object.assign(new Error('Bad request'), { code: 400 })); } });
        req.on('error', reject);
    });
}

async function route(req, res, p, url) {
    const m = req.method;
    if (p === '/health') { res.writeHead(200); return res.end('ok'); }

    if (p === '/login' && m === 'POST') {
        const ip = clientIp(req);
        if (tooMany(ip)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
        const b = await readBody(req);
        const user = loadUsers().users.filter(u => slug(u.name) === slug(b.name || '') || u.id === slug(b.name || ''))[0];
        const stored = user && (user.passwordHash || loadUsers().passwordHash);
        if (!user || !checkPassword(String(b.password || ''), stored)) { miss(ip); return send(res, 401, { error: 'Name or password is wrong' }); }
        setSession(req, res, user);
        return send(res, 200, { user: publicUser(user) });
    }
    if (p === '/logout' && m === 'POST') { clearSession(res); return send(res, 200, { ok: true }); }

    // everything below needs a session
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: 'Sign in' });
    setSession(req, res, user);   // sliding: every visit renews the cookie

    if (p === '/me' && m === 'GET') return send(res, 200, { user: publicUser(user) });
    if (p === '/calendar' && m === 'GET') {
        const days = Math.min(Math.max(parseInt(url.searchParams.get('days'), 10) || 14, 1), 60);
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        return res.end(await build(days));
    }

    if (p === '/house' && m === 'GET') return send(res, 200, { house: readJson(HOUSE_FILE, EMPTY_HOUSE) });
    if (p === '/house' && m === 'PUT') {
        if (isMember(user)) return send(res, 403, { error: 'Only the board login can change these' });
        const r = validateHouse(await readBody(req));
        if (r.error) return send(res, 400, { error: r.error });
        writeJson(HOUSE_FILE, r.house); invalidate();
        return send(res, 200, { house: r.house });
    }

    // members only from here
    if (!isMember(user)) return send(res, 403, { error: 'The board login is view-only' });

    if (p === '/me' && m === 'PATCH') {
        const b = await readBody(req), file = loadUsers(), me = file.users.filter(u => u.id === user.id)[0];
        if (b.color !== undefined) { if (!/^#[0-9a-f]{6}$/i.test(b.color)) return send(res, 400, { error: 'Bad colour' }); me.color = b.color.toLowerCase(); }
        if (b.birthday !== undefined) {
            if (b.birthday !== '') {
                const mm = /^(\d{2})-(\d{2})$/.exec(b.birthday), d = mm && new Date(Date.UTC(2000, +mm[1] - 1, +mm[2]));
                if (!d || d.getUTCMonth() !== +mm[1] - 1) return send(res, 400, { error: 'Bad birthday' });
            }
            me.birthday = b.birthday;
        }
        writeJson(USERS_FILE, file); invalidate();
        return send(res, 200, { user: publicUser(me) });
    }

    if (p === '/events' && m === 'GET') return send(res, 200, { events: readJson(EVENTS_FILE, {})[user.id] || [] });
    if (p === '/events' && m === 'POST') {
        const r = validateEvent(await readBody(req));
        if (r.error) return send(res, 400, { error: r.error });
        const all = readJson(EVENTS_FILE, {}), mine = all[user.id] || [];
        if (mine.length >= 200) return send(res, 400, { error: 'That\'s a lot of events. Delete a few first.' });
        r.ev.id = crypto.randomBytes(6).toString('hex');
        all[user.id] = mine.concat([r.ev]); writeJson(EVENTS_FILE, all); invalidate();
        return send(res, 201, { event: r.ev });
    }
    const em = /^\/events\/([0-9a-f]{12})$/.exec(p);
    if (em && (m === 'PUT' || m === 'DELETE')) {
        const all = readJson(EVENTS_FILE, {}), mine = all[user.id] || [], i = mine.findIndex(e => e.id === em[1]);
        if (i < 0) return send(res, 404, { error: 'Not found' });
        if (m === 'DELETE') mine.splice(i, 1);
        else {
            const r = validateEvent(await readBody(req));
            if (r.error) return send(res, 400, { error: r.error });
            r.ev.id = em[1]; mine[i] = r.ev;
        }
        all[user.id] = mine; writeJson(EVENTS_FILE, all); invalidate();
        return send(res, 200, m === 'DELETE' ? { ok: true } : { event: mine[i] });
    }
    send(res, 404, { error: 'Not found' });
}

function handler(req, res) {
    const url = new URL(req.url, 'http://x');
    if (/^\/api(\/|$)/.test(url.pathname) || !STATIC_DIR) {
        const p = url.pathname.replace(/^\/api(?=\/|$)/, '') || '/';
        return route(req, res, p, url).catch(e => {
            if (e.code && typeof e.code === 'number') return send(res, e.code, { error: e.message });
            console.error(req.method, p, e);
            send(res, 500, { error: 'Something went wrong' });
        });
    }
    serveStatic(res, url.pathname);
}

module.exports = { expand, validateEvent, validateHouse, manualByDay, hashPassword, checkPassword };
if (require.main === module) {
    http.createServer(handler).listen(PORT, '127.0.0.1', () => console.log('board-backend on 127.0.0.1:' + PORT));
}
