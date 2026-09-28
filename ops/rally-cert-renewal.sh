#!/usr/bin/env bash
set -euo pipefail
if [ "${RENEWED_LINEAGE:-}" = '/etc/letsencrypt/live/rall-e.joinfitapp.com' ]; then
    apache2ctl configtest
    systemctl reload apache2
fi
