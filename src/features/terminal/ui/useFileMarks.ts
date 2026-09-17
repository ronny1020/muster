import type { Terminal } from '@xterm/xterm'

import { findFileBlocks } from '../model/codeblocks'
import type { Mark } from '../model/messages'
import { useBufferMarks } from './useBufferMarks'

/**
 * Every file the scrollback names, newest first, for marking on the scrollbar
 * beside the message marks.
 */
export const useFileMarks = (term: Terminal | null, active: boolean): Mark[] =>
  useBufferMarks(term, active, findFileBlocks)
