import type { Terminal } from '@xterm/xterm'

import { findMessageRows, type Message } from '../model/messages'
import { useBufferMarks } from './useBufferMarks'

/**
 * The rows your own messages start on, newest first, kept current as the
 * session writes. See AGENTS.md's message-marks invariant.
 */
export const useMessages = (
  term: Terminal | null,
  active: boolean,
): Message[] => useBufferMarks(term, active, findMessageRows)
