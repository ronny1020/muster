import { describe, expect, it } from 'bun:test'

import { completionFor, MAX_MATCHES, matchesFor } from './suggest'

const history = (ran: string[] = [], stored: string[] = []) => ({ ran, stored })

describe('matchesFor', () => {
  it('offers the past commands that carry on from what is typed', () => {
    expect(
      matchesFor('git ', history([], ['git status', 'ls', 'git push'])),
    ).toEqual(['git status', 'git push'])
  })

  it('says nothing about one or no characters', () => {
    // A single letter matches most of a history file, so the list would be
    // the history rather than a suggestion.
    expect(matchesFor('g', history([], ['git status']))).toEqual([])
    expect(matchesFor('', history([], ['git status']))).toEqual([])
  })

  it('puts what this session ran first, newest first', () => {
    // The history file cannot know about either until the shell exits.
    const ran = ['cargo build', 'cargo test --lib']
    expect(matchesFor('cargo ', history(ran, ['cargo run']))).toEqual([
      'cargo test --lib',
      'cargo build',
      'cargo run',
    ])
  })

  it('says each command once, however many times it was run', () => {
    expect(matchesFor('ls', history(['ls -la'], ['ls -la', 'ls -l']))).toEqual([
      'ls -la',
      'ls -l',
    ])
  })

  it('leaves out a command already typed in full', () => {
    expect(matchesFor('git status', history([], ['git status']))).toEqual([])
  })

  it('leaves a line hidden from the history alone', () => {
    // A leading space is how a shell is asked not to record a line, so
    // completing one would name what was deliberately hidden. Both halves
    // matter: the prefix being typed, and the candidate's own.
    expect(matchesFor(' git st', history([], [' git status']))).toEqual([])
    expect(
      matchesFor('aws', history([' aws configure set secret abc'])),
    ).toEqual([])
  })

  it('refuses a candidate carrying a control byte', () => {
    // Accepting types the rest into a live shell, so a newline in it submits
    // a line nobody wrote.
    expect(matchesFor('ec', history([], ['echo one\nrm -rf /']))).toEqual([])
  })

  it('stays a hint rather than a page', () => {
    // It is drawn over the session's own output.
    const stored = Array.from({ length: 30 }, (_, n) => `echo ${n}`)
    expect(matchesFor('ec', history([], stored))).toHaveLength(MAX_MATCHES)
  })
})

describe('completionFor', () => {
  it('adds what the top match carries on with', () => {
    expect(completionFor('git st', ['git status'])).toBe('atus')
  })

  it('answers nothing when nothing matched', () => {
    expect(completionFor('git st', [])).toBeNull()
  })
})
