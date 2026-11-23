import { BUILTIN_RULES } from "#src/rules/index.ts";

interface Timing {
  timeMs: number;
  calls: number;
}

/** Collects elapsed time and call counts for the rule callbacks in one lint run. */
export class RuleTimings {
  private readonly byRule = new Map<string, Timing>();

  measure<T>(id: string, invoke: () => T): T {
    const start = performance.now();
    const finish = () => {
      const elapsed = performance.now() - start;
      const timing = this.byRule.get(id);
      if (timing) {
        timing.timeMs += elapsed;
        timing.calls++;
      } else {
        this.byRule.set(id, { timeMs: elapsed, calls: 1 });
      }
    };
    let result: T | undefined;
    try {
      result = invoke();
      return result;
    } finally {
      // Keep the original return value and let the caller handle errors as usual.
      if (result instanceof Promise) void result.then(finish, finish);
      else finish();
    }
  }

  format(): string {
    const timings = [...this.byRule].toSorted(([a, x], [b, y]) => y.timeMs - x.timeMs || a.localeCompare(b));
    if (timings.length === 0) return "Rule timings:\nNo rule calls recorded.\n";
    const total = timings.reduce((sum, [, timing]) => sum + timing.timeMs, 0);
    const header = ["Rule", "Time (ms)", "Relative", "Calls", "Source"];
    const rows = timings.map(([id, { timeMs, calls }]) => [
      id,
      timeMs.toFixed(3),
      `${(total === 0 ? 0 : (100 * timeMs) / total).toFixed(1)}%`,
      String(calls),
      BUILTIN_RULES.rules.has(id) ? "built-in" : "plugin",
    ]);
    const widths = header.map((label, i) => rows.reduce((width, row) => Math.max(width, row[i]!.length), label.length));
    const line = (row: string[]) =>
      row
        .map((cell, i) => {
          if (i === 0) return cell.padEnd(widths[i]!);
          if (i === row.length - 1) return cell;
          return cell.padStart(widths[i]!);
        })
        .join("  ");
    const separator = widths.map((width) => "-".repeat(width)).join("  ");
    return ["Rule timings:", line(header), separator, ...rows.map(line), ""].join("\n");
  }
}
