#!/bin/bash
set -e
echo "Updating Beta Site"
echo "=================="
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'
BETA_DIR="/var/www/beta.pierceoxley.ca"
TERMINAL_DIR="/var/www/terminal.pierceoxley.ca"
if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run with sudo: sudo pierce-beta.sh${NC}"
    exit 1
fi
echo -e "${YELLOW}Checking beta directory...${NC}"
if [ ! -d "$BETA_DIR" ]; then
    echo -e "${RED}Beta directory doesn't exist: $BETA_DIR${NC}"
    exit 1
fi
echo -e "${GREEN}Beta directory found${NC}"
cd "$BETA_DIR"
echo -e "${YELLOW}Resetting any local changes...${NC}"
git reset --hard HEAD
git clean -fd
echo -e "${YELLOW}Fetching latest changes from GitHub...${NC}"
git fetch origin main
echo -e "${YELLOW}Pulling latest changes from GitHub...${NC}"
git reset --hard origin/main
echo -e "${GREEN}Repository updated successfully${NC}"
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

echo -e "${YELLOW}Setting proper permissions...${NC}"
chown -R www-data:www-data .
chmod -R 755 .
echo -e "${GREEN}Permissions set${NC}"
echo -e "${YELLOW}Testing nginx configuration...${NC}"
nginx -t
if [ $? -eq 0 ]; then
    echo -e "${GREEN}Nginx configuration is valid${NC}"
    echo -e "${YELLOW}Reloading nginx...${NC}"
    systemctl reload nginx
    echo -e "${GREEN}Nginx reloaded${NC}"
else
    echo -e "${RED}Nginx configuration error!${NC}"
    echo -e "${YELLOW}Please check nginx configuration manually${NC}"
    exit 1
fi
echo ""
echo -e "${GREEN}BETA UPDATE SUCCESSFUL!${NC}"
echo -e "${GREEN}Beta site updated from GitHub${NC}"
echo ""
echo "Beta site is available at https://beta.pierceoxley.ca"