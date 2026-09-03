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
 * Scanne les répertoires disponibles sous defaultWorkspace et projectsRoot
 * pour alimenter la sélection interactive du workspace via Telegram.
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
        // Ignore les dossiers cachés, node_modules, tmp, dist, etc.
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
      // Ignore les erreurs de lecture de répertoire pour la résilience
    }
  };

  // 1. Scanner les sous-dossiers du workspace par défaut (ex: /home/med/projets/*)
  scanDir(defaultWorkspace, true);
  // 2. Scanner les sous-dossiers de la racine des projets si distincte (ex: /home/med/*)
  if (projectsRoot !== defaultWorkspace) {
    scanDir(projectsRoot, false);
  }

  // Trier par ordre alphabétique
  return result.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Valide et résout en toute sécurité un chemin saisi par l'utilisateur.
 * Prend en charge les chemins absolus directs, les chemins avec slash initial (/projets/scripts ou /scripts)
 * ainsi que les noms relatifs directs (scripts).
 * Vérifie rigoureusement le confinement dans projectsRoot ou defaultWorkspace.
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

  // Liste ordonnée de candidats à tester
  const candidates: string[] = [];

  // 1. Si le chemin est absolu et existe directement sur le système de fichiers (ex: /home/med/projets/scripts)
  if (path.isAbsolute(trimmed) && fs.existsSync(trimmed)) {
    candidates.push(path.resolve(trimmed));
  }

  // 2. Si le chemin commence par '/', tester sans les slashs initiaux
  // Ex: "/projets/scripts" ou "/scripts"
  const strippedLeading = trimmed.replace(/^\/+/, "");
  if (strippedLeading) {
    // Relativement au workspace par défaut (ex: /home/med/projets + scripts)
    candidates.push(path.resolve(defaultWorkspace, strippedLeading));
    // Relativement à projectsRoot (ex: /home/med + projets/scripts)
    candidates.push(path.resolve(projectsRoot, strippedLeading));
  }

  // 3. Tester relativement au workspace par défaut (ex: "scripts" dans /home/med/projets)
  candidates.push(path.resolve(defaultWorkspace, trimmed));

  // 4. Tester relativement à projectsRoot (ex: "projets/scripts" dans /home/med)
  candidates.push(path.resolve(projectsRoot, trimmed));

  // 5. Fallback sur le chemin absolu s'il avait été fourni ainsi
  if (path.isAbsolute(trimmed)) {
    candidates.push(path.resolve(trimmed));
  }

  // Sélection du premier candidat existant sur le disque
  let chosenCandidate: string | null = null;
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      chosenCandidate = c;
      break;
    }
  }

  // Si aucun n'existe, on conserve le candidat le plus logique pour le message d'erreur
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

  // Le chemin résolu doit impérativement se situer dans realProjectsRoot OU realDefaultWorkspace
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
