import { SandboxPackage } from '../types.js';

export class DartSandboxPackage extends SandboxPackage {
  // Name of the package
  name = 'dart';

  installScript(): string {
    // Install Flutter SDK (includes Dart SDK) and Linux desktop build deps.
    // Reads .fvmrc for project-pinned version, falls back to stable.
    // Uses pre-built SDK archive for speed instead of cloning the git repo.
    return `
# Linux desktop build toolchain (required for flutter test integration_test/)
sudo apt-get update -qq && sudo apt-get install -y -qq cmake clang ninja-build pkg-config libgtk-3-dev 2>/dev/null || true

FLUTTER_VERSION="stable"
if [ -f /workspace/.fvmrc ]; then
  FVM_VER=$(cat /workspace/.fvmrc | grep -oP '"flutter"\\s*:\\s*"\\K[^"]+' 2>/dev/null || cat /workspace/.fvmrc | tr -d '{}\" ' | grep -oP 'flutter:\\K[^,]+' 2>/dev/null)
  if [ -n "$FVM_VER" ]; then
    FLUTTER_VERSION="$FVM_VER"
    echo "Using Flutter version from .fvmrc: $FLUTTER_VERSION"
  fi
fi
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) FLUTTER_ARCH="x64" ;;
  aarch64) FLUTTER_ARCH="arm64" ;;
  *) FLUTTER_ARCH="x64" ;;
esac
FLUTTER_URL="https://storage.googleapis.com/flutter_infra_release/releases/stable/linux/flutter_linux_\${FLUTTER_VERSION}-stable.tar.xz"
echo "Downloading Flutter SDK from $FLUTTER_URL ..."
if curl -fsSL "$FLUTTER_URL" -o /tmp/flutter.tar.xz 2>/dev/null; then
  rm -rf $HOME/.flutter
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
