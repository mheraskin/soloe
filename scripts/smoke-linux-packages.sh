#!/usr/bin/env bash
set -euo pipefail

release_dir="${1:-release}"
mapfile -t appimages < <(find "$release_dir" -maxdepth 1 -type f -name 'Soloe-*-linux-x86_64.AppImage' -print)
mapfile -t debs < <(find "$release_dir" -maxdepth 1 -type f -name 'Soloe-*-linux-amd64.deb' -print)

if [[ ${#appimages[@]} -ne 1 ]]; then
  echo "Expected exactly one AppImage, found ${#appimages[@]}" >&2
  exit 1
fi

if [[ ${#debs[@]} -ne 1 ]]; then
  echo "Expected exactly one Debian package, found ${#debs[@]}" >&2
  exit 1
fi

appimage="$(realpath "${appimages[0]}")"
deb="$(realpath "${debs[0]}")"
package_name="$(dpkg-deb --field "$deb" Package)"
smoke_root="$(mktemp -d)"
installed_by_smoke=false
export XDG_CONFIG_HOME="$smoke_root/config"
export XDG_DATA_HOME="$smoke_root/data"
export XDG_CACHE_HOME="$smoke_root/cache"
mkdir -p "$XDG_CONFIG_HOME" "$XDG_DATA_HOME" "$XDG_CACHE_HOME"

package_is_installed() {
  dpkg-query --show --showformat='${Status}' "$package_name" 2>/dev/null \
    | grep --quiet --fixed-strings 'install ok installed'
}

assert_package_missing() {
  if package_is_installed; then
    echo "Expected package to be uninstalled: $package_name" >&2
    exit 1
  fi
}

cleanup() {
  if [[ "$installed_by_smoke" == true ]] && package_is_installed; then
    sudo apt-get remove -y "$package_name"
  fi
  rm -rf "$smoke_root"
}
trap cleanup EXIT

assert_stays_running() {
  local label="$1"
  shift
  local log="$smoke_root/$label.log"

  set +e
  xvfb-run -a timeout --kill-after=5s 10s "$@" >"$log" 2>&1
  local status=$?
  set -e

  if [[ $status -ne 124 ]]; then
    echo "$label exited before the smoke window with status $status" >&2
    cat "$log" >&2
    exit 1
  fi
}

assert_package_missing
sudo apt-get update
sudo apt-get install -y xvfb xauth

chmod +x "$appimage"
assert_stays_running appimage env APPIMAGE_EXTRACT_AND_RUN=1 \
  "$appimage" --disable-gpu --no-sandbox

installed_by_smoke=true
sudo apt-get install -y "$deb"
if ! package_is_installed; then
  echo "Debian package was not installed: $package_name" >&2
  exit 1
fi

installed_executable="$(command -v soloe)"
assert_stays_running deb "$installed_executable" --disable-gpu

sudo apt-get remove -y "$package_name"
installed_by_smoke=false
hash -r
assert_package_missing
if [[ -e "$installed_executable" ]]; then
  echo "Installed executable remains after uninstall: $installed_executable" >&2
  exit 1
fi

trap - EXIT
rm -rf "$smoke_root"
echo 'Linux package launch, install, and uninstall smoke test passed'
