import path from "node:path";
import fs from "node:fs";

/**
 * Checks whether `targetPath` is strictly contained within `parentPath` (or equals `parentPath`).
 * Prevents directory traversal attacks (`../`).
 */
export function isWithin(targetPath: string, parentPath: string): boolean {
  const rel = path.relative(parentPath, targetPath);
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

export interface WorkspaceResolutionResult {
  valid: boolean;
  resolvedPath?: string;
  error?: string;
}

/**
 * Validates and safely resolves an input path against an authorized projects root and default workspace.
 * Resolves symlinks to ensure no traversal bypass.
 */
export function resolveWorkspacePath(
  input: string,
  projectsRoot: string,
  defaultWorkspace: string
): WorkspaceResolutionResult {
  const trimmed = input.trim();
  if (!trimmed) {
    return { valid: false, error: "Please specify a project name or directory path." };
  }

  // If input is absolute, use it; otherwise resolve relative to projectsRoot
  const candidate = path.isAbsolute(trimmed)
    ? path.resolve(trimmed)
    : path.resolve(projectsRoot, trimmed);

  if (!fs.existsSync(candidate)) {
    return { valid: false, error: `Directory not found: <code>${candidate}</code>` };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(candidate);
  } catch (err) {
    return { valid: false, error: `Cannot access path: ${(err as Error).message}` };
  }

  if (!stat.isDirectory()) {
    return { valid: false, error: `Path is not a directory: <code>${candidate}</code>` };
  }

  let realCandidate: string;
  let realProjectsRoot: string;
  let realDefaultWorkspace: string;
  try {
    realCandidate = fs.realpathSync(candidate);
    realProjectsRoot = fs.existsSync(projectsRoot) ? fs.realpathSync(projectsRoot) : path.resolve(projectsRoot);
    realDefaultWorkspace = fs.existsSync(defaultWorkspace) ? fs.realpathSync(defaultWorkspace) : path.resolve(defaultWorkspace);
  } catch (err) {
    return { valid: false, error: `Path resolution failure: ${(err as Error).message}` };
  }

  // The resolved path must be within projectsRoot OR defaultWorkspace
  const inProjects = isWithin(realCandidate, realProjectsRoot);
  const inDefault = isWithin(realCandidate, realDefaultWorkspace);

  if (!inProjects && !inDefault) {
    return {
      valid: false,
      error: `Security boundary violation: target directory must reside within <code>${projectsRoot}</code>`,
    };
  }

  return { valid: true, resolvedPath: realCandidate };
}
