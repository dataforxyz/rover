import { describe, expect, it } from 'vitest';
import { UvSandboxPackage } from '../package-managers/uv.js';
import { GoSandboxPackage } from '../languages/go.js';
import { DartSandboxPackage } from '../languages/dart.js';

describe('sandbox dependency init scripts', () => {
  it('does not resolve uv workspace dependencies in the uv package init script', () => {
    const script = new UvSandboxPackage().initScript();

    expect(script).not.toContain('uv sync');
    expect(script).not.toContain('/workspace/.venv/bin');
  });

  it('does not resolve Go workspace dependencies in the Go language init script', () => {
    const script = new GoSandboxPackage().initScript();

    expect(script).toContain('export GOPATH="$HOME/go"');
    expect(script).not.toContain('go mod download');
  });

  it('does not resolve Flutter workspace dependencies in the Dart language init script', () => {
    const script = new DartSandboxPackage().initScript();

    expect(script).toContain('flutter precache');
    expect(script).not.toContain('flutter pub get');
  });

  it('scans child project go.mod files before falling back to latest Go', () => {
    const script = new GoSandboxPackage(['services/api']).installScript();

    expect(script).toContain(
      "for go_mod_path in '/workspace/go.mod' '/workspace/src/go.mod' '/workspace/services/api/go.mod' '/workspace/services/api/src/go.mod'; do"
    );
    expect(script).toContain('TC_VERSION=$(grep -oP');
  });
});
