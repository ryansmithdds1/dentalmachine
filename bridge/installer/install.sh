#!/bin/sh
# Dental Machine imaging bridge - macOS and Linux installer.
#   ./install.sh               install (or update) for the signed-in user and start it
#   ./install.sh --uninstall   stop it and remove it (exported images are kept)
# It copies the bridge to ~/DentalMachineBridge (or $DM_BRIDGE_DIR) and runs it as the signed-in user, so it
# can open imaging programs on their screen: a LaunchAgent on macOS, a systemd user service on Linux.
# Node.js 18 or newer is needed; on a Mac with Homebrew it is installed for you.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
DEST="${DM_BRIDGE_DIR:-$HOME/DentalMachineBridge}"
LABEL=com.dentalmachine.bridge
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
UNIT="$UNIT_DIR/dental-machine-bridge.service"
OS=$(uname -s)

ok() { printf '  OK    %s\n' "$1"; }
fail() { printf '  FAIL  %s\n' "$1"; }

if [ "${1:-}" = "--uninstall" ]; then
  if [ "$OS" = Darwin ]; then
    launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
    rm -f "$PLIST"
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now dental-machine-bridge.service 2>/dev/null
    rm -f "$UNIT"
    systemctl --user daemon-reload 2>/dev/null
  fi
  for f in dental-machine-bridge.mjs presets.json bridge-config.json bridge-config.previous.json bridge-state.json bridge.log SETUP.txt; do rm -f "$DEST/$f"; done
  ok "Removed the bridge from $DEST (images in $DEST/Export were left in place)"
  echo "Last step: in Dental Machine, Settings -> Imaging bridges, remove this workstation so its key stops working."
  exit 0
fi

for f in dental-machine-bridge.mjs presets.json bridge-config.json; do
  if [ ! -f "$HERE/$f" ]; then fail "$f is missing next to install.sh - unzip the whole package first"; exit 1; fi
done

# ---- Node.js ----
node_major() { "$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
NODE=$(command -v node 2>/dev/null || true)
if [ -z "$NODE" ] || [ "$(node_major "$NODE")" -lt 18 ]; then
  if [ "$OS" = Darwin ] && command -v brew >/dev/null 2>&1; then
    echo "Installing Node.js with Homebrew..."
    brew install node
    NODE=$(command -v node 2>/dev/null || true)
  fi
fi
if [ -z "$NODE" ] || [ "$(node_major "$NODE")" -lt 18 ]; then
  fail "Node.js 18 or newer is needed. Install the LTS version from https://nodejs.org (or your package manager), then run ./install.sh again."
  exit 1
fi
ok "Node.js $("$NODE" --version) at $NODE"

# ---- Copy ----
mkdir -p "$DEST"
chmod 700 "$DEST" # bridge-config.json holds the workstation's key
if [ "$HERE" != "$DEST" ]; then
  [ -f "$DEST/bridge-config.json" ] && cp "$DEST/bridge-config.json" "$DEST/bridge-config.previous.json"
  for f in dental-machine-bridge.mjs presets.json bridge-config.json SETUP.txt install.sh; do
    [ -f "$HERE/$f" ] && cp "$HERE/$f" "$DEST/$f"
  done
fi
chmod 600 "$DEST/bridge-config.json"
ok "Bridge copied to $DEST"

# ---- Start at sign-in ----
if [ "$OS" = Darwin ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$DEST/dental-machine-bridge.mjs</string><string>$DEST/bridge-config.json</string></array>
  <key>WorkingDirectory</key><string>$DEST</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$DEST/bridge.log</string>
  <key>StandardErrorPath</key><string>$DEST/bridge.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
  if launchctl bootstrap "gui/$(id -u)" "$PLIST"; then ok "Starts when you sign in (LaunchAgent $LABEL)"; else fail "Couldn't load the LaunchAgent - run: launchctl bootstrap gui/$(id -u) $PLIST"; fi
elif command -v systemctl >/dev/null 2>&1; then
  mkdir -p "$UNIT_DIR"
  cat > "$UNIT" <<UNIT
[Unit]
Description=Dental Machine imaging bridge
After=network-online.target

[Service]
ExecStart="$NODE" "$DEST/dental-machine-bridge.mjs" "$DEST/bridge-config.json"
WorkingDirectory=$DEST
Restart=always
RestartSec=30
StandardOutput=append:$DEST/bridge.log
StandardError=append:$DEST/bridge.log

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  if systemctl --user enable --now dental-machine-bridge.service; then ok "Starts when you sign in (systemd user service dental-machine-bridge)"; else fail "Couldn't start the systemd user service - see: systemctl --user status dental-machine-bridge"; fi
  echo "  (to keep it running while nobody is signed in: sudo loginctl enable-linger $(id -un))"
else
  fail "No launchd or systemd here - start it yourself: $NODE $DEST/dental-machine-bridge.mjs $DEST/bridge-config.json"
fi

# ---- Setup check ----
echo
echo "Checking the setup (programs, export folders, sensor):"
"$NODE" "$DEST/dental-machine-bridge.mjs" "$DEST/bridge-config.json" --check | sed 's/^/  /'
echo
echo "Log file: $DEST/bridge.log"
[ -f "$DEST/SETUP.txt" ] && echo "Next steps for your imaging programs: $DEST/SETUP.txt"
exit 0
