use std::fs;

use zed_extension_api::{
    self as zed, Architecture, Command, ContextServerConfiguration, ContextServerId,
    DownloadedFileType, GithubReleaseOptions, Os, Project, Result,
    serde_json::{self, Value},
    settings::ContextServerSettings,
};

const REPOSITORY: &str = "elviskahoro/zed-csv";
const BINARY: &str = "parquet-viewer-mcp";

const SETTINGS_ENV: &[(&str, &str)] = &[
    ("max_rows", "PARQUET_VIEWER_MAX_ROWS"),
    ("convert_row_limit", "PARQUET_VIEWER_CONVERT_ROW_LIMIT"),
];

struct ParquetViewerNative;

impl ParquetViewerNative {
    /// Downloads the native server from the latest GitHub release (once per version) and
    /// returns the path to its executable.
    ///
    /// Release assets are expected to be named `parquet-viewer-mcp-<os>-<arch>.<ext>`, where
    /// `<os>` is `macos`, `linux` or `windows`, `<arch>` is `aarch64` or `x86_64`, and `<ext>`
    /// is `zip` on Windows and `tar.gz` elsewhere. The archive holds the executable at its root.
    fn server_path(&self) -> Result<String> {
        let (os, arch) = zed::current_platform();
        let os_name = match os {
            Os::Mac => "macos",
            Os::Linux => "linux",
            Os::Windows => "windows",
        };
        let arch_name = match arch {
            Architecture::Aarch64 => "aarch64",
            Architecture::X8664 => "x86_64",
            Architecture::X86 => return Err("32-bit x86 is not supported".to_string()),
        };
        let (extension, file_type) = match os {
            Os::Windows => ("zip", DownloadedFileType::Zip),
            _ => ("tar.gz", DownloadedFileType::GzipTar),
        };
        let exe = if matches!(os, Os::Windows) {
            format!("{BINARY}.exe")
        } else {
            BINARY.to_string()
        };

        let release = zed::latest_github_release(
            REPOSITORY,
            GithubReleaseOptions {
                require_assets: true,
                pre_release: false,
            },
        )?;
        let asset_name = format!("{BINARY}-{os_name}-{arch_name}.{extension}");
        let asset = release
            .assets
            .iter()
            .find(|a| a.name == asset_name)
            .ok_or_else(|| format!("release {} has no asset {asset_name}", release.version))?;

        let version_dir = format!("{BINARY}-{}", release.version);
        let path = format!("{version_dir}/{exe}");
        if !fs::metadata(&path).is_ok_and(|m| m.is_file()) {
            zed::download_file(&asset.download_url, &version_dir, file_type)
                .map_err(|e| format!("failed to download {asset_name}: {e}"))?;
            zed::make_file_executable(&path)?;
            // Drop older versions.
            if let Ok(entries) = fs::read_dir(".") {
                for entry in entries.flatten() {
                    let name = entry.file_name();
                    let name = name.to_string_lossy();
                    if name.starts_with(BINARY) && name != version_dir {
                        fs::remove_dir_all(entry.path()).ok();
                    }
                }
            }
        }

        let dir = std::env::current_dir()
            .map_err(|e| format!("failed to resolve extension work directory: {e}"))?;
        Ok(dir.join(path).to_string_lossy().into_owned())
    }
}

impl zed::Extension for ParquetViewerNative {
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
            command: self.server_path()?,
            args: vec![],
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
                    "description": "Default number of rows returned by read_rows."
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

zed::register_extension!(ParquetViewerNative);
