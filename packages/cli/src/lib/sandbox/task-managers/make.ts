import { SandboxPackage } from '../types.js';

export class MakeSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'make';

  installScript(): string {
    // Install GNU Make only if not already present (avoids triggering
    // broken dpkg postinst scripts that can hijack the container UID)
    return `command -v make >/dev/null 2>&1 && echo "make is already installed" || sudo apt-get install -y --no-install-recommends make`;
  }

  initScript(): string {
    // make is installed system-wide, no user configuration needed
    return ``;
  }
}
