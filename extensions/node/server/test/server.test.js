import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, it } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const bundle = fileURLToPath(new URL('../dist/server.js', import.meta.url))

/** @type {string} */
let dir
/** @type {Client} */
let client

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parquet-viewer-mcp-'))
  await writeFile(join(dir, 'pets.csv'), 'name,legs\ncat,4\nbird,2\n')
  client = new Client({ name: 'test', version: '0.0.0' })
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [bundle],
    cwd: dir,
    env: { PARQUET_VIEWER_MAX_ROWS: '1' },
  }))
})

after(async () => {
  await client?.close()
  await rm(dir, { recursive: true, force: true })
})

it('lists the four tools from the bundled server', async () => {
  const { tools } = await client.listTools()
  assert.deepEqual(tools.map(t => t.name).sort(), ['convert', 'describe_table', 'query', 'read_rows'])
})

it('resolves relative paths against cwd and applies the max-rows env setting', async () => {
  const result = await client.callTool({ name: 'read_rows', arguments: { path: 'pets.csv' } })
  assert.equal(result.isError, undefined)
  const [{ text }] = /** @type {{ text: string }[]} */ (result.content)
  assert.match(text, /Rows 1–1 of 2/)
  assert.match(text, /\| cat \| 4 \|/)
})

it('returns tool errors instead of failing the request', async () => {
  const result = await client.callTool({ name: 'describe_table', arguments: { path: 'missing.parquet' } })
  assert.equal(result.isError, true)
  assert.match(/** @type {{ text: string }[]} */ (result.content)[0].text, /File not found/)
})
