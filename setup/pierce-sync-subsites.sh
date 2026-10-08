#!/bin/bash
# Deploys everything served from outside /var/www/pierceoxley.ca, straight from the beta
# checkout. Called by pierce-beta.sh and pierce-main.sh (safe to run any number of times).
#
# Installed at /usr/local/bin/pierce-sync-subsites.sh (root-owned on purpose: root runs it,
# and the beta checkout is writable by www-data). After editing this file in the repo, copy
# it there:  sudo install -m 755 setup/pierce-sync-subsites.sh /usr/local/bin/
#
#   terminal.pierceoxley.ca  frontend files        (terminal/ minus backend/)
#   board.pierceoxley.ca     pages + backend       (board/); users, events and keys stay live-only
#   git.pierceoxley.ca       mirror sync daemon    (git/sync.js, git/repositories.txt)
#
# Not deployed from here, deliberately:
#   terminal backend  - the live server.js and the repo's have diverged; restarting it also
#                       cuts the connection of whoever is running these scripts from the terminal
#   nginx configs     - certbot edits them in place; the repo copies are a reference
#   archive, notes, ig backends, lechat, calls, sms, airtraffic - separate lifecycles
set -e

BETA_DIR="/var/www/beta.pierceoxley.ca"
MAIN_DIR="/var/www/pierceoxley.ca"
TERMINAL_DIR="/var/www/terminal.pierceoxley.ca"
BOARD_DIR="/var/www/board.pierceoxley.ca"
YELLOW='\033[1;33m'; GREEN='\033[0;32m'; RED='\033[0;31m'; NC='\033[0m'

if [ "$EUID" -ne 0 ]; then echo -e "${RED}Run with sudo${NC}"; exit 1; fi

echo -e "${YELLOW}Syncing terminal frontend...${NC}"
rsync -a --delete --exclude='backend/' "$BETA_DIR/terminal/" "$TERMINAL_DIR/"
chown -R www-data:www-data "$TERMINAL_DIR"
chmod -R 755 "$TERMINAL_DIR"
echo -e "${GREEN}Terminal frontend synced${NC}"
if ! cmp -s "$BETA_DIR/terminal/backend/server.js" "$TERMINAL_DIR/backend/server.js"; then
    echo -e "${YELLOW}Note: terminal backend server.js differs from the repo's; left as is${NC}"
fi

# board.pierceoxley.ca is its own site in its own directory (board-backend.service, port 4033).
# data/ (users, events, signing key), node_modules and feeds.json only exist live and are left alone.
if [ -d "$BETA_DIR/board" ]; then
    echo -e "${YELLOW}Syncing board site...${NC}"
    mkdir -p "$BOARD_DIR/backend"
    rsync -a --delete --exclude='backend/' "$BETA_DIR/board/" "$BOARD_DIR/"
    BACKEND_CHANGES=$(rsync -a --delete -i --exclude='README.md' \
        --exclude='data/' --exclude='node_modules/' --exclude='feeds.json' \
        "$BETA_DIR/board/backend/" "$BOARD_DIR/backend/")
    cp -f "$BETA_DIR/board/backend/README.md" "$BOARD_DIR/backend/README.md"
    find "$BOARD_DIR" -path "$BOARD_DIR/backend/data" -prune -o -path "$BOARD_DIR/backend/node_modules" -prune -o -exec chown www-data:www-data {} +
    find "$BOARD_DIR" -path "$BOARD_DIR/backend/data" -prune -o -path "$BOARD_DIR/backend/node_modules" -prune -o -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
    if [ -n "$BACKEND_CHANGES" ]; then
        echo -e "${YELLOW}Board backend changed; updating dependencies and restarting...${NC}"
        (cd "$BOARD_DIR/backend" && sudo -u www-data env HOME=/tmp npm_config_cache=/tmp/www-npm-cache npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || echo -e "${RED}npm ci failed for board backend${NC}"
        systemctl restart board-backend
    fi
    echo -e "${GREEN}Board site synced${NC}"
fi

# git.pierceoxley.ca: sync.js runs as git-sync.service from /usr/local/bin and reads the repo list
# from the main site's git/ folder.
if [ -d "$BETA_DIR/git" ]; then
    echo -e "${YELLOW}Syncing git mirror...${NC}"
    mkdir -p "$MAIN_DIR/git"
    install -o www-data -g www-data -m 644 "$BETA_DIR/git/repositories.txt" "$MAIN_DIR/git/repositories.txt"
    install -o www-data -g www-data -m 644 "$BETA_DIR/git/sync.js" "$MAIN_DIR/git/sync.js"
    if ! cmp -s "$BETA_DIR/git/sync.js" /usr/local/bin/sync.js; then
        install -o root -g root -m 755 "$BETA_DIR/git/sync.js" /usr/local/bin/sync.js
        systemctl restart git-sync
        echo -e "${GREEN}git-sync updated and restarted${NC}"
    else
        echo -e "${GREEN}Git mirror already current${NC}"
    fi
fi
