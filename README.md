# Parquet Viewer for Zed

Look at Parquet, CSV, TSV, and JSONL files from inside [Zed](https://zed.dev).

Zed extensions can't draw custom UI, and Zed won't open binary files such as `.parquet`. This extension works around both limits:

- **Agent tools.** An MCP server built on [hyparquet](https://github.com/hyparam/hyparquet) and [squirreling](https://github.com/hyparam/squirreling) lets Zed's Agent describe, page through, and run SQL over data files. Results come back as markdown tables.
- **Table preview.** The `convert` tool writes Parquet out as CSV or JSONL. You can then open that file in Zed's built-in table viewer (`tabular data: open preview`).

You don't need this extension for plain CSV viewing: open a `.csv`, `.tsv`, or `.jsonl` file and run `tabular data: open preview to the side` (Zed 1.17 or later).

## Install (dev)

1. Clone this repo.
2. In Zed, run `zed: install dev extension` and pick the repo folder.
3. In the Agent panel's settings, make sure the **parquet-viewer** server is enabled.

You need Rust installed through rustup, because Zed compiles the extension to `wasm32-wasip2`. The server runs on the Node.js runtime that ships with Zed, so you don't need to install Node.

## Tools

| Tool | What it does |
|---|---|
| `describe_table` | Shows the file's columns and types, row count, and size, plus row groups and compression for Parquet. |
| `read_rows` | Returns rows `offset`…`offset+limit` as a markdown table. You can choose which columns. |
| `query` | Runs read-only SQL. Map each table name to a file, e.g. `tables: { "trips": "/data/trips.parquet" }`. You can join Parquet and CSV files. |
| `convert` | Writes `<name>.preview.csv` (or `.jsonl`) next to the source file. It won't overwrite an existing file unless you pass `overwrite: true`. |

Example prompts:

- "Describe `data/trips.parquet`"
- "What are the top 10 vendors by total fare in `data/trips.parquet`?"
- "Convert `data/trips.parquet` to CSV", then open `trips.preview.csv` and run `tabular data: open preview`

Parquet files are read one row group at a time, so large files aren't loaded fully into memory. CSV, TSV, and JSONL files are parsed in full.

## Settings

```jsonc
// settings.json
{
  "context_servers": {
    "parquet-viewer": {
      "settings": {
        "max_rows": 50,             // default row limit for read_rows/query (max 1000)
        "convert_row_limit": 100000 // default row limit for convert
      }
    }
  }
}
```

## Development

The MCP server lives in `server/`. It's bundled into `server/dist/server.js`, which is committed because Zed builds extensions with Cargo only. The bundle is embedded into the WASM extension with `include_str!` and written to the extension's work directory when the server starts.

```sh
cd server
npm ci
npm test            # unit tests + MCP stdio smoke test against dist/server.js
npm run build       # rebuild dist/server.js after changing src/

cd ..
cargo build --release --target wasm32-wasip2
```

CI checks that `dist/server.js` matches the sources.
