# ACP harness CLI login — verified command lines and flow

This is the ground-truth reference for how each ACP harness CLI authenticates,
verified against the pinned CLI versions installed in the gateway image
(`Dockerfile`): claude `2.1.220`, codex `0.146.0`, opencode `1.14.48`,
kimi `0.30.0`, copilot `1.0.75`.

The same command lines work in any terminal — locally, over SSH on a VPS, or
inside the gateway container — because every one of these CLIs supports a
headless flow (device code or paste-back code). What matters is **where the
credential is written**, not where your browser runs: the login must run as the
gateway `node` user with the same `$HOME` (and env overrides) the acpx-spawned
harness process uses, or the harness will not see it.

## Per-harness login commands

| Harness | Login (headless-capable) | Status probe | Credential location (in-container) |
| --- | --- | --- | --- |
| Claude Code | `claude auth login` | `claude auth status --json` | `~/.claude/.credentials.json` → `/home/node/.openclaw/acpx/claude-home` (symlinked) |
| Codex | `CODEX_HOME=/home/node/.openclaw/acpx/codex-home codex -c 'cli_auth_credentials_store="file"' login --device-auth` | `codex login status` (same env) | `/home/node/.openclaw/acpx/codex-home/auth.json` |
| OpenCode · ChatGPT | `opencode auth login --provider openai --method 'ChatGPT Pro/Plus (headless)'` | `opencode auth list` | `~/.local/share/opencode/auth.json` → `/home/node/.openclaw/acpx/data/opencode` (symlinked) |
| OpenCode · xAI/Grok | `opencode auth login --provider xai` (prompts **Enter your API key**) | `opencode auth list` | same as above |
| OpenCode · Copilot | `opencode auth login --provider github-copilot --method 'Login with GitHub Copilot'` (accept the `GitHub.com` deployment prompt with Enter) | `opencode auth list` | same as above |
| GitHub Copilot | `copilot login` | none (device flow, verified by first run) | `~/.copilot` → `/home/node/.openclaw/acpx/copilot-home` (symlinked); env token fallback: `COPILOT_GITHUB_TOKEN`/`GH_TOKEN`/`GITHUB_TOKEN` |
| Kimi Code | `kimi login` | none (device flow) | `~/.kimi-code` → `/home/node/.openclaw/acpx/kimi-home` (symlinked) |

Notes that took real debugging to learn — do not regress them:

- **Claude prints its OAuth URL on `claude.com`** (`https://claude.com/cai/oauth/authorize?...`),
  not `claude.ai`, and then waits on the prompt `Paste code here if prompted >`.
  The bridge's URL allowlist and prompt matcher must recognize both strings.
- **Claude/`claude auth login` emits nothing when stdin is closed.** The child
  must be spawned with an open stdin pipe; with piped stdio it prints the URL
  and code prompt normally.
- **OpenCode without `--method` renders an interactive arrow-key picker**
  (`Login method: ChatGPT Pro/Plus (browser) / ChatGPT Pro/Plus (headless) /
  Manually enter API Key`). A headless job hangs there forever. Method labels
  must match the CLI exactly; a mismatch fails fast with
  `Unknown method "…" for openai. Available: …`.
- **Interactive prompts submit on carriage return (`\r`), not `\n`.**
  Writing `code\n` into OpenCode's clack prompts is silently ignored. The
  bridge submits `\r\n`, which both clack/ink prompts and plain readline
  accept.
- **`opencode auth list` prints display labels** (`OpenAI oauth`,
  `GitHub Copilot oauth`, `xAI api`) — never grep it for raw provider ids
  like `github-copilot`.
- **OpenCode's xAI provider is API-key only** (key from
  `console.x.ai`); there is no SuperGrok OAuth in the CLI. The hosted flow
  prompts for the key and forwards it straight to the CLI's stdin.
- **Codex device auth** talks to `auth.openai.com`; device-code login must be
  enabled for the ChatGPT account/workspace or the CLI reports
  `enable device code authorization for codex`.
- **Kimi device auth** talks to `auth.kimi.com` and stores state under
  `~/.kimi-code` (it ignores XDG variables).

## How the hosted flow uses these commands

1. Trooper UI (`AcpHostedLoginPanel`) → control plane
   `/api/organizations/:orgId/acp/auth/:harness/jobs` → bridge
   `/gateway/acp/auth/:harness/jobs`.
2. The bridge (`lib/acp-account-auth.mjs`, `lib/codex-device-auth.mjs`)
   `docker exec`s the fixed catalog command in the gateway container as the
   `node` user with the persistent ACP homes above, keeps stdin open, and
   streams output.
3. The output parser extracts the verification URL + one-time code (allowlisted
   hosts only) and flips the job to `waiting_for_browser` /
   `waiting_for_input`; pasted codes/API keys are forwarded to the CLI's stdin
   with `\r\n` and never stored.
4. After the CLI exits, the bridge re-verifies with the harness's own status
   probe before reporting `connected`.

## Why logins survive restarts

Only `/home/node/.openclaw` is a mounted volume. `entrypoint.sh`/`startup.sh`
link each CLI's `$HOME` state dir into `/home/node/.openclaw/acpx/…`
(`claude-home`, `kimi-home`, `copilot-home`, `data/opencode`), migrating any
existing image-local credentials once. This is also what keeps the login-time
environment and the acpx runtime environment pointed at the same credential
store:

- the acpx claude/kimi/copilot adapters inherit the gateway env (`HOME=/home/node`)
  and read through the symlinks;
- OpenCode's managed ACPX agent command pins `OPENCODE_CONFIG` under
  `/home/node/.openclaw/acpx/opencode-config`, and its auth store resolves
  through the `data/opencode` symlink;
- Codex uses the acpx plugin's own isolated `CODEX_HOME`
  (`/home/node/.openclaw/acpx/codex-home`), which is the exact directory the
  managed device-auth job writes.

## Manual login on a VPS (fallback)

If the hosted flow is unavailable, SSH to the VPS and run the login **inside
the gateway container as the node user** — a login in the root SSH home
authenticates the wrong `$HOME` and the harness will not see it:

```bash
docker exec -it -u node -e HOME=/home/node <gateway-container> claude auth login
docker exec -it -u node -e HOME=/home/node <gateway-container> \
  opencode auth login --provider openai --method 'ChatGPT Pro/Plus (headless)'
docker exec -it -u node -e HOME=/home/node <gateway-container> copilot login
docker exec -it -u node -e HOME=/home/node <gateway-container> kimi login
docker exec -it -u node -e HOME=/home/node \
  -e CODEX_HOME=/home/node/.openclaw/acpx/codex-home \
  -e CODEX_CLI_AUTH_CREDENTIALS_STORE=file \
  <gateway-container> codex login --device-auth
```

Then refresh status in Trooper (`/acp/agents` re-probes each CLI).
