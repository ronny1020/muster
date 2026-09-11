import { describe, expect, test } from 'bun:test'

import { isMarkdownPath, renderMarkdown, resolveAgainst } from './markdown'

describe('renderMarkdown', () => {
  test("the file's own HTML is escaped, never emitted", async () => {
    // The markdown was written by an agent, and this is the one place the
    // panel builds markup at all.
    const { html } = await renderMarkdown(
      '<img src=x onerror="alert(1)">\n\n<script>alert(2)</script>\n',
      '/code/app',
    )

    // Escaped, so it reads as the text it is: no tag, no attribute, no
    // handler — `onerror=` survives only inside escaped text.
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
    expect(html).toContain('onerror=&quot;')
  })

  test('a link carries its URL as data and cannot navigate', async () => {
    // The webview has one window: an `href` would take the whole app out of
    // the terminal it is sitting beside.
    const { html } = await renderMarkdown('[docs](https://example.com/x)', '')

    expect(html).toContain('data-url="https://example.com/x"')
    expect(html).not.toContain('href')
  })

  test('a javascript URL never becomes a link at all', async () => {
    const { html } = await renderMarkdown('[click](javascript:alert(1))', '')

    expect(html).not.toContain('data-url="javascript')
  })

  test('a mermaid fence becomes a slot, with its source kept for the view', async () => {
    const { html, diagrams } = await renderMarkdown(
      '```mermaid\ngraph TD;\n  A-->B;\n```\n',
      '',
    )

    expect(html).toContain('class="md-diagram"')
    expect([...diagrams.values()]).toEqual(['graph TD;\n  A-->B;\n'])
    // The diagram source is not also rendered as code.
    expect(html).not.toContain('graph TD')
  })

  test('a code fence is coloured by Shiki, with its text escaped', async () => {
    const { html } = await renderMarkdown('```ts\nconst a = "<b>"\n```\n', '')

    expect(html).toContain('<span style="color:#')
    expect(html).toContain('&lt;b&gt;')
  })

  test('a fence in a language we have no grammar for is still readable', async () => {
    const { html } = await renderMarkdown('```zzz\nplain text\n```\n', '')

    expect(html).toContain('plain text')
  })

  test('a relative image is resolved against the file, for Rust to read', async () => {
    // Nothing can be fetched by URL: the policy allows `data:` images only.
    const { html } = await renderMarkdown('![shot](./docs/a.png)', '/code/app')

    expect(html).toContain('data-src="/code/app/docs/a.png"')
    expect(html).not.toContain('src="./docs')
  })

  test('a remote image stays a link, because it cannot be loaded', async () => {
    const { html } = await renderMarkdown('![logo](https://x.test/a.png)', '/c')

    expect(html).toContain('class="md-link"')
    expect(html).not.toContain('<img')
  })

  test('the ordinary structure of a document survives', async () => {
    const { html } = await renderMarkdown(
      '# Title\n\n- one\n- two\n\n| a | b |\n| - | - |\n| 1 | 2 |\n',
      '',
    )

    expect(html).toContain('<h1>Title</h1>')
    expect(html).toContain('<li>one</li>')
    expect(html).toContain('<table>')
  })
})

describe('isMarkdownPath', () => {
  test('the markdown extensions get a rendered view', () => {
    for (const path of ['a.md', 'README.MARKDOWN', 'x/y.mdx']) {
      expect(isMarkdownPath(path)).toBe(true)
    }
  })

  test('nothing else does', () => {
    for (const path of ['a.ts', 'README', '.md', 'a.md.bak']) {
      expect(isMarkdownPath(path)).toBe(false)
    }
  })
})

describe('resolveAgainst', () => {
  test('a relative path joins with the separator the directory uses', () => {
    expect(resolveAgainst('/code/app', './a.png')).toBe('/code/app/a.png')
    expect(resolveAgainst('C:\\code\\app', 'a.png')).toBe(
      'C:\\code\\app\\a.png',
    )
    expect(resolveAgainst('/code/app', 'docs/img/a.png')).toBe(
      '/code/app/docs/img/a.png',
    )
  })

  test('a path that climbs out of the folder is refused', () => {
    // Opening the document was the only action: nothing else asked for this.
    expect(resolveAgainst('/code/app', '../../../../Pictures/x.png')).toBeNull()
    expect(resolveAgainst('/code/app', '..')).toBeNull()
    expect(resolveAgainst('/code/app', 'docs/../../x.png')).toBeNull()
  })

  test('a path that climbs and comes back stays inside', () => {
    expect(resolveAgainst('/code/app', 'docs/../a.png')).toBe('/code/app/a.png')
  })

  test('an absolute path is refused, whichever host wrote it', () => {
    expect(resolveAgainst('/code/app', '/etc/passwd.png')).toBeNull()
    expect(resolveAgainst('/code/app', 'C:\\secrets\\x.png')).toBeNull()
  })

  test('no directory and no target resolve to nothing', () => {
    expect(resolveAgainst('', 'a.png')).toBeNull()
    expect(resolveAgainst('/code/app', '')).toBeNull()
  })
})

describe('fence languages', () => {
  test('a fence spelled out in full is still coloured', async () => {
    // Read as a file extension, `typescript` matched nothing — and spelling it
    // out is how agents write it most of the time.
    for (const tag of [
      'typescript',
      'javascript',
      'python',
      'rust',
      'csharp',
    ]) {
      const { html } = await renderMarkdown(
        `\`\`\`${tag}\nlet a = 1\n\`\`\`\n`,
        '',
      )
      expect(html).toContain('<span style="color:#')
    }
  })

  test('the short spelling still works', async () => {
    const { html } = await renderMarkdown('```ts\nlet a = 1\n```\n', '')

    expect(html).toContain('<span style="color:#')
  })
})

test('an image pointing outside the document says so instead of loading', async () => {
  const { html } = await renderMarkdown(
    '![logo](../../../../Pictures/x.png)',
    '/code/app',
  )

  expect(html).not.toContain('<img')
  expect(html).toContain('image outside this folder')
})
