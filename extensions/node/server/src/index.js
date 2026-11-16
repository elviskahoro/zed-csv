import { fileURLToPath } from 'node:url'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { SUPPORTED_EXTENSIONS } from './tables.js'
import { HARD_ROW_CAP, convert, describeTable, query, readRows } from './tools.js'

/**
 * @param {string | undefined} value
 * @param {number} fallback
 */
function positiveInt(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

/** @type {import('./tools.js').Options} */
const options = {
  baseDir: process.cwd(),
  maxRows: positiveInt(process.env.PARQUET_VIEWER_MAX_ROWS, 50),
  convertRowLimit: positiveInt(process.env.PARQUET_VIEWER_CONVERT_ROW_LIMIT, 100000),
}

const server = new McpServer({ name: 'parquet-viewer', version: '0.1.0' })

const pathArg = z.string().describe(
  `Absolute path to a data file (${SUPPORTED_EXTENSIONS.join(', ')}). Relative paths resolve against the project root.`
)

/**
 * Wraps a tool so thrown errors come back as readable tool errors instead of protocol failures.
 *
 * @template T
 * @param {(args: T, options: import('./tools.js').Options) => Promise<string>} run
 * @returns {(args: T) => Promise<{ content: { type: 'text', text: string }[], isError?: boolean }>}
 */
function tool(run) {
  return async args => {
    try {
      return { content: [{ type: 'text', text: await run(args, options) }] }
    } catch (error) {
      return { content: [{ type: 'text', text: /** @type {Error} */ (error).message }], isError: true }
    }
  }
}

server.registerTool('describe_table', {
  title: 'Describe data file',
  description: 'Show the schema of a Parquet, CSV, TSV, or JSONL file: column names and types, row count, size, and Parquet row groups/compression. Call this first to learn column names.',
  inputSchema: { path: pathArg },
  annotations: { readOnlyHint: true },
}, tool(describeTable))

server.registerTool('read_rows', {
  title: 'Read rows',
  description: 'Return a slice of rows from a Parquet, CSV, TSV, or JSONL file as a markdown table. Use offset/limit to page through the file.',
  inputSchema: {
    path: pathArg,
    offset: z.number().int().min(0).optional().describe('Zero-based row to start at (default 0)'),
    limit: z.number().int().min(1).max(HARD_ROW_CAP).optional().describe(`Rows to return (default ${options.maxRows})`),
    columns: z.array(z.string()).min(1).optional().describe('Only return these columns'),
  },
  annotations: { readOnlyHint: true },
}, tool(readRows))

server.registerTool('query', {
  title: 'SQL query',
  description: 'Run a read-only SQL query over one or more data files. Map each table name used in the SQL to a file path, e.g. tables: { "trips": "/data/trips.parquet" } with sql: SELECT vendor, COUNT(*) AS n FROM trips GROUP BY vendor ORDER BY n DESC. Quote column names containing spaces with double quotes; use single quotes for strings.',
  inputSchema: {
    sql: z.string().describe('SQL SELECT statement'),
    tables: z.record(z.string(), z.string()).describe('Table name → file path'),
    limit: z.number().int().min(1).max(HARD_ROW_CAP).optional().describe(`Maximum rows to return (default ${options.maxRows})`),
  },
  annotations: { readOnlyHint: true },
}, tool(query))

server.registerTool('convert', {
  title: 'Convert for table preview',
  description: 'Convert a Parquet (or other data) file to CSV or JSONL so it can be opened in Zed and viewed with the built-in `tabular data: open preview` table viewer. By default writes <name>.preview.csv next to the source and refuses to overwrite existing files.',
  inputSchema: {
    path: pathArg,
    format: z.enum(['csv', 'jsonl']).optional().describe('Output format (default csv; jsonl keeps nested values as JSON)'),
    out: z.string().optional().describe('Output path (default: <name>.preview.<format> next to the source)'),
    row_limit: z.number().int().min(1).optional().describe(`Maximum rows to write (default ${options.convertRowLimit})`),
    overwrite: z.boolean().optional().describe('Replace the output file if it exists (default false)'),
  },
  annotations: { readOnlyHint: false, destructiveHint: false },
}, tool(convert))

server.server.oninitialized = async () => {
  if (!server.server.getClientCapabilities()?.roots) return
  try {
    const { roots } = await server.server.listRoots()
    const dirs = roots.filter(r => r.uri.startsWith('file://')).map(r => fileURLToPath(r.uri))
    if (dirs.length) {
      options.baseDir = dirs[0]
      options.extraRoots = dirs.slice(1)
    }
  } catch {
    // Roots are only a hint for relative paths; keep the process cwd.
  }
}

await server.connect(new StdioServerTransport())
