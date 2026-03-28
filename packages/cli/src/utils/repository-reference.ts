import { isAbsolute, resolve } from 'node:path';

const REMOTE_URI_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const SCP_LIKE_GIT_REMOTE = /^(?:[^@/:\s]+@)?[^/:\s]+:.+$/;

export function isLocalRepositoryReference(repository: string): boolean {
  if (repository.startsWith('file://')) {
    return true;
  }

  if (isAbsolute(repository)) {
    return true;
  }

  if (repository.length === 0) {
    return false;
  }

  return (
    !REMOTE_URI_SCHEME.test(repository) && !SCP_LIKE_GIT_REMOTE.test(repository)
  );
}

/**
 * Resolve a repository path that may use the container `/workspace/` prefix
 * to the corresponding host path.
 *
 * Container configs often reference `/workspace/sources/foo.git` which maps
 * to `<projectRoot>/sources/foo.git` on the host.
 */
export function resolveRepositoryHostPath(
  repository: string,
  projectRoot: string
): string {
  if (repository.startsWith('/workspace/')) {
    return resolve(projectRoot, repository.slice('/workspace/'.length));
  }
  if (repository === '/workspace') {
    return projectRoot;
  }
  return resolve(projectRoot, repository);
}
