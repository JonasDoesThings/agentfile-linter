import type { Nodes, Parents, Root } from "mdast";

import { computeLineStarts, offsetToPosition, positionToOffset } from "./markdown.ts";
import type { Position, SourceLocation } from "./types.ts";

const FILE_START: SourceLocation = { start: { line: 1, column: 1 }, end: { line: 1, column: 1 } };

/**
 * A parsed Markdown file, with the API of `context.sourceCode` in ESLint's Markdown language
 * (`@eslint/markdown`). Lines and columns are 1-based, as in mdast.
 */
export class SourceCode {
  /** Offsets at which the lines start. */
  readonly lineStartIndices: number[];
  #lines: string[] | undefined;
  #parents: WeakMap<Nodes, Parents> | undefined;

  constructor(
    readonly text: string,
    readonly ast: Root,
  ) {
    this.lineStartIndices = computeLineStarts(text);
  }

  /** The lines of the file, without line breaks. */
  get lines(): string[] {
    this.#lines ??= this.text.split(/\r?\n/);
    return this.#lines;
  }

  /** The source of `node` (the whole file without it), extended by the given number of characters. */
  getText(node?: Nodes, beforeCount = 0, afterCount = 0): string {
    if (!node) return this.text;
    const [start, end] = this.getRange(node);
    return this.text.slice(Math.max(start - beforeCount, 0), end + afterCount);
  }

  getLoc(node: Nodes): SourceLocation {
    return node.position ?? FILE_START;
  }

  getRange(node: Nodes): [number, number] {
    return [node.position?.start.offset ?? 0, node.position?.end.offset ?? 0];
  }

  getParent(node: Nodes): Parents | undefined {
    if (!this.#parents) {
      const parents = new WeakMap<Nodes, Parents>();
      const walk = (parent: Parents) => {
        for (const child of parent.children) {
          parents.set(child, parent);
          if ("children" in child) walk(child);
        }
      };
      walk(this.ast);
      this.#parents = parents;
    }
    return this.#parents.get(node);
  }

  /** The ancestors of `node`, the root first. */
  getAncestors(node: Nodes): Parents[] {
    const ancestors: Parents[] = [];
    for (let parent = this.getParent(node); parent; parent = this.getParent(parent)) ancestors.unshift(parent);
    return ancestors;
  }

  getLocFromIndex(index: number): Position {
    return offsetToPosition(this.lineStartIndices, index);
  }

  getIndexFromLoc(loc: Position): number {
    return positionToOffset(this.lineStartIndices, loc);
  }
}
