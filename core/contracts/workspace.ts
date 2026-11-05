// The workspace boundary, shared by every axis.
//
// A path is a location, not a trust level, but it is still a *boundary*: an agent pointed
// at a project must not wander into the rest of the machine because a model asked it to.
// Every tool that takes a path routes through this, in both products, so there is one
// answer to "is this inside the workspace?" and one place to fix it.
import { isAbsolute, relative, resolve } from "node:path";

/**
 * Resolve `path` inside `workspace`, or throw.
 *
 * Absolute paths are accepted only if they are already inside the root. `..` is caught
 * after resolution, which is the only reliable way to catch it: lexical checks on the
 * raw string miss `a/../../b` and symlink-shaped tricks alike.
 */
export function resolveInWorkspace(workspace: string, path: string): string {
  const root = resolve(workspace);
  const target = isAbsolute(path) ? resolve(path) : resolve(root, path);
  const rel = relative(root, target);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`path escapes the workspace: ${path}`);
  }
  return target;
}
