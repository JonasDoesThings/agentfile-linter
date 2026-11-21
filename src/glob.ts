import { Minimatch } from "minimatch";

/** Compiled glob for matching POSIX paths, including dotfiles. */
export class Glob extends Minimatch {
  constructor(pattern: string) {
    super(pattern, {
      dot: true,
      nocomment: true,
      // A leading extglob is different from negating the entire pattern.
      nonegate: pattern.startsWith("!("),
      platform: "linux",
      preserveMultipleSlashes: true,
    });
  }
}
