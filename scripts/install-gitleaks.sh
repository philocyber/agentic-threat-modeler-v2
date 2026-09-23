#!/usr/bin/env sh
set -eu
version=8.30.1
destination=${1:?Usage: install-gitleaks.sh destination-directory}
case "$(uname -s)" in Linux) platform=linux ;; Darwin) platform=darwin ;; *) exit 1 ;; esac
case "$(uname -m)" in x86_64) arch=x64 ;; arm64|aarch64) arch=arm64 ;; *) exit 1 ;; esac
archive="gitleaks_${version}_${platform}_${arch}.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
base="https://github.com/gitleaks/gitleaks/releases/download/v${version}"
curl -fsSL "$base/$archive" -o "$work/$archive"
curl -fsSL "$base/gitleaks_${version}_checksums.txt" -o "$work/checksums.txt"
python3 - "$work" "$archive" <<'PY'
import hashlib, pathlib, sys
root, name = pathlib.Path(sys.argv[1]), sys.argv[2]
expected = next(line.split()[0] for line in (root/'checksums.txt').read_text().splitlines() if line.split()[-1] == name)
assert hashlib.sha256((root/name).read_bytes()).hexdigest() == expected, 'Checksum mismatch'
PY
mkdir -p "$destination"
tar -xzf "$work/$archive" -C "$destination" gitleaks
"$destination/gitleaks" version
