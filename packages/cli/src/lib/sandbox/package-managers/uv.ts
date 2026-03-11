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
    // Sync project dependencies if pyproject.toml exists (--all-extras for dev deps)
    // Also add venv to PATH so python/pytest work without "uv run" prefix
    return `
source $HOME/.profile
if [ -f /workspace/uv.lock ] && [ -f /workspace/pyproject.toml ]; then
  cd /workspace && uv sync --frozen --all-extras 2>/dev/null || uv sync --all-extras 2>/dev/null || true
elif [ -f /workspace/pyproject.toml ]; then
  cd /workspace && uv sync --all-extras 2>/dev/null || true
fi
if [ -d /workspace/.venv/bin ]; then
  echo 'export PATH="/workspace/.venv/bin:$PATH"' >> $HOME/.profile
  source $HOME/.profile
fi
`;
  }
}
