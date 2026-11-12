#!/usr/bin/env bash
set -euo pipefail
: "${AUR_SSH_PRIVATE_KEY:?Set the AUR publishing SSH key in repository secrets}"
: "${AUR_KNOWN_HOSTS:?Set the verified aur.archlinux.org SSH host key in repository variables}"
recipe=$(realpath "$1")
temporary=$(mktemp -d)
trap 'rm -rf "$temporary"' EXIT
umask 077
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "$temporary/key"
printf '%s\n' "$AUR_KNOWN_HOSTS" > "$temporary/known_hosts"
export GIT_SSH_COMMAND="ssh -i $temporary/key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=$temporary/known_hosts"
git clone ssh://aur@aur.archlinux.org/theprivator-bin.git "$temporary/aur"
previous=''
if [ -f "$temporary/aur/.SRCINFO" ]; then
    previous=$(sed -n 's/^[[:space:]]*pkgver = //p' "$temporary/aur/.SRCINFO")
fi
tar -xzf "$recipe" -C "$temporary/aur" PKGBUILD .SRCINFO LICENSE
cd "$temporary/aur"
grep -qx 'pkgbase = theprivator-bin' .SRCINFO
incoming=$(sed -n 's/^[[:space:]]*pkgver = //p' .SRCINFO)
test "$incoming" = "${RELEASE_TAG#v}"
# Jobs may finish out of order, even though pushes are serialized.
if [ -n "$previous" ] && [ "$(printf '%s\n' "$previous" "$incoming" | sort -V | tail -n 1)" != "$incoming" ]; then
    echo "AUR already has newer version $previous; skipping $incoming."
    exit 0
fi
git config user.name 'ThePrivator release bot'
git config user.email 'yanx9@users.noreply.github.com'
git add PKGBUILD .SRCINFO LICENSE
if git diff --cached --quiet; then
    echo 'AUR recipe is already current.'
    exit 0
fi
git commit -m "Update theprivator-bin to ${RELEASE_TAG}"
git push origin HEAD:master
