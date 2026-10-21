import type { Commit } from '../../../shared/ipc'

/** What the content column is showing, if anything. */
export type Viewed =
  | {
      kind: 'diff'
      /** Repo-relative, which is how git names it. */
      relative: string
      absolute: string
      /** A line of the new file to scroll to, from a click in the terminal. */
      line: number | null
      /** One commit's own change, from the history; absent, the working tree's. */
      commit?: Commit
      /** With `commit`: the name it renamed the file from. */
      oldPath?: string
      /**
       * With `commit`: the repository it belongs to. A file's history comes
       * from the file's own repository, which need not be the tab's.
       */
      root?: string
    }
  | {
      kind: 'file'
      absolute: string
      /** The line the terminal named, for the hand-off to an editor. */
      line: number | null
    }
