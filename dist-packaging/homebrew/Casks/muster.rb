# Template for the ronny1020/homebrew-tap repository. Copy to
# Casks/muster.rb there; `sha256` comes from the GitHub Release assets.
cask "muster" do
  version "0.1.0"
  arch arm: "aarch64", intel: "x64"

  sha256 arm:   "<PLACEHOLDER_SHA256_AARCH64_DMG>",
         intel: "<PLACEHOLDER_SHA256_X64_DMG>"

  url "https://github.com/ronny1020/muster/releases/download/v#{version}/Muster_#{version}_#{arch}.dmg",
      verified: "github.com/ronny1020/muster/"

  name "Muster"
  desc "Run AI agent CLIs in tabs, each a real terminal with its own git state"
  homepage "https://github.com/ronny1020/muster"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The build is ad-hoc signed rather than notarized, so Gatekeeper needs
  # either `--no-quarantine` on install or `xattr -cr` afterwards.
  app "Muster.app"

  zap trash: [
    "~/Library/Application Support/dev.muster.app",
    "~/Library/Caches/dev.muster.app",
    "~/Library/Preferences/dev.muster.app.plist",
    "~/Library/WebKit/dev.muster.app",
  ]
end
