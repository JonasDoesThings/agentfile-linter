import { assertNever } from "./util.ts";

/**
 * A deliberately tiny subset of JSON schema used to describe rule options.
 * It drives both runtime validation of config files and generation of
 * `configuration_schema.json`.
 */
export type OptionSchema =
  | { type: "boolean"; description?: string; default?: boolean }
  | { type: "number"; description?: string; minimum?: number; default?: number }
  | { type: "string"; description?: string; enum?: string[]; pattern?: string; default?: string }
  | { type: "array"; description?: string; items: OptionSchema; default?: unknown[] }
  | {
      type: "object";
      description?: string;
      properties: Record<string, OptionSchema>;
      additionalProperties?: false;
    }
  | { anyOf: OptionSchema[]; description?: string; default?: unknown };

/** What a value must be to match `schema`, for error messages (`a number >= 0`). */
function expected(schema: OptionSchema): string {
  if ("anyOf" in schema) return schema.anyOf.map(expected).join(" or ");
  switch (schema.type) {
    case "boolean":
      return "a boolean";
    case "number":
      return schema.minimum === undefined ? "a number" : `a number >= ${schema.minimum}`;
    case "string":
      if (schema.enum) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
      return schema.pattern ? `a string matching /${schema.pattern}/` : "a string";
    case "array":
      return "an array";
    case "object":
      return "an object";
    default:
      return assertNever(schema);
  }
}

/** Validates `value` against `schema`, returning a list of human-readable problems. */
export function validate(schema: OptionSchema, value: unknown, path = "options"): string[] {
  if ("anyOf" in schema) {
    return schema.anyOf.some((option) => validate(option, value, path).length === 0)
      ? []
      : [`${path} must be ${expected(schema)}`];
  }
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value)) return [`${path} must be a number`];
      return schema.minimum !== undefined && value < schema.minimum ? [`${path} must be ${expected(schema)}`] : [];
    case "string":
      if (typeof value !== "string") return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(value)) return [`${path} must be ${expected(schema)}`];
      if (schema.pattern && !new RegExp(schema.pattern).test(value)) return [`${path} must be ${expected(schema)}`];
      return [];
    case "array":
      if (!Array.isArray(value)) return [`${path} must be an array`];
      return value.flatMap((item, i) => validate(schema.items, item, `${path}[${i}]`));
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return [`${path} must be an object`];
      }
      const problems: string[] = [];
      for (const [key, v] of Object.entries(value)) {
        // `Object.hasOwn`: keys such as `toString` must not resolve to `Object.prototype` members.
        const prop = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
        if (!prop) {
          const known = Object.keys(schema.properties);
          problems.push(`${path} has unknown property "${key}"${known.length ? ` (known: ${known.join(", ")})` : ""}`);
          continue;
        }
        problems.push(...validate(prop, v, `${path}.${key}`));
      }
      return problems;
    }
    default:
      return assertNever(schema);
  }
}

/** Converts an option schema to a JSON schema fragment. */
export function toJsonSchema(schema: OptionSchema): Record<string, unknown> {
  if ("anyOf" in schema) return { ...schema, anyOf: schema.anyOf.map(toJsonSchema) };
  switch (schema.type) {
    case "boolean":
    case "number":
    case "string":
      return { ...schema };
    case "array":
      return { ...schema, items: toJsonSchema(schema.items) };
    case "object":
      return {
        ...schema,
        properties: Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toJsonSchema(v)])),
        additionalProperties: false,
      };
    default:
      return assertNever(schema);
  }
}
