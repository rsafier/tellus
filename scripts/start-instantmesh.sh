#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="${INSTANTMESH_REPO_DIR:-$ROOT_DIR/external/InstantMesh}"
IMAGE_NAME="${INSTANTMESH_DOCKER_IMAGE:-tellus-instantmesh}"
HOST_PORT="${INSTANTMESH_GRADIO_PORT:-43839}"
GPU_DEVICES="${CUDA_VISIBLE_DEVICES:-0}"
MODE="${1:-docker}"

usage() {
  cat <<'EOF'
Usage: scripts/start-instantmesh.sh [docker|conda]

Starts the local InstantMesh Gradio service. The app listens on:
  http://127.0.0.1:43839

Environment:
  INSTANTMESH_REPO_DIR       InstantMesh checkout path.
  INSTANTMESH_DOCKER_IMAGE   Docker image name, default tellus-instantmesh.
  INSTANTMESH_GRADIO_PORT    Host port, default 43839.
  INSTANTMESH_CLEAN_WHITE_BG Enable near-white matte cleanup, default 1.
  INSTANTMESH_WHITE_BG_THRESHOLD
                              Near-white threshold, default 235. Lower is stricter.
  INSTANTMESH_WHITE_BG_CHROMA
                              Max RGB channel spread for white cleanup, default 35.
  INSTANTMESH_MESH_GRID_RES   FlexiCubes mesh grid, default 64 for 12GB GPUs.
  INSTANTMESH_PREVIEW_RENDER_SIZE
                              Preview video render size, default 256.
  CUDA_VISIBLE_DEVICES       GPU selection, default 0.
EOF
}

if [[ "${MODE}" == "-h" || "${MODE}" == "--help" ]]; then
  usage
  exit 0
fi

case "$MODE" in
  docker)
    mkdir -p "$ROOT_DIR/external/instantmesh-ckpts"
    mkdir -p "$ROOT_DIR/external/instantmesh-hf-cache"
    mkdir -p "$ROOT_DIR/external/instantmesh-u2net"
    docker_flags=(--rm)
    if [[ -t 0 && -t 1 ]]; then
      docker_flags+=(-it)
    fi
    docker run "${docker_flags[@]}" \
      --gpus "device=$GPU_DEVICES" \
      -p "$HOST_PORT:43839" \
      -v "$ROOT_DIR/external/instantmesh-ckpts:/workspace/instantmesh/ckpts" \
      -v "$ROOT_DIR/external/instantmesh-hf-cache:/root/.cache/huggingface" \
      -v "$ROOT_DIR/external/instantmesh-u2net:/root/.u2net" \
      -e INSTANTMESH_SAMPLE_STEPS="${INSTANTMESH_SAMPLE_STEPS:-30}" \
      -e INSTANTMESH_SAMPLE_SEED="${INSTANTMESH_SAMPLE_SEED:-42}" \
      -e INSTANTMESH_CLEAN_WHITE_BG="${INSTANTMESH_CLEAN_WHITE_BG:-1}" \
      -e INSTANTMESH_WHITE_BG_THRESHOLD="${INSTANTMESH_WHITE_BG_THRESHOLD:-235}" \
      -e INSTANTMESH_WHITE_BG_CHROMA="${INSTANTMESH_WHITE_BG_CHROMA:-35}" \
      -e INSTANTMESH_MESH_GRID_RES="${INSTANTMESH_MESH_GRID_RES:-64}" \
      -e INSTANTMESH_PREVIEW_RENDER_SIZE="${INSTANTMESH_PREVIEW_RENDER_SIZE:-256}" \
      "$IMAGE_NAME"
    ;;
  conda)
    conda_bin="$ROOT_DIR/external/miniconda/bin/conda"
    if [[ ! -x "$conda_bin" ]]; then
      echo "Missing Miniconda at $conda_bin. Run scripts/setup-instantmesh.sh conda first." >&2
      exit 1
    fi
    cd "$REPO_DIR"
    CUDA_VISIBLE_DEVICES="$GPU_DEVICES" "$conda_bin" run --no-capture-output -n instantmesh python app.py
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac
