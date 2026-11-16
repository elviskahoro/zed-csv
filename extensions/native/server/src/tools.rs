//! The MCP tools: describe_table, read_rows, convert.

use std::fs::OpenOptions;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::parquet_table::Table;

pub const HARD_ROW_CAP: usize = 1000;

pub struct Options {
    pub base_dir: PathBuf,
    pub max_rows: usize,
    pub convert_row_limit: usize,
}

pub fn definitions(options: &Options) -> Value {
    let path = json!({
        "type": "string",
        "description": "Absolute path to a .parquet file. Relative paths resolve against the project root.",
    });
    json!([
        {
            "name": "describe_table",
            "title": "Describe Parquet file",
            "description": "Show the schema of a Parquet file: column names and types, row count, size, row groups and compression. Call this first to learn column names.",
            "inputSchema": { "type": "object", "properties": { "path": path }, "required": ["path"] },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "read_rows",
            "title": "Read rows",
            "description": "Return a slice of rows from a Parquet file as a markdown table. Use offset/limit to page through the file.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path,
                    "offset": { "type": "integer", "minimum": 0, "description": "Zero-based row to start at (default 0)" },
                    "limit": { "type": "integer", "minimum": 1, "maximum": HARD_ROW_CAP,
                        "description": format!("Rows to return (default {})", options.max_rows) },
                    "columns": { "type": "array", "items": { "type": "string" }, "minItems": 1,
                        "description": "Only return these columns" },
                },
                "required": ["path"],
            },
            "annotations": { "readOnlyHint": true },
        },
        {
            "name": "convert",
            "title": "Convert for table preview",
            "description": "Convert a Parquet file to CSV or JSONL so it can be opened in Zed and viewed with the built-in `tabular data: open preview` table viewer. By default writes <name>.preview.csv next to the source and refuses to overwrite existing files.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "path": path,
                    "format": { "type": "string", "enum": ["csv", "jsonl"], "description": "Output format (default csv)" },
                    "out": { "type": "string", "description": "Output path (default: <name>.preview.<format> next to the source)" },
                    "row_limit": { "type": "integer", "minimum": 1,
                        "description": format!("Maximum rows to write (default {})", options.convert_row_limit) },
                    "overwrite": { "type": "boolean", "description": "Replace the output file if it exists (default false)" },
                },
                "required": ["path"],
            },
            "annotations": { "readOnlyHint": false, "destructiveHint": false },
        },
    ])
}

pub fn call(name: &str, args: &Value, options: &Options) -> Result<String, String> {
    match name {
        "describe_table" => describe_table(args, options),
        "read_rows" => read_rows(args, options),
        "convert" => convert(args, options),
        other => Err(format!("Unknown tool: {other}")),
    }
}

fn resolve(args: &Value, options: &Options) -> Result<PathBuf, String> {
    let path = args
        .get("path")
        .and_then(Value::as_str)
        .ok_or("`path` is required")?;
    Ok(options.base_dir.join(path))
}

fn usize_arg(args: &Value, key: &str) -> Result<Option<usize>, String> {
    match args.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| usize::try_from(n).ok())
            .map(Some)
            .ok_or_else(|| format!("`{key}` must be a non-negative integer")),
    }
}

fn describe_table(args: &Value, options: &Options) -> Result<String, String> {
    let table = Table::open(&resolve(args, options)?)?;
    let mut out = format!(
        "File: {}\nFormat: parquet\nSize: {}\nRows: {}\nColumns: {}\nRow groups: {}\nCompression: {}\n\n",
        table.path.display(),
        human_bytes(table.file_size),
        table.num_rows,
        table.fields.len(),
        table.row_groups,
        table.compression.join(", "),
    );
    let rows: Vec<Vec<String>> = table
        .fields
        .iter()
        .map(|(name, ty)| vec![name.clone(), ty.clone()])
        .collect();
    out.push_str(&markdown_table(&["column".into(), "type".into()], &rows));
    Ok(out)
}

fn read_rows(args: &Value, options: &Options) -> Result<String, String> {
    let table = Table::open(&resolve(args, options)?)?;
    let columns: Vec<String> = match args.get("columns") {
        None | Some(Value::Null) => table.columns(),
        Some(v) => {
            let wanted: Vec<String> = v
                .as_array()
                .ok_or("`columns` must be an array of strings")?
                .iter()
                .filter_map(|c| c.as_str().map(String::from))
                .collect();
            let all = table.columns();
            let unknown: Vec<_> = wanted
                .iter()
                .filter(|c| !all.contains(c))
                .cloned()
                .collect();
            if !unknown.is_empty() {
                return Err(format!(
                    "Unknown column(s): {}. Available: {}",
                    unknown.join(", "),
                    all.join(", ")
                ));
            }
            wanted
        }
    };
    let count = usize_arg(args, "limit")?
        .unwrap_or(options.max_rows)
        .min(HARD_ROW_CAP);
    let start = usize_arg(args, "offset")?.unwrap_or(0).min(table.num_rows);
    let end = table.num_rows.min(start + count);
    let rows = table.read_rows(start, end)?;
    let summary = if rows.is_empty() {
        format!(
            "No rows at offset {start} (file has {} rows)",
            table.num_rows
        )
    } else {
        format!(
            "Rows {}–{} of {} from {}",
            start + 1,
            end,
            table.num_rows,
            table.path.display()
        )
    };
    let cells: Vec<Vec<String>> = rows.iter().map(|r| row_cells(r, &columns, true)).collect();
    Ok(format!("{summary}\n\n{}", markdown_table(&columns, &cells)))
}

fn convert(args: &Value, options: &Options) -> Result<String, String> {
    let source = resolve(args, options)?;
    let table = Table::open(&source)?;
    let format = args.get("format").and_then(Value::as_str).unwrap_or("csv");
    if format != "csv" && format != "jsonl" {
        return Err("`format` must be \"csv\" or \"jsonl\"".into());
    }
    let overwrite = args
        .get("overwrite")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let target = match args.get("out").and_then(Value::as_str) {
        Some(out) => options.base_dir.join(out),
        None => source.with_extension(format!("preview.{format}")),
    };
    if same_file(&source, &target) {
        return Err("Output path must differ from the input file".into());
    }
    let total = table
        .num_rows
        .min(usize_arg(args, "row_limit")?.unwrap_or(options.convert_row_limit));

    let mut open = OpenOptions::new();
    open.write(true);
    if overwrite {
        open.create(true).truncate(true);
    } else {
        open.create_new(true);
    }
    let file = open.open(&target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::AlreadyExists {
            format!(
                "{} already exists. Pass overwrite: true to replace it, or choose another `out` path.",
                target.display()
            )
        } else {
            format!("Cannot write {}: {e}", target.display())
        }
    })?;
    if let Err(e) = write_converted(&table, file, format, total) {
        // A half-written file would block retries with "already exists".
        let _ = std::fs::remove_file(&target);
        return Err(e);
    }
    let truncated = if total < table.num_rows {
        format!(
            " (first {total} of {} rows; raise row_limit for more)",
            table.num_rows
        )
    } else {
        String::new()
    };
    Ok(format!(
        "Wrote {total} rows to {}{truncated}.\nOpen that file in Zed and run `tabular data: open preview` (or `open preview to the side`) from the command palette to view it as a table.",
        target.display()
    ))
}

fn write_converted(
    table: &Table,
    file: std::fs::File,
    format: &str,
    total: usize,
) -> Result<(), String> {
    let io = |e: std::io::Error| e.to_string();
    let columns = table.columns();
    let mut w = BufWriter::new(file);
    if format == "csv" {
        let header: Vec<String> = columns.iter().map(|c| csv_field(c)).collect();
        writeln!(w, "{}", header.join(",")).map_err(io)?;
    }
    const CHUNK: usize = 10_000;
    let mut start = 0;
    while start < total {
        let end = (start + CHUNK).min(total);
        for row in table.read_rows(start, end)? {
            if format == "csv" {
                let cells: Vec<String> = row_cells(&row, &columns, false)
                    .iter()
                    .map(|c| csv_field(c))
                    .collect();
                writeln!(w, "{}", cells.join(",")).map_err(io)?;
            } else {
                writeln!(w, "{row}").map_err(io)?;
            }
        }
        start = end;
    }
    w.flush().map_err(io)
}

fn same_file(a: &Path, b: &Path) -> bool {
    let canon = |p: &Path| {
        p.canonicalize().ok().or_else(|| {
            let parent = p.parent()?.canonicalize().ok()?;
            Some(parent.join(p.file_name()?))
        })
    };
    a == b || matches!((canon(a), canon(b)), (Some(x), Some(y)) if x == y)
}

fn row_cells(row: &Value, columns: &[String], null_marker: bool) -> Vec<String> {
    columns
        .iter()
        .map(|name| match row.get(name) {
            None | Some(Value::Null) => {
                if null_marker {
                    "*null*".to_string()
                } else {
                    String::new()
                }
            }
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
        })
        .collect()
}

fn csv_field(text: &str) -> String {
    if text.contains([',', '"', '\r', '\n']) || text != text.trim() {
        format!("\"{}\"", text.replace('"', "\"\""))
    } else {
        text.to_string()
    }
}

fn markdown_table(columns: &[String], rows: &[Vec<String>]) -> String {
    const MAX_CELL_CHARS: usize = 200;
    let cell = |text: &str| {
        let mut t: String = text.chars().take(MAX_CELL_CHARS).collect();
        if text.chars().count() > MAX_CELL_CHARS {
            t.push('…');
        }
        t.replace('\\', "\\\\")
            .replace('|', "\\|")
            .replace(['\r', '\n'], " ")
    };
    let line = |cells: &[String]| {
        format!(
            "| {} |",
            cells
                .iter()
                .map(|c| cell(c))
                .collect::<Vec<_>>()
                .join(" | ")
        )
    };
    let mut lines = vec![
        line(columns),
        format!("| {} |", vec!["---"; columns.len()].join(" | ")),
    ];
    lines.extend(rows.iter().map(|r| line(r)));
    lines.join("\n")
}

fn human_bytes(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1} {}", UNITS[unit])
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use parquet::data_type::{ByteArray, ByteArrayType, Int64Type};
    use parquet::file::properties::WriterProperties;
    use parquet::file::writer::SerializedFileWriter;
    use parquet::schema::parser::parse_message_type;

    use super::*;

    /// Writes 5 rows across two row groups (3 + 2): id 1..=5, name a..e (with a comma in "c,").
    fn fixture(dir: &Path) -> PathBuf {
        let path = dir.join("t.parquet");
        let schema = Arc::new(
            parse_message_type("message m { required int64 id; required binary name (STRING); }")
                .unwrap(),
        );
        let props = Arc::new(WriterProperties::builder().build());
        let mut writer =
            SerializedFileWriter::new(std::fs::File::create(&path).unwrap(), schema, props)
                .unwrap();
        for (ids, names) in [
            (vec![1i64, 2, 3], vec!["a", "b", "c,"]),
            (vec![4, 5], vec!["d", "e"]),
        ] {
            let mut group = writer.next_row_group().unwrap();
            let mut col = group.next_column().unwrap().unwrap();
            col.typed::<Int64Type>()
                .write_batch(&ids, None, None)
                .unwrap();
            col.close().unwrap();
            let mut col = group.next_column().unwrap().unwrap();
            let values: Vec<ByteArray> = names.iter().map(|n| ByteArray::from(*n)).collect();
            col.typed::<ByteArrayType>()
                .write_batch(&values, None, None)
                .unwrap();
            col.close().unwrap();
            group.close().unwrap();
        }
        writer.close().unwrap();
        path
    }

    fn options(dir: &Path) -> Options {
        Options {
            base_dir: dir.to_path_buf(),
            max_rows: 50,
            convert_row_limit: 100,
        }
    }

    #[test]
    fn describes_schema() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let out = call(
            "describe_table",
            &json!({ "path": "t.parquet" }),
            &options(dir.path()),
        )
        .unwrap();
        assert!(out.contains("Rows: 5"), "{out}");
        assert!(out.contains("Row groups: 2"), "{out}");
        assert!(out.contains("| id | INT64 |"), "{out}");
    }

    #[test]
    fn reads_across_row_groups() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let args = json!({ "path": "t.parquet", "offset": 2, "limit": 2, "columns": ["name"] });
        let out = call("read_rows", &args, &options(dir.path())).unwrap();
        assert!(out.contains("Rows 3–4 of 5"), "{out}");
        assert!(out.contains("| c, |") && out.contains("| d |"), "{out}");
        assert!(!out.contains("| e |"), "{out}");
    }

    #[test]
    fn rejects_unknown_columns() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let args = json!({ "path": "t.parquet", "columns": ["nope"] });
        let err = call("read_rows", &args, &options(dir.path())).unwrap_err();
        assert!(err.contains("Unknown column(s): nope"), "{err}");
    }

    #[test]
    fn converts_to_csv_and_refuses_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let opts = options(dir.path());
        call("convert", &json!({ "path": "t.parquet" }), &opts).unwrap();
        let csv = std::fs::read_to_string(dir.path().join("t.preview.csv")).unwrap();
        assert_eq!(csv, "id,name\n1,a\n2,b\n3,\"c,\"\n4,d\n5,e\n");
        let err = call("convert", &json!({ "path": "t.parquet" }), &opts).unwrap_err();
        assert!(err.contains("already exists"), "{err}");
        let err = call(
            "convert",
            &json!({ "path": "t.parquet", "out": "t.parquet" }),
            &opts,
        )
        .unwrap_err();
        assert!(err.contains("must differ"), "{err}");
    }

    #[test]
    fn converts_to_jsonl_with_row_limit() {
        let dir = tempfile::tempdir().unwrap();
        fixture(dir.path());
        let args = json!({ "path": "t.parquet", "format": "jsonl", "row_limit": 2 });
        call("convert", &args, &options(dir.path())).unwrap();
        let out = std::fs::read_to_string(dir.path().join("t.preview.jsonl")).unwrap();
        assert_eq!(out.lines().count(), 2);
        assert!(out.starts_with("{\"id\":1,\"name\":\"a\"}"), "{out}");
    }
}
