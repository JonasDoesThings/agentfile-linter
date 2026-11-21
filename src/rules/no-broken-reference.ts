import { dirname, extname, join, relative } from "node:path";

import type { Nodes } from "mdast";

import { collectAnchors, locateInNode, visit } from "#src/markdown.ts";
import { normalizeAnchor, normalizeAnchors } from "#src/project.ts";
import type { Rule } from "#src/types.ts";

export interface NoBrokenReferenceOptions {
  /** Check `#fragment` anchors against headings. */
  checkAnchors: boolean;
  /** Glob patterns of link targets that are never reported. */
  ignore: string[];
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".mdc"]);
const HTML_ATTR_RE = /\s(?:href|src)\s*=\s*["']([^"']+)["']/gi;

function isExternal(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("//");
}

export const noBrokenReference: Rule<NoBrokenReferenceOptions> = {
  meta: {
    name: "context/no-broken-reference",
    description: "Relative Markdown links, images and local #anchors must resolve",
    categories: ["recommended"],
    defaultSeverity: "error",
    schema: {
      type: "object",
      properties: {
        checkAnchors: { type: "boolean", description: "Check `#fragment` anchors against document headings." },
        ignore: { type: "array", items: { type: "string" }, description: "Glob patterns of link targets to skip." },
      },
    },
  },
  defaultOptions: { checkAnchors: true, ignore: [] },
  check({ file, project, options, report }) {
    const fileDir = dirname(file.path);
    const ignoreGlobs = options.ignore.map((p) => new Bun.Glob(p));
    let ownAnchors: Set<string> | undefined;

    const checkUrl = (url: string, node: Nodes) => {
      const target = url.trim();
      if (!target || isExternal(target)) return;
      if (ignoreGlobs.some((g) => g.match(target))) return;
      const hashIndex = target.indexOf("#");
      const pathPart = (hashIndex === -1 ? target : target.slice(0, hashIndex)).replace(/\?.*$/, "");
      const fragment = hashIndex === -1 ? null : target.slice(hashIndex + 1);
      const loc = () => locateInNode(file.text, file.lineStarts, node, url);

      if (!pathPart) {
        if (!fragment || !options.checkAnchors || fragment.toLowerCase() === "top") return;
        ownAnchors ??= normalizeAnchors(collectAnchors(file.ast));
        if (!ownAnchors.has(normalizeAnchor(fragment))) {
          report({
            message: `Anchor \`#${fragment}\` does not match any heading in this file`,
            help: "Anchors use GitHub-style heading slugs (lowercase, spaces replaced by `-`).",
            ...loc(),
          });
        }
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
          ...loc(),
        });
        return;
      }
      if (
        fragment &&
        options.checkAnchors &&
        fragment.toLowerCase() !== "top" &&
        project.isFile(abs) &&
        MARKDOWN_EXTENSIONS.has(extname(abs).toLowerCase())
      ) {
        const anchors = project.anchorsOf(abs);
        if (anchors && !anchors.has(normalizeAnchor(fragment))) {
          report({
            message: `Anchor \`#${fragment}\` does not match any heading in \`${pathPart}\``,
            help: "Anchors use GitHub-style heading slugs (lowercase, spaces replaced by `-`).",
            ...loc(),
          });
        }
      }
    };

    visit(file.ast, ["link", "image", "definition", "html"], (node) => {
      if (node.type === "html") {
        for (const match of node.value.matchAll(HTML_ATTR_RE)) checkUrl(match[1] as string, node);
      } else {
        checkUrl(node.url, node);
      }
    });
  },
};
