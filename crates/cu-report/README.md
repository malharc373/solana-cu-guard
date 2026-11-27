# cu-report

Writes the `{"instruction": compute units}` file that [solana-cu-guard](https://github.com/malharc373/solana-cu-guard) compares between a pull request and its base. No dependencies, so it works with any test framework: LiteSVM, Mollusk, `solana-program-test`.

```toml
[dev-dependencies]
cu-report = { git = "https://github.com/malharc373/solana-cu-guard", tag = "v1.2.0" }
```

```rust
#[test]
fn cu_report() {
    let mut report = cu_report::Report::new();
    // Fixed keys keep PDAs, bumps and so compute units the same on every run.
    let user = Keypair::new_from_array([1; 32]);
    // ... send each instruction ...
    report.record("initialize", meta.compute_units_consumed);
    report.write(cu_report::default_path!()).unwrap();
}
```

`default_path!()` is `target/cu-report.json` of the package under test, which is where the reusable workflow looks by default.

`record` rejects what the action would reject: empty names, names over 200 characters, names with control characters, duplicates, and values above 2^53 − 1 (the action reads numbers as JavaScript does). So a bad report fails locally, not in CI.
