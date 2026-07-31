# The upstream OpenClaw base is pinned by immutable digest so rebuilds are
# reproducible; bump procedure lives in lib/base-image-pin.mjs, and
# lib/base-image-pin.test.mjs enforces lockstep between this ARG default and
# the constant exported there.
ARG OPENCLAW_BASE_IMAGE=ghcr.io/openclaw/openclaw@sha256:25f5bacf51742c3231d7dd1d319fede009a9d5aeab8b6232cd309ac6475fe82c
FROM ${OPENCLAW_BASE_IMAGE}

USER root

ARG TROOPER_CORE_COMMIT=unknown
ARG CODEX_CLI_VERSION=0.146.0
ARG CLAUDE_CLI_VERSION=2.1.220
ARG OPENCODE_CLI_VERSION=1.14.48
ARG KIMI_CLI_VERSION=0.30.0
ARG COPILOT_CLI_VERSION=1.0.75
ARG GEMINI_CLI_VERSION=0.53.0

LABEL org.opencontainers.image.revision="${TROOPER_CORE_COMMIT}"

# ACP binaries are part of the gateway release contract. They are installed
# once, at pinned versions, and invoked through their managed absolute paths.
# Runtime requests never execute npx or install an unversioned package.
RUN npm install --global --no-audit --no-fund \
    "@openai/codex@${CODEX_CLI_VERSION}" \
    "@anthropic-ai/claude-code@${CLAUDE_CLI_VERSION}" \
    "opencode-ai@${OPENCODE_CLI_VERSION}" \
    "@moonshot-ai/kimi-code@${KIMI_CLI_VERSION}" \
    "@github/copilot@${COPILOT_CLI_VERSION}" \
    "@google/gemini-cli@${GEMINI_CLI_VERSION}"

# Install Chrome + TigerVNC + noVNC/websockify in a single layer
RUN apt-get update && \
    curl -fsSL -o /tmp/chrome.deb https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb && \
    (dpkg -i /tmp/chrome.deb || apt-get install -y -f) && \
    rm -f /tmp/chrome.deb && \
    apt-get install -y --no-install-recommends \
      bubblewrap \
      tigervnc-standalone-server \
      novnc \
      websockify && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

# Chrome wrapper script (starts Xvnc + Chrome)
COPY chrome-wrapper.sh /opt/chrome-wrapper.sh
RUN chmod +x /opt/chrome-wrapper.sh

# Entrypoint wrapper (runs as root, chowns, drops to node)
COPY entrypoint.sh /opt/entrypoint.sh
RUN chmod +x /opt/entrypoint.sh

# ACPX is an external OpenClaw runtime plugin. Bootstrap it on the persisted
# state volume before the gateway reads the ACP-enabled configuration.
COPY acpx-bootstrap.sh /opt/acpx-bootstrap.sh
RUN chmod +x /opt/acpx-bootstrap.sh

# Simplified startup script
COPY startup.sh /opt/startup.sh
RUN chmod +x /opt/startup.sh

# Everything runs as node user
USER node

ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
