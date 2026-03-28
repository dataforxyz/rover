import { isAbsolute } from 'node:path';

const REMOTE_URI_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;
const SCP_LIKE_GIT_REMOTE = /^(?:[^@/:\s]+@)?[^/:\s]+:.+$/;

export function isLocalRepositoryReference(repository: string): boolean {
  if (repository.startsWith('file://')) {
    return true;
  }

  if (isAbsolute(repository)) {
    return !repository.startsWith('/workspace/');
  }

  if (repository.length === 0) {
    return false;
  }

  return (
    !REMOTE_URI_SCHEME.test(repository) && !SCP_LIKE_GIT_REMOTE.test(repository)
  );
}
