import { assertNever, isRecord } from "./util.ts";

type JsonType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";

/**
 * The JSON schema keywords that rule options are validated with (rule schemas are ESLint's
 * draft-04 schemas). Other keywords, such as `$ref` and `format`, are ignored: values they would
 * reject pass.
 */
export interface JsonSchema {
  type?: JsonType | JsonType[];
  description?: string;
  default?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  items?: JsonSchema | JsonSchema[];
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  not?: JsonSchema;
}

/** A rule's `meta.schema`: one schema per option, a schema of the whole options array, or `false` to skip validation. */
export type OptionsSchema = JsonSchema | JsonSchema[] | false;

const NOUNS: Record<JsonType, string> = {
  null: "null",
  boolean: "a boolean",
  number: "a number",
  integer: "an integer",
  string: "a string",
  array: "an array",
  object: "an object",
};

function hasType(value: unknown, type: JsonType): boolean {
  switch (type) {
    case "null":
      return value === null;
    case "array":
      return Array.isArray(value);
    case "object":
      return isRecord(value);
    case "integer":
      return Number.isInteger(value);
    case "boolean":
    case "number":
    case "string":
      return typeof value === type;
    default:
      return assertNever(type);
  }
}

const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Whether a (sub)schema is an object. Plugins may use boolean schemas such as `items: true`, which aren't supported. */
const isSchemaObject = (schema: JsonSchema) => typeof schema === "object" && schema !== null;

/** What a value must be to match `schema`, for error messages (`an integer >= 0`). */
function expected(schema: JsonSchema): string {
  if (!isSchemaObject(schema)) return "a valid value";
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives) return alternatives.map(expected).join(" or ");
  if (schema.enum) return `one of ${schema.enum.map((v) => JSON.stringify(v)).join(", ")}`;
  if ("const" in schema) return JSON.stringify(schema.const);
  const types = [schema.type ?? []].flat();
  let noun = types.length ? types.map((type) => NOUNS[type]).join(" or ") : "a valid value";
  if (schema.minimum !== undefined) noun += ` >= ${schema.minimum}`;
  if (schema.maximum !== undefined) noun += ` <= ${schema.maximum}`;
  if (schema.pattern !== undefined) noun += ` matching /${schema.pattern}/`;
  return noun;
}

/**
 * Compiles a schema `pattern`, or returns undefined when it's invalid. Without the `u` flag, as in
 * ESLint (ajv 6), which accepts patterns such as `^[\w-.]+$` that are invalid with it.
 */
function compilePattern(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
}

/** Thrown by {@link validateValue} for a (sub)schema that isn't an object, such as `true`. */
class UnsupportedSchema extends Error {
  constructor(readonly path: string) {
    super(`${path} can't be checked: the rule's schema is not an object`);
  }
}

/**
 * Validates `value` against `schema`, returning a list of human-readable problems. Throws
 * {@link UnsupportedSchema} for subschemas that aren't objects.
 */
function validateValue(schema: JsonSchema, value: unknown, path: string): string[] {
  if (!isSchemaObject(schema)) throw new UnsupportedSchema(path);
  const mismatch = [`${path} must be ${expected(schema)}`];
  const matches = (alternative: JsonSchema) => validateValue(alternative, value, path).length === 0;
  if (schema.anyOf && !schema.anyOf.some(matches)) return mismatch;
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) return mismatch;
  if (schema.not && matches(schema.not)) return [`${path} must not be ${expected(schema.not)}`];
  const types = [schema.type ?? []].flat();
  if (types.length && !types.some((type) => hasType(value, type)))
    return [`${path} must be ${expected({ type: types })}`];
  if (schema.enum && !schema.enum.some((v) => equal(v, value))) return mismatch;
  if ("const" in schema && !equal(schema.const, value)) return mismatch;

  const problems = (schema.allOf ?? []).flatMap((part) => validateValue(part, value, path));
  if (typeof value === "number") {
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) problems.push(...mismatch);
  } else if (typeof value === "string") {
    if (schema.pattern !== undefined) {
      const pattern = compilePattern(schema.pattern);
      if (!pattern)
        problems.push(`${path} can't be checked: the rule's schema has an invalid pattern /${schema.pattern}/`);
      else if (!pattern.test(value)) problems.push(...mismatch);
    }
    // JSON schema counts code points.
    const length = Array.from(value).length;
    if (length < (schema.minLength ?? 0)) problems.push(`${path} must have at least ${schema.minLength} characters`);
    if (length > (schema.maxLength ?? Infinity))
      problems.push(`${path} must have at most ${schema.maxLength} characters`);
  } else if (Array.isArray(value)) {
    const { items } = schema;
    value.forEach((item, i) => {
      const itemSchema = Array.isArray(items) ? items[i] : items;
      if (itemSchema) problems.push(...validateValue(itemSchema, item, `${path}[${i}]`));
    });
    if (value.length < (schema.minItems ?? 0)) problems.push(`${path} must have at least ${schema.minItems} items`);
    if (value.length > (schema.maxItems ?? Infinity))
      problems.push(`${path} must have at most ${schema.maxItems} items`);
    if (schema.uniqueItems && value.some((item, i) => value.findIndex((other) => equal(item, other)) !== i)) {
      problems.push(`${path} must not contain duplicates`);
    }
  } else if (isRecord(value)) {
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) problems.push(`${path} is missing required property "${key}"`);
    }
    const properties = schema.properties ?? {};
    for (const [key, v] of Object.entries(value)) {
      // `Object.hasOwn`: keys such as `toString` must not resolve to `Object.prototype` members.
      const property = Object.hasOwn(properties, key) ? properties[key] : schema.additionalProperties;
      if (property === false) {
        const known = Object.keys(properties);
        problems.push(`${path} has unknown property "${key}"${known.length ? ` (known: ${known.join(", ")})` : ""}`);
      } else if (typeof property === "object") {
        problems.push(...validateValue(property, v, `${path}.${key}`));
      }
    }
  }
  return problems;
}

/** Validates `value` against `schema`, returning a list of human-readable problems. */
export function validate(schema: JsonSchema, value: unknown, path = "options"): string[] {
  try {
    return validateValue(schema, value, path);
  } catch (error) {
    if (error instanceof UnsupportedSchema) return [error.message];
    throw error;
  }
}

/** Whether a rule with this `meta.schema` takes options. As in ESLint, no schema or `[]` means none. */
export function acceptsOptions(schema: OptionsSchema | undefined): schema is OptionsSchema {
  return schema !== undefined && !(Array.isArray(schema) && schema.length === 0);
}

/**
 * Validates rule options (what follows the severity in a config) against `meta.schema`. The
 * options of a rule with a single option schema are called `options` in messages.
 */
export function validateOptions(schema: OptionsSchema, options: readonly unknown[]): string[] {
  if (schema === false) return [];
  if (!Array.isArray(schema)) return validate(schema, options);
  if (options.length > schema.length) {
    return [`expected at most ${schema.length} option${schema.length === 1 ? "" : "s"}, got ${options.length}`];
  }
  return options.flatMap((option, i) =>
    validate(schema[i] as JsonSchema, option, schema.length === 1 ? "options" : `options[${i}]`),
  );
}

/** A non-negative number (or integer), also accepted as a string of digits (`"30"`). */
export function countSchema(description: string, type: "number" | "integer" = "number"): JsonSchema {
  return {
    description,
    anyOf: [
      { type, minimum: 0 },
      { type: "string", pattern: "^[0-9]+$" },
    ],
  };
}
