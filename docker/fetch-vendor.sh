#!/bin/sh
# Download the vendored Linux tarball for docker/Dockerfile. Run on a host
# with GitHub egress (set PROXY=http://host:port to route through a proxy).
set -e
mkdir -p "$(dirname "$0")/vendor"
cd "$(dirname "$0")/vendor"
curl -fsSL ${PROXY:+-x $PROXY} -o uv.tar.gz https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-unknown-linux-gnu.tar.gz
ls -la
