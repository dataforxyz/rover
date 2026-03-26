import { SandboxPackage } from '../types.js';

export class UvSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'uv';

  installScript(): string {
    // Ensure uv is installed (may already be in base image)
    return `
if ! command -v uv &>/dev/null; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> $HOME/.profile
  source $HOME/.profile
fi
`;
  }

  initScript(): string {
    // Workspace dependency resolution is handled centrally so it can run
    // after user init scripts and repository materialization.
    return ``;
  }
}
