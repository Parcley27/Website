
#!/bin/bash
set -e

echo "Restarting AccessMRI Call Server"
echo "================================="

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run with sudo: sudo accessmri-restart.sh${NC}"
    exit 1
fi

echo -e "${YELLOW}Restarting accessmri-calls service...${NC}"
systemctl restart accessmri-calls

sleep 2

if systemctl is-active --quiet accessmri-calls; then
    echo -e "${GREEN}Call server restarted successfully${NC}"
    echo ""
    systemctl status accessmri-calls --no-pager -l | head -n 10
else
    echo -e "${RED}Call server failed to restart! Check: journalctl -u accessmri-calls -n 50${NC}"
    exit 1
fi
