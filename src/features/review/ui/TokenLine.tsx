import type { ThemedToken } from 'shiki/types'

export interface TokenLineProps {
  /** Shiki's tokens for this line, or `undefined` when it was not coloured. */
  tokens: ThemedToken[] | undefined
  text: string
}

/**
 * One line of code, coloured if the highlighter got to it.
 *
 * Tokens are rendered as elements rather than through `innerHTML`: Shiki can
 * emit HTML directly, but the code being coloured was written by an agent, and
 * nothing an agent wrote should reach the DOM as markup.
 */
export function TokenLine({ tokens, text }: TokenLineProps) {
  if (!tokens) return <>{text || ' '}</>
  return (
    <>
      {tokens.map((token, index) => (
        <span key={index} style={{ color: token.color }}>
          {token.content}
        </span>
      ))}
    </>
  )
}
