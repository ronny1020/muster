import { useEffect, useRef, useState } from 'react'

import {
  AGENTS,
  type Agent,
  pickableAgent,
  resumeArgs,
  SHELL_AGENT,
} from '../../../entities/agent/model/agents'
import { openUrl } from '@tauri-apps/plugin-opener'

import { Combobox } from '../../../shared/ui/Combobox'
import type { LauncherStart } from '../../../entities/tab/model/deck'
import { usePlatform } from '../../../shared/lib/usePlatform'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import type { TerminalMode } from '../../../entities/preferences/model/settings'
import { type BlockedHint, blockedHint } from '../model/blocked'
import { splitFlags } from '../model/flags'
import {
  agentSessionList,
  agentSessions,
  createDirectory,
  homeDir,
  type PastSessions,
  pickDirectory,
  report,
  workspaceInfo,
} from '../../../shared/ipc'
import { agoLabel } from '../../../shared/lib/ago'
import { basename } from '../model/paths'
import {
  type Backend,
  EXAMPLE_DIRECTORY,
  OS,
} from '../../../shared/lib/platform'
import {
  recentDirs,
  rememberDir,
} from '../../../entities/recents/model/recents'

export interface LaunchRequest {
  agent: Agent
  cwd: string
  args: string[]
  title: string
  backend: Backend
  distro: string
  /**
   * Which mode to start the session in, or absent to take the `terminalMode`
   * setting as the default. Absent for an agent that does not answer the
   * variable, since a mode it ignores is not a choice; named by the start
   * screen's own control, by a resume carrying the tab's current mode, and
   * by the status bar changing it.
   */
  scrollback?: boolean
}

/**
 * Modes that reopen past work, keyed by the ids the registry uses. A mode with
 * no history to read cannot succeed, so it is offered only when some exists.
 */
const needsHistory = (modeId: string) =>
  modeId === 'continue' || modeId === 'resume'

/** The button a host with a settings page gets, narrowed so nothing asserts. */
function SettingsButton({
  settings,
}: {
  settings: NonNullable<BlockedHint['settings']>
}) {
  return (
    <button
      type="button"
      onClick={() => void openUrl(settings.url).catch(report)}
      className="h-7 flex-none rounded-lg border border-line bg-surface px-3 text-xs hover:bg-surface-hover"
    >
      {settings.label}
    </button>
  )
}

/** A directory the user asked for that is not there yet, and what to do next. */
interface MissingDirectory {
  /** Tilde-collapsed, for showing back to the user. */
  path: string
  /** The launch mode that was clicked, replayed once the directory exists. */
  modeArgs: string[]
  /**
   * And which agent asked. "Open a plain shell instead" can reach this too, and
   * defaulting to the picker's agent on the way back starts the wrong program —
   * with the flags field applied, since the shell takes none.
   */
  as: Agent
}

/** Start screen of a fresh tab: pick agent, directory and how the session opens. */
export function Launcher({
  active,
  onLaunch,
  start,
}: {
  active: boolean
  onLaunch(request: LaunchRequest): void
  /** What a restored tab opens with, in place of the settings defaults. */
  start?: LauncherStart
}) {
  const directory = useRef<HTMLInputElement>(null)
  const { settings } = useSettings()
  const platform = usePlatform()
  const [recents] = useState(recentDirs)
  const [cwd, setCwd] = useState(
    start?.cwd || settings.defaultDirectory || recents[0] || '',
  )
  const [flags, setFlags] = useState(start?.flags ?? '')
  /**
   * Which mode this session starts in, seeded from the default in settings.
   *
   * Chosen here rather than only afterwards because the agent reads it once,
   * at spawn: picking it later costs a relaunch, and the choice belongs with
   * the other things a launch decides.
   */
  const [mode, setMode] = useState<TerminalMode>(settings.terminalMode)
  const [agent, setAgent] = useState<Agent>(() =>
    pickableAgent(start?.agentId || settings.defaultAgentId),
  )
  const [backend, setBackend] = useState<Backend>(
    start?.backend ?? settings.defaultBackend,
  )
  const [distro, setDistro] = useState(start?.distro ?? settings.defaultDistro)
  const [error, setError] = useState('')
  const [missing, setMissing] = useState<MissingDirectory | null>(null)
  /** A directory that is there and unreadable, by path. */
  const [blocked, setBlocked] = useState<string | null>(null)
  /**
   * Directories the user has already been warned about.
   *
   * Separate from `blocked`, which is only what is on screen, so Dismiss
   * leaves the acknowledgement standing. A ref, because a second click has to
   * see the first one's answer without waiting for a render.
   */
  const warned = useRef(new Set<string>())
  /**
   * Whether this screen has already handed a session over.
   *
   * Every control here launches through one `await`, so a second click inside
   * that window dispatches a second session for the same tab — and
   * `TerminalView` spawns from an effect keyed on the tab id, which does not
   * change, so nothing respawns: the tab runs the first program while the
   * status bar, the mode control and the ⟳ all describe the second. Only the
   * dispatch is guarded, so a click that ends in a warning or a prompt leaves
   * the screen usable.
   */
  const launched = useRef(false)
  const hint = blocked ? blockedHint(OS) : null
  // null = the agent's store is unreadable, so every mode stays offered.
  const [sessions, setSessions] = useState<number | null>(null)
  /**
   * The conversations Resume is offering, or `null` while it is offering none.
   *
   * Read on the click rather than beside the count above: a summary costs a
   * bounded read of every listed transcript, and the directory field re-reads
   * on each keystroke.
   */
  const [past, setPast] = useState<PastSessions | null>(null)
  const [reading, setReading] = useState(false)
  /**
   * Which read the open list is allowed to have come from.
   *
   * The directory, the agent and the backend can all move while a read is in
   * flight, and an answer names the three it was asked about — so a reply that
   * lands late would put one directory's conversations under another's name,
   * and every row here launches. A ref rather than state, because the check
   * happens after an await, where state is the render's.
   */
  const asked = useRef(0)
  /** Whether a Resume click is still being answered. See `offerResume`. */
  const handling = useRef(false)

  const distros = platform?.wslDistros ?? []
  /**
   * The backend a launch from here would really use. A distro that has since
   * been removed would strand the session, so the choice only survives while
   * WSL still offers it — and the store is asked about the same one, or the
   * list describes a host the session will not run on.
   */
  const runIn: Backend = distros.length > 0 ? backend : 'native'
  /** Narrows `resumeMode.args` below; the list exists only where it does. */
  const resumeMode = agent.modes.find((mode) => mode.id === 'resume')
  /**
   * The session settings as they are now, rather than as the click found them.
   *
   * Every launch crosses at least one await — the directory probe, and for
   * Resume the store read before it — so a setting changed in between would be
   * captured in the closure and lost: the agent reads its terminal mode once,
   * at spawn, and a session started in the mode the control no longer shows
   * has no way back but reopening the conversation.
   *
   * The agent and its arguments are deliberately not here. They are chosen
   * together, so pairing a newly picked agent with the previous one's
   * arguments would be worse than the staleness it repaired.
   */
  const chosen = useRef({ flags, mode, distro, backend: runIn, distros })
  chosen.current = { flags, mode, distro, backend: runIn, distros }

  useEffect(() => {
    if (!cwd) void homeDir().then(setCwd, () => setCwd(''))
    // Runs once: it only fills the initial blank, and every later edit is
    // the user's to keep.
  }, [])

  // Claim focus whenever this tab comes forward, not only on mount: switching
  // away leaves focus wherever the other pane had it.
  useEffect(() => {
    if (active) directory.current?.focus()
  }, [active])

  // Re-read on every directory, agent or backend change: `claude --continue`
  // in a
  // directory with no history just prints `No conversation found to
  // continue` and exits, which is a worse answer than not offering the mode.
  useEffect(() => {
    const directory = cwd.trim()
    // Dropped before the guard below, because an emptied field is a change
    // like any other: a list left standing under it offers conversations no
    // button on the page can start. The ticket goes with it, so a read still
    // in flight has nowhere to land.
    setPast(null)
    asked.current += 1
    if (!directory) return
    let cancelled = false
    // Until the new answer lands, "unknown" is the honest state — keeping the
    // previous directory's count would gate on the wrong directory.
    setSessions(null)
    void agentSessions(agent.id, directory, runIn)
      .then((count) => !cancelled && setSessions(count))
      .catch(() => !cancelled && setSessions(null))
    return () => {
      cancelled = true
    }
  }, [agent.id, cwd, runIn])

  /**
   * `as` is how the shell starts without being in the picker: it is not one of
   * the choices, so it never becomes the selected agent — it just launches.
   */
  const launch = async (
    modeArgs: string[],
    options: { directory?: string; as?: Agent } = {},
  ) => {
    const { directory: override, as = agent } = options
    const directory = (override ?? cwd).trim()
    if (!directory) {
      setError('Choose a directory first.')
      return
    }
    const workspace = await workspaceInfo(directory, true).catch(() => null)
    if (!workspace) {
      setError('Could not read that directory.')
      return
    }
    // Warns once, then gets out of the way. The check is `read_dir`, so it
    // answers "cannot be listed" — a directory with search permission and no
    // read permission takes a `cd` and opens every path already known.
    //
    // Returns the first time so the warning survives the click that raised it:
    // `onLaunch` replaces this surface with the terminal. The second click
    // launches.
    //
    // Checked before the missing case: offering to create a directory that is
    // already there reads as the app having lost it.
    if (workspace.denied && !warned.current.has(workspace.path)) {
      warned.current.add(workspace.path)
      setBlocked(workspace.path)
      setMissing(null)
      setError('')
      return
    }
    // Past the warning, so the notice comes down: only one of the two should
    // ever be on screen.
    setBlocked(null)
    if (!workspace.exists) {
      // Not an error yet: offer to create it, and remember which mode was
      // clicked so confirming launches straight into it.
      setMissing({ path: workspace.path, modeArgs, as })
      setError('')
      return
    }
    if (launched.current) return
    launched.current = true
    rememberDir(directory)
    // The directory stays the one that was probed above; everything else is
    // read as it stands. See `chosen`.
    const live = chosen.current
    const extra = as.acceptsFlags ? splitFlags(live.flags) : []
    onLaunch({
      agent: as,
      cwd: directory,
      args: [...modeArgs, ...extra],
      title: workspace.label,
      backend: live.backend,
      distro: live.distros.includes(live.distro) ? live.distro : '',
      // Only where the CLI answers it; anywhere else the launch takes the
      // preference, which is what `App` does with an absent value.
      ...(as.scrollbackMode ? { scrollback: live.mode === 'scrollback' } : {}),
    })
  }

  /**
   * Answers the Resume mode on this page rather than in the terminal.
   *
   * A CLI's own resume flag opens a picker inside the session, so choosing
   * which conversation to reopen costs a launch of its own — and that picker
   * is a full-screen TUI in a tab that may have asked for a scrollback. The
   * store behind the list is the one the CLI itself reads, so where it can be
   * read the choice is made here and the launch names the conversation
   * outright.
   *
   * An empty list covers every case that cannot be read — another agent, a
   * session in a WSL distro, a directory with no history — and those launch
   * the mode as it always was, picker and all.
   */
  const offerResume = async (modeArgs: string[]) => {
    // A second click on the same button closes what the first one opened.
    if (past) {
      setPast(null)
      return
    }
    // Re-entry rather than a disabled button: disabling the control under the
    // keyboard blurs it, and the read is long enough for that to strand focus
    // on `<body>`. Held past the read, because the launch it can fall back to
    // is the slower half.
    if (handling.current) return
    handling.current = true
    const directory = cwd.trim()
    if (!directory) {
      setError('Choose a directory first.')
      handling.current = false
      return
    }
    const ticket = ++asked.current
    setReading(true)
    const found = await agentSessionList(agent.id, directory, runIn).catch(
      () => ({ listed: [], more: false }),
    )
    // The read is over either way, and what follows is a launch: a notice
    // still naming the read would sit above the prompt a blocked or missing
    // directory raises.
    setReading(false)
    // The selection moved while this was in flight, so this answer describes
    // something else now — including the launch below, which would take the
    // directory this render closed over rather than the one on screen.
    if (ticket !== asked.current) {
      handling.current = false
      return
    }
    if (found.listed.length === 0) {
      await launch(modeArgs)
    } else {
      setPast(found)
    }
    handling.current = false
  }

  /** Creates the directory the user just tried to open, then launches into it. */
  const createAndLaunch = async () => {
    if (!missing) return
    const pending = missing
    setMissing(null)
    try {
      // `launch` closes over this render's `cwd`, so the resolved path has to
      // be handed over directly — setting state would not reach it in time.
      const created = await createDirectory(cwd.trim())
      setCwd(created)
      await launch(pending.modeArgs, { directory: created, as: pending.as })
    } catch (cause) {
      setError(String(cause))
    }
  }

  const browse = async () => {
    const picked = await pickDirectory(cwd || undefined).catch(() => null)
    if (picked) {
      setCwd(picked)
      setError('')
      // The third path that moves `cwd`, and both notices name a directory:
      // left up, they describe the folder the user has just navigated away
      // from while the buttons beneath them act on the new one.
      setMissing(null)
      setBlocked(null)
    }
  }

  const submitOnEnter = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter') void launch(agent.modes[0].args)
  }

  return (
    <div className="grid min-h-0 flex-1 place-items-center overflow-auto p-6">
      <div className="flex w-[min(560px,100%)] flex-col gap-3.5">
        <h1 className="m-0 text-[15px] font-semibold tracking-[0.01em]">
          New session
        </h1>

        <Field label="Directory" htmlFor="launcher-dir">
          <div className="flex gap-1.5">
            <div className="min-w-0 flex-1">
              <TextInput
                id="launcher-dir"
                value={cwd}
                onChange={(value) => {
                  setCwd(value)
                  // Both notices name a directory, so both are stale the
                  // moment a different one is typed.
                  setMissing(null)
                  setBlocked(null)
                }}
                onKeyDown={submitOnEnter}
                placeholder={EXAMPLE_DIRECTORY}
                ref={directory}
              />
            </div>
            <button
              type="button"
              onClick={() => void browse()}
              className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
            >
              Browse…
            </button>
          </div>
        </Field>

        {recents.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {recents.map((dir) => (
              <button
                key={dir}
                type="button"
                title={dir}
                onClick={() => {
                  setCwd(dir)
                  setError('')
                  setMissing(null)
                  setBlocked(null)
                }}
                className="h-[26px] rounded-lg border border-line bg-surface px-2.5 text-[11px] text-muted hover:bg-surface-hover hover:text-ink"
              >
                {basename(dir)}
              </button>
            ))}
          </div>
        )}

        <Field label="Agent">
          <Combobox
            label="Agent"
            placeholder="Type to filter…"
            options={AGENTS.map((choice) => ({
              id: choice.id,
              label: choice.name,
              accent: choice.accent,
            }))}
            selected={agent.id}
            onSelect={(id) => setAgent(pickableAgent(id))}
          />
        </Field>

        {agent.scrollbackMode && (
          <Field label="Terminal mode">
            <div className="flex gap-1.5">
              <Choice
                label="Scrollback"
                selected={mode === 'scrollback'}
                onSelect={() => setMode('scrollback')}
              />
              <Choice
                label="Clicks"
                selected={mode === 'clicks'}
                onSelect={() => setMode('clicks')}
              />
            </div>
          </Field>
        )}

        {distros.length > 0 && (
          <Field label="Run in">
            <div className="flex gap-1.5">
              <Choice
                label="Windows"
                selected={backend === 'native'}
                onSelect={() => setBackend('native')}
              />
              <Choice
                label="WSL"
                selected={backend === 'wsl'}
                onSelect={() => setBackend('wsl')}
              />
              {backend === 'wsl' && (
                <select
                  value={distro}
                  aria-label="WSL distro"
                  onChange={(event) => setDistro(event.target.value)}
                  className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-brand focus:outline-none"
                >
                  <option value="">Default distro</option>
                  {distros.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
            </div>
          </Field>
        )}

        {agent.acceptsFlags && (
          <Field label="Extra flags" htmlFor="launcher-flags">
            <TextInput
              id="launcher-flags"
              value={flags}
              onChange={setFlags}
              onKeyDown={submitOnEnter}
              placeholder="--model opus"
            />
          </Field>
        )}

        <div className="mt-0.5 flex justify-end">
          <button
            type="button"
            onClick={() =>
              void launch(SHELL_AGENT.modes[0].args, { as: SHELL_AGENT })
            }
            className="rounded-lg px-2 py-1 text-[11px] text-muted hover:bg-surface hover:text-ink"
          >
            Open a plain shell instead
          </button>
        </div>

        <div className="mt-0.5 grid grid-cols-[repeat(auto-fit,minmax(160px,1fr))] gap-2">
          {agent.modes.map((mode, index) => {
            const unavailable = needsHistory(mode.id) && sessions === 0
            return (
              <button
                key={mode.id}
                type="button"
                disabled={unavailable}
                aria-disabled={
                  mode.id === 'resume' && reading ? true : undefined
                }
                title={
                  unavailable ? 'No past sessions in this directory' : undefined
                }
                aria-expanded={mode.id === 'resume' ? Boolean(past) : undefined}
                onClick={() =>
                  void (mode.id === 'resume'
                    ? offerResume(mode.args)
                    : launch(mode.args))
                }
                style={
                  index === 0 && !unavailable
                    ? { borderColor: `${agent.accent}8c` }
                    : undefined
                }
                className="flex flex-col gap-0.5 rounded-[10px] border border-line bg-surface px-3 py-2.5 text-left enabled:hover:border-[#43434d] enabled:hover:bg-surface-hover disabled:opacity-40"
              >
                <strong className="font-medium">{mode.label}</strong>
                <span className="text-[11px] text-muted">
                  {unavailable ? 'Nothing to continue here yet' : mode.hint}
                </span>
              </button>
            )
          })}
        </div>

        {/* Mounted with only its text changing, for the same reason as the
            hint below. */}
        <div role="status" className="min-h-0">
          {(reading || past) && (
            <p className="m-0 text-[11px] text-faint">
              {reading
                ? 'Reading past conversations…'
                : `${past?.listed.length ?? 0} past conversations`}
            </p>
          )}
        </div>

        {past && (
          <ul
            aria-label="Past conversations"
            className="m-0 max-h-56 list-none divide-y divide-line overflow-y-auto rounded-[10px] border border-line p-0"
          >
            {past.listed.map((session) => {
              const args = resumeArgs(agent, session.id)
              // A row with nothing to launch is left out rather than drawn
              // dead: every agent reaching here has a resume mode, so this is
              // narrowing rather than a case the user can meet.
              return args ? (
                <li key={session.id}>
                  <button
                    type="button"
                    onClick={() => void launch(args)}
                    className="flex w-full items-baseline gap-2 px-3 py-2 text-left hover:bg-surface-hover"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {session.summary || 'Nothing typed in this one'}
                    </span>
                    <span className="flex-none text-[11px] text-faint">
                      {agoLabel(session.at, Date.now())}
                    </span>
                  </button>
                </li>
              ) : null
            })}
            {/* The list is the newest few, so a directory with more history
                than that would otherwise lose the rest: the CLI's own picker
                is where all of it still is. */}
            {resumeMode && past.more && (
              <li>
                <button
                  type="button"
                  onClick={() => void launch(resumeMode.args)}
                  className="flex w-full items-baseline gap-2 px-3 py-2 text-left text-muted hover:bg-surface-hover hover:text-ink"
                >
                  <span className="min-w-0 flex-1 truncate">
                    Older conversations — open {agent.name}&rsquo;s own picker
                  </span>
                </button>
              </li>
            )}
          </ul>
        )}

        {/* Mounted whether or not there is a hint: a region inserted with its
            content already in it is announced by almost nothing, and this is
            the only explanation a screen-reader user gets. */}
        <div role="status">
          {blocked && hint && (
            <div className="flex flex-col gap-2 rounded-[10px] border border-danger/40 bg-surface px-3 py-2.5">
              <span className="text-[11px] text-muted">
                <span className="font-mono text-ink">{blocked}</span> cannot be
                listed. {hint.reason}
              </span>
              <span className="text-[11px] text-muted">
                {hint.remedy} Click the same button again to start here anyway —
                the session may still work if the agent knows the paths it
                needs.
              </span>
              <div className="flex gap-2">
                {hint.settings ? (
                  <SettingsButton settings={hint.settings} />
                ) : null}
                <button
                  type="button"
                  onClick={() => setBlocked(null)}
                  className="h-7 flex-none rounded-lg px-2 text-xs text-muted hover:text-ink"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>

        {missing ? (
          <div className="flex items-center gap-2 rounded-[10px] border border-line bg-surface px-3 py-2">
            <span className="min-w-0 flex-1 text-[11px] text-muted">
              <span className="font-mono text-ink">{missing.path}</span> does
              not exist yet.
            </span>
            <button
              type="button"
              onClick={() => void createAndLaunch()}
              style={{ borderColor: `${agent.accent}8c` }}
              className="h-7 flex-none rounded-lg border bg-surface px-3 text-xs hover:bg-surface-hover"
            >
              Create and start
            </button>
            <button
              type="button"
              onClick={() => setMissing(null)}
              className="h-7 flex-none rounded-lg border border-line px-3 text-xs text-muted hover:bg-surface-hover hover:text-ink"
            >
              Cancel
            </button>
          </div>
        ) : (
          <p className="m-0 min-h-3.5 text-[11px] text-danger">{error}</p>
        )}
      </div>
    </div>
  )
}

interface ChoiceProps {
  label: string
  accent?: string
  selected: boolean
  onSelect(): void
}

function Choice({
  label,
  accent = '#7f8794',
  selected,
  onSelect,
}: ChoiceProps) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      style={
        selected
          ? { borderColor: accent, boxShadow: `inset 2px 0 0 ${accent}` }
          : undefined
      }
      className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
    >
      {label}
    </button>
  )
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string
  htmlFor?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={htmlFor}
        className="text-[11px] tracking-[0.06em] text-muted uppercase"
      >
        {label}
      </label>
      {children}
    </div>
  )
}

interface TextInputProps {
  id: string
  value: string
  placeholder?: string
  ref?: React.Ref<HTMLInputElement>
  onChange(value: string): void
  onKeyDown(event: React.KeyboardEvent): void
}

function TextInput({
  id,
  value,
  placeholder,
  ref,
  onChange,
  onKeyDown,
}: TextInputProps) {
  return (
    <input
      id={id}
      ref={ref}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      autoComplete="off"
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={onKeyDown}
      className="h-8 w-full min-w-0 rounded-lg border border-line bg-[#1e1e22] px-2.5 font-mono text-xs text-ink select-text focus:border-brand focus:outline-none"
    />
  )
}
