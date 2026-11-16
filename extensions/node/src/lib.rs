use std::fs;

use zed_extension_api::{
    self as zed, Command, ContextServerConfiguration, ContextServerId, Project, Result,
    serde_json::{self, Value},
    settings::ContextServerSettings,
};

/// The bundled MCP server, compiled into the extension so it works offline and
/// needs no npm or GitHub-release publishing.
const SERVER_JS: &str = include_str!("../server/dist/server.js");
const SERVER_FILE: &str = "parquet-viewer-server.js";

const SETTINGS_ENV: &[(&str, &str)] = &[
    ("max_rows", "PARQUET_VIEWER_MAX_ROWS"),
    ("convert_row_limit", "PARQUET_VIEWER_CONVERT_ROW_LIMIT"),
];

struct ParquetViewerExtension;

impl ParquetViewerExtension {
    /// Writes the bundled server into the extension's work directory, skipping
    /// the write when an identical copy is already there.
    fn server_path(&self) -> Result<String> {
        if fs::read_to_string(SERVER_FILE).ok().as_deref() != Some(SERVER_JS) {
            fs::write(SERVER_FILE, SERVER_JS)
                .map_err(|e| format!("failed to write {SERVER_FILE}: {e}"))?;
        }
        let dir = std::env::current_dir()
            .map_err(|e| format!("failed to resolve extension work directory: {e}"))?;
        Ok(dir.join(SERVER_FILE).to_string_lossy().into_owned())
    }
}

impl zed::Extension for ParquetViewerExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_command(
        &mut self,
        context_server_id: &ContextServerId,
        project: &Project,
    ) -> Result<Command> {
        let settings = ContextServerSettings::for_project(context_server_id.as_ref(), project)?;
        let user = settings.settings.unwrap_or(Value::Null);
        let env = SETTINGS_ENV
            .iter()
            .filter_map(|(key, var)| {
                let value = user.get(key)?.as_u64()?;
                Some((var.to_string(), value.to_string()))
            })
            .collect();

        Ok(Command {
            command: zed::node_binary_path()?,
            // CSV/TSV/JSONL rows are held in memory (as Zed's own CSV preview does), and V8's
            // default heap cap is far below what a large file needs.
            args: vec!["--max-old-space-size=8192".to_string(), self.server_path()?],
            env,
        })
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &ContextServerId,
        _project: &Project,
    ) -> Result<Option<ContextServerConfiguration>> {
        let settings_schema = serde_json::json!({
            "type": "object",
            "properties": {
                "max_rows": {
                    "type": "integer",
                    "minimum": 1,
                    "maximum": 1000,
                    "default": 50,
                    "description": "Default number of rows returned by read_rows and query."
                },
                "convert_row_limit": {
                    "type": "integer",
                    "minimum": 1,
                    "default": 100000,
                    "description": "Default maximum rows written by convert."
                }
            }
        });
        Ok(Some(ContextServerConfiguration {
            installation_instructions: include_str!(
                "../configuration/installation_instructions.md"
            )
            .to_string(),
            settings_schema: settings_schema.to_string(),
            default_settings: include_str!("../configuration/default_settings.jsonc").to_string(),
        }))
    }
}

zed::register_extension!(ParquetViewerExtension);
