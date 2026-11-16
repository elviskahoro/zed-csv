/**
 * Plain-text form of a cell: numbers/strings as-is, nested values as JSON.
 *
 * @param {any} value
 * @returns {string}
 */
export function cellText(value) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? 'Invalid Date' : value.toISOString()
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  return JSON.stringify(value, jsonReplacer)
}

/**
 * @param {string} _key
 * @param {any} value
 */
function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
  if (value instanceof Uint8Array) return `<${value.length} bytes>`
  return value
}

/**
 * @param {string[]} columns
 * @param {Record<string, any>[]} rows
 * @param {number} [maxCellChars]
 * @returns {string}
 */
export function markdownTable(columns, rows, maxCellChars = 200) {
  /** @param {any} value */
  const cell = value => {
    if (value === null || value === undefined) return '*null*'
    let text = cellText(value)
    if (text.length > maxCellChars) text = `${text.slice(0, maxCellChars)}…`
    return text.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
  }
  const lines = [
    `| ${columns.map(cell).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
    ...rows.map(row => `| ${columns.map(name => cell(row[name])).join(' | ')} |`),
  ]
  return lines.join('\n')
}

/**
 * @param {string} text
 * @returns {string}
 */
function csvField(text) {
  return /[",\r\n]/.test(text) || text !== text.trim() ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * @param {string[]} columns
 * @returns {string}
 */
export function csvHeader(columns) {
  return `${columns.map(csvField).join(',')}\n`
}

/**
 * @param {string[]} columns
 * @param {Record<string, any>[]} rows
 * @returns {string}
 */
export function csvRows(columns, rows) {
  return rows.map(row => `${columns.map(name => csvField(cellText(row[name]))).join(',')}\n`).join('')
}

/**
 * @param {string[]} columns
 * @param {Record<string, any>[]} rows
 * @returns {string}
 */
export function jsonlRows(columns, rows) {
  return rows.map(row => `${JSON.stringify(Object.fromEntries(columns.map(name => [name, row[name] ?? null])), jsonReplacer)}\n`).join('')
}

/**
 * @param {number} bytes
 * @returns {string}
 */
export function humanBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`
}
