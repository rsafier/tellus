#!/usr/bin/env bash
# Build + push the multi-arch Tellus image to the in-cluster registry on the shared, fleet-wide
# `monumental-k8s` BuildKit builder (native per-arch pods, NOT QEMU). Mirrors hyades/deploy/build-push.sh.
# Usage:  ./deploy/build-push.sh <tag>
# The cluster is mixed-arch (amd64 + arm64), so the image must be a multi-arch manifest.
set -euo pipefail

TAG="${1:?usage: build-push.sh <tag>}"
REG="${TELLUS_REGISTRY:-192.168.1.187:30500}"
BUILDER="${BUILDX_BUILDER:-monumental-k8s}"
export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"

# Wake the shared BuildKit builder if the fleet idle-janitor parked it to 0 (else buildx errors
# "expected 1 replicas to be ready, got 0").
if ! kubectl -n buildkit get deploy monumental-amd64 monumental-arm64 \
       -o jsonpath='{range .items[*]}{.status.readyReplicas}{"\n"}{end}' 2>/dev/null | grep -qx 1; then
  echo "waking BuildKit builder (was idle-scaled to 0)…"
  kubectl -n buildkit scale deploy/monumental-amd64 deploy/monumental-arm64 --replicas=1 >/dev/null 2>&1 || true
  kubectl -n buildkit rollout status deploy/monumental-amd64 --timeout=180s || true
  kubectl -n buildkit rollout status deploy/monumental-arm64 --timeout=180s || true
fi

docker buildx inspect --bootstrap "$BUILDER" >/dev/null
docker buildx build --builder "$BUILDER" --platform linux/amd64,linux/arm64 \
  -t "$REG/tellus:$TAG" --push .
echo "pushed $REG/tellus:$TAG (amd64 + arm64)"
