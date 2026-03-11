import { SandboxPackage } from '../types.js';

export class GoSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'go';

  installScript(): string {
    // Install Go from official binaries.
    // Reads go.mod for the required version, falls back to latest stable.
    // Uses the official dl.google.com archive for the exact version needed.
    return `
GO_VERSION=""
if [ -f /workspace/go.mod ]; then
  GO_VERSION=$(grep -oP '^go \\K[0-9]+\\.[0-9]+(\\.[0-9]+)?' /workspace/go.mod | head -1)
elif [ -f /workspace/src/go.mod ]; then
  GO_VERSION=$(grep -oP '^go \\K[0-9]+\\.[0-9]+(\\.[0-9]+)?' /workspace/src/go.mod | head -1)
fi

# If go.mod specifies a toolchain line, prefer that (more precise)
if [ -f /workspace/go.mod ]; then
  TC_VERSION=$(grep -oP '^toolchain go\\K[0-9]+\\.[0-9]+(\\.[0-9]+)?' /workspace/go.mod | head -1)
  [ -n "$TC_VERSION" ] && GO_VERSION="$TC_VERSION"
elif [ -f /workspace/src/go.mod ]; then
  TC_VERSION=$(grep -oP '^toolchain go\\K[0-9]+\\.[0-9]+(\\.[0-9]+)?' /workspace/src/go.mod | head -1)
  [ -n "$TC_VERSION" ] && GO_VERSION="$TC_VERSION"
fi

if [ -z "$GO_VERSION" ]; then
  # Fallback: fetch latest stable version
  GO_VERSION=$(curl -fsSL "https://go.dev/VERSION?m=text" 2>/dev/null | head -1 | sed 's/^go//')
fi

# Ensure 3-part version for download URL
case "$GO_VERSION" in
  *.*.*)  ;; # already 3-part
  *)
    # Try appending .0 — the archive may or may not need it
    GO_VERSION_DL="$GO_VERSION"
    ;;
esac
GO_VERSION_DL="\${GO_VERSION_DL:-$GO_VERSION}"

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  GOARCH="amd64" ;;
  aarch64) GOARCH="arm64" ;;
  *)       GOARCH="amd64" ;;
esac

echo "Installing Go $GO_VERSION_DL ($GOARCH)..."

# Remove any distro-packaged Go first
sudo apt-get remove -y golang-go 2>/dev/null || true
sudo rm -rf /usr/local/go

# Download and extract official binary
GO_URL="https://dl.google.com/go/go\${GO_VERSION_DL}.linux-\${GOARCH}.tar.gz"
if curl -fsSL "$GO_URL" -o /tmp/go.tar.gz 2>/dev/null; then
  sudo tar -C /usr/local -xzf /tmp/go.tar.gz
  rm -f /tmp/go.tar.gz
  echo "Go $GO_VERSION_DL installed to /usr/local/go"
else
  echo "Download failed for $GO_URL, trying without patch version..."
  # Strip patch version and try again (e.g., 1.24 instead of 1.24.1)
  GO_MAJOR_MINOR=$(echo "$GO_VERSION" | grep -oP '^[0-9]+\\.[0-9]+')
  GO_URL2="https://dl.google.com/go/go\${GO_MAJOR_MINOR}.0.linux-\${GOARCH}.tar.gz"
  if curl -fsSL "$GO_URL2" -o /tmp/go.tar.gz 2>/dev/null; then
    sudo tar -C /usr/local -xzf /tmp/go.tar.gz
    rm -f /tmp/go.tar.gz
    echo "Go \${GO_MAJOR_MINOR}.0 installed to /usr/local/go"
  else
    echo "Warning: could not download Go — falling back to apt"
    sudo apt-get install -y --no-install-recommends golang-go
  fi
fi
`;
  }

  initScript(): string {
    // Add Go to PATH and verify it works
    return `mkdir -p $HOME/go/bin
echo 'export PATH="/usr/local/go/bin:$HOME/go/bin:$PATH"' >> $HOME/.profile
echo 'export GOPATH="$HOME/go"' >> $HOME/.profile
source $HOME/.profile
# Verify go is accessible and version
if go version > /dev/null 2>&1; then
  echo "Go ready: $(go version)"
else
  echo "⚠ Warning: go binary is not accessible"
fi
# Pre-download modules if go.mod exists
if [ -f /workspace/go.mod ]; then
  cd /workspace && go mod download 2>/dev/null || true
elif [ -f /workspace/src/go.mod ]; then
  cd /workspace/src && go mod download 2>/dev/null || true
fi`;
  }
}
