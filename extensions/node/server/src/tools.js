import { existsSync } from 'node:fs'
import { open, realpath, unlink } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { executeSql } from 'squirreling'
import { csvHeader, csvRows, humanBytes, jsonlRows, markdownTable } from './format.js'
import { openTable } from './tables.js'

/**
 * @typedef {object} Options
 * @property {string} baseDir - directory relative paths resolve against
 * @property {string[]} [extraRoots] - other workspace roots tried when a relative path is not found in baseDir
 * @property {number} maxRows - default row limit for read_rows/query
 * @property {number} convertRowLimit - default row limit for convert
 */

export const HARD_ROW_CAP = 1000

/**
 * @param {string} path
 * @param {Options} options
 * @returns {string}
 */
function resolvePath(path, options) {
  // resolve() also normalizes ".." in absolute paths.
  const primary = resolve(options.baseDir, path)
  if (existsSync(primary)) return primary
  for (const root of options.extraRoots ?? []) {
    const candidate = resolve(root, path)
    if (existsSync(candidate)) return candidate
  }
  return primary
}

/**
 * @param {{ path: string }} args
 * @param {Options} options
 * @returns {Promise<string>}
 */
export async function describeTable({ path }, options) {
  const table = await openTable(resolvePath(path, options))
  const lines = [
    `File: ${table.path}`,
    `Format: ${table.format}`,
    `Size: ${humanBytes(table.fileSize)}`,
    `Rows: ${table.numRows.toLocaleString('en-US')}`,
    `Columns: ${table.columns.length}`,
    ...table.details,
    '',
    markdownTable(['column', 'type'], table.fields.map(({ name, type }) => ({ column: name, type }))),
  ]
  return lines.join('\n')
}

/**
 * @param {{ path: string, offset?: number, limit?: number, columns?: string[] }} args
 * @param {Options} options
 * @returns {Promise<string>}
 */
export async function readRows({ path, offset = 0, limit, columns }, options) {
  const table = await openTable(resolvePath(path, options))
  if (columns) {
    const unknown = columns.filter(name => !table.columns.includes(name))
    if (unknown.length) {
      throw new Error(`Unknown column(s): ${unknown.join(', ')}. Available: ${table.columns.join(', ')}`)
    }
  }
  const count = Math.min(limit ?? options.maxRows, HARD_ROW_CAP)
  const start = Math.min(Math.max(0, offset), table.numRows)
  const end = Math.min(table.numRows, start + count)
  const selected = columns ?? table.columns
  const rows = await table.readRows(start, end, columns)
  const summary = rows.length
    ? `Rows ${start + 1}–${end} of ${table.numRows.toLocaleString('en-US')} from ${table.path}`
    : `No rows at offset ${start} (file has ${table.numRows.toLocaleString('en-US')} rows)`
  return `${summary}\n\n${markdownTable(selected, rows)}`
}

/**
 * @param {{ sql: string, tables: Record<string, string>, limit?: number }} args
 * @param {Options} options
 * @returns {Promise<string>}
 */
export async function query({ sql, tables, limit }, options) {
  const names = Object.keys(tables)
  if (!names.length) throw new Error('Pass at least one table, e.g. { "t": "/path/to/file.parquet" }')
  /** @type {Record<string, any>} */
  const sources = {}
  for (const name of names) {
    sources[name] = (await openTable(resolvePath(tables[name], options))).sqlSource()
  }
  const max = Math.min(limit ?? options.maxRows, HARD_ROW_CAP)
  const started = performance.now()
  const results = executeSql({ tables: sources, query: sql })
  /** @type {Record<string, any>[]} */
  const rows = []
  let more = false
  for await (const row of results.rows()) {
    if (rows.length === max) {
      more = true
      break
    }
    /** @type {Record<string, any>} */
    const values = {}
    for (const column of row.columns) values[column] = await row.cells[column]()
    rows.push(values)
  }
  const seconds = ((performance.now() - started) / 1000).toFixed(2)
  const summary = more
    ? `Showing the first ${rows.length} rows (more available; raise \`limit\` or add LIMIT/OFFSET) in ${seconds}s`
    : `${rows.length} row${rows.length === 1 ? '' : 's'} in ${seconds}s`
  return `${summary}\n\n${markdownTable(results.columns, rows)}`
}

/**
 * @param {{ path: string, format?: 'csv' | 'jsonl', out?: string, row_limit?: number, overwrite?: boolean }} args
 * @param {Options} options
 * @returns {Promise<string>}
 */
export async function convert({ path, format = 'csv', out, row_limit, overwrite = false }, options) {
  const table = await openTable(resolvePath(path, options))
  const target = out
    ? resolvePath(out, options)
    : join(dirname(table.path), `${basename(table.path, extname(table.path))}.preview.${format}`)
  // realpath catches symlinks and case-insensitive filesystems that string comparison misses.
  // Also resolve the parent dir: a not-yet-existing target can still sit behind a symlinked directory.
  const realTarget = await realpath(target).catch(async () => {
    const parent = await realpath(dirname(target)).catch(() => null)
    return parent && join(parent, basename(target))
  })
  if (target === table.path || realTarget === await realpath(table.path)) {
    throw new Error('Output path must differ from the input file')
  }
  const rowLimit = row_limit ?? options.convertRowLimit
  const total = Math.min(table.numRows, rowLimit)

  let handle
  try {
    handle = await open(target, overwrite ? 'w' : 'wx')
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
      throw new Error(`${target} already exists. Pass overwrite: true to replace it, or choose another \`out\` path.`)
    }
    throw error
  }
  try {
    if (format === 'csv') await handle.write(csvHeader(table.columns))
    for (const [chunkStart, chunkEnd] of table.chunks()) {
      if (chunkStart >= total) break
      const rows = await table.readRows(chunkStart, Math.min(chunkEnd, total))
      await handle.write(format === 'csv' ? csvRows(table.columns, rows) : jsonlRows(table.columns, rows))
    }
  } catch (error) {
    // A half-written file would block retries with "already exists".
    await handle.close().catch(() => {})
    await unlink(target).catch(() => {})
    throw error
  }
  await handle.close()

  const truncated = total < table.numRows
    ? ` (first ${total.toLocaleString('en-US')} of ${table.numRows.toLocaleString('en-US')} rows; raise row_limit for more)`
    : ''
  return [
    `Wrote ${total.toLocaleString('en-US')} rows to ${target}${truncated}.`,
    'Open that file in Zed and run `tabular data: open preview` (or `open preview to the side`) from the command palette to view it as a table.',
  ].join('\n')
}
