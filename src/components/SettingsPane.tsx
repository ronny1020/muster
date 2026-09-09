import { AGENTS } from '../agents'
import { usePlatform } from '../hooks/usePlatform'
import { useEditors } from '../hooks/useEditors'
import { useSettings } from '../hooks/useSettings'
import { pickDirectory } from '../ipc'
import { clearRecentDirs, recentDirs } from '../recents'
import { LIMITS, type Settings } from '../settings'

/** Settings live in a tab of their own, the way Chrome's do. */
export function SettingsPane() {
  const { settings, update, reset } = useSettings()
  const distros = usePlatform()?.wslDistros ?? []

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-[min(620px,100%)] flex-col gap-6">
        <h1 className="m-0 text-[15px] font-semibold tracking-[0.01em]">
          Settings
        </h1>

        <Group title="New tabs">
          <Row label="Default agent" hint="Preselected when a tab opens">
            <select
              value={settings.defaultAgentId}
              onChange={(event) =>
                update({ defaultAgentId: event.target.value })
              }
              className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-brand focus:outline-none"
            >
              {AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
              <option value="shell">Shell</option>
            </select>
          </Row>

          <Row
            label="Default directory"
            hint="Blank uses the last directory you opened"
          >
            <div className="flex gap-1.5">
              <input
                value={settings.defaultDirectory}
                placeholder="last used"
                spellCheck={false}
                onChange={(event) =>
                  update({ defaultDirectory: event.target.value })
                }
                className="h-8 w-[240px] rounded-lg border border-line bg-[#1e1e22] px-2.5 font-mono text-xs text-ink select-text focus:border-brand focus:outline-none"
              />
              <button
                type="button"
                onClick={() =>
                  void pickDirectory(
                    settings.defaultDirectory || undefined,
                  ).then(
                    (picked) => picked && update({ defaultDirectory: picked }),
                  )
                }
                className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
              >
                Browse…
              </button>
            </div>
          </Row>

          {distros.length > 0 && (
            <Row label="Run in" hint="Where a new tab's session starts">
              <div className="flex gap-1.5">
                <select
                  value={settings.defaultBackend}
                  aria-label="Default backend"
                  onChange={(event) =>
                    update({
                      defaultBackend:
                        event.target.value === 'wsl' ? 'wsl' : 'native',
                    })
                  }
                  className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-brand focus:outline-none"
                >
                  <option value="native">Windows</option>
                  <option value="wsl">WSL</option>
                </select>
                {settings.defaultBackend === 'wsl' && (
                  <select
                    value={settings.defaultDistro}
                    aria-label="Default WSL distro"
                    onChange={(event) =>
                      update({ defaultDistro: event.target.value })
                    }
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
            </Row>
          )}
        </Group>

        <Group title="Terminal">
          <Row label="Font family">
            <input
              value={settings.fontFamily}
              spellCheck={false}
              onChange={(event) => update({ fontFamily: event.target.value })}
              className="h-8 w-[300px] rounded-lg border border-line bg-[#1e1e22] px-2.5 font-mono text-xs text-ink select-text focus:border-brand focus:outline-none"
            />
          </Row>
          <NumberRow label="Font size" field="fontSize" suffix="px" />
          <NumberRow label="Line height" field="lineHeight" />
          <NumberRow label="Scrollback" field="scrollback" suffix="lines" />
          <Row label="Blinking cursor">
            <Toggle
              checked={settings.cursorBlink}
              onChange={(cursorBlink) => update({ cursorBlink })}
              label="Blinking cursor"
            />
          </Row>
        </Group>

        <Group title="Editor">
          <EditorRow />
        </Group>

        <Group title="Notifications">
          <Row
            label="When a session is done"
            hint="Agents ring the terminal bell as they hand control back"
          >
            <Toggle
              checked={settings.notifyOnDone}
              onChange={(notifyOnDone) => update({ notifyOnDone })}
              label="Notify when a session is done"
            />
          </Row>
          <Row
            label="Only when looking elsewhere"
            hint="Stay quiet while that tab is already on screen"
          >
            <Toggle
              checked={settings.notifyOnlyWhenUnfocused}
              onChange={(notifyOnlyWhenUnfocused) =>
                update({ notifyOnlyWhenUnfocused })
              }
              label="Only notify when looking elsewhere"
            />
          </Row>
          <Row label="Play a sound">
            <Toggle
              checked={settings.notifySound}
              onChange={(notifySound) => update({ notifySound })}
              label="Play a notification sound"
            />
          </Row>
        </Group>

        <Group title="Git">
          <NumberRow
            label="Status refresh"
            field="gitPollSeconds"
            suffix="seconds"
          />
          <NumberRow
            label="History length"
            field="historyLimit"
            suffix="commits"
          />
        </Group>

        <Group title="Data">
          <Row
            label="Recent directories"
            hint={`${recentDirs().length} remembered`}
          >
            <button
              type="button"
              onClick={clearRecentDirs}
              className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
            >
              Clear
            </button>
          </Row>
          <Row
            label="Everything else"
            hint="Restores every setting on this page"
          >
            <button
              type="button"
              onClick={reset}
              className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
            >
              Restore defaults
            </button>
          </Row>
        </Group>
      </div>
    </div>
  )
}

function Group({
  title,
  children,
}: {
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-1">
      <h2 className="m-0 mb-1 text-[11px] tracking-[0.06em] text-muted uppercase">
        {title}
      </h2>
      <div className="divide-y divide-line rounded-[10px] border border-line bg-chrome">
        {children}
      </div>
    </section>
  )
}

function Row({
  label,
  hint,
  children,
}: {
  label: string
  hint?: string
  children: React.ReactNode
}) {
  return (
    <div className="flex items-center gap-4 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col">
        <span>{label}</span>
        {hint && <span className="text-[11px] text-faint">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A slider paired with its exact value, so the number is never a mystery. */
function NumberRow({
  label,
  field,
  suffix,
}: {
  label: string
  field: keyof typeof LIMITS
  suffix?: string
}) {
  const { settings, update } = useSettings()
  const { min, max, step } = LIMITS[field]
  const value = settings[field] as number

  return (
    <Row label={label}>
      <div className="flex items-center gap-2.5">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(event) =>
            update({ [field]: Number(event.target.value) } as Partial<Settings>)
          }
          className="w-[180px] accent-brand"
        />
        <span className="w-[92px] text-right font-mono text-[11px] text-muted">
          {value}
          {suffix ? ` ${suffix}` : ''}
        </span>
      </div>
    </Row>
  )
}

function Toggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean
  label: string
  onChange(checked: boolean): void
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
      className="h-4 w-4 accent-brand"
    />
  )
}

/**
 * Which editor the status bar's button opens. Only what this machine can
 * actually launch is offered, so the button can never point at nothing.
 */
function EditorRow() {
  const { settings, update } = useSettings()
  const available = useEditors()

  if (available.length === 0) {
    return (
      <Row label="Open in" hint="No editor command found on your PATH">
        <span className="text-faint">none</span>
      </Row>
    )
  }

  return (
    <Row label="Open in" hint="Used by the button in each tab's status bar">
      <select
        value={settings.editorCommand}
        aria-label="Editor"
        onChange={(event) => update({ editorCommand: event.target.value })}
        className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-brand focus:outline-none"
      >
        <option value="">{available[0].name} (first found)</option>
        {available.map((editor) => (
          <option key={editor.command} value={editor.command}>
            {editor.name}
          </option>
        ))}
      </select>
    </Row>
  )
}
