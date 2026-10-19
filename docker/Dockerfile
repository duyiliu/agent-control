# agent-control runner image: one image covering every managed stack
# (Node, Python/uv) plus the pi CLI. Build:
#   bash docker/fetch-vendor.sh && docker build -t agent-control-dev:latest docker/
#
# No PowerShell on purpose: the image is Linux, and the runner hides pi's
# powershell tool via its --tools allowlist (filterToolsForContainer) instead
# of installing a 70MB runtime the agent should not use.
#
# Vendoring rationale: internal build hosts (e.g. 192.168.1.199) have no
# GitHub egress and registry mirrors rate-limit, so the GitHub release tarball
# is downloaded on a capable host into docker/vendor/ (gitignored) and shipped
# through the build context. python3 comes from debian apt.
FROM node:22-bookworm

COPY vendor/uv.tar.gz /tmp/

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv python3-pip \
 && rm -rf /var/lib/apt/lists/* \
 && tar -xzf /tmp/uv.tar.gz -C /tmp --strip-components=1 \
 && chmod +x /tmp/uv /tmp/uvx \
 && mv /tmp/uv /usr/local/bin/uv \
 && mv /tmp/uvx /usr/local/bin/uvx \
 && rm /tmp/uv.tar.gz

RUN npm config set registry https://registry.npmmirror.com \
 && npm install -g @earendil-works/pi-coding-agent

COPY entrypoint.sh /usr/local/bin/ac-entrypoint
RUN chmod +x /usr/local/bin/ac-entrypoint

ENTRYPOINT ["ac-entrypoint"]
CMD ["pi", "--version"]
