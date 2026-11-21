import GithubSlugger from "github-slugger";
import type { Nodes, Parents, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { frontmatterFromMarkdown } from "mdast-util-frontmatter";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { toString } from "mdast-util-to-string";
import { frontmatter } from "micromark-extension-frontmatter";
import { gfm } from "micromark-extension-gfm";

import type { Position } from "./types.ts";

export function parseMarkdown(text: string): Root {
  return fromMarkdown(text, {
    extensions: [gfm(), frontmatter(["yaml", "toml"])],
    mdastExtensions: [gfmFromMarkdown(), frontmatterFromMarkdown(["yaml", "toml"])],
  });
}

type NodeOfType<T extends Nodes["type"]> = Extract<Nodes, { type: T }>;

/**
 * Visits every node of the given type (depth-first, document order).
 * The callback receives the chain of ancestors (root first).
 */
export function visit<T extends Nodes["type"]>(
  tree: Root,
  type: T | readonly T[],
  fn: (node: NodeOfType<T>, ancestors: readonly Parents[]) => void,
): void {
  const types = new Set<string>(Array.isArray(type) ? type : [type]);
  const stack: Parents[] = [];
  const walk = (node: Nodes) => {
    if (types.has(node.type)) fn(node as NodeOfType<T>, stack);
    if ("children" in node) {
      stack.push(node);
      for (const child of node.children) walk(child);
      stack.pop();
    }
  };
  walk(tree);
}

export function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** Converts a 0-based string offset to a 1-based line/column position. */
export function offsetToPosition(lineStarts: number[], offset: number): Position {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((lineStarts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: offset - (lineStarts[lo] as number) + 1 };
}

export function positionToOffset(lineStarts: number[], pos: Position): number {
  return (lineStarts[pos.line - 1] ?? 0) + pos.column - 1;
}

/**
 * Finds `needle` inside the source range of `node` and returns its start/end
 * positions. Falls back to the node's own position when it can't be found
 * (e.g. because of escapes in the source).
 */
export function locateInNode(
  text: string,
  lineStarts: number[],
  node: Nodes,
  needle: string,
  fromOffset?: number,
): { start: Position; end: Position; offset: number } {
  const startOffset = node.position?.start.offset ?? 0;
  const endOffset = node.position?.end.offset ?? text.length;
  const searchFrom = Math.max(startOffset, fromOffset ?? startOffset);
  const idx = text.slice(0, endOffset).indexOf(needle, searchFrom);
  if (idx === -1 || needle.length === 0) {
    const start = node.position
      ? { line: node.position.start.line, column: node.position.start.column }
      : { line: 1, column: 1 };
    const end = node.position ? { line: node.position.end.line, column: node.position.end.column } : start;
    return { start, end, offset: startOffset };
  }
  return {
    start: offsetToPosition(lineStarts, idx),
    end: offsetToPosition(lineStarts, idx + needle.length),
    offset: idx,
  };
}

/** Collects all anchors a link fragment can target: GitHub-style heading slugs and HTML ids/names. */
export function collectAnchors(tree: Root): Set<string> {
  const slugger = new GithubSlugger();
  const anchors = new Set<string>();
  visit(tree, ["heading", "html"], (node) => {
    if (node.type === "heading") {
      anchors.add(slugger.slug(toString(node)));
    } else {
      for (const m of node.value.matchAll(/\s(?:id|name)\s*=\s*["']([^"']+)["']/gi)) {
        if (m[1]) anchors.add(m[1]);
      }
    }
  });
  return anchors;
}
