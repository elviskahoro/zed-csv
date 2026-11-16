# Parquet Viewer for Zed

Look at Parquet, CSV, TSV, and JSONL files from inside [Zed](https://zed.dev).

Zed extensions can't draw custom UI, and Zed won't open binary files such as `.parquet`. This extension works around both limits:

- **Agent tools.** An MCP server built on [hyparquet](https://github.com/hyparam/hyparquet) and [squirreling](https://github.com/hyparam/squirreling) lets Zed's Agent describe, page through, and run SQL over data files. Results come back as markdown tables.
- **Table preview.** The `convert` tool writes Parquet out as CSV or JSONL. You can then open that file in Zed's built-in table viewer (`tabular data: open preview`).

You don't need this extension for plain CSV viewing: open a `.csv`, `.tsv`, or `.jsonl` file and run `tabular data: open preview to the side` (Zed 1.17 or later).

## Two extensions

This repo holds two extensions that do the same job with different server runtimes. Install one, not both.

| | [`extensions/node`](extensions/node) | [`extensions/native`](extensions/native) |
|---|---|---|
| Extension id | `parquet-viewer` | `parquet-viewer-native` |
| Server | JavaScript, bundled and run on Zed's Node | Rust binary, downloaded from a GitHub release |
| Formats | Parquet, CSV, TSV, JSONL | Parquet only |
| Tools | `describe_table`, `read_rows`, `query`, `convert` | `describe_table`, `read_rows`, `convert` (no SQL yet) |
| Release step | None, the server is embedded | Needs per-platform release builds (not set up yet) |

The rest of this README describes the Node extension. The native one has the same tools minus `query`, and uses the same settings.

## Install (dev)

1. Clone this repo.
2. In Zed, run `zed: install dev extension` and pick `extensions/node` (or `extensions/native`).
3. In the Agent panel's settings, make sure the **parquet-viewer** server is enabled.

You need Rust installed through rustup, because Zed compiles the extension to `wasm32-wasip2`. The Node server runs on the Node.js runtime that ships with Zed, so you don't need to install Node.

The native extension downloads `parquet-viewer-mcp-<os>-<arch>.tar.gz` (`.zip` on Windows) from this repo's latest GitHub release. Nothing publishes those yet, so until the release workflow exists the native extension can't start outside a local build of the server.

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

Parquet files are read one row group at a time, so large files aren't loaded fully into memory. CSV, TSV, and JSONL files are parsed in full on every tool call, like Zed's own CSV preview. That works up to 1 GiB, needs about 5× the file size in memory, and takes tens of seconds per call for files in the hundreds of MB. Convert bigger files to Parquet.

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

The Node MCP server lives in `extensions/node/server/`. It's bundled into `extensions/node/server/dist/server.js`, which is committed because Zed builds extensions with Cargo only. The bundle is embedded into the WASM extension with `include_str!` and written to the extension's work directory when the server starts.

```sh
cd extensions/node/server
npm ci
npm test            # unit tests + MCP stdio smoke test against dist/server.js
npm run build       # rebuild dist/server.js after changing src/

cd ../../..
cargo build --release --target wasm32-wasip2 -p zed-parquet-viewer -p zed-parquet-viewer-native
cargo test -p parquet-viewer-mcp     # native server (extensions/native/server)
```

CI checks that `dist/server.js` matches the sources.

## Native Parquet preview (Zed patch prototype)

[`upstream/zed/`](upstream/zed/README.md) holds a patch to Zed itself. It makes Zed's built-in table preview open `.parquet` files directly. The RWX pipeline in [`.rwx/zed-parquet.yml`](.rwx/zed-parquet.yml) builds and tests it, so you don't need a local Zed build.
