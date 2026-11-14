import { isAbsolute, relative } from "node:path";

/**
 * True when `candidate` is inside `root`. Both paths must already be canonical (realpath).
 * `allowEqual` states explicitly whether `root` itself counts as inside.
 */
export function isPathWithin(root: string, candidate: string, options: { allowEqual: boolean }): boolean {
  const nested = relative(root, candidate);
  if (nested === "") return options.allowEqual;
  return nested !== ".." && !nested.startsWith("../") && !nested.startsWith("..\\") && !isAbsolute(nested);
}
