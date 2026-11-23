// Compares a base report with a head report.
//
// An increase is a regression when it is larger than the allowance:
//   allowed = max(thresholdCu, base * thresholdPct / 100)
// With both thresholds at 0 (the default) any increase is a regression, which
// is right for LiteSVM and Mollusk: with fixed keys and a pinned toolchain the
// compute units of a transaction are the same on every run.

export function compare(base, head, { thresholdPct = 0, thresholdCu = 0 } = {}) {
  if (!(thresholdPct >= 0) || !(thresholdCu >= 0)) throw new Error("thresholds must be non-negative numbers");
  const baseByName = new Map((base ?? []).map((r) => [r.name, r.cu]));
  const headNames = new Set(head.map((r) => r.name));

  const rows = head.map(({ name, cu }) => {
    if (!baseByName.has(name)) return { name, base: null, head: cu, delta: null, pct: null, status: "added" };
    const was = baseByName.get(name);
    const delta = cu - was;
    const pct = was === 0 ? (delta === 0 ? 0 : Infinity) : (100 * delta) / was;
    const allowed = Math.max(thresholdCu, (was * thresholdPct) / 100);
    const status = delta > allowed ? "regression" : delta > 0 ? "increase" : delta < 0 ? "improvement" : "unchanged";
    return { name, base: was, head: cu, delta, pct, status };
  });
  for (const { name, cu } of base ?? []) {
    if (!headNames.has(name)) rows.push({ name, base: cu, head: null, delta: null, pct: null, status: "removed" });
  }

  const count = (s) => rows.filter((r) => r.status === s).length;
  return {
    hasBaseline: base != null,
    rows,
    regressions: count("regression"),
    increases: count("increase"),
    improvements: count("improvement"),
    added: count("added"),
    removed: count("removed"),
    changed: rows.some((r) => r.status !== "unchanged"),
  };
}
