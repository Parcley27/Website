// Creates users.json (the people, and the shared password stored only as a hash).
//
//   PASSWORD='the shared password' node init-users.js Pierce Alex Sam Jordan Riley Morgan
//   PASSWORD='new password' node init-users.js --password-only        # change the password, keep everyone
//
// A "board" login (view-only, for the wall display) is always added.
// To add or rename someone later, edit users.json by hand: no password needed, they use the shared one.

const fs = require('fs');
const path = require('path');
const { hashPassword } = require('./server');

const FILE = process.env.USERS_FILE || path.join(process.env.DATA_DIR || path.join(__dirname, 'data'), 'users.json');
const COLORS = ['#4cc2ff', '#ff8a4c', '#b98cff', '#ff6fa5', '#5fd38d', '#f2c94c', '#ff6b6b', '#4ecdc4'];
const args = process.argv.slice(2);
const pw = process.env.PASSWORD;

if (!pw || pw.length < 6) { console.error('Set PASSWORD (6+ characters) in the environment.'); process.exit(1); }

if (args[0] === '--password-only') {
    const f = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    f.passwordHash = hashPassword(pw);
    fs.writeFileSync(FILE, JSON.stringify(f, null, 2));
    console.log('Password updated for everyone.');
    process.exit(0);
}

const names = args.filter(a => a !== '--force').sort((a, b) => a.localeCompare(b));   // alphabetical
if (!names.length) { console.error('Usage: PASSWORD=... node init-users.js Name1 Name2 ...'); process.exit(1); }
if (fs.existsSync(FILE) && !args.includes('--force')) { console.error(FILE + ' already exists. Pass --force to overwrite it.'); process.exit(1); }

fs.mkdirSync(path.dirname(FILE), { recursive: true });
const users = names.map((n, i) => ({ id: n.toLowerCase().replace(/[^a-z0-9]+/g, ''), name: n, color: COLORS[i % COLORS.length], birthday: '' }));
users.push({ id: 'board', name: 'board', role: 'board' });
fs.writeFileSync(FILE, JSON.stringify({ passwordHash: hashPassword(pw), users }, null, 2));
console.log('Wrote ' + FILE + ' with ' + names.length + ' people + the board login.');
