#!/usr/bin/env node
// Local use: node bin/cu-guard.js <base-report> <head-report> [--threshold-pct N] [--threshold-cu N] [--format auto|json|mollusk]
// Prints the markdown table and exits 1 if any instruction regressed.

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { compare } from "../src/compare.js";
import { parseReport } from "../src/report.js";
import { render } from "../src/render.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "threshold-pct": { type: "string", default: "0" },
    "threshold-cu": { type: "string", default: "0" },
    format: { type: "string", default: "auto" },
  },
});
if (positionals.length !== 2) {
  console.error("usage: cu-guard <base-report> <head-report> [--threshold-pct N] [--threshold-cu N] [--format auto|json|mollusk]");
  process.exit(2);
}

const [base, head] = positionals.map((p) => parseReport(readFileSync(p, "utf8"), values.format));
const opts = { thresholdPct: Number(values["threshold-pct"]), thresholdCu: Number(values["threshold-cu"]) };
const result = compare(base, head, opts);
process.stdout.write(render(result, opts));
process.exit(result.regressions > 0 ? 1 : 0);
