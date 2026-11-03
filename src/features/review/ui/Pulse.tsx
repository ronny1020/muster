import type { Edit } from '../model/edits'
import { EditCounts } from './EditLines'

/**
 * A row's flash for one edit, with the edit's `+N −M` fading out beside it
 * when the row shows no counts of its own. Keyed on the edit, so the next
 * edit to the same file mounts a fresh one and the animation plays again —
 * no clock involved.
 */
export function Pulse({ edit, counts }: { edit?: Edit; counts?: boolean }) {
  if (!edit) return null
  return (
    <span
      key={edit.id}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 flex animate-edit-pulse items-center justify-end pr-2"
    >
      {counts && (
        <span className="animate-edit-fade">
          <EditCounts edit={edit} />
        </span>
      )}
    </span>
  )
}

/** What a list needs to decide which of its rows flash. */
export interface Pulses {
  /** Each just-edited row's newest edit, by the list's own key. */
  latest: ReadonlyMap<string, Edit>
  /**
   * Edits up to this id do not flash. A flash plays when its row mounts, so
   * the drawer opening, a view switch, a folder opening or closing and hidden
   * files being shown each move this to the newest edit, or the row would
   * replay an edit it has already shown. The Changes list coming back from an
   * empty or failed read is the one mount that does not: its first row is
   * usually the edit that ended the empty state, and that one should flash.
   */
  since: number
  /** The newest edit in the feed, which is what `since` moves to. */
  newest: number
}

export const NO_PULSES: Pulses = { latest: new Map(), since: 0, newest: 0 }

/** The edit `key` flashes for, if it has one newer than the floor. */
export function freshPulse({ latest, since }: Pulses, key: string) {
  const edit = latest.get(key)
  return edit && edit.id > since ? edit : undefined
}

/** `pulses` with its floor raised to `floor`, if that is higher. */
export const raised = (pulses: Pulses, floor: number): Pulses => ({
  ...pulses,
  since: Math.max(pulses.since, floor),
})
