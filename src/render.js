// Renders a comparison as GitHub-flavoured markdown.

const ORDER = { regression: 0, increase: 1, improvement: 2, added: 3, removed: 4, unchanged: 5 };
const fmt = (n) => n.toLocaleString("en-US");

export function marker(title) {
  return `<!-- cu-guard:${title.replace(/-{2,}/g, "-").replace(/[<>\r\n]/g, " ")} -->`;
}

export function render(result, { title = "Compute units", thresholdPct = 0, thresholdCu = 0 } = {}) {
  const { rows, regressions, improvements, increases, added, removed, hasBaseline } = result;
  const lines = [marker(title), `### ${title}`, ""];

  if (!hasBaseline) {
    lines.push("No baseline report, so there is nothing to compare against yet. Current values:", "");
  } else if (regressions > 0) {
    lines.push(`**${regressions} regression${regressions > 1 ? "s" : ""}** above the allowance (${allowance(thresholdPct, thresholdCu)}).`, "");
  } else if (!result.changed) {
    lines.push("No change in compute units.", "");
  } else {
    const parts = [
      improvements && `${improvements} improved`,
      increases && `${increases} increased within the allowance`,
      added && `${added} new`,
      removed && `${removed} removed`,
    ].filter(Boolean);
    lines.push(`No regressions: ${parts.join(", ")}.`, "");
  }

  lines.push("| Instruction | Base | Head | Change | |", "|---|---:|---:|---:|:---:|");
  const sorted = [...rows].sort((a, b) => ORDER[a.status] - ORDER[b.status]);
  for (const r of sorted) {
    lines.push(
      `| ${cell(r.name)} | ${r.base == null ? "" : fmt(r.base)} | ${r.head == null ? "" : fmt(r.head)} | ${change(r)} | ${ICON[r.status]} |`,
    );
  }
  lines.push("", "<sub>Compute units per instruction, compared by [cu-guard](https://github.com/malharc373/solana-cu-guard).</sub>");
  return fit(lines);
}

const ICON = { regression: "🔴", increase: "🟡", improvement: "🟢", added: "new", removed: "removed", unchanged: "" };

function change(r) {
  if (r.delta == null || r.delta === 0) return r.delta === 0 ? "0" : "";
  const sign = r.delta > 0 ? "+" : "−";
  const pct = Number.isFinite(r.pct) ? ` (${sign}${Math.abs(r.pct).toFixed(1)}%)` : "";
  return `${sign}${fmt(Math.abs(r.delta))}${pct}`;
}

function allowance(pct, cu) {
  if (!pct && !cu) return "any increase fails";
  return [pct && `${pct}%`, cu && `${fmt(cu)} CU`].filter(Boolean).join(" or ") + ", whichever is larger";
}

const cell = (s) => `\`${s.replaceAll("|", "\\|").replaceAll("`", "'")}\``;

// GitHub rejects comments over 65,536 characters. Rows are sorted with
// regressions first, so drop from the end of the table.
const MAX = 60_000;
function fit(lines) {
  const footer = lines.splice(-2);
  let dropped = 0;
  let size = lines.reduce((n, l) => n + l.length + 1, 0) + footer.join("\n").length + 100;
  while (size > MAX) {
    size -= lines.pop().length + 1;
    dropped++;
  }
  if (dropped > 0) lines.push("", `${dropped} more rows not shown.`);
  return [...lines, ...footer].join("\n") + "\n";
}
