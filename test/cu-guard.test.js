import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compare } from "../src/compare.js";
import { upsertComment } from "../src/github.js";
import { parseReport } from "../src/report.js";
import { marker, render } from "../src/render.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const r = (obj) => Object.entries(obj).map(([name, cu]) => ({ name, cu }));

// --- parsing -----------------------------------------------------------------

test("parses a JSON object, keeping order", () => {
  assert.deepEqual(parseReport('{"b": 2, "a": 1}'), [{ name: "b", cu: 2 }, { name: "a", cu: 1 }]);
});

test("parses a JSON array with cu or computeUnits", () => {
  const rows = parseReport('[{"name":"x","cu":5},{"name":"y","computeUnits":"1,200"}]');
  assert.deepEqual(rows, [{ name: "x", cu: 5 }, { name: "y", cu: 1200 }]);
});

test("rejects bad JSON reports", () => {
  assert.throws(() => parseReport("{not json"), /not valid JSON/);
  assert.throws(() => parseReport('{"x": -1}'), /non-negative integer/);
  assert.throws(() => parseReport('{"x": 1.5}'), /non-negative integer/);
  assert.throws(() => parseReport('{"x": null}'), /non-negative integer/);
  assert.throws(() => parseReport('[{"name":"x","cu":1},{"name":"x","cu":2}]'), /duplicate/);
  assert.throws(() => parseReport("[1]"), /not an object/);
  assert.throws(() => parseReport("null", "json"), /object or array/);
});

test("reads only the newest table of a Mollusk compute_units.md", () => {
  assert.deepEqual(parseReport(fixture("mollusk_single.md")), r({ transfer: 1350, initialize: 4363, close_account: 345 }));
});

test("reads a Mollusk matrix table as name (program)", () => {
  assert.deepEqual(
    parseReport(fixture("mollusk_matrix.md")),
    r({ "increment (anchor)": 3520, "increment (pinocchio)": 331, "close (anchor)": 3471, "close (pinocchio)": 345 }),
  );
});

test("an explicit format overrides detection", () => {
  assert.throws(() => parseReport(fixture("base.json"), "mollusk"), /no Mollusk table/);
  assert.throws(() => parseReport("x", "yaml"), /unknown report format/);
});

// --- comparison --------------------------------------------------------------

test("classifies every kind of change", () => {
  const res = compare(parseReport(fixture("base.json")), parseReport(fixture("head.json")));
  const status = Object.fromEntries(res.rows.map((x) => [x.name, x.status]));
  assert.deepEqual(status, { initialize: "unchanged", increment: "regression", decrement: "improvement", close: "unchanged", reset: "added" });
  assert.equal(res.regressions, 1);
  assert.equal(res.improvements, 1);
  assert.equal(res.added, 1);
  assert.equal(res.changed, true);
});

test("instructions missing from head are reported as removed", () => {
  const res = compare(r({ a: 1, gone: 7 }), r({ a: 1 }));
  assert.deepEqual(res.rows.at(-1), { name: "gone", base: 7, head: null, delta: null, pct: null, status: "removed" });
  assert.equal(res.regressions, 0);
});

test("with default thresholds a single extra CU is a regression", () => {
  assert.equal(compare(r({ a: 1000 }), r({ a: 1001 })).regressions, 1);
  assert.equal(compare(r({ a: 1000 }), r({ a: 1000 })).changed, false);
});

test("the allowance is the larger of the percent and absolute thresholds", () => {
  const opts = { thresholdPct: 5, thresholdCu: 20 };
  assert.equal(compare(r({ a: 100 }), r({ a: 120 }), opts).rows[0].status, "increase"); // 20 ≤ max(20, 5)
  assert.equal(compare(r({ a: 100 }), r({ a: 121 }), opts).rows[0].status, "regression");
  assert.equal(compare(r({ a: 1000 }), r({ a: 1050 }), opts).rows[0].status, "increase"); // 50 ≤ max(20, 50)
  assert.equal(compare(r({ a: 1000 }), r({ a: 1051 }), opts).rows[0].status, "regression");
});

test("a zero baseline does not divide by zero", () => {
  const row = compare(r({ a: 0 }), r({ a: 5 })).rows[0];
  assert.equal(row.status, "regression");
  assert.equal(row.pct, Infinity);
  assert.equal(compare(r({ a: 0 }), r({ a: 0 })).rows[0].pct, 0);
});

test("no baseline: everything is new and nothing fails", () => {
  const res = compare(null, r({ a: 1, b: 2 }));
  assert.equal(res.hasBaseline, false);
  assert.equal(res.regressions, 0);
  assert.ok(res.rows.every((x) => x.status === "added"));
});

test("negative thresholds are rejected", () => {
  assert.throws(() => compare(null, [], { thresholdPct: -1 }), /non-negative/);
  assert.throws(() => compare(null, [], { thresholdCu: Number.NaN }), /non-negative/);
});

// --- rendering ---------------------------------------------------------------

test("renders regressions first with signed changes", () => {
  const md = render(compare(parseReport(fixture("base.json")), parseReport(fixture("head.json"))));
  assert.ok(md.startsWith(marker("Compute units")));
  assert.match(md, /\*\*1 regression\*\* above the allowance \(any increase fails\)/);
  const table = md.split("\n").filter((l) => l.startsWith("| `"));
  assert.equal(table[0], "| `increment` | 331 | 520 | +189 (+57.1%) | 🔴 |");
  assert.equal(table[1], "| `decrement` | 323 | 300 | −23 (−7.1%) | 🟢 |");
  assert.equal(table[2], "| `reset` |  | 410 |  | new |");
});

test("renders the no-change and no-baseline cases", () => {
  assert.match(render(compare(r({ a: 1 }), r({ a: 1 }))), /No change in compute units/);
  assert.match(render(compare(null, r({ a: 1 }))), /No baseline report/);
  assert.match(render(compare(r({ a: 10 }), r({ a: 9 }))), /No regressions: 1 improved\./);
});

test("escapes pipes and backticks in instruction names", () => {
  assert.match(render(compare(null, r({ "a|b`c": 1 }))), /`a\\\|b'c`/);
});

test("the marker depends on the title, so several guards can share a PR", () => {
  assert.notEqual(marker("Program A"), marker("Program B"));
  assert.ok(!marker("x -- y").slice(4, -3).includes("--"));
});

// --- PR comment --------------------------------------------------------------

function fakeApi(pages) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body && JSON.parse(init.body) });
    const page = Number(new URL(url).searchParams.get("page"));
    const json = init.method ? { id: 1 } : (pages[page - 1] ?? []);
    return { ok: true, status: 200, json: async () => json };
  };
  return { calls, fetchImpl };
}
const args = { marker: "<!-- cu-guard:t -->", token: "t", repo: "o/r", pr: 7, api: "https://api" };

test("creates a comment when none exists", async () => {
  const { calls, fetchImpl } = fakeApi([[{ id: 3, body: "unrelated" }]]);
  assert.equal(await upsertComment({ ...args, body: "<!-- cu-guard:t -->\nhi", fetchImpl }), "created");
  assert.deepEqual(calls.at(-1), { url: "https://api/repos/o/r/issues/7/comments", method: "POST", body: { body: "<!-- cu-guard:t -->\nhi" } });
});

test("updates its own comment found on a later page", async () => {
  const full = Array.from({ length: 100 }, (_, i) => ({ id: i, body: "x" }));
  const { calls, fetchImpl } = fakeApi([full, [{ id: 555, body: "<!-- cu-guard:t -->\nold", user: { type: "Bot" } }]]);
  assert.equal(await upsertComment({ ...args, body: "new", fetchImpl }), "updated");
  assert.equal(calls.at(-1).url, "https://api/repos/o/r/issues/comments/555");
  assert.equal(calls.at(-1).method, "PATCH");
});

test("does not create a comment when told not to", async () => {
  const { calls, fetchImpl } = fakeApi([[]]);
  assert.equal(await upsertComment({ ...args, body: "x", create: false, fetchImpl }), "skipped");
  assert.equal(calls.length, 1);
});

test("surfaces the HTTP status so a fork's 403 can be handled", async () => {
  const fetchImpl = async () => ({ ok: false, status: 403 });
  await assert.rejects(upsertComment({ ...args, body: "x", fetchImpl }), (e) => e.status === 403);
});

test("ignores a marker pasted by an outside commenter", async () => {
  const body = "<!-- cu-guard:t -->\nforged";
  const outsider = fakeApi([[{ id: 9, body, user: { type: "User" }, author_association: "CONTRIBUTOR" }]]);
  assert.equal(await upsertComment({ ...args, body: "x", fetchImpl: outsider.fetchImpl }), "created");
  const owner = fakeApi([[{ id: 9, body, user: { type: "User" }, author_association: "OWNER" }]]);
  assert.equal(await upsertComment({ ...args, body: "x", fetchImpl: owner.fetchImpl }), "updated");
});

test("rejects names that could inject markdown or workflow commands", () => {
  assert.throws(() => parseReport(JSON.stringify({ "a\n::error::x": 1 })), /control characters/);
  assert.throws(() => parseReport(JSON.stringify({ "a\r\n# hi": 1 })), /control characters/);
  assert.throws(() => parseReport(JSON.stringify({ ["x".repeat(201)]: 1 })), /200 characters/);
});

test("rejects strings that Number() would quietly turn into 0", () => {
  for (const cu of ["", " ", "1e3", "0x10", "-"]) assert.throws(() => parseReport(JSON.stringify([{ name: "x", cu }])), /non-negative integer/);
});

test("a huge table is cut to fit a comment, keeping regressions", () => {
  const base = {}, head = {};
  for (let i = 0; i < 3000; i++) base[`instruction_number_${i}`] = head[`instruction_number_${i}`] = 1000;
  head.instruction_number_2999 = 1001;
  const md = render(compare(r(base), r(head)));
  assert.ok(md.length <= 65_536);
  assert.match(md, /instruction_number_2999.*🔴/);
  assert.match(md, /\d+ more rows not shown\./);
  assert.match(md, /cu-guard\]\(https/);
});

test("a title cannot close the hidden marker", () => {
  assert.equal(marker("a ---> b").indexOf("-->"), marker("a ---> b").length - 3);
});
