# solana-cu-guard

[![CI](https://github.com/malharc373/solana-cu-guard/actions/workflows/ci.yml/badge.svg)](https://github.com/malharc373/solana-cu-guard/actions/workflows/ci.yml)

A GitHub Action that fails a pull request when a Solana program's compute units go up, and posts a per-instruction table on it.

Compute units decide whether a transaction fits in its budget, what it pays in priority fees, and how much room a composing program has left for CPIs. They creep up one `msg!`, one `find_program_address` or one extra deserialization at a time, and nothing in a normal test suite notices. Mollusk's bencher already writes a table with deltas to a local file, but nothing turns that into a pass or fail on a pull request. This action does.

## Demo

[malharc373/solana-pinocchio-counter#1](https://github.com/malharc373/solana-pinocchio-counter/pull/1) makes the counter verify its PDA with `find_program_address` instead of the bump stored in the account. The behaviour is identical, so all 11 tests pass. The guard fails the PR and comments:

| Instruction | Base | Head | Change | |
|---|---:|---:|---:|:---:|
| `increment` | 331 | 1,686 | +1,355 (+409.4%) | 🔴 |
| `decrement` | 323 | 1,677 | +1,354 (+419.2%) | 🔴 |
| `close` | 345 | 1,699 | +1,354 (+392.5%) | 🔴 |
| `initialize` | 3,004 | 3,004 | 0 |  |

The base numbers were built on the GitHub runner from the base commit and match a local run exactly. That is what makes a threshold of 0 work.

## How it works

```
pull request ──build──▶ report (head) ──┐
                                        ├──▶ cu-guard ──▶ table in the PR + job summary
base commit ───build──▶ report (base) ──┘                 step fails on a regression
```

- **Both reports are built in the same job.** The base report comes from a `git worktree` of the PR's base commit, with the same toolchain and on the same runner. A committed baseline file would drift as soon as you upgrade Solana or LiteSVM, and every unrelated PR would fail.
- **The action only compares.** It runs no Rust and installs nothing, so it works with LiteSVM, Mollusk, `solana-program-test`, or anything that can write a JSON file.
- **No dependencies.** It's plain Node 24 with the built-in `fetch`, so there's no `node_modules` or bundle to audit.

## Quick start (LiteSVM)

**1. Write a report** from a test. Use a **fixed keypair**: a random one moves the PDA bumps, and with them the cost of `find_program_address`, so the numbers change between runs.

```rust
#[test]
fn write_cu_report() {
    let mut svm = LiteSVM::new();
    svm.add_program(ID, include_bytes!("../target/deploy/my_program.so")).unwrap();
    let user = Keypair::new_from_array([7; 32]); // fixed: same PDAs and bumps every run
    // ... send each instruction and record meta.compute_units_consumed ...
    std::fs::write("target/cu-report.json", r#"{"initialize": 3004, "increment": 331}"#).unwrap();
}
```

A full example is [`tests/cu_report.rs`](https://github.com/malharc373/solana-pinocchio-counter/blob/main/tests/cu_report.rs) in solana-pinocchio-counter.

**2. Add the workflow.** Copy [`examples/litesvm.yml`](examples/litesvm.yml) to `.github/workflows/`. It builds the report from the PR and from the base commit, then runs:

```yaml
- uses: malharc373/solana-cu-guard@v1
  with:
    base: ${{ runner.temp }}/base.json
    head: ${{ runner.temp }}/head.json
```

## Report formats

| Format | What it looks like |
|---|---|
| `json` | `{"initialize": 4363, "increment": 331}`, or `[{"name": "initialize", "cu": 4363}]` |
| `mollusk` | The `compute_units.md` that [`mollusk-svm-bencher`](https://docs.rs/mollusk-svm-bencher) writes. Only the newest table (the top one) is read. A matrix table (`mx_compute_units.md`) becomes rows named `instruction (program)`. |

`format: auto` (the default) treats a file that starts with `{` or `[` as JSON and anything else as Mollusk.

For Mollusk, run `cargo bench` in each checkout and point `base` and `head` at the two `benches/compute_units.md` files.

## Inputs

| Input | Default | |
|---|---|---|
| `head` | required | Report from the pull request's code. |
| `base` | `""` | Report from the base commit. If the file doesn't exist (the first PR that adds a report), the action shows current values and passes. |
| `format` | `auto` | `auto`, `json` or `mollusk`. |
| `threshold-pct` | `0` | Allowed increase, in percent of the base value. |
| `threshold-cu` | `0` | Allowed increase, in compute units. The larger of the two allowances applies. |
| `fail-on-regression` | `true` | Fail the step when an instruction goes over its allowance. |
| `comment` | `changes` | `always`, `changes` (post only when something changed; an existing comment is always updated, so it never goes stale) or `never`. |
| `title` | `Compute units` | Table heading. Give each program its own title when one workflow guards several; each title gets its own comment. |
| `github-token` | `github.token` | Needs `pull-requests: write`. |

Outputs: `regressions`, `improvements`, `changed` and `markdown`.

**Why the default threshold is 0.** LiteSVM and Mollusk are deterministic: the same program, the same inputs and the same toolchain cost exactly the same compute units on every run. Any increase is therefore a real change in the program, and the comment shows by how much. Raise the threshold only if your report is built from inputs that change between runs.

## Security

- The workflow uses `pull_request`, never `pull_request_target`. A PR's code runs during the build, so it must not see a write token or secrets. With `pull_request`, PRs from forks get a read-only token: the comment fails with 403, the action logs a warning, and the table stays in the job summary.
- The comment is found by a hidden marker (`<!-- cu-guard:<title> -->`) and edited in place, so every push updates one comment instead of adding a new one.

## Local use

```bash
node bin/cu-guard.js base.json head.json --threshold-pct 2
```

It prints the same markdown and exits 1 on a regression.

## Development

```bash
npm test
```

21 unit tests cover the parsers (including fixtures in Mollusk's exact output format), the comparison and thresholds, rendering, and the comment upsert against a fake API. CI also runs the action itself (`uses: ./`) on the fixtures and checks its outputs.

## License

MIT
