import { dirname, extname, join, relative } from "node:path";

import type { Definition, Image, Link, Nodes } from "mdast";

import { Glob } from "#src/glob.ts";
import { collectAnchors, locateInNode } from "#src/markdown.ts";
import { countLines, normalizeAnchor, normalizeAnchors } from "#src/project.ts";
import type { Rule, SourceLocation } from "#src/types.ts";

export interface NoBrokenReferenceOptions {
  /** Check `#fragment` anchors against headings. */
  checkAnchors: boolean;
  /** Check `#L42` / `#L42-L50` line fragments against the length of the target file. */
  checkLines: boolean;
  /** Glob patterns of link targets that are never reported. */
  ignore: string[];
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".mdc"]);
const HTML_ATTR_RE = /\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;
/** `?plain=1` shows a Markdown file's source with numbered lines on GitHub. */
const PLAIN_QUERY_RE = /[?&]plain=1(?:&|$)/;
/** Line fragments as GitHub, GitLab and Gitea write them: `L42`, `L42-L50`, `L42-50`, `L42C5-L50C10`. */
const LINE_FRAGMENT_RE = /^L(\d+)(?:C\d+)?(?:-L?(\d+)(?:C\d+)?)?$/;

interface LineRange {
  start: number;
  end: number;
}

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function parseLineFragment(fragment: string): LineRange | null {
  const match = LINE_FRAGMENT_RE.exec(fragment);
  if (!match) return null;
  const start = Number(match[1]);
  return { start, end: match[2] === undefined ? start : Number(match[2]) };
}

export const noBrokenReference: Rule<[NoBrokenReferenceOptions]> = {
  meta: {
    docs: {
      description: "Relative Markdown links, images, local #anchors and #L42 line fragments must resolve",
      recommended: true,
      category: "correctness",
    },
    schema: [
      {
        type: "object",
        properties: {
          checkAnchors: { type: "boolean", description: "Check `#fragment` anchors against document headings." },
          checkLines: {
            type: "boolean",
            description: "Check `#L42` / `#L42-L50` line fragments against the length of the target file.",
          },
          ignore: { type: "array", items: { type: "string" }, description: "Glob patterns of link targets to skip." },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{ checkAnchors: true, checkLines: true, ignore: [] }],
  },
  create(context) {
    const { filename, sourceCode, project, report } = context;
    const [options] = context.options;
    const fileDir = dirname(filename);
    const ignoreGlobs = options.ignore.map((p) => new Glob(p));
    let ownAnchors: Set<string> | undefined;

    const checkLineRange = (
      fragment: string,
      range: LineRange,
      lineCount: number | null,
      where: string,
      loc: () => SourceLocation,
    ) => {
      if (lineCount === null) return;
      const label = range.start === range.end ? "Line" : "Line range";
      if (range.start === 0) {
        report({ message: `${label} \`#${fragment}\` is invalid: line numbers start at 1`, loc: loc() });
      } else if (range.end < range.start) {
        report({
          message: `Line range \`#${fragment}\` ends before it starts`,
          help: "Put the lower line number first.",
          loc: loc(),
        });
      } else if (range.end > lineCount) {
        report({
          message: `${label} \`#${fragment}\` is out of range: ${where} has ${lineCount} line${lineCount === 1 ? "" : "s"}`,
          help: "The file has probably changed since the link was written. Update the line numbers.",
          loc: loc(),
        });
      }
    };

    const checkUrl = (url: string, node: Nodes) => {
      const target = url.trim();
      if (!target || isExternal(target)) return;
      if (ignoreGlobs.some((g) => g.match(target))) return;
      const hashIndex = target.indexOf("#");
      const beforeHash = hashIndex === -1 ? target : target.slice(0, hashIndex);
      const queryIndex = beforeHash.indexOf("?");
      const pathPart = queryIndex === -1 ? beforeHash : beforeHash.slice(0, queryIndex);
      const plainView = queryIndex !== -1 && PLAIN_QUERY_RE.test(beforeHash.slice(queryIndex));
      const fragment = hashIndex === -1 ? null : target.slice(hashIndex + 1);
      const lineRange = fragment === null ? null : parseLineFragment(fragment);
      const loc = () => locateInNode(sourceCode, node, url);
      // GitHub renders Markdown, where `#L42` is a heading anchor. Lines are numbered only in
      // other files and in the source view of Markdown (`?plain=1`).
      const usesLines = (path: string) => lineRange !== null && (plainView || !isMarkdownPath(path));

      if (!pathPart) {
        if (!fragment || fragment.toLowerCase() === "top") return;
        if (lineRange && usesLines(filename)) {
          if (options.checkLines) checkLineRange(fragment, lineRange, countLines(sourceCode.text), "this file", loc);
          return;
        }
        if (!options.checkAnchors) return;
        ownAnchors ??= normalizeAnchors(collectAnchors(sourceCode.ast));
        if (ownAnchors.has(normalizeAnchor(fragment))) return;
        report({
          message: `Anchor \`#${fragment}\` does not match any heading in this file`,
          help: "Anchors use GitHub-style heading slugs (lowercase, spaces replaced by `-`).",
          loc: loc(),
        });
        return;
      }

      let decoded = pathPart;
      try {
        decoded = decodeURIComponent(pathPart);
      } catch {
        // keep as written
      }
      // GitHub resolves root-relative links (`/docs/x.md`) against the repository root.
      const abs = pathPart.startsWith("/") ? join(project.root, decoded) : join(fileDir, decoded);
      if (!project.exists(abs)) {
        if (project.isIgnored(abs)) return;
        report({
          message: `Link target \`${pathPart}\` does not exist`,
          help: `Resolved to \`${relative(project.root, abs) || "."}\` (relative to this file).`,
          loc: loc(),
        });
        return;
      }
      if (!fragment || fragment.toLowerCase() === "top" || !project.isFile(abs)) return;
      if (lineRange && usesLines(abs)) {
        // Git-ignored files are often generated, so their length depends on the environment.
        if (!options.checkLines || !project.contains(abs) || project.isIgnored(abs)) return;
        checkLineRange(fragment, lineRange, project.lineCountOf(abs), `\`${pathPart}\``, loc);
      } else if (options.checkAnchors && isMarkdownPath(abs)) {
        const anchors = project.anchorsOf(abs);
        if (anchors && !anchors.has(normalizeAnchor(fragment))) {
          report({
            message: `Anchor \`#${fragment}\` does not match any heading in \`${pathPart}\``,
            help: "Anchors use GitHub-style heading slugs (lowercase, spaces replaced by `-`).",
            loc: loc(),
          });
        }
      }
    };

    const checkNode = (node: Link | Image | Definition) => checkUrl(node.url, node);
    return {
      link: checkNode,
      image: checkNode,
      definition: checkNode,
      html(node) {
        for (const match of node.value.matchAll(HTML_ATTR_RE)) checkUrl(match[1] as string, node);
      },
    };
  },
};
