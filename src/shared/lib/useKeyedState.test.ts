import { expect, test } from 'bun:test'
import { act, renderHook } from '@testing-library/react'

import { useKeyedState } from './useKeyedState'

const setup = (initial: string) =>
  renderHook(
    ({ dir }: { dir: string }) => useKeyedState<string | null>([dir], null),
    { initialProps: { dir: initial } },
  )

test('a value reads only for the input it was set for', () => {
  const view = setup('a')
  expect(view.result.current[0]).toBeNull()
  act(() => view.result.current[1](['a'], 'list of a'))
  expect(view.result.current[0]).toBe('list of a')
  view.rerender({ dir: 'b' })
  expect(view.result.current[0]).toBeNull()
})

test('a reply for an input that has moved is dropped', () => {
  const view = setup('a')
  view.rerender({ dir: 'b' })
  act(() => view.result.current[1](['a'], 'late list of a'))
  expect(view.result.current[0]).toBeNull()
})

test('a late reply never displaces the current input’s value', () => {
  const view = setup('r1')
  view.rerender({ dir: 'r2' })
  act(() => view.result.current[1](['r2'], 'list at r2'))
  // A refresh started at r1 answers after r2's read already landed.
  act(() => view.result.current[1](['r1'], 'list at r1'))
  expect(view.result.current[0]).toBe('list at r2')
})
