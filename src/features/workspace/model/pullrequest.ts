import type { TFunction } from 'i18next'

import type { PullRequest, PullRequestState } from '../../../shared/ipc'

/** What the footer draws for a branch's pull request. */
export type PullRequestChip =
  | {
      kind: 'pullRequest'
      text: string
      title: string
      /** What a screen reader reads: the title, less the lines it can do without. */
      label: string
      stage: PullRequest['stage']
      /**
       * The stage in words, beside the number, so it is not carried by colour
       * alone. An open pull request is the usual case, and has none.
       */
      stageText: string | null
      /** The checks' worst outcome, which is the one worth a colour. */
      checks: 'failed' | 'pending' | 'passed' | null
      url: string
    }
  | {
      /**
       * Why nothing can be shown, for someone who turned the chip on: without
       * it, a missing `gh` and a branch with no pull request look the same.
       */
      kind: 'hint'
      text: string
      title: string
    }

export function pullRequestChip(
  state: PullRequestState | null,
  t: TFunction<'workspace'>,
): PullRequestChip | null {
  switch (state?.kind) {
    case 'missing':
      return {
        kind: 'hint',
        text: t('pullRequest.missingShort'),
        title: t('pullRequest.missing'),
      }
    case 'signedOut':
      return {
        kind: 'hint',
        text: t('pullRequest.signedOutShort'),
        title: t('pullRequest.signedOut'),
      }
    case 'found': {
      const summary = summarize(state, t)
      const repo = repository(state.url)
      return {
        kind: 'pullRequest',
        text: `#${state.number}`,
        title: [
          t('pullRequest.heading', {
            repo,
            number: state.number,
            title: state.title,
          }),
          summary,
          t('pullRequest.open'),
        ].join('\n'),
        label: t('pullRequest.label', {
          repo,
          number: state.number,
          state: summary,
        }),
        stage: state.stage,
        stageText:
          state.stage === 'open'
            ? null
            : t(`pullRequest.stage.${state.stage}`).toLocaleLowerCase(),
        checks: worstCheck(state.checks),
        url: state.url,
      }
    }
    default:
      return null
  }
}

/** What a tab last showed, and how many reads in a row have failed since. */
export interface Known {
  state: PullRequestState | null
  misses: number
}

/**
 * `next`, keeping what `known` held through one failed read: a failing check
 * must not vanish for a minute because one request did, and a second failure
 * in a row is shown as it is. `gh` answers a failed `pr view` as it answers a
 * branch with no pull request, so on a branch that had one, an absent read
 * counts as a failure.
 */
export function withLastKnown(
  next: PullRequestState | null,
  { state: last, misses }: Known,
): Known {
  const failed =
    !next || next.kind === 'absent' || (next.kind === 'found' && !next.checks)
  if (!failed) return { state: next, misses: 0 }
  const missed = { misses: misses + 1 }
  if (last?.kind !== 'found') return { state: next ?? last, ...missed }
  if (misses > 0) return { state: next ?? { kind: 'absent' }, ...missed }
  if (next?.kind !== 'found') return { state: last, ...missed }
  const checks = next.url === last.url ? last.checks : null
  return { state: { ...next, checks }, ...missed }
}

/**
 * `owner/repo` from a pull request's URL, behind its host when that is not
 * github.com. The repository is whichever one the branch's remote names, and
 * that is the agent's to change, so the chip says which it is rather than
 * letting it pass for the tab's own.
 */
function repository(url: string) {
  try {
    const { host, pathname } = new URL(url)
    const name = pathname.split('/').slice(1, 3).join('/')
    return host === 'github.com' ? name : `${host}/${name}`
  } catch {
    return url
  }
}

function worstCheck(checks: PullRequest['checks']) {
  if (checks?.failed) return 'failed'
  if (checks?.pending) return 'pending'
  return checks?.passed ? 'passed' : null
}

/** Its stage, review and checks, in one line. */
function summarize(pullRequest: PullRequest, t: TFunction<'workspace'>) {
  const { passed = 0, failed = 0, pending = 0 } = pullRequest.checks ?? {}
  const checks = [
    failed && t('pullRequest.failed', { count: failed }),
    pending && t('pullRequest.pending', { count: pending }),
    passed && t('pullRequest.passed', { count: passed }),
  ].filter(Boolean)
  return [
    t(`pullRequest.stage.${pullRequest.stage}`),
    pullRequest.review && t(`pullRequest.review.${pullRequest.review}`),
    checks.join(t('status.titleSeparator')),
  ]
    .filter(Boolean)
    .join(' · ')
}
