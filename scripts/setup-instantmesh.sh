#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${INSTANTMESH_REPO_DIR:-$ROOT_DIR/external/InstantMesh}"
IMAGE_NAME="${INSTANTMESH_DOCKER_IMAGE:-tellus-instantmesh}"
DOCKERFILE="${INSTANTMESH_DOCKERFILE:-$ROOT_DIR/scripts/InstantMesh.Dockerfile}"
MODE="${1:-auto}"

usage() {
  cat <<'EOF'
Usage: scripts/setup-instantmesh.sh [auto|docker|conda]

Prepares a local TencentARC/InstantMesh Gradio service for Tellus.

Modes:
  auto    Use Docker when available, otherwise create a Miniconda env.
  docker  Build the InstantMesh Docker image.
  conda   Install Miniconda under external/miniconda and create instantmesh.

Environment:
  INSTANTMESH_REPO_DIR       InstantMesh checkout path.
  INSTANTMESH_DOCKER_IMAGE   Docker image name, default tellus-instantmesh.
  INSTANTMESH_DOCKERFILE     Dockerfile path, default scripts/InstantMesh.Dockerfile.
EOF
}

if [[ "${MODE}" == "-h" || "${MODE}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -d "$REPO_DIR/.git" ]]; then
  mkdir -p "$(dirname "$REPO_DIR")"
  git clone --depth 1 https://github.com/TencentARC/InstantMesh.git "$REPO_DIR"
fi

setup_docker() {
  docker build -t "$IMAGE_NAME" -f "$DOCKERFILE" "$REPO_DIR"
  cat <<EOF

InstantMesh Docker image is ready: $IMAGE_NAME
Start it with:
  scripts/start-instantmesh.sh docker
EOF
}

setup_conda() {
  local conda_root="$ROOT_DIR/external/miniconda"
  local conda_bin="$conda_root/bin/conda"

  if [[ ! -x "$conda_bin" ]]; then
    local installer="$ROOT_DIR/external/miniconda.sh"
    curl -L https://repo.anaconda.com/miniconda/Miniconda3-latest-Linux-x86_64.sh -o "$installer"
    bash "$installer" -b -p "$conda_root"
  fi

  if ! "$conda_bin" env list | awk '{print $1}' | grep -qx instantmesh; then
    "$conda_bin" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/main || true
    "$conda_bin" tos accept --override-channels --channel https://repo.anaconda.com/pkgs/r || true
    "$conda_bin" create -y -n instantmesh python=3.10
  fi

  "$conda_bin" run -n instantmesh conda install -y ninja cuda -c nvidia/label/cuda-12.1.0
  "$conda_bin" run -n instantmesh python -m pip install -U pip
  "$conda_bin" run -n instantmesh python -m pip install \
    torch==2.1.0 torchvision==0.16.0 torchaudio==2.1.0 \
    --index-url https://download.pytorch.org/whl/cu121
  "$conda_bin" run -n instantmesh python -m pip install xformers==0.0.22.post7
  "$conda_bin" run -n instantmesh python -m pip install -r "$REPO_DIR/requirements.txt"

  cat <<EOF

InstantMesh conda env is ready at: $conda_root/envs/instantmesh
Start it with:
  scripts/start-instantmesh.sh conda
EOF
}

case "$MODE" in
  auto)
    if command -v docker >/dev/null 2>&1; then
      setup_docker
    else
      setup_conda
    fi
    ;;
  docker)
    setup_docker
    ;;
  conda)
    setup_conda
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
