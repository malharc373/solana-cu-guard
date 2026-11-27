//! Writes the compute-unit report that
//! [solana-cu-guard](https://github.com/malharc373/solana-cu-guard) compares
//! between a pull request and its base commit.
//!
//! ```
//! let mut report = cu_report::Report::new();
//! report.record("initialize", 3_004);
//! report.record("increment", 331);
//! assert_eq!(report.to_json(), "{\n  \"initialize\": 3004,\n  \"increment\": 331\n}\n");
//! ```
//!
//! In a test, write it with `report.write(cu_report::default_path!())`.

#![forbid(unsafe_code)]

use std::{
    fmt, fs, io,
    path::{Path, PathBuf},
};

/// The longest instruction name the action accepts.
pub const MAX_NAME_LEN: usize = 200;

/// The largest value the action reads exactly (JavaScript's `Number.MAX_SAFE_INTEGER`).
/// Far above any real transaction, which is capped at 1.4 million compute units.
pub const MAX_COMPUTE_UNITS: u64 = (1 << 53) - 1;

/// Compute units per instruction, in the order they were recorded.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    rows: Vec<(String, u64)>,
}

/// Why an entry was refused. The action would refuse the same report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryError {
    Empty,
    TooLong(usize),
    ControlCharacter,
    Duplicate(String),
    /// Above 2^53 − 1, the largest integer the action reads exactly.
    TooLarge(u64),
}

impl fmt::Display for EntryError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            EntryError::Empty => write!(f, "instruction names must not be empty"),
            EntryError::TooLong(n) => write!(
                f,
                "instruction name is {n} characters; the limit is {MAX_NAME_LEN}"
            ),
            EntryError::ControlCharacter => {
                write!(f, "instruction names must not contain control characters")
            }
            EntryError::Duplicate(name) => write!(f, "instruction \"{name}\" is recorded twice"),
            EntryError::TooLarge(cu) => write!(
                f,
                "{cu} compute units is more than the report can hold ({MAX_COMPUTE_UNITS})"
            ),
        }
    }
}

impl std::error::Error for EntryError {}

impl Report {
    pub fn new() -> Self {
        Self::default()
    }

    /// Records one instruction.
    ///
    /// # Panics
    /// If the entry is one the action would reject. A report is built in a test,
    /// where a panic is the clearest failure; use [`Report::try_record`] to handle it.
    #[track_caller]
    pub fn record(&mut self, name: impl Into<String>, compute_units: u64) -> &mut Self {
        if let Err(e) = self.try_record(name, compute_units) {
            panic!("cu-report: {e}");
        }
        self
    }

    pub fn try_record(
        &mut self,
        name: impl Into<String>,
        compute_units: u64,
    ) -> Result<&mut Self, EntryError> {
        let name = name.into();
        if compute_units > MAX_COMPUTE_UNITS {
            return Err(EntryError::TooLarge(compute_units));
        }
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(EntryError::Empty);
        }
        // The action counts UTF-16 code units (JavaScript string length).
        let len = name.encode_utf16().count();
        if len > MAX_NAME_LEN {
            return Err(EntryError::TooLong(len));
        }
        if name
            .chars()
            .any(|c| c.is_control() || c == '\u{2028}' || c == '\u{2029}')
        {
            return Err(EntryError::ControlCharacter);
        }
        // The action trims names before comparing them.
        if self.rows.iter().any(|(n, _)| n.trim() == trimmed) {
            return Err(EntryError::Duplicate(trimmed.to_string()));
        }
        self.rows.push((name, compute_units));
        Ok(self)
    }

    pub fn len(&self) -> usize {
        self.rows.len()
    }

    pub fn is_empty(&self) -> bool {
        self.rows.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = (&str, u64)> {
        self.rows.iter().map(|(n, cu)| (n.as_str(), *cu))
    }

    pub fn to_json(&self) -> String {
        if self.rows.is_empty() {
            return "{}\n".to_string();
        }
        let body: Vec<String> = self
            .rows
            .iter()
            .map(|(n, cu)| format!("  {}: {cu}", json_string(n)))
            .collect();
        format!("{{\n{}\n}}\n", body.join(",\n"))
    }

    /// Writes the JSON report, creating parent directories. The file is written
    /// next to its destination and renamed into place, so a crash never leaves
    /// half a report for CI to read.
    pub fn write(&self, path: impl AsRef<Path>) -> io::Result<PathBuf> {
        let path = path.as_ref();
        if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
            fs::create_dir_all(dir)?;
        }
        let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
        fs::write(&tmp, self.to_json())?;
        fs::rename(&tmp, path)?;
        Ok(path.to_path_buf())
    }
}

/// `target/cu-report.json` for the package whose integration tests call it.
///
/// Uses `CARGO_TARGET_TMPDIR`, which Cargo sets for integration tests and
/// benches, so it follows `CARGO_TARGET_DIR` and workspace layouts.
#[macro_export]
macro_rules! default_path {
    () => {
        concat!(env!("CARGO_TARGET_TMPDIR"), "/../cu-report.json")
    };
}

fn json_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c => out.push(c), // control characters were rejected in try_record
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_in_recorded_order() {
        let mut r = Report::new();
        r.record("b", 2).record("a", 1);
        assert_eq!(r.to_json(), "{\n  \"b\": 2,\n  \"a\": 1\n}\n");
        assert_eq!(r.iter().collect::<Vec<_>>(), [("b", 2), ("a", 1)]);
    }

    #[test]
    fn empty_report_is_an_empty_object() {
        assert_eq!(Report::new().to_json(), "{}\n");
    }

    #[test]
    fn escapes_quotes_and_backslashes() {
        let mut r = Report::new();
        r.record(r#"say "hi" \ bye"#, 1)
            .record("make (token-2022)", MAX_COMPUTE_UNITS);
        assert_eq!(
            r.to_json(),
            "{\n  \"say \\\"hi\\\" \\\\ bye\": 1,\n  \"make (token-2022)\": 9007199254740991\n}\n"
        );
    }

    #[test]
    fn rejects_what_the_action_rejects() {
        let mut r = Report::new();
        assert_eq!(r.try_record("", 1).unwrap_err(), EntryError::Empty);
        assert_eq!(r.try_record("   ", 1).unwrap_err(), EntryError::Empty);
        assert_eq!(
            r.try_record("a\nb", 1).unwrap_err(),
            EntryError::ControlCharacter
        );
        assert_eq!(
            r.try_record("a\u{2028}b", 1).unwrap_err(),
            EntryError::ControlCharacter
        );
        assert_eq!(
            r.try_record("x".repeat(201), 1).unwrap_err(),
            EntryError::TooLong(201)
        );
        r.record("x".repeat(200), 1);
        r.record("same", 1);
        assert_eq!(
            r.try_record(" same ", 2).unwrap_err(),
            EntryError::Duplicate("same".into())
        );
        assert_eq!(
            r.try_record("big", MAX_COMPUTE_UNITS + 1).unwrap_err(),
            EntryError::TooLarge(MAX_COMPUTE_UNITS + 1)
        );
        assert_eq!(r.len(), 2);
    }

    #[test]
    fn length_is_counted_like_javascript() {
        // Each emoji is 2 UTF-16 code units: 100 of them is the limit, 101 is over.
        Report::new().record("😀".repeat(100), 1);
        assert_eq!(
            Report::new().try_record("😀".repeat(101), 1).unwrap_err(),
            EntryError::TooLong(202)
        );
    }

    #[test]
    #[should_panic(expected = "cu-report: instruction \"a\" is recorded twice")]
    fn record_panics_with_the_reason() {
        Report::new().record("a", 1).record("a", 2);
    }

    #[test]
    fn write_creates_directories_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("cu-report-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let path = dir.join("nested/cu-report.json");
        let mut r = Report::new();
        r.record("increment", 331);
        r.write(&path).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "{\n  \"increment\": 331\n}\n"
        );
        let names: Vec<_> = fs::read_dir(path.parent().unwrap())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, ["cu-report.json"]);
        fs::remove_dir_all(&dir).unwrap();
    }
}
