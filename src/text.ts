/** Levenshtein distance between two strings. */
export function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        (prev[j] as number) + 1,
        (curr[j - 1] as number) + 1,
        (prev[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length] as number;
}

/** The closest candidate to `name`, if it is reasonably close. */
export function closest(name: string, candidates: Iterable<string>): string | undefined {
  let best: { value: string; distance: number } | undefined;
  for (const value of candidates) {
    const distance = editDistance(name, value);
    if (!best || distance < best.distance) best = { value, distance };
  }
  return best && best.distance <= Math.max(2, Math.floor(name.length / 4)) ? best.value : undefined;
}

/** `a, b, c, …` with at most `max` items. */
export function list(items: string[], max = 12): string {
  return items.length > max ? `${items.slice(0, max).join(", ")}, …` : items.join(", ");
}
