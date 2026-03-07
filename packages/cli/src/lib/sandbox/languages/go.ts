import { SandboxPackage } from '../types.js';

export class GoSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'go';

  installScript(): string {
    return `
GO_VERSION=\$(grep -m1 '^go ' /workspace/go.work /workspace/go.mod 2>/dev/null | head -1 | awk '{print $2}')
GO_VERSION=\${GO_VERSION:-1.24.1}
curl -fsSL "https://go.dev/dl/go\${GO_VERSION}.linux-amd64.tar.gz" | sudo tar -C /usr/local -xzf -
sudo ln -sf /usr/local/go/bin/go /usr/bin/go
sudo ln -sf /usr/local/go/bin/gofmt /usr/bin/gofmt`;
  }

  initScript(): string {
    // Add the go env to the profile
    return `mkdir -p $HOME/go/bin
echo 'export PATH="$HOME/go/bin:$PATH"' >> $HOME/.profile
echo 'export GOPATH="$HOME/go"' >> $HOME/.profile
source $HOME/.profile
# Verify go is accessible
if ! go version > /dev/null 2>&1; then
  echo "⚠ Warning: go binary is not accessible, attempting to fix permissions"
  GO_PATH=$(which go 2>/dev/null || echo "")
  if [ -n "$GO_PATH" ]; then
    sudo chmod +x "$GO_PATH" 2>/dev/null || true
  fi
fi`;
  }
}
