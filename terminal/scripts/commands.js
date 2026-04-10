const COMMANDS = [
    { key: 'update-pierce-beta',    label: 'Update\nbeta.pierceoxley.ca'   },
    { key: 'promote-pierce',        label: 'Update\npierceoxley.ca'        },
    { key: 'update-aerostream-beta',label: 'Update\nbeta.aerostream.online'},
    { key: 'promote-aerostream',    label: 'Update\naerostream.online'     },
    // { key: 'start-proxy',           label: 'Start\nAeroStream Proxy'       },
    { key: 'restart-proxy',         label: 'Restart\nAeroStream Proxy'     },
    { key: 'stop-proxy',            label: 'Stop\nAeroStream Proxy'        },
    // { key: 'sync-coding-club',      label: 'Sync\nCoding Club Repository'  },
    { key: 'restart-git-sync',       label: 'Restart\nGit Repository Sync' },
    { key: 'stop-git-sync',         label: 'Stop\nGit Repository Sync'     },

];

const grid   = document.getElementById('command-grid');
const output = document.getElementById('output-log');

function log(text) {
    output.textContent = text;
    output.scrollTop = output.scrollHeight;

}

async function runCommand(key, button) {
    button.disabled = true;
    log(`Running: ${key}...`);

    try {
        const res = await fetch('/api/run', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: key }),

        });

        const data = await res.json();

        const lines = [];

        if (data.stdout) lines.push(data.stdout.trim());
        if (data.stderr) lines.push(data.stderr.trim());

        lines.push(`\nExit code: ${data.exitCode}`);

        log(lines.join('\n'));

    } catch (err) {
        log(`Error: ${err.message}`);

    } finally {
        button.disabled = false;

    }
}

// Build the grid
COMMANDS.forEach(({ key, label }) => {
    const btn = document.createElement('button');

    btn.textContent = label;
    btn.addEventListener('click', () => runCommand(key, btn));
    grid.appendChild(btn);

});