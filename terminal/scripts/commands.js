const COMMANDS = [
    { key: 'update-pierce-beta',    label: 'Update Pierce Beta'    },
    { key: 'promote-pierce',        label: 'Promote Pierce'        },
    { key: 'update-aerostream-beta',label: 'Update AeroStream Beta'},
    { key: 'promote-aerostream',    label: 'Promote AeroStream'    },
    { key: 'restart-proxy',         label: 'Restart Proxy'         },
    { key: 'stop-proxy',            label: 'Stop Proxy'            },
    { key: 'start-proxy',           label: 'Start Proxy'           },
    { key: 'sync-coding-club',      label: 'Sync Coding Club'      },

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