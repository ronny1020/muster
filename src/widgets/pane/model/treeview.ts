import type { ReviewView } from '../../../entities/tab/model/deck'
import type { Viewed } from '../../../features/review/model/viewed'

/**
 * What a pane's panels are showing. Each tab holds its own, and columns
 * showing one tree are kept alike, so a file opened in one is open in the
 * others.
 */
export interface TreeView {
  viewed: Viewed | null
  /** Which branch the drawer and the file column compare against. */
  base: string
  review: boolean
  view: ReviewView
  history: boolean
}

/** How `App` reads a pane's view, sets it, and hands its session a path. */
export interface PaneChrome {
  read: () => TreeView
  adopt: (patch: Partial<TreeView>) => void
  /** Whether a live session took the path. */
  send: (path: string, suffix?: string) => boolean
}

/**
 * A control that names a review view: the directory shows the tree, the
 * change counts show the changes. Naming the view already on screen closes
 * the drawer, because the control has nothing left to say the second time;
 * naming the other one switches to it.
 */
export const showReview = (
  current: Pick<TreeView, 'review' | 'view'>,
  next: ReviewView,
): Partial<TreeView> => ({
  review: !(current.review && current.view === next),
  view: next,
})
