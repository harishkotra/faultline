#!/usr/bin/env bash
set -euo pipefail
TAG="v0.99.0"
git clone --depth 1 --branch "$TAG" https://github.com/SigNoz/signoz.git upstream
echo "SigNoz $TAG fetched. Follow upstream/deploy/docker/README.md, then start Faultline with npm run dev."
