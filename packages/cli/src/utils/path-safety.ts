import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';

type PathApi = Pick<
  typeof path,
  'resolve' | 'relative' | 'isAbsolute' | 'dirname'
>;

export const isSafeRelativePath = (
  relativePath: string,
  pathApi: Pick<typeof path, 'isAbsolute'> = path
): boolean => {
  if (relativePath.length === 0 || pathApi.isAbsolute(relativePath)) {
    return false;
  }

  const segments = relativePath
    .split(/[\\/]+/)
    .filter(segment => segment.length > 0);

  return segments.length > 0 && segments.every(segment => segment !== '..');
};

const findNearestExistingPath = (
  candidatePath: string,
  pathApi: Pick<typeof path, 'dirname'> = path
): string | null => {
  let current = candidatePath;

  while (!existsSync(current)) {
    const parent = pathApi.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }

  return current;
};

export const resolvePathWithinRoot = (
  rootPath: string,
  filePath: string,
  pathApi: PathApi = path
): string | null => {
  if (!isSafeRelativePath(filePath, pathApi)) {
    return null;
  }

  const resolvedRoot = pathApi.resolve(rootPath);
  const resolvedPath = pathApi.resolve(resolvedRoot, filePath);
  const relativePath = pathApi.relative(resolvedRoot, resolvedPath);

  if (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath)) {
    // Resolve the nearest existing ancestor to catch symlink escapes even
    // when the target path itself does not exist yet.
    try {
      const realRoot = realpathSync(resolvedRoot);
      const existingPath = findNearestExistingPath(resolvedPath, pathApi);
      if (existingPath) {
        const realPath = realpathSync(existingPath);
        const realRelative = pathApi.relative(realRoot, realPath);
        if (realRelative.startsWith('..') || pathApi.isAbsolute(realRelative)) {
          return null;
        }
      }
    } catch {
      // Root or ancestors may not exist yet (for example in unit tests or
      // before a workspace path is materialized). In that case, rely on the
      // lexical containment check above.
    }
    return resolvedPath;
  }

  return null;
};
