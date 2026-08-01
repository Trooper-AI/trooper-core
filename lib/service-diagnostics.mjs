function present(env, name) {
  return typeof env?.[name] === 'string' && env[name].trim().length > 0;
}

function item({ id, name, category, status, headline, check, envNames = [], links = {} }) {
  return { id, name, category, status, headline, check, envNames, links };
}

/**
 * Secret-safe runtime dependency inventory included in /admin/health.
 * This intentionally reports only presence and observed local state; the
 * control plane performs credential/quota probes to external providers.
 */
export function buildRuntimeServiceDiagnostics({
  env = process.env,
  gatewayConnected = false,
  browserResponsive = false,
} = {}) {
  const controlPlaneConfigured = ['MISSION_CONTROL_URL', 'TROOPER_CALLBACK_URL', 'TROOPER_PUBLIC_URL'].some((name) => present(env, name));
  const firebaseConfigured = present(env, 'FIREBASE_PROJECT_ID')
    && ['FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS'].some((name) => present(env, name));
  const providerKeysManaged = present(env, 'OPENCLAW_COMPANY_PROVIDER_KEYS');
  const openRouterConfigured = present(env, 'OPENROUTER_API_KEY') || providerKeysManaged;
  const githubReposConfigured = present(env, 'TROOPER_GITHUB_REPOS') || present(env, 'TROOPER_GITHUB_PAGES');
  const githubTokenConfigured = present(env, 'TROOPER_GITHUB_TOKEN') || present(env, 'GITHUB_TOKEN');
  const tunnelConfigured = present(env, 'TUNNEL_ID') || present(env, 'PUBLIC_BRIDGE_URL') || present(env, 'PUBLIC_BASE_URL');
  const emailEnabled = String(env.TROOPER_EMAIL_ENABLED || '').trim() === '1';

  const items = [
    item({
      id: 'openclaw-gateway', name: 'OpenClaw gateway', category: 'Runtime',
      status: gatewayConnected ? 'healthy' : 'error',
      headline: gatewayConnected ? 'Gateway connected' : 'Gateway disconnected',
      check: gatewayConnected
        ? 'No action needed.'
        : 'Check the openclaw-gateway container, port 18789, gateway token and bridge logs.',
      envNames: ['OPENCLAW_GATEWAY_TOKEN', 'OPENCLAW_GATEWAY_CONTAINER'],
    }),
    item({
      id: 'trooper-control-plane', name: 'Trooper control plane', category: 'Runtime',
      status: controlPlaneConfigured ? 'configured' : 'warning',
      headline: controlPlaneConfigured ? 'Callback target configured' : 'Control-plane callback is missing',
      check: controlPlaneConfigured
        ? 'If heartbeats are missing, check outbound DNS/TLS and the control-plane deployment logs.'
        : 'Set MISSION_CONTROL_URL or TROOPER_CALLBACK_URL and restart Trooper Core.',
      envNames: ['MISSION_CONTROL_URL', 'TROOPER_CALLBACK_URL', 'TROOPER_PUBLIC_URL'],
    }),
    item({
      id: 'firebase', name: 'Firebase', category: 'Data',
      status: firebaseConfigured ? 'configured' : 'warning',
      headline: firebaseConfigured ? 'Runtime Firebase identity configured' : 'Runtime Firebase configuration is incomplete',
      check: firebaseConfigured
        ? 'Use Fleet Recovery Center for the live credential and quota check.'
        : 'Check FIREBASE_PROJECT_ID and the runtime service-account secret.',
      envNames: ['FIREBASE_PROJECT_ID', 'FIREBASE_SERVICE_ACCOUNT', 'GOOGLE_APPLICATION_CREDENTIALS'],
      links: { status: 'https://status.firebase.google.com/' },
    }),
    item({
      id: 'openrouter', name: 'OpenRouter', category: 'AI',
      status: openRouterConfigured ? 'configured' : 'warning',
      headline: openRouterConfigured ? 'Model credentials supplied' : 'No runtime OpenRouter/company provider keys detected',
      check: openRouterConfigured
        ? 'Use Fleet Recovery Center to check key balance and limits.'
        : 'Supply OPENROUTER_API_KEY or OPENCLAW_COMPANY_PROVIDER_KEYS, then restart the gateway.',
      envNames: ['OPENROUTER_API_KEY', 'OPENCLAW_COMPANY_PROVIDER_KEYS'],
      links: { console: 'https://openrouter.ai/settings/credits', status: 'https://status.openrouter.ai/' },
    }),
    item({
      id: 'github', name: 'GitHub', category: 'Integrations',
      status: githubReposConfigured && githubTokenConfigured ? 'configured' : githubReposConfigured ? 'warning' : 'disabled',
      headline: githubReposConfigured && githubTokenConfigured
        ? 'Repository integration configured'
        : githubReposConfigured
          ? 'Repositories configured but GitHub token is missing'
          : 'GitHub workspace integration not enabled',
      check: githubReposConfigured && !githubTokenConfigured
        ? 'Set TROOPER_GITHUB_TOKEN with repository access and restart Trooper Core.'
        : 'Check repository permissions and GitHub Actions when pulls or publishes fail.',
      envNames: ['TROOPER_GITHUB_REPOS', 'TROOPER_GITHUB_TOKEN', 'GITHUB_TOKEN'],
      links: { status: 'https://www.githubstatus.com/' },
    }),
    item({
      id: 'public-tunnel', name: 'Public tunnel', category: 'Network',
      status: tunnelConfigured ? 'configured' : 'warning',
      headline: tunnelConfigured ? 'Public bridge route configured' : 'No public bridge/tunnel route detected',
      check: tunnelConfigured
        ? 'Check Cloudflare/Tailscale tunnel state, DNS and TLS when the bridge is unreachable.'
        : 'Set the managed public bridge URL or tunnel configuration for cloud workspaces.',
      envNames: ['TUNNEL_ID', 'TUNNEL_PROVIDER', 'PUBLIC_BRIDGE_URL', 'PUBLIC_BASE_URL'],
    }),
    item({
      id: 'browser-runtime', name: 'Browser runtime', category: 'Runtime',
      status: browserResponsive ? 'healthy' : 'warning',
      headline: browserResponsive ? 'Browser control is responsive' : 'Browser control is not responsive',
      check: browserResponsive
        ? 'No action needed.'
        : 'Check browser mode, Chromium process, port 18791 and gateway browser logs.',
      envNames: ['BROWSER_MODE', 'DISPLAY'],
    }),
    item({
      id: 'email-runtime', name: 'Runtime email', category: 'Integrations',
      status: emailEnabled ? 'configured' : 'disabled',
      headline: emailEnabled ? 'Runtime email integration enabled' : 'Runtime email integration disabled',
      check: emailEnabled
        ? 'Check the control-plane Resend/SES health, account assignment and runtime email logs.'
        : 'Enable TROOPER_EMAIL_ENABLED only for workspaces that should receive email wake events.',
      envNames: ['TROOPER_EMAIL_ENABLED'],
    }),
  ];

  const summary = { total: items.length, healthy: 0, configured: 0, warning: 0, error: 0, disabled: 0 };
  for (const service of items) summary[service.status] = (summary[service.status] || 0) + 1;
  summary.attentionCount = summary.warning + summary.error;
  return { summary, items };
}
