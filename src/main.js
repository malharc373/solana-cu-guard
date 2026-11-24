// GitHub Action entry point. Inputs arrive as INPUT_* environment variables.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { compare } from "./compare.js";
import { upsertComment } from "./github.js";
import { parseReport } from "./report.js";
import { marker, render } from "./render.js";

const input = (name, fallback = "") => (process.env[`INPUT_${name.toUpperCase()}`] ?? "").trim() || fallback;
const bool = (name, fallback) => {
  const v = input(name, String(fallback)).toLowerCase();
  if (v !== "true" && v !== "false") throw new Error(`input "${name}" must be true or false, got "${v}"`);
  return v === "true";
};
const number = (name) => {
  const n = Number(input(name, "0"));
  if (!Number.isFinite(n) || n < 0) throw new Error(`input "${name}" must be a non-negative number`);
  return n;
};

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  const delimiter = `cu_guard_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}\n${value}\n${delimiter}\n`);
}

// Escaping for the message part of a workflow command.
const escape = (text) => text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

async function run() {
  const headPath = input("head");
  if (!headPath) throw new Error('input "head" is required');
  const basePath = input("base");
  const format = input("format", "auto");
  const title = input("title", "Compute units");
  const thresholdPct = number("threshold-pct");
  const thresholdCu = number("threshold-cu");
  const failOnRegression = bool("fail-on-regression", true);
  const commentMode = input("comment", "changes");
  if (!["always", "changes", "never"].includes(commentMode)) throw new Error('input "comment" must be always, changes or never');

  const head = parseReport(readFileSync(headPath, "utf8"), format);
  let base = null;
  if (basePath && existsSync(basePath)) base = parseReport(readFileSync(basePath, "utf8"), format);
  else if (basePath) console.log(`::notice::No base report at ${basePath}; showing current values only.`);

  const result = compare(base, head, { thresholdPct, thresholdCu });
  const body = render(result, { title, thresholdPct, thresholdCu });
  // The table contains text from the pull request: print it with workflow commands off.
  const stop = randomUUID();
  console.log(`::stop-commands::${stop}\n${body}\n::${stop}::`);

  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body);
  setOutput("regressions", String(result.regressions));
  setOutput("improvements", String(result.improvements));
  setOutput("changed", String(result.changed));
  setOutput("markdown", body);

  await maybeComment(body, title, commentMode, result.changed || result.regressions > 0);

  for (const r of result.rows.filter((r) => r.status === "regression")) {
    console.log(`::error title=Compute units went up::${escape(`${r.name}: ${r.base} → ${r.head} CU (+${r.delta})`)}`);
  }
  if (result.regressions > 0 && failOnRegression) process.exitCode = 1;
}

async function maybeComment(body, title, mode, interesting) {
  if (mode === "never") return;
  const event = process.env.GITHUB_EVENT_PATH && existsSync(process.env.GITHUB_EVENT_PATH)
    ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"))
    : {};
  const pr = event.pull_request?.number;
  if (!pr) return;
  const token = input("github-token");
  if (!token) return console.log("::warning::No github-token, so no PR comment was posted.");

  try {
    const status = await upsertComment({
      body,
      marker: marker(title),
      token,
      repo: process.env.GITHUB_REPOSITORY,
      pr,
      api: process.env.GITHUB_API_URL || "https://api.github.com",
      // With "changes", an existing comment is still updated so it never goes stale.
      create: mode === "always" || interesting,
    });
    console.log(`PR comment: ${status}`);
  } catch (e) {
    // Pull requests from forks get a read-only token; the job summary still has the table.
    if (e.status === 403 || e.status === 404) {
      console.log(`::warning::Could not comment on the pull request (${e.status}). Pull requests from forks get a read-only token; the table is in the job summary.`);
    } else throw e;
  }
}

run().catch((e) => {
  console.log(`::error::${escape(e.message)}`);
  process.exitCode = 1;
});
