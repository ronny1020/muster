/**
 * Splits a user-typed flag string into argv, honouring single and double
 * quoted values so `--append-system-prompt "be terse"` survives intact.
 */
export function splitFlags(input: string): string[] {
  const tokens = input.match(/"[^"]*"?|'[^']*'?|\S+/g) ?? []
  return tokens.map((token) =>
    /^["']/.test(token)
      ? token.slice(
          1,
          token.at(-1) === token[0] && token.length > 1 ? -1 : undefined,
        )
      : token,
  )
}
