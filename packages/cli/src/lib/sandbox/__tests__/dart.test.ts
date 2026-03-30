import { describe, expect, it } from 'vitest';
import { DartSandboxPackage } from '../languages/dart.js';

describe('DartSandboxPackage', () => {
  it('installs Linux desktop Flutter dependencies during setup', () => {
    const script = new DartSandboxPackage().installScript();

    expect(script).toContain(
      'sudo apt-get install -y -qq cmake clang ninja-build pkg-config libgtk-3-dev'
    );
    expect(script).toContain('sudo userdel systemd-network');
  });

  it('pre-caches Linux Flutter artifacts during init', () => {
    const script = new DartSandboxPackage().initScript();

    expect(script).toContain('flutter precache');
    expect(script).toContain('--no-web');
  });

  it('scans child project .fvmrc files when selecting Flutter versions', () => {
    const script = new DartSandboxPackage(['apps/mobile']).installScript();

    expect(script).toContain(
      "for fvmrc_path in '/workspace/.fvmrc' '/workspace/apps/mobile/.fvmrc'; do"
    );
    expect(script).toContain('Using Flutter version from $fvmrc_path');
  });
});
