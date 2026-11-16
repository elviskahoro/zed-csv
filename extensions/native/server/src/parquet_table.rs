//! Reading schema and row slices out of a Parquet file.

use std::fs::File;
use std::path::{Path, PathBuf};

use parquet::file::reader::{FileReader, SerializedFileReader};
use serde_json::Value;

pub struct Table {
    pub path: PathBuf,
    pub file_size: u64,
    pub num_rows: usize,
    /// Top-level column name and a human-readable type.
    pub fields: Vec<(String, String)>,
    pub row_groups: usize,
    pub compression: Vec<String>,
    reader: SerializedFileReader<File>,
}

impl Table {
    pub fn open(path: &Path) -> Result<Self, String> {
        let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
        let file_size = file.metadata().map_err(|e| e.to_string())?.len();
        let reader = SerializedFileReader::new(file)
            .map_err(|e| format!("{} is not a readable Parquet file: {e}", path.display()))?;
        let meta = reader.metadata();
        let schema = meta.file_metadata().schema();
        let fields = schema
            .get_fields()
            .iter()
            .map(|f| {
                let ty = if f.is_primitive() {
                    match f.get_basic_info().logical_type_ref() {
                        Some(logical) => format!("{logical:?}"),
                        None => format!("{}", f.get_physical_type()),
                    }
                } else {
                    "GROUP".to_string()
                };
                (f.name().to_string(), ty)
            })
            .collect();
        let mut compression: Vec<String> = meta
            .row_groups()
            .iter()
            .flat_map(|rg| rg.columns().iter().map(|c| format!("{}", c.compression())))
            .collect();
        compression.sort();
        compression.dedup();
        Ok(Self {
            path: path.to_path_buf(),
            file_size,
            num_rows: usize::try_from(meta.file_metadata().num_rows()).unwrap_or(0),
            fields,
            row_groups: meta.num_row_groups(),
            compression,
            reader,
        })
    }

    pub fn columns(&self) -> Vec<String> {
        self.fields.iter().map(|(name, _)| name.clone()).collect()
    }

    /// Rows `start..end` as JSON objects keyed by column name.
    pub fn read_rows(&self, start: usize, end: usize) -> Result<Vec<Value>, String> {
        let mut rows = Vec::with_capacity(end.saturating_sub(start));
        let mut group_start = 0usize;
        for index in 0..self.reader.num_row_groups() {
            let group_rows =
                usize::try_from(self.reader.metadata().row_group(index).num_rows()).unwrap_or(0);
            let group_end = group_start + group_rows;
            if group_end > start && group_start < end {
                let skip = start.saturating_sub(group_start);
                let take = end.min(group_end) - group_start - skip;
                let group = self
                    .reader
                    .get_row_group(index)
                    .map_err(|e| e.to_string())?;
                let iter = group.get_row_iter(None).map_err(|e| e.to_string())?;
                for row in iter.skip(skip).take(take) {
                    rows.push(row.map_err(|e| e.to_string())?.to_json_value());
                }
            }
            if group_end >= end {
                break;
            }
            group_start = group_end;
        }
        Ok(rows)
    }
}
