# apimanager

**Switch between Claude / Anthropic-compatible API providers with a single command.**

Managing Claude endpoints by hand is a pain: every time you want to change providers you have to open your shell config, hunt down `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL`, paste a new key and URL, save, reload — and hope you didn't break anything. Do that a few times a day across a dozen providers and it becomes pure toil.

With apimanager, you just type:

```
api
```

…and everything is ready: a fullscreen, searchable picker. Type a few letters, hit Enter, and your shell is already pointing at that provider.

## Features

- 🔍 **Web-style live search** — the list narrows as you type; best match is auto-highlighted, just hit Enter
- 🖥️ **Fullscreen-friendly picker** — fills almost the whole terminal, no tiny 7-row box
- ⚙️ **Provider CRUD** — add, edit, and bulk-delete providers without touching config files
- ⚡ **Instant activation** — new or edited providers are activated immediately, no re-searching the list
- ✔️ **Active-profile detection** — reads your shell config and marks the current provider
- 🛡️ **Injection-safe writes** — tokens are shell-quoted before touching `~/.zshrc`, with validation against empty values

## Requirements

- macOS or Linux
- Node.js 18+ (`node -v`)
- zsh (primary) or bash

## Install

One-liner:

```bash
curl -fsSL https://raw.githubusercontent.com/Vytral/apimanager/main/install.sh | bash
```

Or manually:

```bash
git clone https://github.com/Vytral/apimanager.git
cd apimanager
./install.sh
```

The installer:

1. Copies the app to `~/.local/share/api-manager` and the launcher to `~/.local/bin/api-manager`
2. Runs `npm install --omit=dev`
3. Creates `~/.config/api-manager.json` if missing (mode `600`)
4. Adds an `api()` function to `~/.zshrc` (and `~/.bashrc` if present), keeping a timestamped backup — existing setups are never overwritten, only extended

Then restart your terminal (or `source ~/.zshrc`).

## Usage

```bash
api
```

- **Empty input** shows every provider, with `Manage Providers` and `Cancel & Exit` on top.
- **Type to filter** by name or URL (`free`, `tabi`, `openrouter`…). Matches move to the top with the closest one highlighted; management actions stay available below the list.
- **Enter** activates the highlighted provider — `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_BASE_URL` are updated in `~/.zshrc` instantly (the `api()` wrapper re-sources it for you).
- **Manage Providers → Add new provider**: enter the base URL first, then the auth token. The new provider is saved *and* activated right away.
- **Manage Providers → Delete**: multi-select with `space`, confirm with `enter`.

### Files

| Path | What |
| ---- | ---- |
| `~/.local/share/api-manager/` | App code + dependencies |
| `~/.local/bin/api-manager` | Launcher |
| `~/.config/api-manager.json` | Your providers (`{ "name": { "token", "url" } }`) |
| `~/.zshrc` | Receives the active `ANTHROPIC_*` exports + `api()` |

## Security notes

- Tokens are stored in plaintext in `~/.config/api-manager.json` and exported in `~/.zshrc` (mode `600` is enforced on the JSON store). This tool is designed for a **personal machine** — do not commit these files or copy them to shared hosts.
- Values written to `~/.zshrc` are single-quote escaped, so special characters (`"`, `$`, backticks…) can't break or inject into your shell.

## Uninstall

```bash
./uninstall.sh            # keeps providers + shell backups
./uninstall.sh --purge    # also deletes ~/.config/api-manager.json
```

Shell blocks added by the installer are removed cleanly (a backup is kept next to each modified rc file).

## License

MIT — see [LICENSE](LICENSE).
