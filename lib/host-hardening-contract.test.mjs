import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

function read(relativePath) {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

function bridgeUnitTemplate(setup) {
  const start = setup.indexOf('cat > /etc/systemd/system/openclaw-bridge.service');
  assert.ok(start > -1, 'setup must write openclaw-bridge.service');
  const end = setup.indexOf('\nBSVC', start);
  assert.ok(end > start, 'bridge unit heredoc must close with BSVC');
  return setup.slice(start, end);
}

test('openclaw-bridge.service stops in 15s instead of systemd default 90s', () => {
  const unit = bridgeUnitTemplate(read('setup-openclaw-full.sh'));
  assert.match(unit, /TimeoutStopSec=15/);
  assert.match(unit, /KillMode=mixed/);
});

test('setup aliases Chromium names to google-chrome-stable when Chrome is present', () => {
  const setup = read('setup-openclaw-full.sh');
  assert.match(setup, /_ensure_chrome_chromium_aliases\(\)/);
  assert.match(setup, /ln -sfn "\$chrome" "\$dest"/);
  assert.match(setup, /for name in chromium chromium-browser;/);
  assert.equal(
    (setup.match(/_ensure_chrome_chromium_aliases$/gm) || []).length,
    2,
    'aliases must run after Playwright is written and again before daemon-reload',
  );
});

test('gateway image aliases Chromium names after installing Chrome', () => {
  const dockerfile = read('Dockerfile');
  const chromeInstall = dockerfile.indexOf('google-chrome-stable_current_amd64.deb');
  const chromiumLink = dockerfile.indexOf('ln -sfn /usr/bin/google-chrome-stable /usr/bin/chromium-browser');
  assert.ok(chromeInstall > -1, 'Dockerfile must install google-chrome-stable');
  assert.ok(chromiumLink > chromeInstall, 'chromium-browser symlink must follow Chrome install');
  assert.match(dockerfile, /ln -sfn \/usr\/bin\/google-chrome-stable \/usr\/bin\/chromium\b/);
});
