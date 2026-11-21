/** Fails type checking when a `switch` doesn't handle every member of a union. */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
}

/** Whether `value` is a plain (non-array) object, e.g. a parsed JSON/TOML/YAML table. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `value` if it's a plain object, otherwise an empty one. */
export function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** The string elements of `value` if it's an array, otherwise an empty array. */
export function asStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
