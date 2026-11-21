import { describe, expect, test } from "bun:test";

import { firstLineRange, lineRange, splitLines } from "./text.ts";

describe("line helpers", () => {
  test("splitLines strips a byte order mark and splits on LF and CRLF", () => {
    expect(splitLines("﻿a\r\nb\nc")).toEqual(["a", "b", "c"]);
    expect(splitLines("a\nb\nc", 1)).toEqual(["a"]);
  });

  test("line ranges don't count a byte order mark", () => {
    expect(firstLineRange("﻿# Title\n")).toEqual({ start: { line: 1, column: 1 }, end: { line: 1, column: 8 } });
    expect(firstLineRange("")).toEqual({ start: { line: 1, column: 1 }, end: { line: 1, column: 1 } });
    expect(lineRange(["a", "bcd"], 2)).toEqual({ start: { line: 2, column: 1 }, end: { line: 2, column: 4 } });
  });
});
