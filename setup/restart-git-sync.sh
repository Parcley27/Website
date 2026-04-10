#!/bin/bash
set -e
cp /var/www/pierceoxley.ca/git/sync.js /usr/local/bin/sync.js
systemctl restart git-sync
echo "git-sync updated and restarted"