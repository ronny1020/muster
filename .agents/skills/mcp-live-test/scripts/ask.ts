/** Line-delimited client for tauri-plugin-mcp's socket: {command, payload, id, authToken}. */
import { connect } from 'node:net'
import { readFileSync } from 'node:fs'

const SOCKET = '/tmp/muster-mcp.sock'

export function send(command: string, payload: unknown, timeoutMs = 40000) {
  const token = readFileSync(`${SOCKET}.token`, 'utf8').trim()
  return new Promise<unknown>((resolve, reject) => {
    const socket = connect(SOCKET)
    let buffer = ''
    socket.on('connect', () =>
      socket.write(
        `${JSON.stringify({ command, payload, id: 'probe', authToken: token })}\n`,
      ),
    )
    socket.on('data', (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        socket.end()
        const msg: unknown = JSON.parse(line)
        if (typeof msg === 'object' && msg !== null && 'success' in msg) {
          if (msg.success) resolve('data' in msg ? msg.data : undefined)
          else reject(new Error('error' in msg ? String(msg.error) : line))
        } else reject(new Error(line))
        return
      }
    })
    socket.on('error', reject)
    setTimeout(() => {
      socket.destroy()
      reject(new Error('timeout'))
    }, timeoutMs)
  })
}

/** Runs `code` in the webview and returns whatever it evaluates to. */
export async function js(code: string) {
  const data = (await send('execute_js', { code, timeout_ms: 20000 })) as {
    result?: string
  }
  return data?.result ?? JSON.stringify(data)
}

if (import.meta.main) {
  const [command, arg] = process.argv.slice(2)
  if (command === 'js') console.log(await js(arg ?? '1'))
  else console.log(JSON.stringify(await send(command, JSON.parse(arg ?? '{}'))))
}
