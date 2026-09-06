#!/usr/bin/env bash
#
# apimanager uninstaller — https://github.com/Vytral/apimanager
#
#   ./uninstall.sh            # keep providers + shell backups
#   ./uninstall.sh --purge    # also delete ~/.config/api-manager.json
#
set -euo pipefail

APP_DIR="$HOME/.local/share/api-manager"
BIN_PATH="$HOME/.local/bin/api-manager"
CONFIG_FILE="$HOME/.config/api-manager.json"

info() { printf '\033[1;36m[api]\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }

[ -x "$BIN_PATH" ] && rm -f "$BIN_PATH" && ok "Removed $BIN_PATH"
[ -d "$APP_DIR" ] && rm -rf "$APP_DIR" && ok "Removed $APP_DIR"

for rc in "$HOME/.zshrc" "$HOME/.bashrc"; do
    if [ -f "$rc" ] && grep -q "# >>> apimanager >>>" "$rc" 2>/dev/null; then
        cp "$rc" "$rc.bak-$(date +%Y%m%d%H%M%S)"
        # delete everything between the markers (inclusive)
        sed -i.tmp "/# >>> apimanager >>>/,/# <<< apimanager <<</d" "$rc" && rm -f "$rc.tmp"
        ok "Removed api() block from $rc (backup kept next to it)"
    fi
done

if [ "${1:---}" = "--purge" ]; then
    [ -f "$CONFIG_FILE" ] && rm -f "$CONFIG_FILE" && ok "Removed $CONFIG_FILE"
else
    info "Kept $CONFIG_FILE (use --purge to delete it)"
fi

ok "Uninstalled."
