import { describe, expect, it } from 'vitest';
import {
  isLocalRepositoryReference,
  resolveLocalRepositoryReference,
  resolveRepositoryHostPath,
} from '../repository-reference.js';

describe('isLocalRepositoryReference', () => {
  it('treats absolute paths as local repositories', () => {
    expect(isLocalRepositoryReference('/tmp/frontend.git')).toBe(true);
    expect(isLocalRepositoryReference('/workspace/sources/frontend.git')).toBe(
      true
    );
  });

  it('treats file URLs as local repositories', () => {
    expect(
      isLocalRepositoryReference('file:///workspace/sources/frontend.git')
    ).toBe(true);
  });

  it('treats remote URLs and scp-like git remotes as remote repositories', () => {
    expect(
      isLocalRepositoryReference('https://github.com/endorhq/rover.git')
    ).toBe(false);
    expect(isLocalRepositoryReference('git@github.com:endorhq/rover.git')).toBe(
      false
    );
  });

  it('treats relative paths as local repositories', () => {
    expect(isLocalRepositoryReference('../repos/frontend.git')).toBe(true);
  });

  it('rejects empty repository references', () => {
    expect(isLocalRepositoryReference('')).toBe(false);
  });
});

describe('resolveRepositoryHostPath', () => {
  it('strips /workspace/ prefix and resolves relative to project root', () => {
    expect(
      resolveRepositoryHostPath(
        '/workspace/sources/backend.git',
        '/tmp/my-project'
      )
    ).toBe('/tmp/my-project/sources/backend.git');
  });

  it('resolves /workspace to project root', () => {
    expect(resolveRepositoryHostPath('/workspace', '/tmp/my-project')).toBe(
      '/tmp/my-project'
    );
  });

  it('resolves relative paths against project root', () => {
    expect(
      resolveRepositoryHostPath('./repos/frontend.git', '/tmp/my-project')
    ).toBe('/tmp/my-project/repos/frontend.git');
  });

  it('resolves non-workspace absolute paths as-is', () => {
    expect(
      resolveRepositoryHostPath('/opt/repos/frontend.git', '/tmp/my-project')
    ).toBe('/opt/repos/frontend.git');
  });
});

describe('resolveLocalRepositoryReference', () => {
  it('maps file URLs under /workspace back to the host project root', () => {
    expect(
      resolveLocalRepositoryReference(
        'file:///workspace/sources/backend.git',
        '/tmp/my-project'
      )
    ).toBe('/tmp/my-project/sources/backend.git');
  });
});
