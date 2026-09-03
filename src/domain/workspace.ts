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

export interface AvailableWorkspace {
  name: string;
  path: string;
  isDefault: boolean;
}

/**
 * Scans available directories under defaultWorkspace and projectsRoot
 * to populate interactive Telegram workspace selection.
 */
export function listAvailableWorkspaces(
  projectsRoot: string,
  defaultWorkspace: string
): AvailableWorkspace[] {
  const result: AvailableWorkspace[] = [];
  const seenPaths = new Set<string>();

  const scanDir = (parentDir: string, isDefaultParent: boolean) => {
    try {
      if (!fs.existsSync(parentDir)) return;
      const realParent = fs.realpathSync(parentDir);
      const entries = fs.readdirSync(realParent, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const name = entry.name;
        // Ignore hidden folders, node_modules, tmp, dist, etc.
        if (name.startsWith(".") || name === "node_modules" || name === "tmp" || name === "dist") {
          continue;
        }
        const fullPath = path.join(realParent, name);
        let realPath: string;
        try {
          realPath = fs.realpathSync(fullPath);
        } catch {
          continue;
        }
        if (!seenPaths.has(realPath)) {
          seenPaths.add(realPath);
          result.push({
            name,
            path: realPath,
            isDefault: isDefaultParent && realPath === defaultWorkspace,
          });
        }
      }
    } catch {
      // Ignore directory read errors for resilience
    }
  };

  // 1. Scan subdirectories of default workspace (e.g. /home/user/projects/*)
  scanDir(defaultWorkspace, true);
  // 2. Scan subdirectories of projects root if distinct (e.g. /home/user/*)
  if (projectsRoot !== defaultWorkspace) {
    scanDir(projectsRoot, false);
  }

  // Sort alphabetically by name
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Safely validates and resolves a user-provided workspace path.
 * Supports direct absolute paths, paths with leading slashes (/projects/scripts or /scripts),
 * and direct relative project names (scripts).
 * Strictly enforces boundary containment within projectsRoot or defaultWorkspace.
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

  // Ordered candidate list to test
  const candidates: string[] = [];

  // 1. If path is absolute and exists directly on disk (e.g. /home/user/projects/scripts)
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    candidates.push(path.resolve(trimmed));
  }

  // 2. If path starts with '/', test without leading slashes
  // E.g. "/projects/scripts" or "/scripts"
  const strippedLeading = trimmed.replace(/^\/+/, "");
  if (strippedLeading) {
    // Relative to default workspace (e.g. /home/user/projects + scripts)
    candidates.push(path.resolve(defaultWorkspace, strippedLeading));
    // Relative to projectsRoot (e.g. /home/user + projects/scripts)
    candidates.push(path.resolve(projectsRoot, strippedLeading));
  }

  // 3. Test relative to default workspace (e.g. "scripts" in /home/user/projects)
  candidates.push(path.resolve(defaultWorkspace, trimmed));

  // 4. Test relative to projectsRoot (e.g. "projects/scripts" in /home/user)
  candidates.push(path.resolve(projectsRoot, trimmed));

  // 5. Fallback to absolute path if provided as such
  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  }

  // Select first existing candidate on disk
  let chosenCandidate: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      chosenCandidate = c;
      break;
    }
  }

  // If none exists, keep the most logical candidate for error reporting
  const candidate = chosenCandidate || (path.isAbsolute(trimmed) ? path.resolve(trimmed) : path.resolve(projectsRoot, trimmed));

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

  // Resolved path must strictly reside within realProjectsRoot OR realDefaultWorkspace
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
