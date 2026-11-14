// End-to-end test for the installable web app (app/). Serves the repo locally, fakes xKiro
// with Playwright request routing, and drives the real page.  Run: node tests/app-e2e.mjs
import { createRequire } from 'node:module';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
const { chromium } = createRequire(import.meta.url)('playwright');

const results = [];
const check = (c, n) => { results.push(!!c); console.log((c ? 'PASS ' : 'FAIL ') + n); };
const ROOT = process.cwd();
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const server = http.createServer(async (req, res) => {
  const p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, p.endsWith('/') ? p + 'index.html' : p);
  try { const b = await readFile(file); res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' }); res.end(b); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const ORIGIN = `http://127.0.0.1:${server.address().port}`;

const seen = [];
let mode = 'ok';
const browser = await chromium.launch();
const ctx = await browser.newContext({ serviceWorkers: 'block' });
await ctx.route('https://api.xkiro.com/**', async route => {
  const req = route.request(); const url = req.url();
  if (mode === 'blocked') return route.abort('failed');
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...cors, 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' } });
  if (req.headers()['x-api-key'] !== 'test-key-123456') return route.fulfill({ status: 401, headers: cors, body: '{"error":{"message":"bad key"}}' });
  if (url.endsWith('/v1/models')) return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ data: [
    { id: 'mistralai/mistral-large-2512', tier: 'free', context_length: 128000 },
    { id: 'mistralai/mistral-small-2603', pricing: { prompt: 0, completion: 0 }, context_length: 32000 },
    { id: 'paid/model', pricing: { prompt: 3, completion: 9 } }] }) });
  if (url.endsWith('/v1/fetch')) return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Garden signup', content: 'Shifts run Saturdays 9am to 1pm at 14 Elm Street.' }) });
  if (url.endsWith('/v1/chat/completions')) {
    const j = JSON.parse(req.postData()); seen.push(j);
    const user = j.messages[j.messages.length - 1].content;
    const text = /MY REQUEST: Draft/.test(user)
      ? 'Here is a short reply you can paste.\n<<<ACTIONS>>>\n[{"type":"insert","text":"Thanks! I can make the Saturday shift."}]'
      : 'The shifts are on **Saturdays** from 9am to 1pm.';
    const sse = text.match(/[\s\S]{1,10}/g).map(p => 'data: ' + JSON.stringify({ choices: [{ delta: { content: p } }] }) + '\n\n').join('') + 'data: [DONE]\n\n';
    return route.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'text/event-stream' }, body: sse });
  }
  return route.fulfill({ status: 404, headers: cors, body: '{}' });
});

const page = await ctx.newPage();
const errors = []; page.on('pageerror', e => errors.push(e.message));

// 1) Installable: manifest, icons, share target
const man = await (await page.request.get(ORIGIN + '/app/manifest.webmanifest')).json();
check(man.display === 'standalone' && man.icons.some(i => i.sizes === '512x512') && man.icons.some(i => i.sizes === '192x192'), 'manifest is installable (standalone, 192 and 512 icons)');
check(man.share_target && man.share_target.params.url === 'url', 'appears in Chrome\'s Share menu once installed (share_target)');
for (const ic of man.icons) check((await page.request.get(ORIGIN + '/app/' + ic.src)).ok(), 'icon loads: ' + ic.src);

// 2) Opening from Share fills the page box
await page.goto(ORIGIN + '/app/?title=Garden%20signup&text=Shifts%20run%20Saturdays%209am%20to%201pm.&url=https%3A%2F%2Fexample.com%2Fsignup');
check((await page.inputValue('#pageUrl')) === 'https://example.com/signup' && (await page.inputValue('#pageText')).includes('Saturdays'), 'shared page arrives in the page box');
check(!page.url().includes('?'), 'shared data removed from the address bar');
check(await page.isVisible('#banner'), 'asks for the API key first');

// 3) Settings
await page.click('#settingsBtn');
await page.fill('#apiKey', 'test-key-123456'); await page.click('#saveKey');
await page.click('#testKey');
await page.waitForFunction(() => /Connected to xKiro/.test(document.querySelector('#keyMsg').textContent));
check((await page.textContent('#keyMsg')).includes('3 models, 2 usable'), 'test connection lists models; paid one not usable');
await page.click('#settingsBtn');

// 4) Ask a question about the shared page
await page.fill('#q', 'When are the shifts?'); await page.press('#q', 'Enter');
await page.waitForSelector('.msga .meta');
check((await page.textContent('.msga .answer')).includes('Saturdays'), 'answers from the shared page text');
check(seen[0].model === 'mistralai/mistral-small-2603' && seen[0].stream === true, 'simple question: fast free model, streamed');
check(seen[0].messages.at(-1).content.includes('<<<UNTRUSTED_PAGE_'), 'page text sent as untrusted data');

// 5) Writing request gives a copy block
await page.fill('#q', 'Draft a reply saying I can come'); await page.press('#q', 'Enter');
await page.waitForFunction(() => document.querySelectorAll('.msga .meta').length === 2);
check((await page.textContent('.copyblock .new')) === 'Thanks! I can make the Saturday shift.', 'drafted text shown in a Copy block');
check(!(await page.textContent('.msga:last-child .answer')).includes('<<<'), 'action marker never shown');
check(seen[1].model === 'mistralai/mistral-large-2512', 'writing: strong free model');

// 6) Read link through xKiro fetch
await page.fill('#pageText', ''); await page.fill('#pageUrl', 'https://example.com/other'); await page.click('#readUrl');
await page.waitForFunction(() => /Read \d/.test(document.querySelector('#pageMsg').textContent));
check((await page.inputValue('#pageText')).includes('14 Elm Street'), 'Read link loads the page text through xKiro');

// 7) xKiro not allowing browser requests -> clear message
mode = 'blocked';
await page.fill('#q', 'When?'); await page.press('#q', 'Enter');
await page.waitForSelector('.msga:last-child .msg.err');
check((await page.textContent('.msga:last-child .msg.err')).includes('does not accept requests made directly from a web page'), 'clear message if xKiro blocks browser requests');

check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''));
await page.setViewportSize({ width: 420, height: 820 });
await page.screenshot({ path: 'tests/app.png' });
await browser.close(); server.close();
const failed = results.filter(x => !x).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
