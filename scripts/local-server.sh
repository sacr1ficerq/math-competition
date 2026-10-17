#!/bin/sh
# Keep the local server independent of the terminal that started it.
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
server_unit=math-competition-local.service

start_server() {
    if systemctl --user is-active --quiet "$server_unit"; then
        systemctl --user status "$server_unit" --no-pager
        return
    fi
    if [ ! -x "$project_dir/.venv/bin/python" ]; then
        echo 'Run uv sync --locked before starting the local server.' >&2
        exit 1
    fi
    systemd-run --user --collect --unit="$server_unit" \
        --description='Math competition local server' \
        --working-directory="$project_dir" \
        --property=Restart=on-failure --property=RestartSec=2 \
        "$project_dir/.venv/bin/python" "$project_dir/run.py"
}

case "${1:-start}" in
    start) start_server ;;
    stop) systemctl --user stop "$server_unit" ;;
    restart)
        if systemctl --user is-active --quiet "$server_unit"; then
            systemctl --user restart "$server_unit"
        else
            start_server
        fi
        ;;
    status) systemctl --user status "$server_unit" --no-pager ;;
    logs) journalctl --user -u "$server_unit" -n 100 --no-pager ;;
    *) echo "Usage: $0 {start|stop|restart|status|logs}" >&2; exit 2 ;;
esac
