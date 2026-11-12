#!/usr/bin/env bash
set -euo pipefail
# Run inside archlinux:base-devel with the repository mounted at /work.
pacman -Syu --noconfirm --needed libarchive python webkit2gtk-4.1 gtk3 openssl hicolor-icon-theme
useradd --create-home builder
chown -R builder:builder /work/dist/arch
cd /work/dist/arch
runuser -u builder -- makepkg --printsrcinfo > .SRCINFO
runuser -u builder -- makepkg --noconfirm --cleanbuild --force
mkdir -p release
cp ./*.pkg.tar.zst release/
tar -czf "release/theprivator-arch-recipe-${RELEASE_TAG}.tar.gz" PKGBUILD .SRCINFO LICENSE
mkdir -p verify
bsdtar -xf ./*.pkg.tar.zst -C verify
test -x verify/usr/bin/theprivator
test -x verify/usr/bin/theprivator-sidecar
if ldd verify/usr/bin/theprivator | grep -q 'not found'; then
    echo 'Arch package has unresolved runtime libraries.' >&2
    exit 1
fi
python /work/scripts/release/verify-arch.py verify/usr/bin/theprivator-sidecar
