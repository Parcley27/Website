#!/bin/bash
set -e

echo "Reinstalling Dependencies & Recaching AccessMRI"
echo "================================================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

APP_DIR="/opt/accessmri"
VENV_PIP="$APP_DIR/.venv/bin/pip"
VENV_PYTHON="$APP_DIR/.venv/bin/python"

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run with sudo: sudo accessmri-reinstall.sh${NC}"
    exit 1
fi

echo -e "${YELLOW}Checking application directory...${NC}"

if [ ! -d "$APP_DIR" ]; then
    echo -e "${RED}Application directory doesn't exist: $APP_DIR${NC}"
    exit 1
fi

echo -e "${GREEN}Application directory found${NC}"

cd "$APP_DIR"

echo -e "${YELLOW}Installing dependencies from requirements.txt...${NC}"
sudo -u accessmri "$VENV_PIP" install -r "$APP_DIR/requirements.txt"
echo -e "${GREEN}Dependencies installed${NC}"

echo -e "${YELLOW}Stopping call server before recaching...${NC}"
systemctl stop accessmri-calls
echo -e "${GREEN}Call server stopped${NC}"

echo -e "${YELLOW}Regenerating greeting/retry/goodbye cache...${NC}"
sudo -u accessmri "$VENV_PYTHON" -m Agent.Cache.Cache
echo -e "${GREEN}Cache regenerated${NC}"

echo -e "${YELLOW}Restarting call server...${NC}"
systemctl start accessmri-calls

sleep 2

if systemctl is-active --quiet accessmri-calls; then
    echo -e "${GREEN}Call server started successfully${NC}"
else
    echo -e "${RED}Call server failed to start! Check: journalctl -u accessmri-calls -n 50${NC}"
    exit 1
fi

echo ""
echo -e "${GREEN}REINSTALL & RECACHE SUCCESSFUL!${NC}"
