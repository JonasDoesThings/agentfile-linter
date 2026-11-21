import { assertNever } from "./util.ts";

/**
 * A deliberately tiny subset of JSON schema used to describe rule options.
 * It drives both runtime validation of config files and generation of
 * `configuration_schema.json`.
 */
export type OptionSchema =
  | { type: "boolean"; description?: string; default?: boolean }
  | { type: "number"; description?: string; default?: number }
  | { type: "string"; description?: string; enum?: string[]; default?: string }
  | { type: "array"; description?: string; items: OptionSchema; default?: unknown[] }
  | {
      type: "object";
      description?: string;
      properties: Record<string, OptionSchema>;
      additionalProperties?: false;
    };

/** Validates `value` against `schema`, returning a list of human-readable problems. */
export function validate(schema: OptionSchema, value: unknown, path = "options"): string[] {
  switch (schema.type) {
    case "boolean":
      return typeof value === "boolean" ? [] : [`${path} must be a boolean`];
    case "number":
      return typeof value === "number" && Number.isFinite(value) ? [] : [`${path} must be a number`];
    case "string":
      if (typeof value !== "string") return [`${path} must be a string`];
      if (schema.enum && !schema.enum.includes(value)) {
        return [`${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`];
      }
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
        const prop = schema.properties[key];
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
