#!/bin/bash
set -e
echo "Promoting Beta to Main"
echo "======================"
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BETA_DIR="/var/www/beta.pierceoxley.ca"
MAIN_DIR="/var/www/pierceoxley.ca"
BOARD_DIR="/var/www/board.pierceoxley.ca"
TERMINAL_DIR="/var/www/terminal.pierceoxley.ca"
BACKUP_DIR="/var/www/backups"
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run with sudo: sudo pierce-main.sh${NC}"
    exit 1
fi
echo -e "${YELLOW}Checking beta site status...${NC}"
if [ ! -d "$BETA_DIR" ] || [ -z "$(ls -A $BETA_DIR)" ]; then
    echo -e "${RED}Beta directory is empty or doesn't exist!${NC}"
    exit 1
fi
echo -e "${GREEN}Beta site found${NC}"
mkdir -p "$BACKUP_DIR"
echo -e "${YELLOW}Creating backup of current main site...${NC}"
BACKUP_NAME="main-backup-$(date +%Y%m%d-%H%M%S)"
if [ -d "$MAIN_DIR" ] && [ "$(ls -A $MAIN_DIR)" ]; then
    # rsync rather than cp: backends write files (thumbnails, notes uploads) while this runs,
    # and a file vanishing mid-copy made cp fail the whole deploy. Exit 24 = some files
    # vanished, which is fine for a backup.
    # A backup only needs what a deploy can change. The big stuff is untouched by deploys
    # (the sync below never deletes it) or rebuildable: thumbnails, deps, caches, and the
    # notes lecture media/uploads (>1 GB, which made this step take minutes).
    rsync -a \
        --exclude='archive-backend/.thumb-cache/' \
        --exclude='notes-backend/media/' \
        --exclude='notes-backend/incoming/' \
        --exclude='ig-backend/.npm/' \
        --exclude='ig-backend/.cache/' \
        --exclude='ig-backend/.config/' \
        --exclude='ig-backend/.local/' \
        --exclude='notes-backend/.npm/' \
        --exclude='node_modules/' \
        "$MAIN_DIR/" "$BACKUP_DIR/$BACKUP_NAME/" || [ $? -eq 24 ]
    # The house board lives in its own directory, outside MAIN_DIR; keep its users/events.
    if [ -d "$BOARD_DIR/backend/data" ]; then
        rsync -a "$BOARD_DIR/backend/data/" "$BACKUP_DIR/$BACKUP_NAME/board-data/"
    fi
    echo -e "${GREEN}Backup created: $BACKUP_DIR/$BACKUP_NAME${NC}"
else
    echo -e "${YELLOW}No existing main site to backup${NC}"
fi
echo -e "${YELLOW}Promoting beta to main site...${NC}"
# These paths never exist on beta (gitignored: API keys, scraped/uploaded
# runtime data, deps) but are live on main — excluded so --delete doesn't
# wipe them out just because beta's checkout doesn't have them.
rsync -av --delete \
    --exclude='ig-backend/' \
    --exclude='archive-backend/' \
    --exclude='notes-backend/data/' \
    --exclude='notes-backend/media/' \
    --exclude='notes-backend/incoming/' \
    --exclude='notes-backend/node_modules/' \
    --exclude='notes-backend/.env' \
    --exclude='notes-backend/.npm/' \
    --exclude='main/ig/' \
    --exclude='main/archive/' \
    "$BETA_DIR/" "$MAIN_DIR/"
# Backend dirs run as their own service users (igstudy, archive, notes) and
# hold secrets like notes-backend/.env (0600) — a blanket chown/chmod here
# locks the services out of their own data, so skip them.
find "$MAIN_DIR" \( -path "$MAIN_DIR/ig-backend" -o -path "$MAIN_DIR/archive-backend" -o -path "$MAIN_DIR/notes-backend" \) -prune \
    -o -exec chown www-data:www-data {} + -exec chmod 755 {} +
# board.pierceoxley.ca is its own site in its own directory (board-backend.service, port 4033),
# so promoting beta into MAIN_DIR never updated it. data/ (users, events, signing key),
# node_modules and feeds.json only exist live and are left alone.
if [ -d "$BETA_DIR/board" ]; then
    echo -e "${YELLOW}Syncing board site...${NC}"
    mkdir -p "$BOARD_DIR/backend"
    rsync -a --delete --exclude='backend/' "$BETA_DIR/board/" "$BOARD_DIR/"
    BACKEND_CHANGES=$(rsync -a --delete -i \
        --exclude='data/' --exclude='node_modules/' --exclude='feeds.json' \
        "$BETA_DIR/board/backend/" "$BOARD_DIR/backend/")
    find "$BOARD_DIR" -path "$BOARD_DIR/backend/data" -prune -o -path "$BOARD_DIR/backend/node_modules" -prune -o -exec chown www-data:www-data {} +
    find "$BOARD_DIR" -path "$BOARD_DIR/backend/data" -prune -o -path "$BOARD_DIR/backend/node_modules" -prune -o -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} +
    if [ -n "$BACKEND_CHANGES" ]; then
        echo -e "${YELLOW}Board backend changed; updating dependencies and restarting...${NC}"
        (cd "$BOARD_DIR/backend" && sudo -u www-data env HOME=/tmp npm_config_cache=/tmp/www-npm-cache npm ci --omit=dev --no-audit --no-fund >/dev/null 2>&1) || echo -e "${RED}npm ci failed for board backend${NC}"
        systemctl restart board-backend
    fi
    echo -e "${GREEN}Board site synced${NC}"
fi

echo -e "${YELLOW}Syncing terminal frontend...${NC}"
rsync -av --delete --exclude='backend/' "$BETA_DIR/terminal/" "$TERMINAL_DIR/"
chown -R www-data:www-data "$TERMINAL_DIR"
chmod -R 755 "$TERMINAL_DIR"
echo -e "${GREEN}Terminal frontend synced${NC}"

echo -e "${YELLOW}Testing nginx configuration...${NC}"
nginx -t
if [ $? -eq 0 ]; then
    echo -e "${GREEN}Nginx configuration is valid${NC}"
    echo -e "${YELLOW}Reloading nginx...${NC}"
    systemctl reload nginx
    echo -e "${GREEN}Nginx reloaded${NC}"
else
    echo -e "${RED}Nginx configuration error! Rolling back...${NC}"
    if [ -d "$BACKUP_DIR/$BACKUP_NAME" ]; then
        rm -rf "$MAIN_DIR"
        cp -r "$BACKUP_DIR/$BACKUP_NAME" "$MAIN_DIR"
        chown -R www-data:www-data "$MAIN_DIR"
        echo -e "${YELLOW}Rollback completed${NC}"
    fi
    exit 1
fi
echo -e "${YELLOW}Cleaning up old backups...${NC}"
cd "$BACKUP_DIR"
ls -t | tail -n +11 | xargs -r rm -rf 2>/dev/null || true
echo -e "${GREEN}Cleanup completed${NC}"
echo ""
echo -e "${GREEN}PROMOTION SUCCESSFUL!${NC}"
echo -e "${GREEN}Beta site promoted to https://pierceoxley.ca${NC}"
if [ -d "$BACKUP_DIR/$BACKUP_NAME" ]; then
    echo -e "${GREEN}Backup saved as: $BACKUP_NAME${NC}"
fi
echo ""
echo "Main site is available at https://pierceoxley.ca"