const COMMANDS = [
    { key: 'update-pierce-beta',    label: 'Update beta.pierceoxley.ca'   },
    { key: 'promote-pierce',        label: 'Update pierceoxley.ca'        },
    { key: 'update-aerostream-beta',label: 'Update beta.aerostream.online'},
    { key: 'promote-aerostream',    label: 'Update aerostream.online'     },
    { key: 'restart-proxy',         label: 'Restart AeroStream Proxy'     },
    { key: 'stop-proxy',            label: 'Stop AeroStream Proxy'        },
    { key: 'start-proxy',           label: 'Start AeroStream Proxy'       },
    { key: 'sync-coding-club',      label: 'Sync Coding Club Repository'  },

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