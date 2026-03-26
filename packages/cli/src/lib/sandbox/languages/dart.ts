import { SandboxPackage } from '../types.js';

export class DartSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'dart';

  installScript(): string {
    // Install Flutter SDK (includes Dart SDK) and Linux desktop build deps.
    // Reads .fvmrc for project-pinned version, falls back to stable.
    // Uses the git repo for the channel name and the archive for pinned versions.
    return `
# Linux desktop build toolchain (required for flutter test integration_test/)
sudo apt-get update -qq && sudo apt-get install -y -qq cmake clang ninja-build pkg-config libgtk-3-dev 2>/dev/null || true
# systemd postinst creates systemd-network (UID 998) which can conflict
# with the container runtime user. Remove it to avoid HOME resolution issues.
if getent passwd systemd-network >/dev/null 2>&1; then
  sudo userdel systemd-network 2>/dev/null || sudo sed -i '/^systemd-network:/d' /etc/passwd
fi
if getent group systemd-network >/dev/null 2>&1; then
  sudo groupdel systemd-network 2>/dev/null || sudo sed -i '/^systemd-network:/d' /etc/group
fi

FLUTTER_VERSION="stable"
if [ -f /workspace/.fvmrc ]; then
  FVM_VER=$(cat /workspace/.fvmrc | grep -oP '"flutter"\\s*:\\s*"\\K[^"]+' 2>/dev/null || cat /workspace/.fvmrc | tr -d '{}\" ' | grep -oP 'flutter:\\K[^,]+' 2>/dev/null)
  if [ -n "$FVM_VER" ]; then
    # Validate version looks like a semver string or channel name to prevent injection
    if echo "$FVM_VER" | grep -qP '^[0-9]+\\.[0-9]+\\.[0-9]+([._-].*)?$' || echo "$FVM_VER" | grep -qP '^(stable|beta|master|dev)$'; then
      FLUTTER_VERSION="$FVM_VER"
      echo "Using Flutter version from .fvmrc: $FLUTTER_VERSION"
    else
      echo "Warning: Invalid Flutter version in .fvmrc ($FVM_VER), using stable"
    fi
  fi
fi
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) FLUTTER_ARCH="x64" ;;
  aarch64) FLUTTER_ARCH="arm64" ;;
  *) FLUTTER_ARCH="x64" ;;
esac

rm -rf $HOME/.flutter
if [ "$FLUTTER_VERSION" = "stable" ]; then
  echo "Resolving latest Flutter stable archive..."
  RELEASES_JSON=$(curl -fsSL "https://storage.googleapis.com/flutter_infra_release/releases/releases_linux.json" 2>/dev/null || true)
  if [ -n "$RELEASES_JSON" ]; then
    # Try python3 first (most reliable JSON parsing), fall back to grep-based extraction.
    # python3 may not be available yet if dart is the first language being installed.
    FLUTTER_VERSION=$(echo "$RELEASES_JSON" | python3 -c "
import json, sys
meta = json.load(sys.stdin)
h = meta['current_release']['stable']
print(next(r['version'] for r in meta['releases'] if r.get('hash') == h))
" 2>/dev/null) || \
    FLUTTER_VERSION=$(echo "$RELEASES_JSON" | grep -oP '"version"\\s*:\\s*"\\K[0-9]+\\.[0-9]+\\.[0-9]+' 2>/dev/null | head -1) || \
    FLUTTER_VERSION="stable"
  fi
fi

FLUTTER_URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_\${FLUTTER_VERSION}-stable.tar.xz"
echo "Downloading Flutter SDK from $FLUTTER_URL ..."
if curl -fsSL "$FLUTTER_URL" -o /tmp/flutter.tar.xz 2>/dev/null; then
  tar xf /tmp/flutter.tar.xz -C $HOME --strip-components=0
  mv $HOME/flutter $HOME/.flutter
  rm -f /tmp/flutter.tar.xz
else
  echo "Archive download failed, falling back to git clone..."
  git clone --depth 1 --branch "$FLUTTER_VERSION" https://github.com/flutter/flutter.git $HOME/.flutter 2>/dev/null || \
  git clone --depth 1 --branch stable https://github.com/flutter/flutter.git $HOME/.flutter
fi
`;
  }

  initScript(): string {
    // Add Flutter and Dart to PATH, run precache for linux desktop only,
    // and pre-resolve project dependencies.
    // Also reconcile Flutter version: the cache image may have been built
    // without /workspace mounted, so .fvmrc was unavailable during install.
    return `echo 'export PATH="$HOME/.flutter/bin:$HOME/.flutter/bin/cache/dart-sdk/bin:$HOME/.pub-cache/bin:$PATH"' >> $HOME/.profile
echo 'export FLUTTER_GIT_URL=""' >> $HOME/.profile
echo 'export PUB_CACHE="$HOME/.pub-cache"' >> $HOME/.profile
source $HOME/.profile

# Reconcile Flutter version: cache may have been built without .fvmrc
if [ -f /workspace/.fvmrc ]; then
  WANT_VER=$(cat /workspace/.fvmrc | grep -oP '"flutter"\\s*:\\s*"\\K[^"]+' 2>/dev/null || cat /workspace/.fvmrc | tr -d '{}\" ' | grep -oP 'flutter:\\K[^,]+' 2>/dev/null)
  # Validate version before using it
  if [ -n "$WANT_VER" ] && ! (echo "$WANT_VER" | grep -qP '^[0-9]+\\.[0-9]+\\.[0-9]+([._-].*)?$' || echo "$WANT_VER" | grep -qP '^(stable|beta|master|dev)$'); then
    echo "Warning: Invalid Flutter version in .fvmrc ($WANT_VER), skipping reconciliation"
    WANT_VER=""
  fi
  if [ -n "$WANT_VER" ]; then
    HAVE_VER=$($HOME/.flutter/bin/flutter --version --machine 2>/dev/null | grep -oP '"frameworkVersion"\\s*:\\s*"\\K[^"]+' 2>/dev/null || echo "")
    if [ "$HAVE_VER" != "$WANT_VER" ]; then
      echo "Flutter version mismatch: have=$HAVE_VER want=$WANT_VER — upgrading..."
      ARCH=$(uname -m)
      case "$ARCH" in
        x86_64) FLUTTER_ARCH="x64" ;;
        aarch64) FLUTTER_ARCH="arm64" ;;
        *) FLUTTER_ARCH="x64" ;;
      esac
      FLUTTER_URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_\${WANT_VER}-stable.tar.xz"
      if curl -fsSL "$FLUTTER_URL" -o /tmp/flutter.tar.xz 2>/dev/null; then
        rm -rf $HOME/.flutter
        tar xf /tmp/flutter.tar.xz -C $HOME --strip-components=0
        mv $HOME/flutter $HOME/.flutter
        rm -f /tmp/flutter.tar.xz
        echo "Flutter upgraded to $WANT_VER"
      else
        echo "Archive download failed, trying git..."
        rm -rf $HOME/.flutter
        git clone --depth 1 --branch "$WANT_VER" https://github.com/flutter/flutter.git $HOME/.flutter 2>/dev/null || true
      fi
      source $HOME/.profile
    fi
  fi
fi

flutter precache --no-ios --no-macos --no-windows --no-fuchsia --no-universal-apk --no-web 2>/dev/null || true
if [ -f /workspace/pubspec.yaml ]; then
  cd /workspace && flutter pub get 2>/dev/null || true
fi`;
  }
}
