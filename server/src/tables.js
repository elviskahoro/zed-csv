import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { createInterface } from 'node:readline'
import { pipeline } from 'node:stream'
import { parse } from 'csv-parse'
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { asyncRow } from 'squirreling'

/**
 * @import { AsyncDataSource } from 'squirreling'
 * @import { FileMetaData, SchemaTree } from 'hyparquet'
 */

/**
 * @typedef {'parquet' | 'csv' | 'tsv' | 'jsonl'} Format
 *
 * @typedef {object} Table
 * @property {Format} format
 * @property {string} path
 * @property {number} fileSize
 * @property {string[]} columns
 * @property {{ name: string, type: string }[]} fields
 * @property {number} numRows
 * @property {string[]} details - extra format-specific lines for describe_table
 * @property {(start: number, end: number, columns?: string[]) => Promise<Record<string, any>[]>} readRows
 *   reads rows in [start, end)
 * @property {() => Iterable<[number, number]>} chunks - row ranges sized for streaming reads
 * @property {() => AsyncDataSource} sqlSource
 */

/** @type {Record<string, Format>} */
const FORMATS = {
  '.parquet': 'parquet',
  '.pq': 'parquet',
  '.csv': 'csv',
  '.tsv': 'tsv',
  '.tab': 'tsv',
  '.jsonl': 'jsonl',
  '.ndjson': 'jsonl',
}

export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS)

/**
 * Text formats are held fully in memory. A 600 MiB CSV parsed and then queried with GROUP BY
 * fits in a heap capped at 5.3x its size, so a 1 GiB file needs about 5.3 GiB of the 8 GiB
 * heap the extension gives Node, leaving headroom for denser data.
 */
export const MAX_TEXT_FILE_BYTES = 2 ** 30

/**
 * @param {string} path
 * @returns {Format}
 */
export function formatOf(path) {
  const format = FORMATS[extname(path).toLowerCase()]
  if (!format) {
    throw new Error(`Unsupported file type "${extname(path) || path}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`)
  }
  return format
}

/**
 * @param {string} path - absolute path
 * @returns {Promise<Table>}
 */
export async function openTable(path) {
  const format = formatOf(path)
  let fileSize
  try {
    fileSize = (await stat(path)).size
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'ENOENT') {
      throw new Error(`File not found: ${path}`)
    }
    throw error
  }
  if (format === 'parquet') return openParquet(path, fileSize)
  if (fileSize > MAX_TEXT_FILE_BYTES) {
    throw new Error(
      `${path} is ${(fileSize / 2 ** 30).toFixed(1)} GiB; ${format.toUpperCase()} files over ${MAX_TEXT_FILE_BYTES / 2 ** 30} GiB aren't supported because they are loaded fully into memory. Convert the file to Parquet, which is read in row groups.`,
    )
  }
  return openText(path, fileSize, format)
}

/**
 * @param {string} path
 * @param {number} fileSize
 * @returns {Promise<Table>}
 */
async function openParquet(path, fileSize) {
  const file = await asyncBufferFromFile(path)
  /** @type {FileMetaData} */
  let metadata
  try {
    metadata = await parquetMetadataAsync(file)
  } catch (error) {
    throw new Error(`Not a readable Parquet file: ${path} (${/** @type {Error} */ (error).message})`)
  }
  const schema = parquetSchema(metadata)
  const columns = schema.children.map(child => child.element.name)
  const numRows = Number(metadata.num_rows)

  /** @type {Table['readRows']} */
  function readRows(start, end, selected) {
    return parquetReadObjects({ file, metadata, compressors, rowStart: start, rowEnd: end, columns: selected })
  }

  function* chunks() {
    let start = 0
    for (const group of metadata.row_groups) {
      const end = start + Number(group.num_rows)
      if (end > start) yield /** @type {[number, number]} */ ([start, end])
      start = end
    }
  }

  const codecs = new Set(metadata.row_groups.flatMap(group => group.columns.map(c => c.meta_data?.codec).filter(Boolean)))
  const details = [
    `Row groups: ${metadata.row_groups.length}`,
    `Compression: ${[...codecs].join(', ') || 'none'}`,
  ]
  if (metadata.created_by) details.push(`Created by: ${metadata.created_by}`)

  return {
    format: 'parquet',
    path,
    fileSize,
    columns,
    fields: schema.children.map(child => ({ name: child.element.name, type: parquetType(child) })),
    numRows,
    details,
    readRows,
    chunks,
    sqlSource: () => chunkedDataSource(columns, numRows, chunks, readRows),
  }
}

/**
 * Human-readable type for a top-level schema node.
 *
 * @param {SchemaTree} node
 * @returns {string}
 */
function parquetType({ element, children }) {
  const logical = element.logical_type
  if (logical) {
    if (logical.type === 'DECIMAL') return `DECIMAL(${logical.precision},${logical.scale})`
    if (logical.type === 'TIMESTAMP') return `TIMESTAMP(${logical.unit})`
    return logical.type
  }
  if (element.converted_type) return element.converted_type
  if (children.length) return 'STRUCT'
  return element.type ?? 'UNKNOWN'
}

/**
 * Streams one chunk (a Parquet row group) at a time so large files never sit fully in memory.
 * Declaring columns up front also lets squirreling query files that have no rows.
 *
 * @param {string[]} columns
 * @param {number} numRows
 * @param {() => Iterable<[number, number]>} chunks
 * @param {Table['readRows']} readRows
 * @returns {AsyncDataSource}
 */
function chunkedDataSource(columns, numRows, chunks, readRows) {
  return {
    numRows,
    columns,
    scan({ columns: wanted, where, limit, offset, signal }) {
      const rowColumns = wanted ?? columns
      // Limit/offset can only be pushed down when no filter runs after the scan.
      const start = where ? 0 : offset ?? 0
      const end = !where && limit !== undefined ? Math.min(numRows, start + limit) : numRows
      return {
        async *rows() {
          for (const [chunkStart, chunkEnd] of chunks()) {
            const from = Math.max(chunkStart, start)
            const to = Math.min(chunkEnd, end)
            if (from >= to) continue
            if (signal?.aborted) return
            for (const row of await readRows(from, to, rowColumns)) {
              yield asyncRow(row, rowColumns)
            }
          }
        },
        appliedWhere: false,
        appliedLimitOffset: !where,
      }
    },
  }
}

const BOOLEAN = /^(?:true|false)$/i

/**
 * Decides one cast per column so a column never mixes numbers and strings. Values are
 * observed one at a time while parsing, so no per-column copy of the data is needed.
 */
class ColumnTypeTracker {
  present = false
  allNumbers = true
  allBooleans = true

  /** @param {string} value */
  observe(value) {
    if (value === '') return
    this.present = true
    // Only cast when the number prints back to the exact same text, so codes like "007",
    // "1.50", or IDs beyond 2^53 keep their original form.
    if (this.allNumbers && String(Number(value)) !== value) this.allNumbers = false
    if (this.allBooleans && !BOOLEAN.test(value)) this.allBooleans = false
  }

  /** @returns {(value: string) => string | number | boolean | null} */
  caster() {
    if (this.present && this.allNumbers) return value => (value === '' ? null : Number(value))
    if (this.present && this.allBooleans) return value => (value === '' ? null : value.toLowerCase() === 'true')
    return value => (value === '' ? null : value)
  }
}

/**
 * @param {string} path
 * @param {number} fileSize
 * @param {'csv' | 'tsv' | 'jsonl'} format
 * @returns {Promise<Table>}
 */
async function openText(path, fileSize, format) {
  // Parsed from a stream rather than one string: Node strings max out at 512 MiB, which made
  // larger files fail outright. Rows still live in memory, like Zed's own CSV preview.
  const { columns, rows } = format === 'jsonl'
    ? await parseJsonLines(path)
    : await parseDelimited(path, format === 'tsv' ? '\t' : ',')
  const numRows = rows.length

  /** @type {Table['readRows']} */
  async function readRows(start, end, selected) {
    const slice = rows.slice(start, end)
    if (!selected) return slice
    return slice.map(row => Object.fromEntries(selected.map(name => [name, row[name]])))
  }

  function* chunks() {
    for (let start = 0; start < numRows; start += 10000) {
      yield /** @type {[number, number]} */ ([start, Math.min(numRows, start + 10000)])
    }
  }

  return {
    format,
    path,
    fileSize,
    columns,
    fields: columns.map(name => ({ name, type: inferType(rows, name) })),
    numRows,
    details: [],
    readRows,
    chunks,
    sqlSource: () => chunkedDataSource(columns, numRows, chunks, readRows),
  }
}

/**
 * @param {string} path
 * @param {string} delimiter
 */
async function parseDelimited(path, delimiter) {
  /** @type {string[][]} */
  const records = []
  /** @type {string[] | undefined} */
  let header
  /** @type {ColumnTypeTracker[]} */
  let trackers = []
  const parser = parse({
    delimiter,
    bom: true,
    relax_column_count: true,
    relax_quotes: true,
    skip_empty_lines: true,
    // TSV has no quoting convention; a literal " is just text.
    quote: delimiter === '\t' ? false : '"',
  })
  try {
    // utf8 decoding on the stream keeps multi-byte characters intact across chunk boundaries.
    // pipeline (unlike pipe) forwards read errors such as EISDIR or EACCES to the parser, so
    // they reject this loop instead of crashing the server, and closes the file on any failure.
    const parsed = pipeline(createReadStream(path, { encoding: 'utf8' }), parser, () => {})
    for await (const record of parsed) {
      if (!header) {
        header = record
        trackers = record.map(() => new ColumnTypeTracker())
        continue
      }
      for (let i = 0; i < trackers.length; i++) trackers[i].observe(record[i] ?? '')
      records.push(record)
    }
  } catch (error) {
    throw new Error(`Could not parse ${path}: ${/** @type {Error} */ (error).message}`)
  }
  const columns = uniqueNames(header ?? [])
  const casters = trackers.map(tracker => tracker.caster())
  // Convert in place so raw records and row objects aren't both held for the whole file.
  // fromEntries defines own properties, so a header like "__proto__" stays a column.
  /** @type {Record<string, any>[]} */
  const rows = /** @type {any} */ (records)
  for (let r = 0; r < records.length; r++) {
    const record = records[r]
    rows[r] = Object.fromEntries(columns.map((name, i) => [name, casters[i](record[i] ?? '')]))
  }
  return { columns, rows }
}

/**
 * @param {string} path
 */
async function parseJsonLines(path) {
  /** @type {Record<string, any>[]} */
  const rows = []
  /** @type {Set<string>} */
  const columns = new Set()
  const input = createReadStream(path, { encoding: 'utf8' })
  const lines = createInterface({ input, crlfDelay: Infinity })
  let lineNumber = 0
  /** @type {string | undefined} */
  let invalidJson
  try {
    for await (const rawLine of lines) {
      lineNumber++
      const line = lineNumber === 1 ? rawLine.replace(/^\uFEFF/, '') : rawLine
      if (!line.trim()) continue
      let value
      try {
        value = JSON.parse(line)
      } catch (error) {
        invalidJson = /** @type {Error} */ (error).message
        break
      }
      const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { value }
      for (const key of Object.keys(row)) columns.add(key)
      rows.push(row)
    }
  } catch (error) {
    // Read errors (EISDIR, EACCES, ...), worded like the CSV path's.
    throw new Error(`Could not parse ${path}: ${/** @type {Error} */ (error).message}`)
  } finally {
    // Closing readline leaves the file open after an early break, so release it explicitly.
    lines.close()
    input.destroy()
  }
  if (invalidJson !== undefined) {
    throw new Error(`Invalid JSON on line ${lineNumber} of ${path}: ${invalidJson}`)
  }
  const names = [...columns]
  // SQL needs every row to expose every column.
  for (const row of rows) for (const name of names) if (!Object.hasOwn(row, name)) row[name] = null
  return { columns: names, rows }
}

/**
 * Blank or repeated headers would collide as object keys.
 *
 * @param {string[]} header
 * @returns {string[]}
 */
function uniqueNames(header) {
  /** @type {Set<string>} */
  const seen = new Set()
  return header.map((raw, i) => {
    const base = raw.trim() || `column_${i + 1}`
    let name = base
    for (let n = 2; seen.has(name); n++) name = `${base}_${n}`
    seen.add(name)
    return name
  })
}

/**
 * @param {Record<string, any>[]} rows
 * @param {string} name
 * @returns {string}
 */
function inferType(rows, name) {
  /** @type {Set<string>} */
  const types = new Set()
  for (const row of rows.slice(0, 1000)) {
    const value = row[name]
    if (value === null || value === undefined) continue
    if (typeof value === 'number') types.add(Number.isInteger(value) ? 'integer' : 'number')
    else if (Array.isArray(value)) types.add('array')
    else types.add(typeof value)
  }
  if (types.size === 0) return 'null'
  if (types.size === 2 && types.has('integer') && types.has('number')) return 'number'
  return types.size === 1 ? [...types][0] : 'mixed'
}
