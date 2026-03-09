import { realpathSync } from 'node:fs';
import path from 'node:path';

type PathApi = Pick<
  typeof path,
  'resolve' | 'relative' | 'isAbsolute' | 'dirname'
>;

export const resolvePathWithinRoot = (
  rootPath: string,
  filePath: string,
  pathApi: PathApi = path
): string | null => {
  const resolvedRoot = pathApi.resolve(rootPath);
  const resolvedPath = pathApi.resolve(resolvedRoot, filePath);
  const relativePath = pathApi.relative(resolvedRoot, resolvedPath);

  if (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !pathApi.isAbsolute(relativePath))
  ) {
    // Additionally resolve symlinks to prevent symlink-based traversal.
    try {
      const realRoot = realpathSync(resolvedRoot);
      const realPath = realpathSync(resolvedPath);
      const realRelative = pathApi.relative(realRoot, realPath);
      if (
        realRelative !== '' &&
        (realRelative.startsWith('..') || pathApi.isAbsolute(realRelative))
      ) {
        return null;
      }
    } catch {
      // File doesn't exist yet — resolve the parent directory to catch
      // symlinked parent directories that point outside the root.
      try {
        const realRoot = realpathSync(resolvedRoot);
        const realParent = realpathSync(pathApi.dirname(resolvedPath));
        const parentRelative = pathApi.relative(realRoot, realParent);
        if (
          parentRelative.startsWith('..') ||
          pathApi.isAbsolute(parentRelative)
        ) {
          return null;
        }
      } catch {
        // Parent doesn't exist either — textual check is sufficient
      }
    }
    return resolvedPath;
  }

  return null;
};
