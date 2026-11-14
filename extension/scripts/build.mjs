// Builds one unpacked folder and one zip per browser family into dist/.
//   node scripts/build.mjs
import { cpSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const base = {
  manifest_version: 3,
  name: 'Universal Page AI',
  version: pkg.version,
  description: 'Ask about any web page, get answers, and have it write into text boxes and forms. Uses your own xKiro key.',
  icons: { 16: 'icons/icon16.png', 32: 'icons/icon32.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' },
  action: { default_title: 'Universal Page AI', default_icon: { 16: 'icons/icon16.png', 32: 'icons/icon32.png' } },
  permissions: ['storage', 'scripting', 'tabs', 'contextMenus'],
  host_permissions: ['<all_urls>'],
  commands: { 'open-panel': { suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+Y' }, description: 'Open Universal Page AI' } }
};

const targets = {
  chromium: { // Chrome, Edge, Brave, Opera, Vivaldi
    ...base,
    permissions: [...base.permissions, 'sidePanel'],
    background: { service_worker: 'background.js' },
    side_panel: { default_path: 'panel.html' },
    minimum_chrome_version: '116'
  },
  firefox: {
    ...base,
    background: { scripts: ['lib/core.js', 'background.js'] },
    sidebar_action: { default_panel: 'panel.html', default_title: 'Universal Page AI', default_icon: 'icons/icon32.png', open_at_install: false },
    browser_specific_settings: { gecko: { id: 'universal-page-ai@congerie.studio', strict_min_version: '115.0' } }
  }
};

rmSync('dist', { recursive: true, force: true });
for (const [name, manifest] of Object.entries(targets)) {
  const dir = join('dist', name);
  mkdirSync(dir, { recursive: true });
  cpSync('src', dir, { recursive: true });
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  execSync(`cd ${dir} && zip -qr ../universal-page-ai-${name}-${pkg.version}.zip .`);
  console.log('built', dir);
}
