import type { TFunction } from 'i18next'
import { useTranslation } from 'react-i18next'

import {
  commitControl,
  commitWarning,
  pullControl,
  pushControl,
  type SyncControl,
} from '../model/sync'
import type { Done, GitRun, Notice } from '../model/useGitRun'
import {
  type GitStatus,
  gitCommit,
  gitPull,
  gitPush,
} from '../../../shared/ipc'

export interface GitActionsProps {
  cwd: string
  git: GitStatus
  /** The pane's one run at a time — see `useGitRun`. */
  gitRun: GitRun
  /** Whether to offer a commit, or only pull and push. */
  withCommit: boolean
}

/**
 * Commit, pull and push for the session's tree.
 *
 * Each one hands git's own words back — a refusal usually says exactly what
 * to do next, so it is shown as it came rather than summarised.
 */
export function GitActions({ cwd, git, gitRun, withCommit }: GitActionsProps) {
  const { t } = useTranslation('workspace')
  const { draft: message, setDraft: setMessage } = gitRun
  const busy = gitRun.running !== null
  const commit = commitControl(git, t)
  const warning = withCommit ? commitWarning(git, t) : null
  const pull = pullControl(git, t)
  const push = pushControl(git, t)
  const canCommit = !busy && !commit.blocked && message.trim() !== ''

  const submit = async () => {
    if (!canCommit) return
    const sent = message
    const committed = await gitRun.run((op) => gitCommit(cwd, sent, op), {
      key: 'sync.committed',
    })
    // Anything typed while git ran is the next message, not this one.
    if (committed) setMessage((now) => (now === sent ? '' : now))
  }

  return (
    <section
      aria-label={withCommit ? t('sync.commitAndSync') : t('sync.syncLabel')}
      className="flex flex-none flex-col gap-1.5 p-2"
    >
      {withCommit && (
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              void submit()
            }
          }}
          rows={2}
          placeholder={t('sync.message')}
          aria-label={t('sync.message')}
          spellCheck={false}
          className="w-full resize-y rounded border border-line bg-surface px-1.5 py-1 text-[11px] text-ink outline-none placeholder:text-faint focus:border-primary"
        />
      )}
      {warning && <p className="m-0 text-[10px] text-danger">{warning}</p>}
      <div className="flex items-center gap-1">
        {withCommit && (
          <Action
            control={commit}
            disabled={!canCommit}
            primary
            onClick={() => void submit()}
          />
        )}
        {busy && (
          <Action
            control={{ label: t('sync.cancel'), blocked: null }}
            disabled={false}
            onClick={gitRun.cancel}
          />
        )}
        <span className="flex-1" />
        <Action
          control={pull}
          disabled={busy || Boolean(pull.blocked)}
          onClick={() =>
            void gitRun.run((op) => gitPull(cwd, op), { key: 'sync.pulled' })
          }
        />
        <Action
          control={push}
          disabled={busy || Boolean(push.blocked)}
          onClick={() =>
            void gitRun.run((op) => gitPush(cwd, op), { key: 'sync.pushed' })
          }
        />
      </div>
      <p
        role="status"
        className={`m-0 text-[10px] break-words whitespace-pre-wrap ${
          gitRun.notice?.failed ? 'text-danger' : 'text-faint'
        }`}
      >
        {busy ? t('sync.running') : noticeText(gitRun.notice, t)}
      </p>
    </section>
  )
}

function noticeText(notice: Notice | null, t: TFunction<'workspace'>) {
  if (!notice) return ''
  return 'done' in notice ? doneText(notice.done, t) : notice.text
}

const doneText = (done: Done, t: TFunction<'workspace'>) =>
  'values' in done ? t(done.key, done.values) : t(done.key)

interface ActionProps {
  control: SyncControl
  disabled: boolean
  primary?: boolean
  onClick(): void
}

const Action = ({ control, disabled, primary, onClick }: ActionProps) => (
  <button
    type="button"
    disabled={disabled}
    title={control.blocked ?? undefined}
    onClick={onClick}
    className={`rounded px-2 py-0.5 text-[11px] disabled:cursor-default disabled:opacity-40 ${
      primary
        ? 'bg-primary text-canvas enabled:hover:opacity-90'
        : 'border border-line text-ink enabled:hover:bg-surface-hover'
    }`}
  >
    {control.label}
  </button>
)
