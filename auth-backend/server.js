// Shared sign-in for the password-protected pages (archive, ig, trading, notes, terminal).
//
// nginx asks this service "is this request signed in?" through auth_request (GET /check).
// A browser signs in once on /_auth/login; with "Remember this device" ticked it gets a
// long-lived random token in a cookie, so the password isn't asked for again.
//
//  - Tokens are random, only their SHA-256 is stored, and each one is tied to a single
//    realm (archive / ig / notes / terminal) and one username. A stolen archive cookie
//    does nothing on the terminal.
//  - Passwords are checked against the same .htpasswd files nginx used before (with
//    `htpasswd -v`), so changing the master password (site-auth-sync) still works as it did.
//  - A valid HTTP Basic header is still accepted by /check, so curl and scripts keep working.
//  - Revoke a device with "sign out" on the login page, or everything with /_auth/logout-all.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const PORT = parseInt(process.env.PORT || '4034', 10);
const STATE_DIR = process.env.STATE_DIRECTORY || path.join(__dirname, 'data');
const STORE = path.join(STATE_DIR, 'devices.json');
const DAY = 86400000;

const REALMS = {
    archive:  { label: 'Family Archive', file: '/etc/nginx/.htpasswd-archive', days: 90 },
    ig:       { label: 'IG Tracker and Trading', file: '/etc/nginx/.htpasswd-ig', days: 90 },
    notes:    { label: 'Lecture Notes', file: '/etc/nginx/.htpasswd-notes', days: 90 },
    terminal: { label: 'Terminal', file: '/etc/nginx/.htpasswd', days: 30 }   // a shell: shorter
};
const SHORT_SESSION_MS = 12 * 3600 * 1000;   // "Remember" unticked: valid for 12 hours

// ---------- device store ----------
let devices = {};   // sha256(token) -> { realm, user, created, expires, seen, ua }
try { devices = JSON.parse(fs.readFileSync(STORE, 'utf8')); } catch (e) { devices = {}; }
let dirty = false;
function save() {
    if (!dirty) return;
    dirty = false;
    const now = Date.now();
    for (const k of Object.keys(devices)) if (devices[k].expires < now) delete devices[k];
    try {
        fs.mkdirSync(STATE_DIR, { recursive: true });
        fs.writeFileSync(STORE + '.tmp', JSON.stringify(devices), { mode: 0o600 });
        fs.renameSync(STORE + '.tmp', STORE);
    } catch (e) { console.error('save failed', e.message); }
}
setInterval(save, 30000).unref();
process.on('SIGTERM', () => { save(); process.exit(0); });
process.on('SIGINT', () => { save(); process.exit(0); });

const hash = t => crypto.createHash('sha256').update(t).digest('hex');
function cookieName(realm) { return 'sd_' + realm; }
function readCookie(req, name) {
    const m = new RegExp('(?:^|;\\s*)' + name + '=([^;]+)').exec(req.headers.cookie || '');
    return m ? m[1] : '';
}
function cookie(realm, value, maxAgeSec) {
    return cookieName(realm) + '=' + value + '; Path=/; HttpOnly; Secure; SameSite=Lax' +
        (maxAgeSec === undefined ? '' : '; Max-Age=' + maxAgeSec);
}

// ---------- password check (htpasswd -v reads the password from stdin) ----------
function checkPassword(file, user, pass) {
    return new Promise(resolve => {
        if (!user || !pass || /[\r\n:]/.test(user) || user.length > 64 || pass.length > 256) return resolve(false);
        const p = spawn('htpasswd', ['-vi', file, user], { stdio: ['pipe', 'ignore', 'ignore'] });
        p.on('error', () => resolve(false));
        p.on('close', code => resolve(code === 0));
        p.stdin.on('error', () => {});
        p.stdin.end(pass);
    });
}

// ---------- slow down guessing: 10 misses per 15 minutes per address ----------
const misses = {};
function tooMany(ip) { const m = misses[ip]; return !!m && m.until > Date.now() && m.n >= 10; }
function miss(ip) {
    const m = misses[ip];
    if (!m || m.until < Date.now()) misses[ip] = { n: 1, until: Date.now() + 15 * 60000 };
    else m.n++;
}
setInterval(() => { for (const k of Object.keys(misses)) if (misses[k].until < Date.now()) delete misses[k]; }, 600000).unref();
const clientIp = req => req.headers['x-real-ip'] || req.socket.remoteAddress;

// ---------- helpers ----------
function safeNext(n) {
    n = String(n || '/');
    if (n[0] !== '/' || n[1] === '/' || n[1] === '\\' || /[\r\n]/.test(n) || n.startsWith('/_auth')) return '/';
    return n;
}
function send(res, status, body, headers) {
    const isObj = typeof body === 'object';
    res.writeHead(status, Object.assign({
        'Content-Type': isObj ? 'application/json' : 'text/html; charset=utf-8',
        'Cache-Control': 'no-store'
    }, headers || {}));
    res.end(isObj ? JSON.stringify(body) : body);
}
function readBody(req) {
    return new Promise(resolve => {
        let s = '';
        req.on('data', c => { s += c; if (s.length > 10000) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch (e) { resolve({}); } });
        req.on('error', () => resolve({}));
    });
}
// the login form posts from our own page: require a same-site Origin on POSTs
function sameOrigin(req) {
    const o = req.headers.origin;
    if (!o) return true;
    try { return new URL(o).host === req.headers.host; } catch (e) { return false; }
}
function basicUser(req) {
    const m = /^Basic\s+(.+)$/i.exec(req.headers.authorization || '');
    if (!m) return null;
    const s = Buffer.from(m[1], 'base64').toString();
    const i = s.indexOf(':');
    return i < 0 ? null : { user: s.slice(0, i), pass: s.slice(i + 1) };
}
function deviceFor(req, realm) {
    const tok = readCookie(req, cookieName(realm));
    if (!tok) return null;
    const d = devices[hash(tok)];
    return d && d.realm === realm && d.expires > Date.now() ? d : null;
}

// replace every {{KEY}} (not just the first)
const fill = (tpl, vars) => Object.keys(vars).reduce((t, k) => t.split('{{' + k + '}}').join(vars[k]), tpl);
const PAGE = fs.readFileSync(path.join(__dirname, 'login.html'), 'utf8');
const MANAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>Devices · {{LABEL}}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;max-width:420px;margin:12vh auto;padding:0 16px}button{font:inherit;padding:10px 14px;margin:6px 6px 6px 0;border-radius:8px;border:1px solid #888;cursor:pointer}#m{color:#888}</style>
<h1>{{LABEL}}</h1>
<p>{{COUNT}} device(s) currently remembered for this page.</p>
<button id="a">Sign out this device</button><button id="b">Sign out all devices</button>
<p id="m"></p>
<script>
function go(path, msg){fetch('/_auth/'+path+'?realm={{REALM}}',{method:'POST',credentials:'same-origin'}).then(function(r){document.getElementById('m').textContent=r.ok?msg:'Sign in to this page first.'})}
document.getElementById('a').onclick=function(){go('logout','Signed out on this device.')};
document.getElementById('b').onclick=function(){if(confirm('Sign out every device?'))go('logout-all','Signed out everywhere.')};
</script>`;

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname, m = req.method;
    const realmKey = url.searchParams.get('realm') || (p === '/check' ? req.headers['x-auth-realm'] : '') || '';
    const realm = Object.prototype.hasOwnProperty.call(REALMS, realmKey) ? REALMS[realmKey] : null;

    // nginx auth_request: 200 = let through, 401 = go sign in
    if (p === '/check' && realm) {
        const d = deviceFor(req, realmKey);
        if (d) {
            const now = Date.now();
            if (now - d.seen > 3600000) { d.seen = now; dirty = true; }
            return send(res, 200, { ok: true }, { 'X-Auth-User': d.user });
        }
        const b = basicUser(req);   // curl / scripts
        if (b) {
            const ip = clientIp(req);
            if (!tooMany(ip)) {
                if (await checkPassword(realm.file, b.user, b.pass)) return send(res, 200, { ok: true }, { 'X-Auth-User': b.user });
                miss(ip);
            }
        }
        return send(res, 401, { error: 'sign in' });
    }

    if (p === '/login' && m === 'GET' && realm) {
        return send(res, 200, fill(PAGE, {
            LABEL: realm.label, REALM: realmKey, DAYS: String(realm.days),
            NEXT: safeNext(url.searchParams.get('next')).replace(/[&<>"']/g, c => '&#' + c.charCodeAt(0) + ';')
        }));
    }

    if (p === '/login' && m === 'POST') {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Bad origin' });
        const b = await readBody(req);
        const r = REALMS[b.realm];
        if (!r) return send(res, 400, { error: 'Unknown page' });
        const ip = clientIp(req);
        if (tooMany(ip)) return send(res, 429, { error: 'Too many tries. Wait a few minutes.' });
        const user = String(b.username || '').trim();
        if (!(await checkPassword(r.file, user, String(b.password || '')))) {
            miss(ip);
            return send(res, 401, { error: 'Username or password is wrong' });
        }
        const remember = b.remember !== false;
        const life = remember ? r.days * DAY : SHORT_SESSION_MS;
        const tok = crypto.randomBytes(32).toString('base64url');
        const now = Date.now();
        devices[hash(tok)] = { realm: b.realm, user, created: now, seen: now, expires: now + life, ua: String(req.headers['user-agent'] || '').slice(0, 160) };
        dirty = true; save();
        // unticked: a session cookie (gone when the browser closes), 12 h server side regardless
        return send(res, 200, { next: safeNext(b.next) }, { 'Set-Cookie': cookie(b.realm, tok, remember ? Math.floor(life / 1000) : undefined) });
    }

    // sign this device out
    if (p === '/logout' && m === 'POST' && realm) {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Bad origin' });
        const tok = readCookie(req, cookieName(realmKey));
        if (tok && devices[hash(tok)]) { delete devices[hash(tok)]; dirty = true; save(); }
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(realmKey, '', 0) });
    }

    // sign every device out of one page (needs this device to be signed in to it)
    if (p === '/logout-all' && m === 'POST' && realm) {
        if (!sameOrigin(req)) return send(res, 403, { error: 'Bad origin' });
        if (!deviceFor(req, realmKey)) return send(res, 401, { error: 'Sign in first' });
        for (const k of Object.keys(devices)) if (devices[k].realm === realmKey) delete devices[k];
        dirty = true; save();
        return send(res, 200, { ok: true }, { 'Set-Cookie': cookie(realmKey, '', 0) });
    }

    // small page to sign out this device or every device
    if (p === '/manage' && m === 'GET' && realm) {
        const n = Object.values(devices).filter(d => d.realm === realmKey && d.expires > Date.now()).length;
        return send(res, 200, MANAGE.replace(/\{\{LABEL\}\}/g, realm.label).replace(/\{\{REALM\}\}/g, realmKey).replace('{{COUNT}}', String(n)));
    }

    send(res, 404, { error: 'Not found' });
});
server.listen(PORT, '127.0.0.1', () => console.log('site-auth gateway on 127.0.0.1:' + PORT));
