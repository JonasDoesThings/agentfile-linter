import { type ParseError, getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";

export function parseJsonc(text: string): unknown {
  const errors: ParseError[] = [];
  const tree = parseTree(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  const error = errors[0];
  if (error) throw new SyntaxError(`${printParseErrorCode(error.error)} at offset ${error.offset}`);
  return tree ? getNodeValue(tree) : undefined;
}
