#!/bin/sh
# Installs Muster on macOS, from any starting state.
#
# The single Homebrew command in the README is fine on a clean machine, but it
# consults Homebrew's own record rather than /Applications: if the app was ever
# deleted by hand the two disagree, and the command reports "the latest version
# is already installed" while doing nothing. This script does not care which
# state you are in.
#
#   curl -fsSL https://raw.githubusercontent.com/ronny1020/muster/main/install.sh | sh
#
# It is deliberately short enough to read before running.

set -eu

TAP=ronny1020/tap
CASK=muster
APP=/Applications/Muster.app

fail() {
	echo "install: $1" >&2
	exit 1
}

[ "$(uname -s)" = Darwin ] || fail "this script is for macOS; see the README for Windows and Linux"

command -v brew >/dev/null 2>&1 ||
	fail "Homebrew is required — https://brew.sh — or download the .dmg from
         https://github.com/ronny1020/muster/releases"

# `</dev/null` on every brew call is load-bearing, not tidiness. This script is
# meant to be run as `curl … | sh`, where stdin is the script itself — any
# command that reads stdin would eat the rest of it.
#
# Installing is also the first brew command allowed to mention the tap.
# Homebrew 6 trusts a cask you name explicitly, and refuses to load one from a
# tap you have not trusted — so `brew tap $TAP` on its own is fatal on a
# machine that has never seen it: tapping validates the cask, validating needs
# trust, and nothing has granted it yet. Naming the cask does all three in the
# right order, tap included.
echo "==> Installing $CASK"
brew install --cask "$TAP/$CASK" </dev/null

# The stale-record case: Homebrew believes it is installed, /Applications
# disagrees, and `install` no-ops rather than repairing it. `--force` does not
# help; `reinstall` does, and by this point the tap exists and the cask is
# trusted, so it is able to run at all.
if [ ! -d "$APP" ]; then
	echo "==> Homebrew's record disagrees with /Applications; repairing"
	brew reinstall --cask "$TAP/$CASK" </dev/null
fi

[ -d "$APP" ] || fail "Homebrew reported success but $APP is missing"

# Muster is ad-hoc signed rather than notarized, so macOS refuses to open the
# copy Homebrew quarantines. Homebrew 6 removed the --no-quarantine flag that
# used to skip this.
echo "==> Clearing the quarantine attribute"
xattr -cr "$APP"

echo
echo "Muster $(defaults read "$APP/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo '') is installed."
echo "Open it from Applications, or run: open $APP"
