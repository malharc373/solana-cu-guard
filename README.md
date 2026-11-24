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

[malharc373/solana-counter#1](https://github.com/malharc373/solana-counter/pull/1) shows the whole cycle with the reusable workflow: one added `msg!` fails the check at +104 CU, removing it turns the check green, and the same comment is edited both times.

In both, the base numbers were built on the GitHub runner from the base commit and match a local run exactly. That is what makes a threshold of 0 work.

## How it works

```
pull request ──build──▶ report (head) ──┐
                                        ├──▶ cu-guard ──▶ table in the PR + job summary
base commit ───build──▶ report (base) ──┘                 step fails on a regression
```

- **Both reports are built in the same job.** The base report comes from a `git worktree` of the base commit, with the same toolchain and on the same runner. A committed baseline file would drift as soon as you upgrade Solana or LiteSVM, and every unrelated PR would fail.
- **The base is the merge commit's first parent** (`HEAD^1`), not `pull_request.base.sha`. That event field can lag behind the target branch, and then the PR gets blamed for changes that landed on `main` in the meantime.
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

**2. Add the workflow** as `.github/workflows/compute-units.yml` ([`examples/litesvm.yml`](examples/litesvm.yml)):

```yaml
name: Compute units
on: pull_request
jobs:
  cu-guard:
    permissions:
      contents: read
      pull-requests: write # for the comment
    uses: malharc373/solana-cu-guard/.github/workflows/compare.yml@v1
    with:
      solana-version: v3.1.10
      command: cargo build-sbf && cargo test --test cu_report
      report: target/cu-report.json
      requires: tests/cu_report.rs
```

| Workflow input | Default | |
|---|---|---|
| `command` | required | Builds the program and writes the report. Runs once on the base commit and once on the change. |
| `report` | `target/cu-report.json` | The file it writes. |
| `requires` | `""` | A file the command needs. If the base commit doesn't have it yet, there is no baseline and the check passes. Any other failure on the base commit fails the check, so a broken baseline can't hide a regression. |
| `solana-version` | `""` | Solana release to install, or empty for none. |
| `id` | `default` | Give each program its own `id` and `title` when one workflow guards several. |

`format`, `threshold-pct`, `threshold-cu`, `comment` and `title` are passed to the action.

Building the reports some other way? Use the action on its own:

```yaml
- uses: malharc373/solana-cu-guard@v1
  with:
    base: base.json
    head: head.json
```

A run builds the program twice, so expect a few minutes: 3 to 9 on the four repos that use it, with a cold cache.

## Report formats

| Format | What it looks like |
|---|---|
| `json` | `{"initialize": 4363, "increment": 331}`, or `[{"name": "initialize", "cu": 4363}]` |
| `mollusk` | The `compute_units.md` that [`mollusk-svm-bencher`](https://docs.rs/mollusk-svm-bencher) writes. Only the newest table (the top one) is read. A matrix table (`mx_compute_units.md`) becomes rows named `instruction (program)`. |

`format: auto` (the default) treats a file that starts with `{` or `[` as JSON and anything else as Mollusk.

For Mollusk, run `cargo bench` in each checkout and point `base` and `head` at the two `benches/compute_units.md` files.

## Action inputs

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

- **The code under test never sees a write token.** The reusable workflow has two jobs. `measure` runs the pull request's code with `contents: read` and no stored git credentials. `compare` can write comments, and it only downloads the two reports and runs the action. If you write your own workflow, keep that split.
- **Use `pull_request`, never `pull_request_target`.** PRs from forks then get a read-only token: the comment fails with 403, the action logs a warning, and the table stays in the job summary.
- **Reports are untrusted input.** Instruction names with control characters are rejected, names are escaped in the table, and the table is logged with workflow commands turned off.
- **One comment, edited in place.** It is found by a hidden marker, and only if a bot or someone with write access wrote it, so a pasted marker can't redirect it.
- **What it can't do:** a pull request controls its own test code, so it could write a false report. This is a check against accidents, and review still has to catch a changed `cu_report` test.

## Local use

```bash
node bin/cu-guard.js base.json head.json --threshold-pct 2
```

It prints the same markdown and exits 1 on a regression.

## Development

```bash
npm test
```

26 unit tests cover the parsers (including fixtures in Mollusk's exact output format), the comparison and thresholds, rendering, hostile input, and the comment upsert against a fake API. CI also runs the action (`uses: ./`) and the reusable workflow on the fixtures.

## License

MIT
