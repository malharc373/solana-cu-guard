// Parses a compute-unit report into an ordered list of { name, cu }.
//
// Accepted formats:
//   json     {"initialize": 4363, "increment": 331}
//            [{"name": "initialize", "cu": 4363}, ...]   ("computeUnits" also accepted)
//   mollusk  compute_units.md / mx_compute_units.md written by mollusk-svm-bencher.
//            The newest table is at the top of the file; only that one is read.
//            Matrix tables (one column per program) become "name (program)".

export function parseReport(text, format = "auto") {
  const kind = format === "auto" ? detect(text) : format;
  if (kind === "json") return parseJson(text);
  if (kind === "mollusk") return parseMollusk(text);
  throw new Error(`unknown report format "${format}" (expected auto, json or mollusk)`);
}

function detect(text) {
  const first = text.trimStart()[0];
  return first === "{" || first === "[" ? "json" : "mollusk";
}

function parseJson(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new Error(`report is not valid JSON: ${e.message}`);
  }
  if (data === null || typeof data !== "object") throw new Error("report must be a JSON object or array");
  const entries = Array.isArray(data)
    ? data.map((row, i) => {
        if (row === null || typeof row !== "object") throw new Error(`entry ${i} is not an object`);
        return [row.name, row.cu ?? row.computeUnits];
      })
    : Object.entries(data);
  return unique(entries.map(([name, cu]) => entry(name, cu)));
}

function unique(rows) {
  const seen = new Set();
  for (const { name } of rows) {
    if (seen.has(name)) throw new Error(`duplicate instruction name "${name}"`);
    seen.add(name);
  }
  return rows;
}

function parseMollusk(text) {
  const lines = text.split(/\r?\n/);
  const header = lines.findIndex((l) => /^\|\s*Name\s*\|/.test(l));
  if (header === -1) throw new Error("no Mollusk table found (expected a '| Name | ...' header)");

  const columns = cells(lines[header]);
  const matrix = columns[1] !== "CUs"; // single: Name | CUs | Delta; matrix: Name | CU (`p1`) | ...
  const programs = matrix ? columns.slice(1).map((c) => c.replace(/^CU \(`?(.*?)`?\)$/, "$1")) : [];

  const rows = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    const [name, ...values] = cells(line);
    if (matrix) programs.forEach((p, i) => rows.push(entry(`${name} (${p})`, values[i])));
    else rows.push(entry(name, values[0]));
  }
  if (rows.length === 0) throw new Error("the newest Mollusk table has no rows");
  return unique(rows);
}

const cells = (line) => line.split("|").slice(1, -1).map((c) => c.trim());

function entry(name, cu) {
  if (typeof name !== "string" || name.trim() === "") throw new Error(`invalid instruction name: ${JSON.stringify(name)}`);
  // Names come from the pull request's code and end up in a comment and in the log.
  if (/[\u0000-\u001f\u007f\u2028\u2029]/.test(name) || name.length > 200) throw new Error("instruction names must be at most 200 characters with no control characters");
  const n = typeof cu === "string" ? (/^[\d,]+$/.test(cu) ? Number(cu.replaceAll(",", "")) : NaN) : cu;
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`"${name}": compute units must be a non-negative integer, got ${JSON.stringify(cu)}`);
  return { name: name.trim(), cu: n };
}
