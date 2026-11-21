import { basename, dirname, join } from "node:path";

import type { InlineCode, Nodes, Parents, Root } from "mdast";
import { toString } from "mdast-util-to-string";

import { locateInNode, visit } from "#src/markdown.ts";
import type { Project } from "#src/project.ts";
import type { Rule } from "#src/types.ts";

export interface NoMissingPathOptions {
  /** Glob patterns of referenced paths that are never reported. */
  ignore: string[];
  /** Accept a path when some project path ends with it (e.g. `components/Button.tsx`). */
  allowSuffixMatch: boolean;
  /** Check `@path/to/file.md` imports (CLAUDE.md / GEMINI.md import syntax). */
  checkImports: boolean;
}

/** File extensions that make a code span look like a file reference. */
export const KNOWN_EXTENSIONS = new Set(
  (
    "md mdx mdc markdown txt rst adoc json jsonc json5 yaml yml toml ini cfg conf xml csv tsv " +
    "ts tsx mts cts js jsx mjs cjs vue svelte astro css scss sass less styl html htm " +
    "py pyi ipynb rb go rs java kt kts scala swift m mm c h cc cpp cxx hpp cs fs php pl lua dart ex exs erl " +
    "zig nim jl r clj cljs elm hs ml sh bash zsh fish ps1 bat cmd sql prisma graphql gql proto " +
    "lock tf tfvars hcl gradle properties plist xcconfig pbxproj entitlements storyboard xib " +
    "png jpg jpeg gif svg webp ico avif pdf wasm dockerfile mk nix vim el tex bib patch diff http rest " +
    "snap tmpl hbs ejs pug njk liquid twig j2 sol move cairo"
  ).split(" "),
);

/** Second-level "extensions" used to describe naming conventions (`.test.ts`, `.d.ts`). */
const COMPOUND_INFIXES = new Set(
  (
    "d test spec module config stories story e2e min server client page layout route worker cy bench " +
    "mock mocks fixture fixtures setup types gen generated native web ios android browser node api " +
    "schema service controller entity dto guard pipe component directive resolver store slice hook " +
    "util utils helper helpers int unit integration"
  ).split(" "),
);

/** Well-known files without an extension. */
const EXTENSIONLESS_FILES = new Set([
  "Makefile",
  "GNUmakefile",
  "Dockerfile",
  "Containerfile",
  "Justfile",
  "justfile",
  "Procfile",
  "Gemfile",
  "Rakefile",
  "Brewfile",
  "Vagrantfile",
  "Jenkinsfile",
  "Tiltfile",
  "Taskfile",
  "Caddyfile",
  "Pipfile",
  "Podfile",
  "Fastfile",
  "LICENSE",
  "CODEOWNERS",
]);

/** `Node.js`, `Next.js`, ...: product names that look like JS files. */
const JS_PRODUCT_NAMES =
  /^(node|next|nuxt|vue|react|express|three|d3|chart|ember|backbone|angular|alpine|solid|nest|socket|moment|day|preact|svelte|deno|bun|p5|ml5|anime|hapi|koa|meteor|gatsby|eleventy|knockout|mithril|polymer|riot|ext|video|highlight|pixi|phaser|babylon|matter|paper|fabric|leaflet|tensorflow|brain|immutable|redux|mobx|xstate|zod|htmx|lit|qwik|remix|astro|vite|webpack|rollup|parcel|turbo|nx|lerna|electron|ionic|cordova|capacitor|expo|hono|elysia|fastify|adonis|strapi|sails|loopback|feathers|keystone|ghost|docusaurus|vuepress|hexo|metalsmith|handlebars|mustache|nunjucks|underscore|lodash|ramda|rx|bacon|most|chai|mocha|jasmine|karma|cypress|jest|vitest|playwright|puppeteer|postgres|sql|pdf|tone|fuse|howler|popper|tippy|swiper|luxon|sortable|dexie|pouchdb|quill|plotly|vis|cytoscape|sigma|math|hls|dash|plyr|wavesurfer|peer|sockjs|ws|uppy|dropzone|cleave|inputmask|algolia|instantsearch|marked|showdown|prism|shiki|chartist|apex|echarts|nivo|visx|recharts|framer|motion|gsap|lenis|locomotive|barba|swup|turbolinks|stimulus|hotwire|alpinejs|petite-vue|uhtml|lighterhtml|hyperhtml|inferno|million|signal|signals|kysely|knex|sequelize|typeorm|mongoose|prisma|drizzle|objection|bookshelf|waterline|mikro-orm)\.js$/i;

/** Receivers whose members look like files: `Bun.sql`, `res.json`, `Response.json`. */
const API_STEMS =
  /^(?:Bun|Deno|Node|JSON|Math|Response|Request|Headers|Promise|Object|Array|Buffer|Intl|Reflect|Symbol|String|Number|Date|process|window|document|console|globalThis|navigator|res|req|ctx|err|z)$/;

export interface PathCandidate {
  /** Normalized path: no leading `./`, no trailing `/`. */
  path: string;
  /** Written with a trailing slash. */
  isDir: boolean;
  /**
   * `strong` candidates are almost certainly paths (extension, `./` prefix, trailing slash).
   * `weak` candidates (`src/components`) are only checked when their first segment exists.
   */
  strength: "strong" | "weak";
  glob: boolean;
  /** Written as `./x` or `../x`: resolved against the file's directory only. */
  relativeToFile: boolean;
}

const ALLOWED_CHARS = /^[A-Za-z0-9._\-/@*?[\]{},+]+$/;
const PLACEHOLDER_SEGMENT = /^(?:(?:your|my)[-_].*|x{3,}|(?:foo|bar|baz|qux|example|sample)(?:\.[A-Za-z0-9]+)?)$/i;

/**
 * Decides whether the content of an inline code span is a reference to a
 * file or directory. Returns null for anything that doesn't look like one.
 */
export function classifyPathCandidate(raw: string): PathCandidate | null {
  let s = raw.trim();
  if (!s || s.length > 300 || /\s/.test(s)) return null;
  // `src/foo.ts:12`, `src/foo.ts:12:3`, `src/foo.ts#L10-L20`
  s = s.replace(/#L\d+(?:C\d+)?(?:-L?\d+(?:C\d+)?)?$/, "").replace(/:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/, "");
  if (!ALLOWED_CHARS.test(s)) return null;
  if (s.startsWith("/") || s.startsWith("@") || s.includes("...")) return null;
  if (/\{[^},]*\}/.test(s)) return null; // `{id}` placeholders (but not `{a,b}` globs)
  if (/(?:^|\/)path\/to(?:\/|$)/i.test(s)) return null;

  const relativeToFile = s.startsWith("./") || s.startsWith("../");
  let p = s.replace(/^(?:\.\/)+/, "");
  const isDir = p.endsWith("/");
  p = p.replace(/\/+$/, "");
  if (!p || p === "." || p === "..") return null;
  const segments = p.split("/");
  if (segments.some((seg) => seg === "")) return null;
  if (segments.some((seg) => PLACEHOLDER_SEGMENT.test(seg))) return null;

  const glob = /[*?]|\[[^\]]*\]|\{[^}]*,[^}]*\}/.test(p);
  const last = segments.at(-1) as string;
  const hasSlash = segments.length > 1;
  const lastIsDotfile = last.startsWith(".") && last !== "..";
  const ext = !lastIsDotfile && last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : null;
  const knownExt = !!ext && KNOWN_EXTENSIONS.has(ext);
  const make = (strength: PathCandidate["strength"]): PathCandidate => ({
    path: p,
    isDir,
    strength,
    glob,
    relativeToFile,
  });

  if (!hasSlash) {
    if (glob) return null; // `*.ts` describes a naming convention, not a location
    if (isDir) return make("strong");
    if (lastIsDotfile) {
      const parts = last.slice(1).split(".");
      const first = parts[0]?.toLowerCase() ?? "";
      if (!first || KNOWN_EXTENSIONS.has(first) || COMPOUND_INFIXES.has(first)) return null; // `.ts`, `.d.ts`
      // Short lowercase parts read as extension mentions (`.tscn`, `.gd.uid`), not dotfiles (`.nvmrc`).
      if (parts.every((part) => /^[a-z0-9]{1,4}$/.test(part))) return null;
      return make("strong");
    }
    if (knownExt) {
      const stem = last.slice(0, last.lastIndexOf("."));
      const writtenExt = last.slice(last.lastIndexOf(".") + 1);
      if (JS_PRODUCT_NAMES.test(last) || API_STEMS.test(stem) || /[A-Z]/.test(writtenExt)) return null;
      return make("strong");
    }
    if (EXTENSIONLESS_FILES.has(last)) return make("strong");
    return null;
  }

  const first = segments[0] as string;
  if (!relativeToFile && !first.startsWith(".") && first.includes(".")) {
    // `github.com/org/repo`, `example.com/file.json`: only check when it exists locally.
    return make("weak");
  }
  if (relativeToFile || isDir || knownExt || lastIsDotfile || glob || EXTENSIONLESS_FILES.has(last)) {
    return make("strong");
  }
  return make("weak");
}

/** Whether `abs` exists, optionally allowing extension-less module paths (`src/utils` -> `src/utils.ts`). */
function existsLoosely(project: Project, abs: string, isDir: boolean, loose: boolean): boolean {
  if (isDir ? project.isDirectory(abs) : project.exists(abs)) return true;
  if (!loose || isDir) return false;
  const prefix = `${basename(abs)}.`;
  return project.readDir(dirname(abs))?.some((entry) => entry.startsWith(prefix)) ?? false;
}

export type Resolution = { ok: true } | { ok: false; suggestions: string[] };

/** Build outputs and the source extensions they are compiled from (`main.js` <- `main.ts`). */
const COMPILED_FROM: Record<string, string[]> = {
  js: ["ts", "tsx", "mts", "cts", "jsx"],
  mjs: ["mts", "ts"],
  cjs: ["cts", "ts"],
  jsx: ["tsx"],
  css: ["scss", "sass", "less", "styl", "pcss"],
};

/** Whether a missing `x.js` / `x.css` is the build output of an existing `x.ts` / `x.scss`. */
function isCompiledArtifact(
  candidate: PathCandidate,
  bases: string[],
  project: Project,
  allowSuffixMatch: boolean,
): boolean {
  const dot = candidate.path.lastIndexOf(".");
  const sources = COMPILED_FROM[candidate.path.slice(dot + 1).toLowerCase()];
  if (dot <= 0 || !sources) return false;
  const stem = candidate.path.slice(0, dot);
  for (const ext of sources) {
    const source = `${stem}.${ext}`;
    if (bases.some((base) => project.isFile(join(base, source)))) return true;
    if (!candidate.relativeToFile && allowSuffixMatch && project.findBySuffix(source, "file", 1).length) {
      return true;
    }
  }
  return false;
}

export function resolvePathCandidate(
  candidate: PathCandidate,
  fileDir: string,
  project: Project,
  allowSuffixMatch: boolean,
): Resolution {
  const ok: Resolution = { ok: true };
  const bases = candidate.relativeToFile ? [fileDir] : project.ancestorsUpToRoot(fileDir);
  const hasExtension = /\.[^/.]+$/.test(candidate.path) && !basename(candidate.path).startsWith(".");
  const loose = !hasExtension;
  let searchBases = bases;

  if (candidate.strength === "weak") {
    const first = candidate.path.split("/")[0] as string;
    searchBases = bases.filter((base) => project.exists(join(base, first)));
    if (searchBases.length === 0) return ok; // not anchored in this project: probably not a path
  }
  if (searchBases.some((base) => existsLoosely(project, join(base, candidate.path), candidate.isDir, loose))) {
    return ok;
  }
  if (candidate.glob && searchBases.some((base) => project.globMatches(candidate.path, base))) return ok;
  // Git-ignored paths (build output, local env files) legitimately don't exist in a fresh checkout.
  if (bases.some((base) => project.isIgnored(join(base, candidate.path), candidate.isDir || undefined))) return ok;
  if (!candidate.relativeToFile && !candidate.glob && allowSuffixMatch) {
    if (project.findBySuffix(candidate.path, candidate.isDir ? "dir" : "any", 1).length) return ok;
  }
  if (!candidate.isDir && !candidate.glob && isCompiledArtifact(candidate, searchBases, project, allowSuffixMatch)) {
    return ok;
  }
  const suggestions = candidate.glob
    ? []
    : project.findBySuffix(basename(candidate.path), candidate.isDir ? "dir" : "any", 3);
  return { ok: false, suggestions };
}

/** File names declared by code fences: ```tsx#frontend.tsx, ```ts title="src/app.ts". */
function exampleFilesFromCodeFences(tree: Root): Set<string> {
  const files = new Set<string>();
  visit(tree, "code", (node) => {
    const info = `${node.lang ?? ""} ${node.meta ?? ""}`;
    for (const match of info.matchAll(/(?:^[\w+-]*#|\b(?:title|file|filename)=["']?)([^\s"']+)/g)) {
      const file = (match[1] as string).replace(/^\.\//, "");
      files.add(file);
      files.add(basename(file));
    }
  });
  return files;
}

const EXAMPLE_LEAD_IN = /(?:\be\.?g\.|\bi\.e\.|\bfor (?:example|instance)|\bsuch as|\blike)[,:]?\s*\(?\s*$/i;
const LIST_SEPARATOR = /^\s*(?:,|\/|or|and|,\s*or|,\s*and)\s*$/i;

/**
 * Whether an inline code span introduces example content rather than referencing
 * an existing file: "e.g. `index.js`", or a paragraph ending in ":" that is
 * followed by a code block ("With the following `frontend.tsx`:").
 */
function isExampleContext(node: InlineCode, ancestors: readonly Parents[]): boolean {
  const parent = ancestors.at(-1);
  if (!parent) return false;
  let index = parent.children.indexOf(node as never);
  while (index > 0) {
    const prev = parent.children[index - 1] as Nodes;
    if (prev.type !== "text") break;
    if (EXAMPLE_LEAD_IN.test(prev.value)) return true;
    if (!LIST_SEPARATOR.test(prev.value) || index < 2 || parent.children[index - 2]?.type !== "inlineCode") break;
    index -= 2;
  }
  for (let i = ancestors.length - 1; i > 0; i--) {
    const ancestor = ancestors[i] as Parents;
    if (ancestor.type !== "paragraph") continue;
    const container = ancestors[i - 1] as Parents;
    const next = container.children[container.children.indexOf(ancestor as never) + 1];
    return next?.type === "code" && toString(ancestor).trimEnd().endsWith(":");
  }
  return false;
}

function insideLink(ancestors: readonly { type: string }[]): boolean {
  return ancestors.some((a) => a.type === "link" || a.type === "linkReference");
}

const IMPORT_RE = /(^|[\s([{])@([A-Za-z0-9_.-][A-Za-z0-9._\-/]*)/g;

/** Extracts `@path` imports (Claude Code / Gemini CLI syntax) from plain text. */
export function findImports(text: string): { path: string; index: number }[] {
  const out: { path: string; index: number }[] = [];
  for (const match of text.matchAll(IMPORT_RE)) {
    const path = (match[2] as string).replace(/[.,;:!?]+$/, "");
    const index = (match.index ?? 0) + (match[1] as string).length;
    const last = path.split("/").at(-1) ?? "";
    const ext = last.includes(".") ? last.slice(last.lastIndexOf(".") + 1).toLowerCase() : "";
    const explicit = path.startsWith("./") || path.startsWith("../");
    if (explicit || (ext && KNOWN_EXTENSIONS.has(ext))) out.push({ path, index });
  }
  return out;
}

export const noMissingPath: Rule<NoMissingPathOptions> = {
  meta: {
    name: "context/no-missing-path",
    description: "Referenced files and directories (in code spans and @imports) must exist",
    categories: ["recommended"],
    defaultSeverity: "error",
    schema: {
      type: "object",
      properties: {
        ignore: {
          type: "array",
          items: { type: "string" },
          description: "Glob patterns of referenced paths to skip.",
        },
        allowSuffixMatch: {
          type: "boolean",
          description:
            "Accept a path if any project path ends with it (e.g. `components/Button.tsx` matches `apps/web/src/components/Button.tsx`).",
        },
        checkImports: {
          type: "boolean",
          description: "Check `@path/to/file.md` imports used by CLAUDE.md and GEMINI.md.",
        },
      },
    },
  },
  defaultOptions: { ignore: [], allowSuffixMatch: true, checkImports: true },
  check({ file, project, options, report }) {
    const fileDir = dirname(file.path);
    const ignoreGlobs = options.ignore.map((p) => new Bun.Glob(p));
    const isIgnoredByOption = (p: string) => ignoreGlobs.some((g) => g.match(p));
    let exampleFiles: Set<string> | undefined;

    visit(file.ast, "inlineCode", (node, ancestors) => {
      if (insideLink(ancestors)) return; // covered by context/no-broken-reference
      const candidate = classifyPathCandidate(node.value);
      if (!candidate || isIgnoredByOption(candidate.path) || isIgnoredByOption(node.value.trim())) return;
      exampleFiles ??= exampleFilesFromCodeFences(file.ast);
      if (exampleFiles.has(candidate.path) || isExampleContext(node, ancestors)) return;
      const resolution = resolvePathCandidate(candidate, fileDir, project, options.allowSuffixMatch);
      if (resolution.ok) return;
      const { start, end } = locateInNode(file.text, file.lineStarts, node, node.value);
      report({
        message: candidate.glob
          ? `No files match the glob \`${node.value.trim()}\``
          : `${candidate.isDir ? "Directory" : "Path"} \`${node.value.trim()}\` does not exist`,
        help: resolution.suggestions.length
          ? `Did you mean ${resolution.suggestions.map((s) => `\`${s}\``).join(", ")}?`
          : "Paths are resolved against this file's directory and its parents up to the project root.",
        start,
        end,
      });
    });

    if (!options.checkImports) return;
    visit(file.ast, "text", (node, ancestors) => {
      if (insideLink(ancestors)) return;
      for (const imp of findImports(node.value)) {
        if (imp.path.startsWith("~")) continue;
        if (isIgnoredByOption(imp.path)) continue;
        const abs = join(fileDir, imp.path);
        if (project.exists(abs) || project.isIgnored(abs)) continue;
        const { start, end } = locateInNode(file.text, file.lineStarts, node, `@${imp.path}`);
        const suggestions = project.findBySuffix(basename(imp.path), "file", 3);
        report({
          message: `Imported file \`@${imp.path}\` does not exist`,
          help: suggestions.length
            ? `Imports are resolved relative to this file. Did you mean ${suggestions.map((s) => `\`${s}\``).join(", ")}?`
            : "Imports are resolved relative to this file's directory.",
          start,
          end,
        });
      }
    });
  },
};
