import { expect, test } from 'bun:test'

import { parseAgentEvent } from './agentevents'

/** The payload Claude Code actually emitted, minus the `777;` identifier. */
const stop =
  'notify;warp://cli-agent;' +
  JSON.stringify({
    v: 1,
    agent: 'claude',
    event: 'stop',
    session_id: 'de4b1743',
    cwd: '/Users/ronny/Documents/temp/ai-terminal',
    project: 'ai-terminal',
    query: 'reply with exactly: probe-ok',
    response: 'probe-ok',
    transcript_path: '/Users/ronny/.claude/projects/x.jsonl',
  })

test('a turn ending carries the reply, which is what a notification reads', () => {
  expect(parseAgentEvent(stop)).toEqual({
    name: 'stop',
    response: 'probe-ok',
  })
})

test('an event with nothing to carry is still recognised', () => {
  expect(
    parseAgentEvent(
      'notify;warp://cli-agent;{"event":"tool_complete","tool_name":"Bash"}',
    ),
  ).toEqual({ name: 'tool_complete' })
})

test('a payload whose json holds semicolons survives the split', () => {
  const event = parseAgentEvent(
    'notify;warp://cli-agent;{"event":"stop","response":"a;b;c"}',
  )
  expect(event?.response).toBe('a;b;c')
})

test('an agent printing a novel cannot become a wall of notification text', () => {
  const event = parseAgentEvent(
    `notify;warp://cli-agent;{"event":"stop","response":"${'x'.repeat(5000)}"}`,
  )
  expect(event?.response).toHaveLength(200)
})

test('a cap landing inside a surrogate pair drops it rather than halving it', () => {
  // The 200th code unit is the high half of the emoji.
  const response = `${'x'.repeat(199)}\u{1F600}tail`
  const event = parseAgentEvent(
    `notify;warp://cli-agent;${JSON.stringify({ event: 'stop', response })}`,
  )
  expect(event?.response).toHaveLength(199)
  expect(event?.response).toBe('x'.repeat(199))
})

test('an oversized payload is refused before it is parsed', () => {
  const huge = JSON.stringify({ event: 'stop', response: 'x'.repeat(20_000) })
  expect(parseAgentEvent(`notify;warp://cli-agent;${huge}`)).toBeNull()
})

test.each([
  ['a plain human-facing notification', 'notify;Build done;All tests passed'],
  ['an unknown event', 'notify;warp://cli-agent;{"event":"heartbeat"}'],
  ['a body that is not json', 'notify;warp://cli-agent;not json'],
  ['a body that is json but not an object', 'notify;warp://cli-agent;42'],
  ['an event of the wrong type', 'notify;warp://cli-agent;{"event":7}'],
  ['no event at all', 'notify;warp://cli-agent;{"agent":"claude"}'],
  ['another osc 777 verb', 'ping;warp://cli-agent;{"event":"stop"}'],
  ['too few fields', 'notify;warp://cli-agent'],
  ['nothing', ''],
])('%s is not a status event', (_label, data) => {
  expect(parseAgentEvent(data)).toBeNull()
})

test('a field of the wrong type is dropped rather than carried', () => {
  expect(
    parseAgentEvent(
      'notify;warp://cli-agent;{"event":"stop","response":{"a":1}}',
    ),
  ).toEqual({ name: 'stop' })
})
