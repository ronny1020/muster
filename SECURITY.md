# Security

## Reporting

Report privately through
[GitHub's advisory form](https://github.com/ronny1020/muster/security/advisories/new)
rather than opening an issue. This is a personal project with no paid support,
so expect a reply in days rather than hours, and no bounty.

## What Muster is, so a report can be judged against it

Muster is a terminal emulator. Its purpose is to run programs you chose, as
you, with your full privileges. **"An attacker who can already run code in the
webview can run arbitrary commands" is not a vulnerability here** — that is the
product, and `pty_spawn` grants it by design.

What _is_ in scope is anything that gives one of these three a capability it
should not have:

| Actor                                      | Why it counts                                                                                             |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| **A remote web page** you click a link to  | Muster fetches it for the preview card. This is the app's only network egress.                            |
| **A hostile repository** you open a tab in | Its filenames, commit messages and file contents reach the parser, the terminal and the editor.           |
| **An agent CLI's output**                  | It is written into the terminal, scanned for paths and URLs, and can carry inline-image escape sequences. |

None of those three is you, and none of them should be able to reach the
network on your behalf, read a file you did not choose, or put an argument in
front of a program you did not type.

## Known gaps

Named rather than hidden, because the code carries the same notes:

- **Redirects in the link preview.** The private-address check validates every
  hop of a redirect chain, but DNS is resolved twice — once to validate and
  once to connect — so a short-TTL rebinding record remains a theoretical
  bypass. Resolving once and connecting to that address is the fix.
- **Unsigned binaries.** No Apple Developer membership and no Windows
  certificate, so macOS builds are ad-hoc signed and Windows builds are
  unsigned. Every release is built in public by GitHub Actions from the tag it
  claims to be; that provenance is what stands in for a signature.
- **`create_directory` is unscoped.** It creates any directory you confirm.
  Dominated by the PTY for any attacker who already has webview execution.

## Out of scope

- Vulnerabilities in the agent CLIs themselves — report those to their projects.
- A hostile local user, or malware already running as you.
- The Gatekeeper and SmartScreen warnings; those are the unsigned builds above.
