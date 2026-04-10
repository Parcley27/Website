// Runs as terminal-backend.service on localhost:4028
// Never exposed directly to the internet, and runs
// only after HTTP Basic Auth has already passed

const express = require('express');
const { execFile } = require('child_process');
const app = express();
const PORT = 4028;

const timeout = 60000; // 60s timeout to allow for git and system restarts


app.use(express.json());

// Allowlist of named commands
// No shell access and no string manipulation to avoid injections
const COMMANDS = {
    // Personal site
    'update-pierce-beta':       ['sudo', '/usr/local/bin/pierce-beta.sh'],
    'promote-pierce':           ['sudo', '/usr/local/bin/pierce-main.sh'],

    // AeroStream
    'update-aerostream-beta':   ['sudo', '/usr/local/bin/aerostream-beta.sh'],
    'promote-aerostream':       ['sudo', '/usr/local/bin/aerostream-main.sh'],
    'restart-proxy':            ['sudo', 'systemctl', 'restart', 'aerostream-proxy.service'],
    'stop-proxy':               ['sudo', 'systemctl', 'stop',    'aerostream-proxy.service'],
    'start-proxy':              ['sudo', 'systemctl', 'start',   'aerostream-proxy.service'],

    'restart-git-sync':  ['sudo', '/usr/local/bin/restart-git-sync.sh'],
    'stop-git-sync':    ['sudo', 'systemctl', 'stop', 'git-sync'],

    'restart-backend': ['sudo', 'systemctl', 'restart', 'terminal-backend'],

    // Other stuff here later (email, coding club git extras, lechat, minecraft, etc)

};

// POST /run { "command": "<key>" }
// Runs the mapped command and returns stdout/stderr
app.post('/run', (req, res) => {
    const { command } = req.body;

    if (!command || !COMMANDS[command]) {
        return res.status(400).json({ error: `Unknown command: ${command}` });

    }

    const [bin, ...args] = COMMANDS[command];

    execFile(bin, args, { timeout: timeout }, (err, stdout, stderr) => {
        res.json({
            success:  !err || err.code === 0,
            stdout:   stdout  || '',
            stderr:   stderr  || '',
            exitCode: err ? (err.code ?? 1) : 0,

        });
    });
});

// GET /status
// Returns systemctl is-active for each tracked service
app.get('/status', (req, res) => {
    const services = [
        'aerostream-proxy',
        'minecraft',
        'nginx',
        'fail2ban',
        'fcgiwrap',
        'git-sync',
        'terminal-backend',

    ];

    const results = {};
    let pending = services.length;

    services.forEach(service => {
        execFile('systemctl', ['is-active', service], (err, stdout) => {
            results[service] = stdout.trim(); // 'active', 'inactive', 'failed', etc
            if (--pending === 0) res.json(results);

        });
    });
});

app.listen(PORT, 'localhost', () => {
    console.log(`Terminal backend listening on localhost:${PORT}`);

});