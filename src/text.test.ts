import { describe, expect, test } from "bun:test";

import { characterOffsets, firstLineRange, lineRange, splitLines } from "./text.ts";

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

const characters = (text: string) => [...characterOffsets(text)].length;

describe("characterOffsets", () => {
  test("counts characters as displayed", () => {
    expect(characters("abc")).toBe(3);
    // Precomposed and decomposed `é`, CJK, emoji with a skin tone modifier, a flag, a ZWJ sequence.
    expect(characters("\u00e9e\u0301日👍🏽🇦🇹👨‍👩‍👧")).toBe(6);
    // CRLF is one line break.
    expect(characters("a\r\nb\nc")).toBe(5);
    expect(characters("")).toBe(0);
  });

  test("yields UTF-16 offsets and skips a byte order mark", () => {
    expect([...characterOffsets("a👍🏽\r\nb")]).toEqual([0, 1, 5, 7]);
    expect([...characterOffsets("\uFEFFab")]).toEqual([1, 2]);
  });
});
