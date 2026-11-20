import { expect, test } from 'bun:test'

import { showReview } from './treeview'

test('a control that names a view opens the drawer on it', () => {
  expect(showReview({ review: false, view: 'changes' }, 'files')).toEqual({
    review: true,
    view: 'files',
  })
})

test('naming the other view switches rather than closing', () => {
  // The directory and the change counts each say "show me this", not "flip
  // the drawer".
  expect(showReview({ review: true, view: 'files' }, 'changes')).toEqual({
    review: true,
    view: 'changes',
  })
})

test('naming the view already on screen closes the drawer, keeping the view', () => {
  expect(showReview({ review: true, view: 'files' }, 'files')).toEqual({
    review: false,
    view: 'files',
  })
})
