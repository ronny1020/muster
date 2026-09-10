# Template for the ronny1020/homebrew-tap repository. Copy to
# Casks/muster.rb there; `sha256` comes from the GitHub Release assets.
cask "muster" do
  version "0.1.1"
  arch arm: "aarch64", intel: "x64"

  sha256 arm:   "a29b0c651089f7e0f30d9a870e0778e74444d7b0c5e1b36db12d5ac556294fbc",
         intel: "625a1ff73a034968165f01f3ff53b1cefefde2e22008d645862b89dff0340eec"

  url "https://github.com/ronny1020/muster/releases/download/v#{version}/Muster_#{version}_#{arch}.dmg"

  name "Muster"
  desc "Run AI agent CLIs in tabs, each a real terminal with its own git state"
  homepage "https://github.com/ronny1020/muster"

  livecheck do
    url :url
    strategy :github_latest
  end

  # The build is ad-hoc signed rather than notarized, so Gatekeeper refuses a
  # quarantined copy. Homebrew 6 removed `--no-quarantine`, which leaves
  # `xattr -cr /Applications/Muster.app` after installing as the only route.
  app "Muster.app"

  zap trash: [
    "~/Library/Application Support/io.github.ronny1020.muster",
    "~/Library/Caches/io.github.ronny1020.muster",
    "~/Library/Preferences/io.github.ronny1020.muster.plist",
    "~/Library/WebKit/io.github.ronny1020.muster",
  ]
end
