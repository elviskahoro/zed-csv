//! A small MCP server (JSON-RPC over stdio) that lets Zed's agent inspect and convert Parquet files.

mod parquet_table;
mod tools;

use std::io::{BufRead, Write};

use serde_json::{Value, json};

use tools::Options;

const PROTOCOL_VERSION: &str = "2025-06-18";

fn env_usize(name: &str, default: usize) -> usize {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .filter(|&n| n > 0)
        .unwrap_or(default)
}

fn handle(request: &Value, options: &Options) -> Option<Value> {
    let id = request.get("id")?.clone();
    let method = request.get("method").and_then(Value::as_str).unwrap_or("");
    let params = request.get("params").cloned().unwrap_or(Value::Null);
    let result = match method {
        "initialize" => Ok(json!({
            "protocolVersion": params
                .get("protocolVersion")
                .and_then(Value::as_str)
                .unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": {} },
            "serverInfo": { "name": "parquet-viewer-native", "version": env!("CARGO_PKG_VERSION") },
        })),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::definitions(options) })),
        "tools/call" => {
            let name = params.get("name").and_then(Value::as_str).unwrap_or("");
            let args = params.get("arguments").cloned().unwrap_or(json!({}));
            Ok(match tools::call(name, &args, options) {
                Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                Err(message) => {
                    json!({ "content": [{ "type": "text", "text": message }], "isError": true })
                }
            })
        }
        other => Err(format!("Method not found: {other}")),
    };
    Some(match result {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err(message) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": message } })
        }
    })
}

fn main() {
    let options = Options {
        base_dir: std::env::current_dir().unwrap_or_default(),
        max_rows: env_usize("PARQUET_VIEWER_MAX_ROWS", 50),
        convert_row_limit: env_usize("PARQUET_VIEWER_CONVERT_ROW_LIMIT", 100_000),
    };
    let mut stdout = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let response = match serde_json::from_str::<Value>(&line) {
            Ok(request) => handle(&request, &options),
            Err(e) => Some(json!({
                "jsonrpc": "2.0", "id": null,
                "error": { "code": -32700, "message": format!("Parse error: {e}") },
            })),
        };
        if let Some(response) = response
            && (writeln!(stdout, "{response}").is_err() || stdout.flush().is_err())
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Options {
        Options {
            base_dir: std::env::temp_dir(),
            max_rows: 50,
            convert_row_limit: 100,
        }
    }

    #[test]
    fn notifications_get_no_response() {
        let request = json!({ "jsonrpc": "2.0", "method": "notifications/initialized" });
        assert!(handle(&request, &options()).is_none());
    }

    #[test]
    fn lists_three_tools() {
        let request = json!({ "jsonrpc": "2.0", "id": 1, "method": "tools/list" });
        let response = handle(&request, &options()).unwrap();
        let names: Vec<_> = response["result"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .map(|t| t["name"].as_str().unwrap())
            .collect();
        assert_eq!(names, ["describe_table", "read_rows", "convert"]);
    }

    #[test]
    fn unknown_tool_is_a_tool_error() {
        let request = json!({
            "jsonrpc": "2.0", "id": 2, "method": "tools/call",
            "params": { "name": "nope", "arguments": {} },
        });
        let response = handle(&request, &options()).unwrap();
        assert_eq!(response["result"]["isError"], true);
    }
}
