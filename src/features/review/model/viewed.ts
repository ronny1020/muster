/** What the content column is showing, if anything. */
export type Viewed =
  | {
      kind: 'diff'
      /** Repo-relative, which is how git names it. */
      relative: string
      absolute: string
      /** A line of the new file to scroll to, from a click in the terminal. */
      line: number | null
    }
  | { kind: 'file'; absolute: string }
