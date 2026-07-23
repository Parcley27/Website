#!/bin/bash
set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="/opt/accessmri"

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run with sudo: sudo accessmri-update.sh${NC}"
    exit 1
fi

echo -e "${YELLOW}Pulling latest changes from GitHub...${NC}"
cd "$APP_DIR"
git fetch origin main
git reset --hard origin/main
echo -e "${GREEN}Repository updated${NC}"

echo -e "${YELLOW}Restoring ownership to accessmri user...${NC}"
chown -R accessmri:accessmri "$APP_DIR"
echo -e "${GREEN}Ownership restored${NC}"

echo -e "${YELLOW}Restarting call server...${NC}"
systemctl restart accessmri-calls
echo -e "${GREEN}Call server restarted${NC}"

echo ""
echo -e "${GREEN}UPDATE SUCCESSFUL!${NC}"
echo "Note: if requirements.txt changed, dependencies need a manual reinstall:"
echo "  sudo -u accessmri /opt/accessmri/.venv/bin/pip install -r /opt/accessmri/requirements.txt"
echo ""
echo -e "${YELLOW}Note:${NC} if .env changed, edit and restart:"
echo "  sudo nano /opt/accessmri/.env"
