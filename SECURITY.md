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

| Actor                                      | Why it counts                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A remote web page** you click a link to  | Muster fetches it for the preview card. This is the app's only network egress.                                                                                         |
| **A hostile repository** you open a tab in | Its filenames, commit messages and file contents reach the parser, the terminal, the editor — and the review panel, which renders its markdown and draws its diagrams. |
| **An agent CLI's output**                  | It is written into the terminal, scanned for paths and URLs, and can carry inline-image escape sequences.                                                              |
| **A file an agent just wrote**             | Same reach as a hostile repository: an agent chooses its own filenames and file contents, and both are what the review panel reads.                                    |

None of those four is you, and none of them should be able to reach the
network on your behalf, read a file you did not choose, or put an argument in
front of a program you did not type.

## What the review panel will not do

The panel reads a working tree an agent has been editing, so the file contents
and the filenames in it are attacker-controlled in the sense above. Four
properties hold, and each has a test:

- **Nothing an agent names reaches a session as keystrokes.** A path carrying a
  control byte is never typed: the text goes through bracketed paste, which
  does not strip an end marker embedded in a filename, so such a path would
  leave paste mode and submit whatever followed.
- **A pathspec is literal.** A file named `:setup.sh` or `!notes.md` names
  itself and nothing else, so the diff you are shown is the diff of the file you
  clicked.
- **Nothing is read through a symlink**, including the line count taken for a
  new file, which happens with no click. The final component is refused by the
  open itself (`O_NOFOLLOW`, so it cannot be raced), and for the reads that
  happen without a click, every directory between the repository root and the
  file is checked too — a committed `docs -> ~/.ssh` would otherwise make
  everything under it look repo-relative. The root may itself sit under a link;
  that is not refused, because it is the tree you opened.
- **A document's images stay inside its own folder.** A markdown file cannot
  point at `../../../../Pictures` and have it displayed, and the check is the
  filesystem's rather than the path's spelling — a folder that is a symlink
  resolves to where it really goes before being compared.
- **A diagram cannot navigate the window.** Mermaid's `click` directive becomes
  a real anchor in the SVG and `securityLevel: strict` does not prevent that,
  so the destination is moved onto the same preview card every other link in a
  document uses.

Rendering a document also loads code — markdown-it, and mermaid with DOMPurify
for a diagram — in response to what a file contains. Markdown is parsed with
raw HTML disabled, links carry no `href` and are activated through the same
preview card a terminal URL uses, and mermaid runs at `securityLevel: strict`.

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
- **The review panel's readers are unscoped too.** `read_text_file`,
  `list_directory` and `git_file_diff` take the path they are given. Confinement
  lives at the callers that act without a click — a markdown image, a new
  file's line count — rather than in the commands, because the file tree and
  the image preview both legitimately point wherever you pointed them. Same
  reasoning as `create_directory`: dominated by the PTY for anyone who already
  has webview execution.
- **Syntax colours are below the contrast bar in a diff.** The dimmest token of
  the bundled theme measures 2.43:1 against the added-line tint, where WCAG AA
  asks 4.5:1. An accessibility gap rather than a security one, recorded here
  because it is measured and unfixed.

## Out of scope

- Vulnerabilities in the agent CLIs themselves — report those to their projects.
- A hostile local user, or malware already running as you.
- The Gatekeeper and SmartScreen warnings; those are the unsigned builds above.
