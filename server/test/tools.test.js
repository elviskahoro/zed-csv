import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { parquetWriteFile } from 'hyparquet-writer'
import { MAX_TEXT_FILE_BYTES } from '../src/tables.js'
import { convert, describeTable, query, readRows } from '../src/tools.js'

/** @type {string} */
let dir
/** @type {import('../src/tools.js').Options} */
let options

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'parquet-viewer-'))
  options = { baseDir: dir, maxRows: 50, convertRowLimit: 100000 }

  const n = 250
  parquetWriteFile({
    filename: join(dir, 'trips.parquet'),
    rowGroupSize: 100,
    columnData: [
      { name: 'id', data: BigInt64Array.from({ length: n }, (_, i) => BigInt(i)), type: 'INT64' },
      { name: 'vendor', data: Array.from({ length: n }, (_, i) => ['acme', 'globex', 'initech'][i % 3]), type: 'STRING' },
      { name: 'fare', data: Array.from({ length: n }, (_, i) => (i % 10 === 0 ? null : i * 1.5)), type: 'DOUBLE', nullable: true },
      { name: 'note', data: Array.from({ length: n }, (_, i) => (i === 1 ? 'has, comma | pipe\nnewline "quote"' : `row ${i}`)), type: 'STRING' },
      { name: 'started', data: Array.from({ length: n }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, i))), type: 'TIMESTAMP' },
      { name: 'meta', data: Array.from({ length: n }, (_, i) => ({ tags: ['a', String(i)] })), type: 'JSON' },
    ],
  })

  await writeFile(join(dir, 'people.csv'), '﻿name,zip,age,active,,name\nAda,02134,36,true,x,dup\n"Lovelace, A",10001,,false,y,dup2\n')
  await writeFile(join(dir, 'vendors.csv'), 'vendor,country\nacme,US\nglobex,US\ninitech,CA\n')
  await writeFile(join(dir, 'events.tsv'), 'kind\tcount\nclick\t3\nview\t10\n')
  await writeFile(join(dir, 'logs.jsonl'), '{"level":"info","ms":5}\n\n{"level":"warn","extra":{"a":1}}\n')
})

after(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('describe_table', () => {
  it('reports parquet schema, row groups, and compression', async () => {
    const text = await describeTable({ path: join(dir, 'trips.parquet') }, options)
    assert.match(text, /Format: parquet/)
    assert.match(text, /Rows: 250/)
    assert.match(text, /Columns: 6/)
    assert.match(text, /Row groups: 3/)
    assert.match(text, /Compression: SNAPPY/)
    assert.match(text, /\| id \| INT64 \|/)
    assert.match(text, /\| vendor \| UTF8 \|/)
    assert.match(text, /\| started \| TIMESTAMP_MILLIS \|/)
  })

  it('infers CSV column types, keeps zero-padded codes as strings, and dedupes headers', async () => {
    const text = await describeTable({ path: 'people.csv' }, options)
    assert.match(text, /Rows: 2/)
    assert.match(text, /\| name \| string \|/)
    assert.match(text, /\| zip \| string \|/)
    assert.match(text, /\| age \| integer \|/)
    assert.match(text, /\| active \| boolean \|/)
    assert.match(text, /\| column_5 \| string \|/)
    assert.match(text, /\| name_2 \| string \|/)
  })

  it('fails clearly for missing and unsupported files', async () => {
    await assert.rejects(describeTable({ path: 'nope.parquet' }, options), /File not found/)
    await assert.rejects(describeTable({ path: 'a.xlsx' }, options), /Unsupported file type ".xlsx"/)
  })

  it('rejects files that are not parquet', async () => {
    await writeFile(join(dir, 'fake.parquet'), 'not parquet at all')
    await assert.rejects(describeTable({ path: 'fake.parquet' }, options), /Not a readable Parquet file/)
  })
})

describe('read_rows', () => {
  it('reads a slice spanning row groups and escapes markdown', async () => {
    const text = await readRows({ path: join(dir, 'trips.parquet'), offset: 98, limit: 4, columns: ['id', 'vendor'] }, options)
    assert.match(text, /Rows 99–102 of 250/)
    const body = text.split('\n').slice(4)
    assert.deepEqual(body, ['| 98 | initech |', '| 99 | acme |', '| 100 | globex |', '| 101 | initech |'])
  })

  it('renders nulls, dates, nested JSON, and escapes pipes/newlines', async () => {
    const text = await readRows({ path: join(dir, 'trips.parquet'), limit: 2 }, options)
    assert.match(text, /\| 0 \| acme \| \*null\* \| row 0 \| 2026-01-01T00:00:00\.000Z \| \{"tags":\["a","0"\]\} \|/)
    assert.match(text, /has, comma \\\| pipe newline "quote"/)
  })

  it('handles offsets past the end and unknown columns', async () => {
    assert.match(await readRows({ path: 'trips.parquet', offset: 1000 }, options), /No rows at offset 250/)
    await assert.rejects(readRows({ path: 'trips.parquet', columns: ['missing'] }, options), /Unknown column\(s\): missing/)
  })

  it('reads JSONL with columns unioned across lines', async () => {
    const text = await readRows({ path: 'logs.jsonl' }, options)
    assert.match(text, /\| level \| ms \| extra \|/)
    assert.match(text, /\| warn \| \*null\* \| \{"a":1\} \|/)
  })
})

describe('query', () => {
  it('aggregates across all row groups of a parquet file', async () => {
    const text = await query({
      sql: 'SELECT vendor, COUNT(*) AS n FROM trips GROUP BY vendor ORDER BY vendor',
      tables: { trips: join(dir, 'trips.parquet') },
    }, options)
    assert.match(text, /3 rows/)
    assert.match(text, /\| acme \| 84 \|/)
    assert.match(text, /\| globex \| 83 \|/)
    assert.match(text, /\| initech \| 83 \|/)
  })

  it('pushes LIMIT/OFFSET into the parquet scan', async () => {
    const text = await query({ sql: 'SELECT id FROM t LIMIT 2 OFFSET 150', tables: { t: 'trips.parquet' } }, options)
    assert.match(text, /\| 150 \|\n\| 151 \|/)
  })

  it('joins parquet with CSV', async () => {
    const text = await query({
      sql: 'SELECT v.country, COUNT(*) AS n FROM trips t JOIN vendors v ON t.vendor = v.vendor GROUP BY v.country ORDER BY v.country',
      tables: { trips: 'trips.parquet', vendors: 'vendors.csv' },
    }, options)
    assert.match(text, /\| CA \| 83 \|\n\| US \| 167 \|/)
  })

  it('filters TSV numbers as numbers', async () => {
    const text = await query({
      sql: 'SELECT e.kind, e.count FROM events e WHERE e.count > 5',
      tables: { events: 'events.tsv' },
    }, options)
    assert.match(text, /1 row in/)
    assert.match(text, /\| view \| 10 \|/)
  })

  it('caps results and says more are available', async () => {
    const text = await query({ sql: 'SELECT id FROM t', tables: { t: 'trips.parquet' }, limit: 5 }, options)
    assert.match(text, /Showing the first 5 rows \(more available/)
  })

  it('surfaces SQL errors', async () => {
    await assert.rejects(query({ sql: 'SELEC nope', tables: { t: 'trips.parquet' } }, options))
    await assert.rejects(query({ sql: 'SELECT 1', tables: {} }, options), /at least one table/)
  })
})

describe('convert', () => {
  it('writes a CSV next to the source that round-trips through the CSV reader', async () => {
    const text = await convert({ path: join(dir, 'trips.parquet') }, options)
    const target = join(dir, 'trips.preview.csv')
    assert.match(text, new RegExp(`Wrote 250 rows to ${target}\\.`))
    assert.match(text, /tabular data: open preview/)

    const csv = await readFile(target, 'utf8')
    const lines = csv.split('\n')
    assert.equal(lines[0], 'id,vendor,fare,note,started,meta')
    assert.equal(lines[1], '0,acme,,row 0,2026-01-01T00:00:00.000Z,"{""tags"":[""a"",""0""]}"')
    assert.equal(lines[2], '1,globex,1.5,"has, comma | pipe')

    const roundTrip = await readRows({ path: target, offset: 1, limit: 1, columns: ['note'] }, options)
    assert.match(roundTrip, /has, comma \\\| pipe newline "quote"/)
  })

  it('refuses to overwrite unless asked', async () => {
    await assert.rejects(convert({ path: 'trips.parquet' }, options), /already exists\. Pass overwrite: true/)
    assert.match(await convert({ path: 'trips.parquet', overwrite: true, row_limit: 120 }, options), /first 120 of 250 rows/)
    const csv = await readFile(join(dir, 'trips.preview.csv'), 'utf8')
    assert.equal(csv.trimEnd().split('\n').filter(line => /^\d+,/.test(line)).length, 120)
  })

  it('writes JSONL to an explicit path', async () => {
    await convert({ path: 'trips.parquet', format: 'jsonl', out: 'out/../trips.jsonl', row_limit: 2 }, options)
    const lines = (await readFile(join(dir, 'trips.jsonl'), 'utf8')).trimEnd().split('\n')
    assert.equal(lines.length, 2)
    assert.deepEqual(JSON.parse(lines[0]), { id: 0, vendor: 'acme', fare: null, note: 'row 0', started: '2026-01-01T00:00:00.000Z', meta: { tags: ['a', '0'] } })
  })

  it('refuses to write over its own input', async () => {
    await assert.rejects(convert({ path: 'people.csv', out: 'people.csv' }, options), /must differ/)
  })
})

describe('regressions', () => {
  it('refuses to overwrite its input through "..", symlinks, or overwrite: true', async () => {
    await mkdir(join(dir, 'sub'), { recursive: true })
    const before = (await stat(join(dir, 'trips.parquet'))).size
    await assert.rejects(convert({ path: 'trips.parquet', out: join(dir, 'sub', '..', 'trips.parquet'), overwrite: true }, options), /must differ/)
    await symlink(join(dir, 'trips.parquet'), join(dir, 'link.csv'))
    await assert.rejects(convert({ path: 'trips.parquet', out: 'link.csv', overwrite: true }, options), /must differ/)
    assert.equal((await stat(join(dir, 'trips.parquet'))).size, before)
  })

  it('queries header-only CSV and empty JSONL files', async () => {
    await writeFile(join(dir, 'empty.csv'), 'a,b\n')
    await writeFile(join(dir, 'empty.jsonl'), '')
    assert.match(await query({ sql: 'SELECT COUNT(*) AS n FROM t', tables: { t: 'empty.csv' } }, options), /\| 0 \|/)
    assert.match(await query({ sql: 'SELECT COUNT(*) AS n FROM t', tables: { t: 'empty.jsonl' } }, options), /\| 0 \|/)
  })

  it('tolerates stray quotes in CSV and treats quotes in TSV as text', async () => {
    await writeFile(join(dir, 'quotes.csv'), 'item,n\n5" screen,2\n')
    await writeFile(join(dir, 'quotes.tsv'), 'item\tn\n"quoted" word\t2\n')
    assert.match(await readRows({ path: 'quotes.csv' }, options), /\| 5" screen \| 2 \|/)
    assert.match(await readRows({ path: 'quotes.tsv' }, options), /\| "quoted" word \| 2 \|/)
  })

  it('keeps numbers that would not round-trip as their original text', async () => {
    await writeFile(join(dir, 'precise.csv'), 'big,dec,neg,ok\n12345678901234567.0,1.50,-0,1.5\n9007199254740993,2,1,2\n')
    const text = await describeTable({ path: 'precise.csv' }, options)
    assert.match(text, /\| big \| string \|/)
    assert.match(text, /\| dec \| string \|/)
    assert.match(text, /\| neg \| string \|/)
    assert.match(text, /\| ok \| number \|/)
    await convert({ path: 'precise.csv', out: 'precise.out.csv' }, options)
    assert.equal(await readFile(join(dir, 'precise.out.csv'), 'utf8'), 'big,dec,neg,ok\n12345678901234567.0,1.50,-0,1.5\n9007199254740993,2,1,2\n')
  })

  it('handles JSONL keys and CSV headers that collide with Object.prototype', async () => {
    await writeFile(join(dir, 'proto.jsonl'), '{"constructor":1,"a":1}\n{"a":2}\n')
    await writeFile(join(dir, 'proto.csv'), '__proto__,b\nx,1\n')
    assert.match(await readRows({ path: 'proto.jsonl' }, options), /\| \*null\* \| 2 \|/)
    assert.match(await query({ sql: 'SELECT a FROM t', tables: { t: 'proto.jsonl' } }, options), /2 rows/)
    assert.match(await readRows({ path: 'proto.csv' }, options), /\| x \| 1 \|/)
  })

  it('strips a UTF-8 BOM from JSONL files', async () => {
    await writeFile(join(dir, 'bom.jsonl'), '\uFEFF{"a":1}\n')
    assert.match(await readRows({ path: 'bom.jsonl' }, options), /\| 1 \|/)
  })

  it('finds relative paths in secondary workspace roots', async () => {
    const other = join(dir, 'other')
    await mkdir(other)
    await writeFile(join(other, 'only-here.jsonl'), '{"a":7}\n')
    const multi = { ...options, extraRoots: [other] }
    assert.match(await readRows({ path: 'only-here.jsonl' }, multi), /\| 7 \|/)
  })

  it('refuses to overwrite its input through a symlinked directory', async () => {
    await symlink(dir, join(dir, 'dirlink'))
    await assert.rejects(
      convert({ path: 'trips.parquet', format: 'csv', out: 'dirlink/trips.parquet', overwrite: true }, options),
      /must differ/,
    )
  })

  it('parses files larger than one stream chunk without splitting rows or characters', async () => {
    // Several 64 KiB stream chunks, with multi-byte characters and quoted newlines landing on
    // chunk boundaries somewhere in the file.
    const count = 5000
    const csvRows = Array.from({ length: count }, (_, i) => `${i},"naïve ☃ ${i}\nsecond line",${i % 2 ? 'true' : 'false'}`)
    await writeFile(join(dir, 'chunked.csv'), `id,note,flag\n${csvRows.join('\n')}\n`)
    const jsonRows = Array.from({ length: count }, (_, i) => JSON.stringify({ id: i, note: `ünïcødé ${i}` }))
    await writeFile(join(dir, 'chunked.jsonl'), `${jsonRows.join('\n')}\n`)

    const csv = await describeTable({ path: 'chunked.csv' }, options)
    assert.match(csv, new RegExp(`Rows: ${count.toLocaleString('en-US')}`))
    assert.match(csv, /\| id \| integer \|/)
    assert.match(csv, /\| flag \| boolean \|/)
    const lastCsv = await readRows({ path: 'chunked.csv', offset: count - 1, limit: 1 }, options)
    assert.match(lastCsv, new RegExp(`\\| ${count - 1} \\| naïve ☃ ${count - 1} second line \\| true \\|`))

    assert.match(await describeTable({ path: 'chunked.jsonl' }, options), new RegExp(`Rows: ${count.toLocaleString('en-US')}`))
    const lastJson = await readRows({ path: 'chunked.jsonl', offset: count - 1, limit: 1 }, options)
    assert.match(lastJson, new RegExp(`\\| ${count - 1} \\| ünïcødé ${count - 1} \\|`))
  })

  it('reports the line number of invalid JSONL', async () => {
    await writeFile(join(dir, 'broken.jsonl'), '{"a":1}\n\n{"a":\n')
    await assert.rejects(readRows({ path: 'broken.jsonl' }, options), /Invalid JSON on line 3 of/)
  })

  it('refuses text files too large to hold in memory before reading them', async () => {
    // Sparse file: the size check happens before any bytes are read, so this is instant.
    await writeFile(join(dir, 'huge.csv'), 'a,b\n')
    await truncate(join(dir, 'huge.csv'), MAX_TEXT_FILE_BYTES + 1)
    await assert.rejects(describeTable({ path: 'huge.csv' }, options), /over 1 GiB aren't supported.*Convert the file to Parquet/)
  })

  it('rejects unreadable text files instead of crashing', async () => {
    for (const name of ['folder.csv', 'folder.jsonl']) {
      await mkdir(join(dir, name))
      await assert.rejects(describeTable({ path: name }, options), /Could not parse .*EISDIR/, name)
    }
  })
})
