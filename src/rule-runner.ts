import esquery from "esquery";
import type { Node as EsNode } from "estree";
import type { Nodes } from "mdast";

import type { EnabledRule } from "./config.ts";
import type { Project } from "./project.ts";
import type { RuleTimings } from "./rule-timings.ts";
import type { SourceCode } from "./source-code.ts";
import type { AnyRule, Diagnostic, Position, ReportDescriptor, RuleContext, Visitor } from "./types.ts";
import { assertNever } from "./util.ts";

const PLACEHOLDER = /\{\{([^{}]+?)\}\}/g;

const point = ({ line, column }: Position): Position => ({ line, column });

/** The location of a reported problem: its `loc`, else its `node`, else `fallback`. */
function location({ node, loc }: ReportDescriptor, fallback?: Position): { start: Position; end: Position } {
  const range = loc ? ("start" in loc ? loc : { start: loc }) : (node?.position ?? (fallback && { start: fallback }));
  if (!range) throw new TypeError("`report` needs a `node` or a `loc`");
  return { start: point(range.start), end: point(range.end ?? range.start) };
}

/**
 * Turns a reported problem into a diagnostic, as ESLint does: the message is `message` or the
 * rule's `meta.messages[messageId]`, with `{{ key }}` placeholders replaced from `data`.
 */
export function toDiagnostic(
  { id, rule, severity }: Pick<EnabledRule, "id" | "rule" | "severity">,
  filePath: string,
  descriptor: ReportDescriptor,
  fallback?: Position,
): Diagnostic {
  let { message } = descriptor;
  const { messageId, data } = descriptor;
  if (messageId !== undefined) {
    const messages = rule.meta?.messages ?? {};
    if (!Object.hasOwn(messages, messageId)) throw new Error(`Unknown messageId "${messageId}"`);
    message = messages[messageId];
  }
  if (typeof message !== "string") throw new TypeError("`report` needs a `message` or a `messageId`");
  if (data) {
    message = message.replace(PLACEHOLDER, (match, key: string) => {
      const value = data[key.trim()];
      // oxlint-disable-next-line typescript/no-base-to-string -- ESLint stringifies data values the same way
      return value === undefined ? match : String(value);
    });
  }
  return { ruleId: id, severity, message, help: descriptor.help, filePath, ...location(descriptor, fallback) };
}

export function crashDiagnostic(ruleId: string, filePath: string, error: unknown): Diagnostic {
  const pos = { line: 1, column: 1 };
  const message = `Rule crashed: ${(error as Error)?.stack ?? String(error)}`;
  return { ruleId, severity: "error", message, filePath, start: pos, end: pos };
}

/** A visitor key parsed: which nodes it selects, and whether on entering or leaving them. */
interface ParsedSelector {
  exit: boolean;
  /** The node types it can select, or `*` for any. */
  types: string[];
  /** For selectors that aren't just a node type (`heading > text`, `link[url=""]`): the esquery selector. */
  query?: esquery.Selector;
}

const selectorCache = new Map<string, ParsedSelector>();

/** The node types a selector can match, or null for any (as in ESLint). */
function possibleTypes(selector: esquery.Selector): string[] | null {
  switch (selector.type) {
    case "identifier":
      return [selector.value];
    case "matches": {
      const types = selector.selectors.map(possibleTypes);
      return types.every((t) => t !== null) ? [...new Set(types.flat())] : null;
    }
    case "compound": {
      const known = selector.selectors.map(possibleTypes).filter((t) => t !== null);
      return known.length ? known.reduce((a, b) => a.filter((type) => b.includes(type))) : null;
    }
    case "child":
    case "descendant":
    case "sibling":
    case "adjacent":
      return possibleTypes(selector.right);
    case "wildcard":
    case "attribute":
    case "field":
    case "type":
    case "has":
    case "not":
    case "nth-child":
    case "nth-last-child":
    case "class":
      return null;
    default:
      return assertNever(selector);
  }
}

/** Parses a visitor key, a CSS-like selector as in ESLint (`link`, `heading:exit`, `:matches(heading, paragraph) > text`). */
function parseSelector(key: string): ParsedSelector {
  let parsed = selectorCache.get(key);
  if (!parsed) {
    const exit = key.endsWith(":exit");
    const query = esquery.parse(exit ? key.slice(0, -":exit".length) : key);
    const simple = query.type === "identifier" || query.type === "wildcard";
    parsed = { exit, types: possibleTypes(query) ?? ["*"], query: simple ? undefined : query };
    selectorCache.set(key, parsed);
  }
  return parsed;
}

// mdast nodes have a `type` and their children in `children`.
const QUERY_OPTIONS: esquery.ESQueryOptions = {
  fallback: (node) => ("children" in node ? ["children"] : []),
};
const matches = (node: Nodes, query: esquery.Selector, ancestry: Nodes[]) =>
  esquery.matches(node as unknown as EsNode, query, ancestry as unknown as EsNode[], QUERY_OPTIONS);

export interface FileInput {
  filename: string;
  cwd: string;
  sourceCode: SourceCode;
  project: Project;
  settings: Readonly<Record<string, unknown>>;
}

/** What a rule does with one file. */
interface RuleRun {
  enabled: EnabledRule;
  crashed: boolean;
  /** Promises returned by the rule's visitor functions. */
  pending: Promise<unknown>[];
  after?: () => void | Promise<void>;
}

/**
 * Runs the `create` and `createOnce` hooks of `rules` over one file. One walk of the AST calls the
 * visitors of all rules. A rule that throws is reported as crashed and stops checking the file.
 */
export async function runRules(
  rules: readonly EnabledRule[],
  file: FileInput,
  timings?: RuleTimings,
): Promise<Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  type Listener = { run: RuleRun; query?: esquery.Selector; listener: (node: Nodes) => unknown };
  /** Listeners on entering and leaving nodes, by node type (`*` for any). */
  const listeners = { enter: new Map<string, Listener[]>(), exit: new Map<string, Listener[]>() };
  const runs: RuleRun[] = [];
  const crash = (run: RuleRun, error: unknown) => {
    if (run.crashed) return;
    run.crashed = true;
    diagnostics.push(crashDiagnostic(run.enabled.id, file.filename, error));
  };
  /** Calls a function of a rule, unless the rule crashed. Errors and rejected promises crash it. */
  const guard = <T>(run: RuleRun, fn: (arg: T) => unknown, arg: T) => {
    if (run.crashed) return;
    try {
      const result = timings ? timings.measure(run.enabled.id, () => fn(arg)) : fn(arg);
      if (result instanceof Promise) run.pending.push(result.catch((error: unknown) => crash(run, error)));
    } catch (error) {
      crash(run, error);
    }
  };

  // As in ESLint and Oxlint, a rule's context has `id`, `options` and `report` and inherits the
  // rest from the file's context (Oxlint's `eslintCompatPlugin` relies on this).
  const fileContext = Object.freeze({
    filename: file.filename,
    physicalFilename: file.filename,
    cwd: file.cwd,
    sourceCode: file.sourceCode,
    settings: file.settings,
    project: file.project,
  });
  for (const enabled of rules) {
    const { id, rule, options } = enabled;
    if (!rule.create && !rule.createOnce) continue;
    const run: RuleRun = { enabled, crashed: false, pending: [] };
    runs.push(run);
    const report = (descriptor: ReportDescriptor) => {
      if (run.crashed) return;
      diagnostics.push(toDiagnostic(enabled, file.filename, descriptor));
    };
    const context = Object.freeze(Object.assign(Object.create(fileContext) as RuleContext, { id, options, report }));
    try {
      const created = createVisitor(rule, context, timings);
      if (!created) continue;
      for (const [key, listener] of Object.entries(created.visitor)) {
        if (typeof listener !== "function") continue;
        const { exit, types, query } = parseSelector(key);
        const byType = exit ? listeners.exit : listeners.enter;
        const entry = { run, query, listener: listener as Listener["listener"] };
        for (const type of types) byType.set(type, [...(byType.get(type) ?? []), entry]);
      }
      run.after = created.after;
    } catch (error) {
      crash(run, error);
    }
  }

  /** The ancestors of the current node, the parent first (as esquery expects). */
  const ancestry: Nodes[] = [];
  const dispatch = (entries: Listener[] | undefined, node: Nodes) => {
    for (const { run, query, listener } of entries ?? []) {
      if (!query || matches(node, query, ancestry)) guard(run, listener, node);
    }
  };
  const call = (byType: Map<string, Listener[]>, node: Nodes) => {
    dispatch(byType.get("*"), node);
    dispatch(byType.get(node.type), node);
  };
  const walk = (node: Nodes) => {
    call(listeners.enter, node);
    if ("children" in node) {
      ancestry.unshift(node);
      for (const child of node.children) walk(child);
      ancestry.shift();
    }
    call(listeners.exit, node);
  };
  if (listeners.enter.size || listeners.exit.size) walk(file.sourceCode.ast);

  await Promise.all(
    runs.map(async (run) => {
      await Promise.all(run.pending);
      if (!run.after) return;
      // `after` may return a promise too, which `guard` adds to `pending`.
      guard(run, run.after, undefined);
      await Promise.all(run.pending);
    }),
  );
  return diagnostics;
}

/**
 * The rule's visitor for one file, and the `after` hook of `createOnce`, or undefined when the
 * `before` hook skips the file.
 */
function createVisitor(
  rule: AnyRule,
  context: RuleContext,
  timings?: RuleTimings,
): { visitor: Visitor; after?: () => void | Promise<void> } | undefined {
  const { id } = context;
  if (rule.create) {
    return { visitor: timings ? timings.measure(id, rule.create.bind(rule, context)) : rule.create(context) };
  }
  const createOnce = rule.createOnce as NonNullable<AnyRule["createOnce"]>;
  const { before, after, ...visitor } = timings
    ? timings.measure(id, createOnce.bind(rule, context))
    : createOnce.call(rule, context);
  if (before && (timings ? timings.measure(id, before) : before()) === false) return undefined;
  return { visitor, after };
}
