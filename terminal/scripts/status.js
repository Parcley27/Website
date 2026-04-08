const POLL_INTERVAL = 10000;
const bar = document.getElementById('status-bar');

async function fetchStatus() {
    try {
        const res  = await fetch('/api/status');
        const data = await res.json();

        render(data);

    } catch (err) {
        bar.textContent = 'Status unavailable';

    }
}

function render(statuses) {
    bar.innerHTML = '';

    Object.entries(statuses).forEach(([service, state]) => {
        const chip = document.createElement('span');
        chip.className = `status-chip ${state}`; // 'active', 'inactive', 'failed'
        chip.textContent = `${service.replace(": ", ":\n")}: ${state}`;
        bar.appendChild(chip);

    });
}

fetchStatus();
setInterval(fetchStatus, POLL_INTERVAL);