const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPOS_FILE   = '/var/www/pierceoxley.ca/git/repositories.txt';
const REPOS_ROOT   = '/var/git-repos';
const SYNC_INTERVAL = 60 * 1000; // time in ms, therefore 60 seconds

function run(bin, args, cwd) {
    return new Promise((resolve, reject) => {
        execFile(bin, args, { cwd }, (err, stdout, stderr) => {
            if (err) reject({ err, stdout, stderr });
            else resolve({ stdout, stderr });

        });
    });
}

function parseRepos() {
    if (!fs.existsSync(REPOS_FILE)) return [];

    return fs.readFileSync(REPOS_FILE, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('#'))
        .map(line => {
            const [url, webPath] = line.split(/\s+/);
            const dir = path.join(REPOS_ROOT, webPath.replace(/^\//, ''));
            return { url, webPath, dir };

        });
}

async function ensureCloned({ url, dir }) {
    if (!fs.existsSync(dir)) {
        console.log(`Cloning ${url} into ${dir}...`);

        await run('git', ['clone', '--mirror', url, dir], REPOS_ROOT);
        await run('git', ['config', 'remote.origin.fetch', '+refs/*:refs/*'], dir);

        console.log(`Cloned ${url}`);

    }
}

async function syncRepo({ url, dir, webPath }) {
    const timestamp = new Date().toISOString();

    try {
        await ensureCloned({ url, dir });
        await run('git', ['push', '--mirror'], dir);
        await run('git', ['remote', 'update', '--prune'], dir);

        console.log(`[${timestamp}] Synced ${webPath}`);

    } catch ({ err, stderr }) {
        console.error(`[${timestamp}] Failed ${webPath}: ${err.message}`);

        if (stderr) console.error(stderr);

    }
}

async function sync() {
    const repos = parseRepos();
    
    for (const repo of repos) {
        await syncRepo(repo);

    }
    
    setTimeout(sync, SYNC_INTERVAL);

}

sync();