import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { AGENTS, pickableAgent } from '../../../entities/agent/model/agents'
import { useBackground } from '../../../shared/lib/useBackground'
import { usePlatform } from '../../../shared/lib/usePlatform'
import { useEditors } from '../../../shared/lib/useEditors'
import { useSettings } from '../../../entities/preferences/model/useSettings'
import {
  type FontFamily,
  fontFamilies,
  pickDirectory,
  pickImage,
} from '../../../shared/ipc'
import {
  clearRecentDirs,
  recentDirs,
} from '../../../entities/recents/model/recents'
import { LIMITS } from '../../../entities/preferences/model/settings'
import {
  everyFont,
  fontChoices,
  fontLabel,
  fontName,
  installedFonts,
  monospacedFonts,
  stackFor,
} from '../../../shared/lib/fonts'
import { themeChoices, themeFor } from '../../../shared/lib/themes'
import {
  LOCALE_NAMES,
  LOCALES,
  isLanguageSetting,
} from '../../../shared/i18n/i18n'

/** Settings live in a tab of their own, the way Chrome's do. */
export function SettingsPane() {
  const { settings, update, reset } = useSettings()
  const { t } = useTranslation('settings')
  const { t: chromeText } = useTranslation('chrome')
  const distros = usePlatform()?.wslDistros ?? []
  // Read once into state: the count has to fall to zero the moment Clear is
  // pressed, and reading storage during render leaves it stale until something
  // unrelated re-renders the pane.
  const [remembered, setRemembered] = useState(() => recentDirs().length)
  // Asked once per open. Enumeration is a Rust round trip, so the pane starts
  // on the measured fallback and swaps when the real list lands; `null` is
  // "not answered yet", which is not the same as "answered with nothing".
  const [families, setFamilies] = useState<FontFamily[] | null>(null)
  useEffect(() => {
    let live = true
    void fontFamilies()
      .then((found) => {
        if (live) setFamilies(found)
      })
      .catch(() => {
        if (live) setFamilies([])
      })
    return () => {
      live = false
    }
  }, [])
  // Memoised to keep one array identity per answer: the options are rebuilt
  // from it on every render otherwise.
  const enumerated = families !== null && families.length > 0
  // Counted from the flag, never from the list being shown: with the toggle on
  // that list is every family, so `fonts.length` claimed all 248 of them could
  // hold a terminal grid — the exact thing the flag exists to deny.
  const fixedPitch = families?.filter((family) => family.monospaced).length ?? 0
  const fonts = useMemo(() => {
    if (!enumerated) return installedFonts()
    if (settings.allSystemFonts) return everyFont(families)
    const offered = monospacedFonts(families)
    // The family in use is always offered, whatever the filter says. Turn the
    // toggle on, choose a proportional face, turn it back off, and it drops out
    // of this list — `fontChoices` then re-adds it labelled "(not installed)"
    // on a machine that plainly has it.
    const chosen = fontName(settings.fontFamily)
    const hidden =
      families.find((family) => family.name === chosen) &&
      !offered.some((font) => font.name === chosen)
    return hidden
      ? [
          ...offered.slice(0, -1),
          { name: chosen, stack: stackFor(chosen) },
          ...offered.slice(-1),
        ]
      : offered
  }, [enumerated, families, settings.allSystemFonts, settings.fontFamily])

  return (
    <div className="min-h-0 flex-1 overflow-y-auto p-6">
      <div className="mx-auto flex w-[min(620px,100%)] flex-col gap-6">
        <h1 className="m-0 text-[15px] font-semibold tracking-[0.01em]">
          {t('title')}
        </h1>

        <Group title={t('groups.general')}>
          <Row label={t('language.label')}>
            <select
              value={settings.language}
              aria-label={t('language.label')}
              onChange={(event) => {
                const language = event.target.value
                if (isLanguageSetting(language)) update({ language })
              }}
              className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
            >
              <option value="system">{t('language.matchSystem')}</option>
              {LOCALES.map((locale) => (
                <option key={locale} value={locale} lang={locale}>
                  {LOCALE_NAMES[locale]}
                </option>
              ))}
            </select>
          </Row>
        </Group>

        <Group title={t('groups.newTabs')}>
          <Row label={t('defaultAgent.label')} hint={t('defaultAgent.hint')}>
            <select
              // Through `pickableAgent` for the reason the launcher is: a
              // stored `shell` would otherwise leave this select on a value no
              // option carries, which renders blank.
              value={pickableAgent(settings.defaultAgentId).id}
              onChange={(event) =>
                update({ defaultAgentId: event.target.value })
              }
              className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
            >
              {AGENTS.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </Row>

          <Row label={t('terminalMode.label')} hint={t('terminalMode.hint')}>
            <select
              value={settings.terminalMode}
              aria-label={t('terminalMode.control')}
              onChange={(event) =>
                update({
                  terminalMode:
                    event.target.value === 'clicks' ? 'clicks' : 'scrollback',
                })
              }
              className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
            >
              <option value="scrollback">{t('terminalMode.scrollback')}</option>
              <option value="clicks">{t('terminalMode.clicks')}</option>
            </select>
          </Row>

          <Row
            label={t('defaultDirectory.label')}
            hint={t('defaultDirectory.hint')}
          >
            <div className="flex gap-1.5">
              <input
                value={settings.defaultDirectory}
                placeholder={t('defaultDirectory.placeholder')}
                spellCheck={false}
                onChange={(event) =>
                  update({ defaultDirectory: event.target.value })
                }
                className="h-8 w-[240px] rounded-lg border border-line bg-[#1e1e22] px-2.5 font-mono text-xs text-ink select-text focus:border-primary focus:outline-none"
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
                {t('defaultDirectory.browse')}
              </button>
            </div>
          </Row>

          {distros.length > 0 && (
            <Row label={t('runIn.label')} hint={t('runIn.hint')}>
              <div className="flex gap-1.5">
                <select
                  value={settings.defaultBackend}
                  aria-label={t('runIn.backend')}
                  onChange={(event) =>
                    update({
                      defaultBackend:
                        event.target.value === 'wsl' ? 'wsl' : 'native',
                    })
                  }
                  className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
                >
                  <option value="native">Windows</option>
                  <option value="wsl">WSL</option>
                </select>
                {settings.defaultBackend === 'wsl' && (
                  <select
                    value={settings.defaultDistro}
                    aria-label={t('runIn.distro')}
                    onChange={(event) =>
                      update({ defaultDistro: event.target.value })
                    }
                    className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
                  >
                    <option value="">{t('runIn.defaultDistro')}</option>
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

        <Group title={t('groups.terminal')}>
          <Row label={t('theme.label')} hint={t('theme.hint')}>
            <div className="flex items-center gap-2.5">
              <ThemeSwatch id={settings.themeId} />
              <select
                value={settings.themeId}
                onChange={(event) => update({ themeId: event.target.value })}
                aria-label={t('theme.label')}
                className="h-8 w-[180px] rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
              >
                {themeChoices().map((choice) => (
                  <option key={choice.id} value={choice.id}>
                    {choice.name}
                  </option>
                ))}
              </select>
            </div>
          </Row>
          <Row
            label={t('fontFamily.label')}
            hint={
              families === null
                ? t('fontFamily.reading')
                : enumerated
                  ? t('fontFamily.counted', {
                      fixed: fixedPitch,
                      total: families.length,
                    })
                  : t('fontFamily.unreadable')
            }
          >
            <select
              // `Row`'s label is a span, not a `<label>`, so nothing here is
              // named programmatically — a gap every row in this pane shares,
              // and one this control at least does not add to.
              aria-label={t('fontFamily.label')}
              value={settings.fontFamily}
              onChange={(event) => update({ fontFamily: event.target.value })}
              className="h-8 w-[300px] rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
            >
              {fontChoices(settings.fontFamily, fonts).map((font) => (
                <option
                  key={font.stack}
                  value={font.stack}
                  // Shown in its own face, so the list is a sample rather than
                  // a set of names you have to try one at a time.
                  style={{ fontFamily: font.stack }}
                >
                  {fontLabel(font, chromeText)}
                </option>
              ))}
            </select>
          </Row>
          <Row
            label={t('allSystemFonts.label')}
            hint={t('allSystemFonts.hint')}
          >
            <Toggle
              checked={settings.allSystemFonts}
              onChange={(allSystemFonts) => update({ allSystemFonts })}
              label={t('allSystemFonts.label')}
            />
          </Row>
          <NumberRow
            label={t('fontSize')}
            field="fontSize"
            format={(value) => `${value} px`}
          />
          <NumberRow label={t('lineHeight')} field="lineHeight" />
          <NumberRow
            label={t('textWidth')}
            field="letterSpacing"
            format={(value) => `${value} px`}
          />
          <NumberRow
            label={t('scrollback')}
            field="scrollback"
            format={(value) => t('units.lines', { count: value })}
          />
          <Row label={t('cursorBlink')}>
            <Toggle
              checked={settings.cursorBlink}
              onChange={(cursorBlink) => update({ cursorBlink })}
              label={t('cursorBlink')}
            />
          </Row>
          <Row
            label={t('shellIntegration.label')}
            hint={t('shellIntegration.hint')}
          >
            <Toggle
              checked={settings.shellIntegration}
              onChange={(shellIntegration) => update({ shellIntegration })}
              label={t('shellIntegration.label')}
            />
          </Row>
        </Group>

        <Group title={t('groups.background')}>
          <BackgroundRow />
          {settings.backgroundImage && (
            <>
              <NumberRow
                label={t('brightness')}
                field="backgroundBrightness"
                format={(value) => `${value}%`}
              />
              <BackgroundPreview />
            </>
          )}
        </Group>

        <Group title={t('groups.editor')}>
          <EditorRow />
        </Group>

        <Group title={t('groups.notifications')}>
          <Row label={t('notifyOnDone.label')} hint={t('notifyOnDone.hint')}>
            <Toggle
              checked={settings.notifyOnDone}
              onChange={(notifyOnDone) => update({ notifyOnDone })}
              label={t('notifyOnDone.control')}
            />
          </Row>
          <Row
            label={t('notifyOnlyWhenUnfocused.label')}
            hint={t('notifyOnlyWhenUnfocused.hint')}
          >
            <Toggle
              checked={settings.notifyOnlyWhenUnfocused}
              onChange={(notifyOnlyWhenUnfocused) =>
                update({ notifyOnlyWhenUnfocused })
              }
              label={t('notifyOnlyWhenUnfocused.control')}
            />
          </Row>
          <Row label={t('notifySound.label')}>
            <Toggle
              checked={settings.notifySound}
              onChange={(notifySound) => update({ notifySound })}
              label={t('notifySound.control')}
            />
          </Row>
        </Group>

        <Group title={t('groups.git')}>
          <NumberRow
            label={t('gitPoll')}
            field="gitPollSeconds"
            format={(value) => t('units.seconds', { count: value })}
          />
          <NumberRow
            label={t('historyLimit')}
            field="historyLimit"
            format={(value) => t('units.commits', { count: value })}
          />
          <Row label={t('pullRequests.label')} hint={t('pullRequests.hint')}>
            <Toggle
              checked={settings.pullRequests}
              onChange={(pullRequests) => update({ pullRequests })}
              label={t('pullRequests.label')}
            />
          </Row>
        </Group>

        <Group title={t('groups.sessionRecords')}>
          <Row label={t('journal.label')} hint={t('journal.hint')}>
            <Toggle
              checked={settings.journalEnabled}
              onChange={(journalEnabled) => update({ journalEnabled })}
              label={t('journal.label')}
            />
          </Row>
          <NumberRow
            label={t('journalRetention')}
            field="journalRetentionDays"
            format={(value) => t('units.days', { count: value })}
          />
        </Group>

        <Group title={t('groups.data')}>
          <Row
            label={t('recentDirs.label')}
            hint={t('recentDirs.hint', { count: remembered })}
          >
            <button
              type="button"
              onClick={() => {
                clearRecentDirs()
                setRemembered(0)
              }}
              className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
            >
              {t('recentDirs.clear')}
            </button>
          </Row>
          <Row label={t('reset.label')} hint={t('reset.hint')}>
            <button
              type="button"
              onClick={reset}
              className="h-8 rounded-lg border border-line bg-surface px-3 hover:bg-surface-hover"
            >
              {t('reset.action')}
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
  format = String,
}: {
  label: string
  field: keyof typeof LIMITS
  /** The value as the row reads it, unit included. */
  format?: (value: number) => string
}) {
  const { settings, update } = useSettings()
  const { min, max, step } = LIMITS[field]
  const value = settings[field]

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
          onChange={(event) => update({ [field]: Number(event.target.value) })}
          className="w-[180px] accent-primary"
        />
        <span className="w-[92px] text-right font-mono text-[11px] text-muted">
          {format(value)}
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
  onChange: (checked: boolean) => void
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
      className="size-4 accent-primary"
    />
  )
}

/**
 * Which editor the status bar's button opens. Only what this machine can
 * actually launch is offered, so the button can never point at nothing.
 */
function EditorRow() {
  const { settings, update } = useSettings()
  const { t } = useTranslation('settings')
  const available = useEditors()

  if (available.length === 0) {
    return (
      <Row label={t('editor.label')} hint={t('editor.none')}>
        <span className="text-faint">{t('editor.noneValue')}</span>
      </Row>
    )
  }

  return (
    <Row label={t('editor.label')} hint={t('editor.hint')}>
      <select
        value={settings.editorCommand}
        aria-label={t('editor.control')}
        onChange={(event) => update({ editorCommand: event.target.value })}
        className="h-8 rounded-lg border border-line bg-[#1e1e22] px-2 text-xs text-ink focus:border-primary focus:outline-none"
      >
        <option value="">
          {t('editor.firstFound', { name: available[0].name })}
        </option>
        {available.map((editor) => (
          <option key={editor.command} value={editor.command}>
            {editor.name}
          </option>
        ))}
      </select>
    </Row>
  )
}

/** Picks the image drawn behind every terminal, or clears it. */
function BackgroundRow() {
  const { settings, update } = useSettings()
  const { t } = useTranslation('settings')
  const chosen = settings.backgroundImage

  const choose = async () => {
    const picked = await pickImage()
    if (picked) update({ backgroundImage: picked })
  }

  return (
    <Row
      label={t('image.label')}
      hint={chosen ? basename(chosen) : t('image.hint')}
    >
      <div className="flex items-center gap-2">
        {chosen && (
          <button
            type="button"
            onClick={() => update({ backgroundImage: '' })}
            className="h-8 rounded-lg border border-line px-2.5 text-xs text-muted hover:border-danger hover:text-danger"
          >
            {t('image.clear')}
          </button>
        )}
        <button
          type="button"
          onClick={() => void choose()}
          className="h-8 rounded-lg border border-line px-2.5 text-xs text-ink hover:border-primary"
        >
          {chosen ? t('image.change') : t('image.choose')}
        </button>
      </div>
    </Row>
  )
}

/**
 * The image at the chosen brightness, with terminal text over it.
 *
 * Brightness is only ever judged against the text it has to sit behind, so the
 * preview carries a sample rather than showing the picture alone.
 */
function BackgroundPreview() {
  const { settings } = useSettings()
  const { t } = useTranslation('settings')
  const background = useBackground(settings.backgroundImage)

  return (
    <div className="px-3 pb-3">
      <div className="relative h-[124px] overflow-hidden rounded-lg border border-line bg-canvas">
        {background ? (
          <div
            aria-hidden="true"
            className="absolute inset-0 bg-cover bg-center bg-no-repeat"
            style={{
              backgroundImage: `url("${background}")`,
              filter: `brightness(${settings.backgroundBrightness}%)`,
            }}
          />
        ) : (
          <p className="absolute inset-0 flex items-center justify-center text-[11px] text-faint">
            {t('preview.unreadable')}
          </p>
        )}
        {background && (
          <pre
            aria-label={t('preview.label')}
            className="relative m-0 p-2.5 leading-snug text-ink"
            style={{
              fontFamily: settings.fontFamily,
              fontSize: `${settings.fontSize}px`,
            }}
          >
            <span className="text-[#7fb37a]">~/work/muster</span> on{' '}
            <span className="text-[#6f9ede]">main</span>
            {'\n'}$ claude --continue{'\n'}
            <span className="text-muted">
              Reading src/deck.ts to work out what a tab is…
            </span>
          </pre>
        )}
      </div>
    </div>
  )
}

/** Last path segment, for showing which file was picked. */
const basename = (path: string) =>
  path.split(/[/\\]/).filter(Boolean).pop() ?? path

/** The theme's own colours, so the name is not the only thing to go on. */
function ThemeSwatch({ id }: { id: string }) {
  const theme = themeFor(id)
  return (
    <span
      aria-hidden="true"
      className="flex h-8 items-center gap-1 rounded-lg border border-line px-2"
      style={{ background: theme.background }}
    >
      {[theme.red, theme.green, theme.yellow, theme.blue, theme.magenta].map(
        (colour) => (
          <span
            key={colour}
            className="size-2.5 rounded-full"
            style={{ background: colour }}
          />
        ),
      )}
    </span>
  )
}
