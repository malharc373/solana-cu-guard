//! The JSON this crate writes must parse with the action's own parser.
//! Runs `node` on src/report.js when node is available.

use std::process::Command;

#[test]
fn the_action_parses_what_the_crate_writes() {
    let mut r = cu_report::Report::new();
    r.record("initialize", 3004)
        .record(r#"quote " and \ backslash"#, 1)
        .record("make (token-2022)", cu_report::MAX_COMPUTE_UNITS)
        .record("😀".repeat(100), 7);
    let path = r.write(cu_report::default_path!()).unwrap();

    let Ok(out) = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(format!(
            "import {{ parseReport }} from {:?}; import {{ readFileSync }} from 'node:fs'; \
             const rows = parseReport(readFileSync({:?}, 'utf8')); \
             console.log(JSON.stringify(rows.map(r => [r.name, String(r.cu)])));",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../../src/report.js"),
            path
        ))
        .output()
    else {
        eprintln!("node not found; skipping");
        return;
    };
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let parsed = String::from_utf8(out.stdout).unwrap();
    let expected: Vec<String> = r
        .iter()
        .map(|(n, cu)| format!("[{},\"{cu}\"]", serde_free_json(n)))
        .collect();
    assert_eq!(parsed.trim(), format!("[{}]", expected.join(",")));
}

fn serde_free_json(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}
