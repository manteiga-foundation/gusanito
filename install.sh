#!/bin/sh
# Gusanito: run your own game server, installed with one command.
#
#   curl -fsSL https://gusanito.manteiga.org/install.sh | sh
#
# What it does:
#   1. Uses Bun if you have it; otherwise installs it with Bun's official installer (bun.sh).
#   2. Downloads the latest Gusanito release from github.com/manteiga-foundation/gusanito.
#   3. Builds the game into ~/.gusanito/app. The build happens in a separate folder first, so a
#      failed update leaves the copy you already have working.
#   4. Adds the command ~/.local/bin/gusanito, and that folder to your PATH if it is missing.
#
# Then `gusanito` starts the server and prints the addresses to open: one for this computer and
# one for phones on the same Wi-Fi. `gusanito update` installs the latest release again.
#
# Uninstall: rm -rf ~/.gusanito ~/.local/bin/gusanito
#
# Settings (environment variables, given to sh):
#   GUSANITO_VERSION=v1.0.0   a release tag, or main for the latest code
#   GUSANITO_HOME             where the game is installed (default ~/.gusanito)
#   GUSANITO_BIN              where the command goes (default ~/.local/bin)
#   e.g. curl -fsSL https://gusanito.manteiga.org/install.sh | GUSANITO_VERSION=main sh
#
# Read it before running it: curl -fsSL https://gusanito.manteiga.org/install.sh -o install.sh

main() {
  set -eu
  REPO="manteiga-foundation/gusanito"
  INSTALL_URL="https://gusanito.manteiga.org/install.sh"
  HOME_DIR="${GUSANITO_HOME:-$HOME/.gusanito}"
  BIN_DIR="${GUSANITO_BIN:-$HOME/.local/bin}"
  GITHUB="${GUSANITO_GITHUB:-https://github.com}"
  LOG="$HOME_DIR/install.log"
  STAGE=""

  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) fail "this installer supports macOS and Linux. You can always play at https://gusanito.manteiga.org" ;;
  esac
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed to install Gusanito"
  done

  mkdir -p "$HOME_DIR"
  : >"$LOG"

  # 1. Bun
  if command -v bun >/dev/null 2>&1; then
    BUN="$(command -v bun)"
  elif [ -x "$HOME/.bun/bin/bun" ]; then
    BUN="$HOME/.bun/bin/bun"
  else
    say "Installing Bun (bun.sh)"
    command -v bash >/dev/null 2>&1 || fail "bash is needed to install Bun"
    curl -fsSL "${GUSANITO_BUN_INSTALLER:-https://bun.sh/install}" -o "$HOME_DIR/bun-install.sh" >>"$LOG" 2>&1 ||
      fail "could not download Bun's installer"
    quiet bash "$HOME_DIR/bun-install.sh" || fail "Bun's installer failed"
    rm -f "$HOME_DIR/bun-install.sh"
    BUN="$HOME/.bun/bin/bun"
    [ -x "$BUN" ] || fail "Bun was installed but $BUN is missing"
  fi
  bun_version="$("$BUN" --version 2>/dev/null || echo 0.0.0)"
  major="${bun_version%%.*}"
  rest="${bun_version#*.}"
  minor="${rest%%.*}"
  if [ "$major" -lt 1 ] || { [ "$major" -eq 1 ] && [ "$minor" -lt 2 ]; }; then
    fail "Gusanito needs Bun 1.2 or newer (found $bun_version). Run: bun upgrade"
  fi

  # 2. Source
  if [ -n "${GUSANITO_SOURCE:-}" ]; then
    SOURCE="$GUSANITO_SOURCE"
    VERSION="(local source)"
  else
    VERSION="${GUSANITO_VERSION:-}"
    if [ -z "$VERSION" ]; then
      landed="$(curl -fsSL -o /dev/null -w '%{url_effective}' "$GITHUB/$REPO/releases/latest" 2>>"$LOG" || true)"
      case "$landed" in
        */releases/tag/*) VERSION="${landed##*/releases/tag/}" ;;
        *) fail "no Gusanito release was found. For the latest code run: curl -fsSL $INSTALL_URL | GUSANITO_VERSION=main sh" ;;
      esac
    fi
    if [ "$VERSION" = "main" ]; then
      SOURCE="$GITHUB/$REPO/archive/refs/heads/main.tar.gz"
    else
      SOURCE="$GITHUB/$REPO/archive/refs/tags/$VERSION.tar.gz"
    fi
  fi

  say "Downloading Gusanito $VERSION"
  STAGE="$HOME_DIR/.app-new"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/unpacked"
  curl -fsSL "$SOURCE" -o "$STAGE/source.tar.gz" >>"$LOG" 2>&1 || fail "the download failed ($SOURCE)"
  quiet tar -xzf "$STAGE/source.tar.gz" -C "$STAGE/unpacked" || fail "could not unpack the download"
  top="$(find "$STAGE/unpacked" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
  [ -n "$top" ] && [ -f "$top/package.json" ] && [ -f "$top/src/server/main.ts" ] ||
    fail "the download does not look like Gusanito"

  # 3. Build, then swap it in
  say "Building the game"
  (cd "$top" && quiet "$BUN" run build) || fail "the build failed"
  mv "$top" "$HOME_DIR/.app-built"
  rm -rf "$STAGE"
  STAGE="$HOME_DIR/.app-built"
  if [ -d "$HOME_DIR/app" ]; then
    rm -rf "$HOME_DIR/.app-old"
    mv "$HOME_DIR/app" "$HOME_DIR/.app-old"
  fi
  mv "$HOME_DIR/.app-built" "$HOME_DIR/app"
  STAGE=""
  rm -rf "$HOME_DIR/.app-old"
  installed="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$HOME_DIR/app/package.json" | head -n 1)"

  # 4. The command
  mkdir -p "$BIN_DIR"
  write_launcher >"$BIN_DIR/.gusanito.tmp"
  chmod +x "$BIN_DIR/.gusanito.tmp"
  mv "$BIN_DIR/.gusanito.tmp" "$BIN_DIR/gusanito"

  added=""
  case ":$PATH:" in
    *":$BIN_DIR:"*) ;;
    *) add_to_path && added=1 ;;
  esac

  rm -f "$LOG"
  say "Installed Gusanito $installed in $(pretty "$HOME_DIR")"
  printf '\n  Start a server:  gusanito\n  Update later:    gusanito update\n'
  if [ -n "$added" ]; then
    printf '\nOpen a new terminal first: %s was just added to your PATH.\n' "$(pretty "$BIN_DIR")"
  fi
}

say() { printf '> %s\n' "$1"; }

# A path under the home folder, written the short way (~/.gusanito).
pretty() {
  case "$1" in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

# Run a tool with its output kept in the log, never on screen. stdin is closed so no tool can read
# the rest of this script from the pipe it arrives on.
quiet() { "$@" >>"$LOG" 2>&1 </dev/null; }

fail() {
  printf 'Error: %s\n' "$1" >&2
  if [ -n "${LOG:-}" ] && [ -s "$LOG" ]; then
    printf '%s\n' "--- $LOG ---" >&2
    cat "$LOG" >&2
  fi
  if [ -n "${STAGE:-}" ]; then rm -rf "$STAGE"; fi
  exit 1
}

add_to_path() {
  if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then dir='$HOME/.local/bin'; else dir="$BIN_DIR"; fi
  case "$(basename "${SHELL:-sh}")" in
    zsh) rc="$HOME/.zshrc"; line="export PATH=\"$dir:\$PATH\"" ;;
    bash)
      if [ "$(uname -s)" = "Darwin" ]; then rc="$HOME/.bash_profile"; else rc="$HOME/.bashrc"; fi
      line="export PATH=\"$dir:\$PATH\""
      ;;
    fish) rc="$HOME/.config/fish/config.fish"; line="fish_add_path $dir" ;;
    *) rc="$HOME/.profile"; line="export PATH=\"$dir:\$PATH\"" ;;
  esac
  mkdir -p "$(dirname "$rc")"
  touch "$rc"
  if grep -qF "$line" "$rc"; then return 1; fi
  printf '\n# Added by the Gusanito installer\n%s\n' "$line" >>"$rc"
}

write_launcher() {
  sed -e "s|@HOME_DIR@|$HOME_DIR|g" -e "s|@BUN@|$BUN|g" <<'LAUNCHER'
#!/bin/sh
# gusanito: start your own Gusanito server.
# Installed by: curl -fsSL https://gusanito.manteiga.org/install.sh | sh
set -eu
home="${GUSANITO_HOME:-@HOME_DIR@}"
app="$home/app"
bun="$(command -v bun 2>/dev/null || true)"
[ -n "$bun" ] || bun="@BUN@"
port="${PORT:-8080}"
case "${1:-}" in
  update)
    curl -fsSL https://gusanito.manteiga.org/install.sh | sh
    exit $?
    ;;
  -v | --version)
    printf 'gusanito %s\n' "$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$app/package.json" | head -n 1)"
    exit 0
    ;;
  -h | --help | help)
    cat <<'USAGE'
Usage: gusanito [--port N]   start the game server (port 8080 unless you choose one)
       gusanito update       install the latest release
       gusanito --version    show the installed version
USAGE
    exit 0
    ;;
  -p | --port) port="${2:?--port needs a number}" ;;
  "") ;;
  *)
    echo "gusanito: unknown option $1 (see gusanito --help)" >&2
    exit 2
    ;;
esac
cd "$app"
PORT="$port" STATIC_DIR="$app/dist" exec "$bun" src/server/main.ts
LAUNCHER
}

main "$@"
