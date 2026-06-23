#!/usr/bin/env bash
#
# setup-fpcalc.sh — descarga el binario standalone de fpcalc (Chromaprint) para
# la plataforma actual y lo coloca en src-tauri/resources/bin/.
#
# Necesario porque fpcalc está .gitignore-ado (binario platform-specific, no
# viaja por git). Sin él, el bundle de Tauri falla con:
#   "glob pattern resources/bin/* path not found or didn't match any files."
#
# Uso:  bash tools/setup-fpcalc.sh   (o  pnpm setup:fpcalc)
#
# Chromaprint solo publica builds x86_64. En Apple Silicon corre bajo Rosetta 2.

set -euo pipefail

VERSION="1.5.1"
BASE="https://github.com/acoustid/chromaprint/releases/download/v${VERSION}"

# Raíz del repo = un nivel arriba de este script (sirva desde donde sirva).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${REPO_ROOT}/src-tauri/resources/bin"

UNAME_S="$(uname -s)"

case "${UNAME_S}" in
  Darwin)
    ASSET="chromaprint-fpcalc-${VERSION}-macos-x86_64.tar.gz"
    BIN_IN_ARCHIVE="chromaprint-fpcalc-${VERSION}-macos-x86_64/fpcalc"
    OUT_NAME="fpcalc"
    KIND="targz"
    ;;
  Linux)
    ASSET="chromaprint-fpcalc-${VERSION}-linux-x86_64.tar.gz"
    BIN_IN_ARCHIVE="chromaprint-fpcalc-${VERSION}-linux-x86_64/fpcalc"
    OUT_NAME="fpcalc"
    KIND="targz"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    ASSET="chromaprint-fpcalc-${VERSION}-windows-x86_64.zip"
    BIN_IN_ARCHIVE="chromaprint-fpcalc-${VERSION}-windows-x86_64/fpcalc.exe"
    OUT_NAME="fpcalc.exe"
    KIND="zip"
    ;;
  *)
    echo "ERROR: plataforma no soportada: ${UNAME_S}" >&2
    echo "Descargá fpcalc ${VERSION} a mano de ${BASE} y ponelo en ${DEST_DIR}/" >&2
    exit 1
    ;;
esac

OUT_PATH="${DEST_DIR}/${OUT_NAME}"

if [ -x "${OUT_PATH}" ] && "${OUT_PATH}" -version >/dev/null 2>&1; then
  echo "fpcalc ya presente y funcional en ${OUT_PATH} — nada que hacer."
  exit 0
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "Descargando ${ASSET}…"
curl -fSL -o "${TMP_DIR}/${ASSET}" "${BASE}/${ASSET}"

echo "Extrayendo…"
if [ "${KIND}" = "targz" ]; then
  tar xzf "${TMP_DIR}/${ASSET}" -C "${TMP_DIR}"
else
  unzip -q "${TMP_DIR}/${ASSET}" -d "${TMP_DIR}"
fi

mkdir -p "${DEST_DIR}"
# Sobrescribir aunque exista un binario read-only de un intento previo.
chmod u+w "${OUT_PATH}" 2>/dev/null || true
cp "${TMP_DIR}/${BIN_IN_ARCHIVE}" "${OUT_PATH}"
chmod +x "${OUT_PATH}"

echo "Verificando…"
"${OUT_PATH}" -version

echo "OK — fpcalc instalado en ${OUT_PATH}"
