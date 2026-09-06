#!/usr/bin/env bash
#
# apimanager installer — https://github.com/Vytral/apimanager
#
# One-liner:
#   curl -fsSL https://raw.githubusercontent.com/Vytral/apimanager/main/install.sh | bash
#
# Or from a clone:
#   git clone https://github.com/Vytral/apimanager.git && cd apimanager && ./install.sh
#
set -euo pipefail

REPO_URL="https://github.com/Vytral/apimanager"
APP_DIR="$HOME/.local/share/api-manager"
BIN_DIR="$HOME/.local/bin"
BIN_PATH="$BIN_DIR/api-manager"
CONFIG_FILE="$HOME/.config/api-manager.json"

info()  { printf '\033[1;36m[api]\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m[ok]\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
fail()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; exit 1; }

# --- 1. Requirements ---------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js not found. Install Node 18+ first: https://nodejs.org"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node 18+ required (found: $(node -v))"
command -v npm >/dev/null 2>&1 || fail "npm not found. Reinstall Node.js from https://nodejs.org"
ok "Node $(node -v) + npm $(npm -v)"

# --- 2. Locate sources (local clone or remote download) ----------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || echo "")"
SRC_DIR=""
CLEANUP_SRC=""

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/src/index.js" ] && [ -f "$SCRIPT_DIR/package.json" ]; then
    SRC_DIR="$SCRIPT_DIR"
    info "Installing from local sources: $SRC_DIR"
else
    TMP="$(mktemp -d)"
    CLEANUP_SRC="$TMP"
    if command -v git >/dev/null 2>&1; then
        info "Cloning $REPO_URL ..."
        git clone --depth 1 "$REPO_URL" "$TMP/apimanager" >/dev/null 2>&1 \
            || fail "git clone failed. Check your connection and the repo URL."
        SRC_DIR="$TMP/apimanager"
    else
        command -v curl >/dev/null 2>&1 || fail "Neither git nor curl found. Install git first."
        info "Downloading tarball ..."
        curl -fsSL "$REPO_URL/archive/refs/heads/main.tar.gz" -o "$TMP/apimanager.tar.gz" \
            || fail "Download failed. Check your connection and the repo URL."
        tar -xzf "$TMP/apimanager.tar.gz" -C "$TMP"
        SRC_DIR="$TMP/apimanager-main"
    fi
    [ -f "$SRC_DIR/src/index.js" ] || fail "Downloaded archive looks invalid (src/index.js missing)."
fi

# --- 2b. Version check: fresh install vs update --------------------------------
# Usage: ./install.sh [--force]
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

repo_ver() { node -p "require('$SRC_DIR/package.json').version" 2>/dev/null || echo "0.0.0"; }
installed_ver() {
    [ -f "$APP_DIR/package.json" ] \
        && node -p "require('$APP_DIR/package.json').version" 2>/dev/null \
        || echo "none"
}

REPO_VER="$(repo_ver)"
INSTALLED_VER="$(installed_ver)"

if [ "$INSTALLED_VER" != "none" ] && [ "$FORCE" -eq 0 ]; then
    if [ "$INSTALLED_VER" = "$REPO_VER" ]; then
        ok "Already installed and up to date (v$INSTALLED_VER at $APP_DIR). Use --force to reinstall."
        exit 0
    fi
    NEWER="$(printf '%s\n%s\n' "$INSTALLED_VER" "$REPO_VER" | sort -V | tail -n 1)"
    if [ "$NEWER" = "$INSTALLED_VER" ]; then
        warn "Installed v$INSTALLED_VER is newer than repo v$REPO_VER — reinstalling anyway."
    else
        info "Updating v$INSTALLED_VER -> v$REPO_VER (your providers are kept)."
    fi
else
    [ "$FORCE" -eq 1 ] && info "Force reinstall requested (v$INSTALLED_VER -> v$REPO_VER)."
fi

# --- 3. Install app files -----------------------------------------------------
info "Installing to $APP_DIR ..."
mkdir -p "$APP_DIR/src" "$BIN_DIR"
cp "$SRC_DIR/src/"*.js "$APP_DIR/src/"
cp "$SRC_DIR/package.json" "$APP_DIR/package.json"
[ -f "$SRC_DIR/package-lock.json" ] && cp "$SRC_DIR/package-lock.json" "$APP_DIR/package-lock.json"

cat > "$BIN_PATH" <<'EOF'
#!/usr/bin/env bash
# api-manager launcher (managed by the apimanager installer)
exec node "$HOME/.local/share/api-manager/src/index.js" "$@"
EOF
chmod +x "$BIN_PATH"
ok "Launcher installed at $BIN_PATH"

info "Installing dependencies (npm) ..."
if [ -f "$APP_DIR/package-lock.json" ]; then
    (cd "$APP_DIR" && npm ci --omit=dev --no-audit --no-fund)
else
    (cd "$APP_DIR" && npm install --omit=dev --no-audit --no-fund)
fi
ok "Dependencies installed"

# --- 4. Config file -----------------------------------------------------------
if [ ! -f "$CONFIG_FILE" ]; then
    mkdir -p "$(dirname "$CONFIG_FILE")"
    echo '{}' > "$CONFIG_FILE"
    ok "Created empty provider store at $CONFIG_FILE"
fi
chmod 600 "$CONFIG_FILE" 2>/dev/null || true

# --- 5. Shell integration -----------------------------------------------------
# Detects the login shell and installs api() into its rc file first,
# then into the other one if it exists (users with both get both).
API_FN='api() {
    "$HOME/.local/bin/api-manager"
    source ~/.zshrc
}'

add_api_fn() {
    local rc="$1" src_cmd="$2"
    [ -f "$rc" ] || return 0
    if grep -q "api-manager" "$rc" 2>/dev/null && grep -q "^api()" "$rc" 2>/dev/null; then
        ok "api() already present in $rc"
        return 0
    fi
    cp "$rc" "$rc.bak-$(date +%Y%m%d%H%M%S)"
    {
        echo ""
        echo "# >>> apimanager >>> (https://github.com/Vytral/apimanager)"
        printf 'api() {\n    "$HOME/.local/bin/api-manager"\n    source %s\n}\n' "$src_cmd"
        echo "# <<< apimanager <<<"
        case ":$PATH:" in
            *":$HOME/.local/bin:"*) ;;
            *) echo 'export PATH="$HOME/.local/bin:$PATH"' ;;
        esac
    } >> "$rc"
    ok "Added api() to $rc (backup kept next to it)"
}

LOGIN_SHELL="$(basename "${SHELL:-/bin/zsh}")"
PRIMARY_RC="$HOME/.zshrc"
PRIMARY_SRC="~/.zshrc"
PRIMARY_FISH=0
if [ "$LOGIN_SHELL" = "bash" ]; then
    PRIMARY_RC="$HOME/.bashrc"
    PRIMARY_SRC="~/.bashrc"
elif [ "$LOGIN_SHELL" = "fish" ]; then
    PRIMARY_RC="$HOME/.config/fish/config.fish"
    PRIMARY_SRC="~/.config/fish/config.fish"
    PRIMARY_FISH=1
fi
info "Detected login shell: $LOGIN_SHELL"

add_api_fn_fish() {
    local rc="$1"
    [ -f "$rc" ] || return 0
    if grep -q "api-manager" "$rc" 2>/dev/null && grep -q "^function api" "$rc" 2>/dev/null; then
        ok "api() already present in $rc"
        return 0
    fi
    cp "$rc" "$rc.bak-$(date +%Y%m%d%H%M%S)"
    {
        echo ""
        echo "# >>> apimanager >>> (https://github.com/Vytral/apimanager)"
        echo "function api"
        echo '    ~/.local/bin/api-manager $argv'
        echo "    source ~/.config/fish/config.fish"
        echo "end"
        echo "# <<< apimanager <<<"
    } >> "$rc"
    ok "Added api() to $rc (backup kept next to it)"
}

if [ "$PRIMARY_FISH" -eq 1 ]; then
    mkdir -p "$(dirname "$PRIMARY_RC")"
    [ -f "$PRIMARY_RC" ] || touch "$PRIMARY_RC"
    add_api_fn_fish "$PRIMARY_RC"
else
    [ -f "$PRIMARY_RC" ] || touch "$PRIMARY_RC"
    add_api_fn "$PRIMARY_RC" "$PRIMARY_SRC"
fi
[ "$PRIMARY_RC" != "$HOME/.zshrc" ] && [ -f "$HOME/.zshrc" ] && add_api_fn "$HOME/.zshrc" "~/.zshrc"
[ "$PRIMARY_RC" != "$HOME/.bashrc" ] && [ -f "$HOME/.bashrc" ] && add_api_fn "$HOME/.bashrc" "~/.bashrc"

# --- 6. Cleanup ----------------------------------------------------------------
[ -n "$CLEANUP_SRC" ] && rm -rf "$CLEANUP_SRC"

echo ""
ok "Done (shell: $LOGIN_SHELL). Restart your terminal (or run: source $PRIMARY_SRC), then type:"
echo ""
echo "    api"
echo ""
echo "Add your first provider via:  Manage Providers -> Add new provider"
