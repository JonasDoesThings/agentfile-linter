export interface Colors {
  red(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  underline(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\x1b[${open}m${s}\x1b[${close}m`;

const ansi: Colors = {
  red: wrap(31, 39),
  yellow: wrap(33, 39),
  cyan: wrap(36, 39),
  dim: wrap(2, 22),
  bold: wrap(1, 22),
  underline: wrap(4, 24),
};

const plain: Colors = {
  red: (s) => s,
  yellow: (s) => s,
  cyan: (s) => s,
  dim: (s) => s,
  bold: (s) => s,
  underline: (s) => s,
};

/** Honors NO_COLOR / FORCE_COLOR, otherwise colors only TTYs. */
export function shouldUseColor(stream: { isTTY?: boolean }): boolean {
  if (process.env.NO_COLOR) return false;
  const force = process.env.FORCE_COLOR;
  if (force !== undefined) return force !== "0" && force !== "false";
  return !!stream.isTTY;
}

export function getColors(enabled: boolean): Colors {
  return enabled ? ansi : plain;
}
