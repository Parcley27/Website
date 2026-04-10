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
    cp -r "$MAIN_DIR" "$BACKUP_DIR/$BACKUP_NAME"
    echo -e "${GREEN}Backup created: $BACKUP_DIR/$BACKUP_NAME${NC}"
else
    echo -e "${YELLOW}No existing main site to backup${NC}"
fi
echo -e "${YELLOW}Promoting beta to main site...${NC}"
rsync -av --delete "$BETA_DIR/" "$MAIN_DIR/"
chown -R www-data:www-data "$MAIN_DIR"
chmod -R 755 "$MAIN_DIR"
echo -e "${YELLOW}Syncing terminal frontend...${NC}"
rsync -av --delete --exclude='backend/' "$BETA_DIR/terminal/" "$TERMINAL_DIR/"
chown -R www-data:www-data "$TERMINAL_DIR"
chmod -R 755 "$TERMINAL_DIR"
echo -e "${GREEN}Terminal frontend synced${NC}"

echo -e "${YELLOW}Syncing terminal backend...${NC}"
cp "$BETA_DIR/terminal/backend/server.js" "$TERMINAL_DIR/backend/server.js"
chown terminal:terminal "$TERMINAL_DIR/backend/server.js"
systemctl restart terminal-backend
echo -e "${GREEN}Terminal backend synced and restarted${NC}"

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