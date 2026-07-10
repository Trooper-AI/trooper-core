#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is for macOS only." >&2
  exit 1
fi

need_env() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required environment variable: $name" >&2
    exit 1
  fi
}

need_env ORG_ID
need_env API_URL
need_env GATEWAY_TOKEN
need_env BRIDGE_AUTH_TOKEN

TROOPER_HOME="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}"
BRIDGE_DIR="${BRIDGE_DIR:-$TROOPER_HOME/bridge}"
OPENCLAW_DATA_DIR="${OPENCLAW_DATA_DIR:-$TROOPER_HOME/openclaw-data}"
OPENCLAW_CONFIG_ROOT="${OPENCLAW_CONFIG_ROOT:-$OPENCLAW_DATA_DIR/config}"
LOG_DIR="$TROOPER_HOME/logs"
BIN_DIR="$TROOPER_HOME/bin"
PLIST_DIR="$HOME/Library/LaunchAgents"
ENV_FILE="$TROOPER_HOME/trooper-local-host.env"
TROOPER_PARENT_DIR="$(dirname "$TROOPER_HOME")"
INSTALLATION_ID_FILE="$TROOPER_PARENT_DIR/install-id"

REQUESTED_HOST_DEVICE_ID="${HOST_DEVICE_ID:-}"
BRIDGE_PORT="${BRIDGE_PORT:-3002}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
BROWSER_MODE="${BROWSER_MODE:-managed}"
TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-cloudflare}"
TROOPER_BRIDGE_REPO_URL="${TROOPER_BRIDGE_REPO_URL:-https://github.com/absurdfounder/trooper-bridge.git}"
OPENCLAW_DOCKER_IMAGE="${OPENCLAW_DOCKER_IMAGE:-ghcr.io/trooper-ai/trooper-gateway:latest}"
OPENCLAW_GATEWAY_CONTAINER="${OPENCLAW_GATEWAY_CONTAINER:-openclaw-openclaw-gateway-1}"
COLIMA_VERSION="${COLIMA_VERSION:-v0.10.3}"
LIMA_VERSION="${LIMA_VERSION:-2.1.2}"
DOCKER_CLI_VERSION="${DOCKER_CLI_VERSION:-29.1.3}"
DOCKER_COMPOSE_VERSION="${DOCKER_COMPOSE_VERSION:-v5.1.4}"
DOCKER_BUILDX_VERSION="${DOCKER_BUILDX_VERSION:-v0.35.0}"

export PATH="$BIN_DIR:$TROOPER_HOME/lima/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

load_homebrew_path() {
  local brew_bin
  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [[ -x "$brew_bin" ]]; then
      eval "$("$brew_bin" shellenv)"
      return 0
    fi
  done
  return 1
}

load_homebrew_path || true

if [[ "$EUID" -eq 0 ]]; then
  echo "Run this installer as your signed-in macOS user, not with sudo." >&2
  exit 1
fi

# Repair files left by older installers that incorrectly ran the whole setup as root.
ROOT_OWNED_PATHS=()
for path in "$TROOPER_PARENT_DIR" "$TROOPER_HOME" "$PLIST_DIR"/so.trooper.local-*.plist; do
  if [[ -e "$path" && ! -O "$path" ]]; then
    ROOT_OWNED_PATHS+=("$path")
  fi
done
if (( ${#ROOT_OWNED_PATHS[@]} > 0 )); then
  echo "Repairing ownership from an earlier Trooper local-host installation..."
  sudo chown -R "$(id -u):$(id -g)" "${ROOT_OWNED_PATHS[@]}"
fi

mkdir -p \
  "$TROOPER_HOME" \
  "$BRIDGE_DIR" \
  "$OPENCLAW_DATA_DIR" \
  "$OPENCLAW_CONFIG_ROOT" \
  "$OPENCLAW_CONFIG_ROOT/devices" \
  "$OPENCLAW_DATA_DIR/devices" \
  "$OPENCLAW_DATA_DIR/workspace" \
  "$OPENCLAW_DATA_DIR/diagnostics/logs" \
  "$LOG_DIR" \
  "$BIN_DIR" \
  "$PLIST_DIR"

read_env_value() {
  local key="$1"
  local line=""
  [[ -f "$ENV_FILE" ]] || return 0
  line="$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)"
  printf '%s' "${line#*=}"
}

EXISTING_ORG_ID="$(read_env_value ORG_ID)"
EXISTING_HOST_DEVICE_ID="$(read_env_value HOST_DEVICE_ID)"
if [[ -n "$EXISTING_ORG_ID" && "$EXISTING_ORG_ID" != "local-unpaired" && "$ORG_ID" != "$EXISTING_ORG_ID" ]]; then
  echo "This computer already hosts Trooper workspace $EXISTING_ORG_ID." >&2
  echo "Trooper will not replace it with workspace $ORG_ID." >&2
  echo "Open the existing workspace, use another computer, or uninstall the local host before continuing." >&2
  exit 73
fi
if [[ "$ORG_ID" == "local-unpaired" && -n "$EXISTING_ORG_ID" && "$EXISTING_ORG_ID" != "local-unpaired" ]]; then
  echo "This computer already hosts Trooper workspace $EXISTING_ORG_ID." >&2
  echo "The existing local workspace was left unchanged. Opening Trooper is enough to use it." >&2
  exit 73
fi

if [[ -s "$INSTALLATION_ID_FILE" ]]; then
  HOST_DEVICE_ID="$(tr -d '[:space:]' < "$INSTALLATION_ID_FILE")"
else
  HOST_DEVICE_ID="${EXISTING_HOST_DEVICE_ID:-}"
  if [[ -z "$HOST_DEVICE_ID" ]]; then
    HOST_DEVICE_ID="mac-local-$(uuidgen | tr '[:upper:]' '[:lower:]' | tr -d '-')"
  fi
  printf '%s\n' "$HOST_DEVICE_ID" > "$INSTALLATION_ID_FILE"
  chmod 600 "$INSTALLATION_ID_FILE"
fi
if [[ -z "$HOST_DEVICE_ID" ]]; then
  HOST_DEVICE_ID="${REQUESTED_HOST_DEVICE_ID:-mac-$(scutil --get LocalHostName 2>/dev/null || hostname | tr -cd '[:alnum:]-' | tr '[:upper:]' '[:lower:]')}"
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required. Install Xcode Command Line Tools, then rerun this installer." >&2
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required. Install Node.js 20+ or run: brew install node" >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is required. Install Node.js 20+ or run: brew install node" >&2
  exit 1
fi

docker_ready() {
  if ! command -v docker >/dev/null 2>&1; then
    return 1
  fi
  # Always prefer the Colima-forwarded host socket when present.
  if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  elif [[ -S "$HOME/.colima/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.colima/docker.sock"
  fi
  unset DOCKER_CONTEXT || true
  docker info >/dev/null 2>&1
}

# Colima profile used for Trooper local host. 8GiB avoids OOM while the amd64
# gateway image runs under qemu/binfmt on Apple Silicon.
colima_start_trooper() {
  local mem="${TROOPER_COLIMA_MEMORY_GIB:-8}"
  local cpus="${TROOPER_COLIMA_CPUS:-4}"
  # Best-effort: Rosetta makes amd64 containers much faster when available.
  if [[ "$(uname -m)" == "arm64" ]] && [[ ! -d /Library/Apple/usr/libexec/oah ]]; then
    echo "Installing Rosetta (helps amd64 gateway image on Apple Silicon)..."
    /usr/sbin/softwareupdate --install-rosetta --agree-to-license >/dev/null 2>&1 || true
  fi
  colima start --runtime docker --vm-type vz --mount-type virtiofs --memory "$mem" --cpu "$cpus" 2>/dev/null \
    || colima start --runtime docker --memory "$mem" --cpu "$cpus" 2>/dev/null \
    || colima start --runtime docker 2>/dev/null \
    || colima start 2>/dev/null \
    || true
}

mac_arch() {
  case "$(uname -m)" in
    arm64|aarch64) echo "arm64" ;;
    x86_64|amd64) echo "x86_64" ;;
    *)
      echo "Unsupported macOS CPU architecture: $(uname -m)" >&2
      return 1
      ;;
  esac
}

download_file() {
  local url="$1"
  local dest="$2"
  # -sS: no progress meter (keeps in-app install logs readable), still show errors
  echo "Downloading $(basename "$dest")..."
  curl --fail --silent --show-error --location --retry 3 --retry-delay 2 --output "$dest" "$url"
}

install_homebrew() {
  if [[ "${TROOPER_SKIP_HOMEBREW_INSTALL:-0}" == "1" ]]; then
    return 1
  fi

  if command -v brew >/dev/null 2>&1; then
    return 0
  fi

  if ! command -v curl >/dev/null 2>&1; then
    echo "curl is required to install Homebrew automatically." >&2
    return 1
  fi

  echo "Installing Homebrew so Trooper can install a local Docker runtime..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_homebrew_path || true
  command -v brew >/dev/null 2>&1
}

install_standalone_colima_docker_runtime() (
  if [[ "${TROOPER_SKIP_STANDALONE_DOCKER_INSTALL:-0}" == "1" ]]; then
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    return 1
  fi

  local arch docker_arch colima_arch lima_arch compose_arch buildx_arch tmp_dir
  arch="$(mac_arch)" || return 1
  case "$arch" in
    arm64)
      docker_arch="aarch64"
      colima_arch="arm64"
      lima_arch="arm64"
      compose_arch="aarch64"
      buildx_arch="arm64"
      ;;
    x86_64)
      docker_arch="x86_64"
      colima_arch="x86_64"
      lima_arch="x86_64"
      compose_arch="x86_64"
      buildx_arch="amd64"
      ;;
  esac

  echo "Installing user-local Docker CLI runtime with Colima..."
  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "$tmp_dir" "$TROOPER_HOME/lima.tmp"' EXIT

  download_file "https://download.docker.com/mac/static/stable/${docker_arch}/docker-${DOCKER_CLI_VERSION}.tgz" "$tmp_dir/docker.tgz"
  tar -xzf "$tmp_dir/docker.tgz" -C "$tmp_dir"
  install -m 0755 "$tmp_dir/docker/docker" "$BIN_DIR/docker"

  mkdir -p "$TROOPER_HOME/lima"
  download_file "https://github.com/lima-vm/lima/releases/download/v${LIMA_VERSION}/lima-${LIMA_VERSION}-Darwin-${lima_arch}.tar.gz" "$tmp_dir/lima.tgz"
  rm -rf "$TROOPER_HOME/lima.tmp"
  mkdir -p "$TROOPER_HOME/lima.tmp"
  tar -xzf "$tmp_dir/lima.tgz" -C "$TROOPER_HOME/lima.tmp"
  rm -rf "$TROOPER_HOME/lima"
  mv "$TROOPER_HOME/lima.tmp" "$TROOPER_HOME/lima"
  if [[ -x "$TROOPER_HOME/lima/bin/limactl" ]]; then
    ln -sfn "$TROOPER_HOME/lima/bin/limactl" "$BIN_DIR/limactl"
  fi
  if [[ -x "$TROOPER_HOME/lima/bin/lima" ]]; then
    ln -sfn "$TROOPER_HOME/lima/bin/lima" "$BIN_DIR/lima"
  fi

  download_file "https://github.com/abiosoft/colima/releases/download/${COLIMA_VERSION}/colima-Darwin-${colima_arch}" "$BIN_DIR/colima"
  chmod 0755 "$BIN_DIR/colima"

  mkdir -p "$HOME/.docker/cli-plugins"
  download_file "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-darwin-${compose_arch}" "$HOME/.docker/cli-plugins/docker-compose"
  chmod 0755 "$HOME/.docker/cli-plugins/docker-compose"
  download_file "https://github.com/docker/buildx/releases/download/${DOCKER_BUILDX_VERSION}/buildx-${DOCKER_BUILDX_VERSION}.darwin-${buildx_arch}" "$HOME/.docker/cli-plugins/docker-buildx"
  chmod 0755 "$HOME/.docker/cli-plugins/docker-buildx"
  hash -r

  echo "Starting Colima..."
  # Subshell cannot call outer shell functions — inline the Trooper Colima profile.
  local mem="${TROOPER_COLIMA_MEMORY_GIB:-8}"
  local cpus="${TROOPER_COLIMA_CPUS:-4}"
  if [[ "$(uname -m)" == "arm64" ]] && [[ ! -d /Library/Apple/usr/libexec/oah ]]; then
    /usr/sbin/softwareupdate --install-rosetta --agree-to-license >/dev/null 2>&1 || true
  fi
  colima start --runtime docker --vm-type vz --mount-type virtiofs --memory "$mem" --cpu "$cpus" \
    || colima start --runtime docker --memory "$mem" --cpu "$cpus" \
    || colima start --runtime docker \
    || colima start
)

install_colima_docker_runtime() {
  if [[ "${TROOPER_SKIP_DOCKER_INSTALL:-0}" == "1" ]]; then
    return 1
  fi

  if ! command -v brew >/dev/null 2>&1; then
    if install_standalone_colima_docker_runtime; then
      return 0
    fi
    install_homebrew || return 1
  fi

  echo "Installing Docker CLI runtime with Colima..."
  brew install colima docker docker-compose docker-buildx

  local brew_prefix
  brew_prefix="$(brew --prefix)"
  mkdir -p "$HOME/.docker/cli-plugins"
  if [[ -x "$brew_prefix/opt/docker-compose/bin/docker-compose" ]]; then
    ln -sfn "$brew_prefix/opt/docker-compose/bin/docker-compose" "$HOME/.docker/cli-plugins/docker-compose"
  fi
  if [[ -x "$brew_prefix/opt/docker-buildx/bin/docker-buildx" ]]; then
    ln -sfn "$brew_prefix/opt/docker-buildx/bin/docker-buildx" "$HOME/.docker/cli-plugins/docker-buildx"
  fi
  hash -r

  echo "Starting Colima..."
  colima_start_trooper
}

start_docker_desktop() {
  if [[ "${TROOPER_SKIP_DOCKER_DESKTOP:-0}" == "1" ]]; then
    return 1
  fi

  if [[ ! -d "/Applications/Docker.app" && ! -d "$HOME/Applications/Docker.app" ]]; then
    return 1
  fi

  open -a Docker >/dev/null 2>&1 || true
  echo "Waiting for Docker Desktop to start..."
  for _ in {1..60}; do
    docker_ready && return 0
    sleep 2
  done
  return 1
}

ensure_docker_runtime() {
  if docker_ready; then
    return 0
  fi

  if install_colima_docker_runtime && docker_ready; then
    return 0
  fi

  if start_docker_desktop && docker_ready; then
    return 0
  fi

  echo "A Docker-compatible local runtime is required for the local AI gateway." >&2
  if command -v brew >/dev/null 2>&1; then
    echo "Trooper tried to install/start Colima. You can retry manually with:" >&2
    echo "  brew install colima docker docker-compose docker-buildx && colima start" >&2
  else
    echo "Trooper tried to install Homebrew automatically but it did not complete." >&2
    echo "You can retry manually with:" >&2
    echo "  NONINTERACTIVE=1 /bin/bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"" >&2
  fi
  return 1
}

if ! ensure_docker_runtime; then
  exit 1
fi

echo "Preparing Trooper gateway image..."
docker pull "$OPENCLAW_DOCKER_IMAGE"

# Ensure a real git checkout. Prior failed installs (or Docker bind-mounts of a missing
# startup.sh) can leave BRIDGE_DIR non-empty without .git — plain `git clone` then fails
# with exit 128 ("destination path already exists and is not an empty directory").
if [[ -d "$BRIDGE_DIR/.git" ]]; then
  echo "Updating Trooper bridge..."
  git -C "$BRIDGE_DIR" fetch --all --prune || {
    rm -f "$BRIDGE_DIR/.git/refs/remotes/origin/main" "$BRIDGE_DIR/.git/packed-refs.lock"
    git -C "$BRIDGE_DIR" fetch origin main --prune
  }
  git -C "$BRIDGE_DIR" pull --ff-only || true
else
  if [[ -e "$BRIDGE_DIR" ]]; then
    echo "Clearing incomplete bridge directory at $BRIDGE_DIR..."
    rm -rf "$BRIDGE_DIR"
  fi
  echo "Cloning Trooper bridge..."
  git clone "$TROOPER_BRIDGE_REPO_URL" "$BRIDGE_DIR"
fi

if [[ -n "${OPENCLAWBRIDGE_GIT_SHA:-}" ]]; then
  git -C "$BRIDGE_DIR" checkout "$OPENCLAWBRIDGE_GIT_SHA"
fi

# Guard against Docker turning a missing bind-mount source into a directory later.
if [[ -d "$BRIDGE_DIR/startup.sh" && ! -f "$BRIDGE_DIR/startup.sh" ]]; then
  echo "Removing invalid startup.sh directory left by a previous Docker mount..."
  rm -rf "$BRIDGE_DIR/startup.sh"
fi

echo "Installing bridge dependencies..."
npm --prefix "$BRIDGE_DIR" install --omit=dev

write_env_line() {
  printf '%s=%q\n' "$1" "${2:-}"
}

{
  write_env_line ORG_ID "$ORG_ID"
  write_env_line API_URL "$API_URL"
  write_env_line GATEWAY_TOKEN "$GATEWAY_TOKEN"
  write_env_line OPENCLAW_GATEWAY_TOKEN "$GATEWAY_TOKEN"
  write_env_line BRIDGE_AUTH_TOKEN "$BRIDGE_AUTH_TOKEN"
  write_env_line HOST_DEVICE_ID "$HOST_DEVICE_ID"
  write_env_line TROOPER_INSTALLATION_ID "$HOST_DEVICE_ID"
  write_env_line BRIDGE_PORT "$BRIDGE_PORT"
  write_env_line PORT "$BRIDGE_PORT"
  write_env_line GATEWAY_PORT "$GATEWAY_PORT"
  write_env_line OPENCLAW_GATEWAY_URL "http://127.0.0.1:$GATEWAY_PORT"
  write_env_line PUBLIC_BRIDGE_URL "${PUBLIC_BRIDGE_URL:-}"
  write_env_line PUBLIC_GATEWAY_URL "${PUBLIC_GATEWAY_URL:-}"
  write_env_line TUNNEL_ID "${TUNNEL_ID:-}"
  write_env_line TUNNEL_PROVIDER "$TUNNEL_PROVIDER"
  write_env_line BROWSER_MODE "$BROWSER_MODE"
  write_env_line TROOPER_LOCAL_MAC_HOST "1"
  write_env_line TROOPER_LOCAL_UNPAIRED "${TROOPER_LOCAL_UNPAIRED:-0}"
  write_env_line TROOPER_BRIDGE_DIR "$BRIDGE_DIR"
  write_env_line TROOPER_HOME "$TROOPER_HOME"
  write_env_line OPENCLAW_DATA_DIR "$OPENCLAW_DATA_DIR"
  write_env_line OPENCLAW_DATA_ROOT "$OPENCLAW_DATA_DIR"
  write_env_line OPENCLAW_CONFIG_ROOT "$OPENCLAW_CONFIG_ROOT"
  write_env_line OPENCLAW_DEVICES_DIR "$OPENCLAW_CONFIG_ROOT/devices"
  write_env_line OPENCLAW_PAIRED_JSON_PATH "$OPENCLAW_CONFIG_ROOT/devices/paired.json"
  write_env_line OPENCLAW_WORKSPACE_HOST_ROOT "$OPENCLAW_DATA_DIR/workspace"
  write_env_line OPENCLAW_DOCKER_IMAGE "$OPENCLAW_DOCKER_IMAGE"
  write_env_line OPENCLAW_GATEWAY_CONTAINER "$OPENCLAW_GATEWAY_CONTAINER"
  write_env_line BRIDGE_DEVICE_IDENTITY_PATH "$BRIDGE_DIR/device-identity.json"
  write_env_line TROOPER_DIAGNOSTICS_DIR "$OPENCLAW_DATA_DIR/diagnostics"
  write_env_line CLOUDFLARE_TUNNEL_TOKEN "${CLOUDFLARE_TUNNEL_TOKEN:-}"
  write_env_line TROOPER_MAC_ACCESSIBILITY "${TROOPER_MAC_ACCESSIBILITY:-0}"
  write_env_line TROOPER_MAC_AUTOMATION "${TROOPER_MAC_AUTOMATION:-0}"
  write_env_line TROOPER_MAC_SCREEN_RECORDING "${TROOPER_MAC_SCREEN_RECORDING:-0}"
  write_env_line TROOPER_ALLOW_EXISTING_BROWSER "${TROOPER_ALLOW_EXISTING_BROWSER:-0}"
  write_env_line PATH "$PATH"
  # So bridge/gateway helpers can reach Colima's docker.sock without Docker Desktop.
  if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
    write_env_line DOCKER_HOST "unix://$HOME/.colima/default/docker.sock"
  elif [[ -S "$HOME/.colima/docker.sock" ]]; then
    write_env_line DOCKER_HOST "unix://$HOME/.colima/docker.sock"
  fi
} > "$ENV_FILE"
chmod 600 "$ENV_FILE"

OPENCLAW_ROOT_CONFIG_PATH="$OPENCLAW_DATA_DIR/openclaw.json" GATEWAY_TOKEN="$GATEWAY_TOKEN" node <<'NODE'
const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const configPath = process.env.OPENCLAW_ROOT_CONFIG_PATH;
const token = process.env.GATEWAY_TOKEN;
let config = {};
if (existsSync(configPath)) {
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    config = {};
  }
}
config.gateway = config.gateway && typeof config.gateway === 'object' ? config.gateway : {};
config.gateway.auth = config.gateway.auth && typeof config.gateway.auth === 'object' ? config.gateway.auth : {};
config.gateway.auth.mode = config.gateway.auth.mode || 'token';
config.gateway.auth.token = token;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
NODE
chmod 600 "$OPENCLAW_DATA_DIR/openclaw.json"

cat > "$BIN_DIR/start-bridge.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a
cd "$TROOPER_BRIDGE_DIR"
exec node index.mjs
EOF

cat > "$BIN_DIR/start-gateway.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

# Always prefer Trooper-bundled docker/colima over a missing system PATH (LaunchAgents
# only inherit a minimal PATH).
export PATH="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/bin:${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/lima/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin"

# Free GATEWAY_PORT: Trooper may also run a managed OpenClaw node gateway
# (ai.openclaw.gateway) on 18789. That process steals the port from Docker and
# causes "gateway token mismatch" because it uses a different auth token.
free_gateway_port() {
  local port="${GATEWAY_PORT:-18789}"
  local uid
  uid="$(/usr/bin/id -u)"
  /bin/launchctl bootout "gui/$uid/ai.openclaw.gateway" >/dev/null 2>&1 || true
  /bin/launchctl bootout "gui/$uid" "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" >/dev/null 2>&1 || true
  /bin/launchctl disable "gui/$uid/ai.openclaw.gateway" >/dev/null 2>&1 || true
  local pids
  pids="$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "$pids" ]]; then
    echo "Stopping processes on gateway port $port: $pids"
    # shellcheck disable=SC2086
    /bin/kill $pids >/dev/null 2>&1 || true
    sleep 1
    pids="$(/usr/sbin/lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)"
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      /bin/kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}

ensure_docker() {
  # Prefer the Colima-forwarded host socket. Never restart docker.service inside
  # the guest alone — that leaves a stale host socket while guest docker is fine.
  if [[ -S "$HOME/.colima/default/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"
  elif [[ -S "$HOME/.colima/docker.sock" ]]; then
    export DOCKER_HOST="unix://$HOME/.colima/docker.sock"
  fi
  unset DOCKER_CONTEXT || true

  if docker info >/dev/null 2>&1; then
    return 0
  fi
  if ! command -v colima >/dev/null 2>&1; then
    return 1
  fi

  echo "Starting Colima Docker runtime..."
  colima_start_trooper
  local i
  for i in $(seq 1 20); do
    if docker_ready; then
      return 0
    fi
    sleep 2
  done

  # Host socket often goes stale after guest churn. Full restart re-binds the forward.
  echo "Host Docker socket is stale — restarting Colima to rebind unix socket..."
  colima stop 2>/dev/null || true
  sleep 1
  colima_start_trooper
  for i in $(seq 1 30); do
    if docker_ready; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if command -v docker >/dev/null 2>&1; then
  free_gateway_port
  if ! ensure_docker; then
    echo "Docker daemon is not available (Colima failed to start)." >&2
    sleep 30
    exit 1
  fi
  docker rm -f "${OPENCLAW_GATEWAY_CONTAINER}" trooper-local-gateway >/dev/null 2>&1 || true
  # Gateway image is currently linux/amd64; Colima binfmt/qemu emulates it on arm64.
  # Publish on 0.0.0.0 (not 127.0.0.1): with Colima, 127.0.0.1 is the guest loopback
  # and is NOT forwarded to the Mac host, so the bridge can never reach the gateway.
  exec docker run --name "${OPENCLAW_GATEWAY_CONTAINER}" --pull=missing \
    --platform linux/amd64 \
    -p "${GATEWAY_PORT}:${GATEWAY_PORT}" \
    -v "${OPENCLAW_DATA_DIR}:/home/node/.openclaw" \
    -v "${TROOPER_BRIDGE_DIR}/startup.sh:/opt/startup.sh:ro" \
    --entrypoint /bin/bash \
    -e "OPENCLAW_HOST=0.0.0.0" \
    -e "OPENCLAW_PORT=${GATEWAY_PORT}" \
    -e "GATEWAY_TOKEN=${GATEWAY_TOKEN}" \
    -e "OPENCLAW_GATEWAY_TOKEN=${GATEWAY_TOKEN}" \
    -e "TROOPER_GATEWAY_SKIP_DOCTOR=1" \
    -e "DOCKER_HOST=${DOCKER_HOST:-}" \
    "${OPENCLAW_DOCKER_IMAGE}" \
    /opt/startup.sh \
    "${GATEWAY_PORT}"
fi

echo "Docker is not available." >&2
sleep 30
exit 1
EOF

cat > "$BIN_DIR/start-tunnel.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

if [[ -n "${CLOUDFLARE_TUNNEL_TOKEN:-}" ]] && command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel run --token "$CLOUDFLARE_TUNNEL_TOKEN"
fi

echo "No managed tunnel token configured yet. Waiting for PUBLIC_BRIDGE_URL or Cloudflare tunnel token..."
while true; do sleep 3600; done
EOF

cat > "$BIN_DIR/heartbeat.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
ENV_FILE="${TROOPER_HOME:-$HOME/Library/Application Support/Trooper/runtime}/trooper-local-host.env"
set -a
source "$ENV_FILE"
set +a

if [[ "${TROOPER_LOCAL_UNPAIRED:-0}" == "1" || "${ORG_ID:-}" == "local-unpaired" ]]; then
  echo "Trooper local host is installed but not paired yet. Open Trooper to connect this Mac to a workspace."
  while true; do sleep 3600; done
fi

post_json() {
  local path="$1"
  local body="$2"
  curl -fsS -X POST "$API_URL/api/organizations/$ORG_ID/$path" \
    -H 'Content-Type: application/json' \
    --data "$body" >/dev/null
}

while true; do
  HEALTH_JSON="$(curl -fsS "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null || printf '{}')"
  BODY="$(HEALTH_JSON="$HEALTH_JSON" python3 - <<'PY'
import json, os
try:
    health = json.loads(os.environ.get("HEALTH_JSON") or "{}")
except Exception:
    health = {}
payload = {
    "token": os.environ.get("BRIDGE_AUTH_TOKEN"),
    "hostDeviceId": os.environ.get("HOST_DEVICE_ID"),
    "bridgeUrl": os.environ.get("PUBLIC_BRIDGE_URL") or f"http://127.0.0.1:{os.environ.get('BRIDGE_PORT', '3002')}",
    "gatewayUrl": os.environ.get("PUBLIC_GATEWAY_URL") or f"http://127.0.0.1:{os.environ.get('GATEWAY_PORT', '18789')}",
    "tunnelId": os.environ.get("TUNNEL_ID"),
    "tunnelProvider": os.environ.get("TUNNEL_PROVIDER") or "cloudflare",
    "platform": "macOS",
    "status": "ready" if health.get("status") == "ok" else "local_pending",
    "health": health,
    "browserModes": {
        "default": os.environ.get("BROWSER_MODE") or "managed",
        "managed": True,
        "existingOsBrowser": True,
        "vpsDesktop": False,
    },
    "permissions": {
        "accessibility": os.environ.get("TROOPER_MAC_ACCESSIBILITY") == "1",
        "automation": os.environ.get("TROOPER_MAC_AUTOMATION") == "1",
        "screenRecording": os.environ.get("TROOPER_MAC_SCREEN_RECORDING") == "1",
        "existingBrowser": os.environ.get("TROOPER_ALLOW_EXISTING_BROWSER") == "1",
    },
}
print(json.dumps(payload, separators=(",", ":")))
PY
)"
  post_json local-host/heartbeat "$BODY" || true
  if [[ -n "${PUBLIC_BRIDGE_URL:-}" ]]; then
    post_json local-host/complete "$BODY" || true
  fi
  sleep 30
done
EOF

chmod +x "$BIN_DIR/start-bridge.sh" "$BIN_DIR/start-gateway.sh" "$BIN_DIR/start-tunnel.sh" "$BIN_DIR/heartbeat.sh"

write_plist() {
  local label="$1"
  local program="$2"
  local plist="$PLIST_DIR/$label.plist"
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$program</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>$HOME</string>
    <key>TROOPER_HOME</key><string>$TROOPER_HOME</string>
    <key>PATH</key><string>$TROOPER_HOME/bin:$TROOPER_HOME/lima/bin:/opt/homebrew/bin:/usr/local/bin:/Applications/Docker.app/Contents/Resources/bin:$HOME/Applications/Docker.app/Contents/Resources/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>DOCKER_HOST</key><string>unix://$HOME/.colima/default/docker.sock</string>
  </dict>
  <key>StandardOutPath</key><string>$LOG_DIR/$label.out.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/$label.err.log</string>
  <key>WorkingDirectory</key><string>$TROOPER_HOME</string>
</dict>
</plist>
EOF
}

write_plist so.trooper.local-bridge "$BIN_DIR/start-bridge.sh"
write_plist so.trooper.local-gateway "$BIN_DIR/start-gateway.sh"
write_plist so.trooper.local-tunnel "$BIN_DIR/start-tunnel.sh"
write_plist so.trooper.local-heartbeat "$BIN_DIR/heartbeat.sh"

# Avoid port 18789 collisions with the managed OpenClaw node gateway
# (ai.openclaw.gateway). That service uses a different token and causes
# "gateway token mismatch" when it steals the port from Docker.
launchctl bootout "gui/$(id -u)/ai.openclaw.gateway" >/dev/null 2>&1 || true
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist" >/dev/null 2>&1 || true
# Disable so LaunchAgent KeepAlive does not steal the port again.
launchctl disable "gui/$(id -u)/ai.openclaw.gateway" >/dev/null 2>&1 || true

for label in so.trooper.local-gateway so.trooper.local-bridge so.trooper.local-tunnel so.trooper.local-heartbeat; do
  launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
  launchctl bootout "gui/$(id -u)" "$PLIST_DIR/$label.plist" >/dev/null 2>&1 || true
  if ! launchctl bootstrap "gui/$(id -u)" "$PLIST_DIR/$label.plist"; then
    if ! launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
      echo "Failed to start $label. Run: launchctl print gui/$(id -u)/$label" >&2
      exit 1
    fi
  fi
done

# Wait for gateway, auto-approve the Trooper bridge device, then wait for bridge health.
# Gateway image is amd64-emulated on Apple Silicon and can take 1–2 minutes to listen.
echo "Waiting for local gateway and bridge to become healthy..."
gateway_ready=0
for _ in $(seq 1 90); do
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 3 "http://127.0.0.1:${GATEWAY_PORT}/" 2>/dev/null || echo 000)"
  if [[ "$code" == "200" ]] || curl -fsS --max-time 2 "http://127.0.0.1:${GATEWAY_PORT}/health" 2>/dev/null | grep -q '"live"\|"ok"\|"ready"'; then
    gateway_ready=1
    break
  fi
  sleep 2
done
if [[ "$gateway_ready" != "1" ]]; then
  echo "Warning: gateway HTTP did not become ready yet; continuing. Check logs in $LOG_DIR."
else
  echo "Local gateway is accepting connections on :${GATEWAY_PORT}."
fi

# Approve pending bridge pairing inside the gateway container (required for WS operator role).
# First-time pairing often needs an explicit request id; --latest is best-effort after that.
approve_gateway_devices() {
  command -v docker >/dev/null 2>&1 || return 0
  docker ps --format '{{.Names}}' 2>/dev/null | grep -qx "${OPENCLAW_GATEWAY_CONTAINER}" || return 0
  docker exec -e OPENCLAW_GATEWAY_TOKEN="$GATEWAY_TOKEN" -e GATEWAY_TOKEN="$GATEWAY_TOKEN" \
    "${OPENCLAW_GATEWAY_CONTAINER}" \
    sh -c '
      cd /app || exit 0
      # Approve every pending request id (if the CLI prints them).
      node openclaw.mjs devices list 2>/dev/null | sed -n "s/.*requestId[=\": ]*\\([a-f0-9-]\\{36\\}\\).*/\\1/p" | while read -r rid; do
        node openclaw.mjs devices approve "$rid" 2>/dev/null || true
      done
      node openclaw.mjs devices approve --token "$GATEWAY_TOKEN" --latest 2>/dev/null || true
      node openclaw.mjs devices approve --latest 2>/dev/null || true
    ' >/dev/null 2>&1 || true
}

if command -v docker >/dev/null 2>&1 && docker ps --format '{{.Names}}' | grep -qx "${OPENCLAW_GATEWAY_CONTAINER}"; then
  echo "Approving Trooper bridge device with the local gateway..."
  approve_gateway_devices
  # Nudge bridge to reconnect after approval.
  launchctl kickstart -k "gui/$(id -u)/so.trooper.local-bridge" >/dev/null 2>&1 || true
fi

bridge_ready=0
for _ in $(seq 1 60); do
  health_json="$(curl -fsS --max-time 3 "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null || true)"
  if printf '%s' "$health_json" | grep -qE '"status":"ok"|"gateway_available":true|"websocketConnected":true'; then
    bridge_ready=1
    break
  fi
  # Retry device approval mid-wait if still pairing or missing scopes.
  if printf '%s' "$health_json" | grep -qiE 'pairing|not approved|missing scope|auth_or_pairing'; then
    approve_gateway_devices
    launchctl kickstart -k "gui/$(id -u)/so.trooper.local-bridge" >/dev/null 2>&1 || true
  fi
  sleep 2
done
if [[ "$bridge_ready" == "1" ]]; then
  echo "Local bridge is healthy and connected to the gateway."
else
  echo "Warning: bridge health is not fully green yet. Services will keep retrying in the background."
  echo "  Bridge logs: $LOG_DIR/so.trooper.local-bridge.err.log"
  echo "  Gateway logs: $LOG_DIR/so.trooper.local-gateway.err.log"
fi

# One immediate heartbeat so Trooper UI can leave "connecting..." as soon as health is ok.
if [[ -n "${ORG_ID:-}" && "${ORG_ID}" != "local-unpaired" && -x "$BIN_DIR/heartbeat.sh" ]]; then
  # Run a single heartbeat cycle without the infinite loop.
  HEALTH_JSON="$(curl -fsS --max-time 5 "http://127.0.0.1:${BRIDGE_PORT}/health" 2>/dev/null || printf '{}')"
  BODY="$(HEALTH_JSON="$HEALTH_JSON" BRIDGE_AUTH_TOKEN="$BRIDGE_AUTH_TOKEN" HOST_DEVICE_ID="$HOST_DEVICE_ID" \
    PUBLIC_BRIDGE_URL="${PUBLIC_BRIDGE_URL:-}" PUBLIC_GATEWAY_URL="${PUBLIC_GATEWAY_URL:-}" \
    BRIDGE_PORT="$BRIDGE_PORT" GATEWAY_PORT="$GATEWAY_PORT" TUNNEL_PROVIDER="${TUNNEL_PROVIDER:-cloudflare}" \
    BROWSER_MODE="${BROWSER_MODE:-managed}" python3 - <<'PY'
import json, os
try:
    health = json.loads(os.environ.get("HEALTH_JSON") or "{}")
except Exception:
    health = {}
payload = {
    "token": os.environ.get("BRIDGE_AUTH_TOKEN"),
    "hostDeviceId": os.environ.get("HOST_DEVICE_ID"),
    "bridgeUrl": os.environ.get("PUBLIC_BRIDGE_URL") or f"http://127.0.0.1:{os.environ.get('BRIDGE_PORT', '3002')}",
    "gatewayUrl": os.environ.get("PUBLIC_GATEWAY_URL") or f"http://127.0.0.1:{os.environ.get('GATEWAY_PORT', '18789')}",
    "tunnelProvider": os.environ.get("TUNNEL_PROVIDER") or "cloudflare",
    "platform": "macOS",
    "status": "ready" if health.get("status") == "ok" else "local_pending",
    "health": health,
    "browserModes": {"default": os.environ.get("BROWSER_MODE") or "managed", "managed": True, "existingOsBrowser": True, "vpsDesktop": False},
}
print(json.dumps(payload, separators=(",", ":")))
PY
)"
  curl -fsS -X POST "$API_URL/api/organizations/$ORG_ID/local-host/heartbeat" \
    -H 'Content-Type: application/json' --data "$BODY" >/dev/null 2>&1 || true
fi

cat <<EOF
Trooper Local Mac Host installed.

Host device: $HOST_DEVICE_ID
Runtime dir: $TROOPER_HOME
Bridge: http://127.0.0.1:$BRIDGE_PORT
Gateway: http://127.0.0.1:$GATEWAY_PORT

If you installed without a Trooper setup token, open Trooper to connect this Mac
to a workspace. The local host can keep running while it waits for pairing.

This Mac mode does not install LXQt, Xvnc, noVNC, or a Linux desktop.
For hosted app access, configure PUBLIC_BRIDGE_URL/PUBLIC_GATEWAY_URL or CLOUDFLARE_TUNNEL_TOKEN in:
$ENV_FILE
EOF
