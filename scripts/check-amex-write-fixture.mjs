// Local-only mounted regression gate. Uses installed esbuild/Tailwind and Chrome's CDP pipe.
import { build } from 'esbuild';
import postcss from 'postcss';
import tailwind from '@tailwindcss/postcss';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const root = process.cwd();
const output = await mkdtemp(path.join(tmpdir(), 'amex-mounted-'));
await build({ entryPoints: ['tests/receipts/fixture/amex-entry.tsx'], bundle: true, outfile: path.join(output, 'fixture.js'), platform: 'browser', jsx: 'automatic',
  alias: { '@': root, 'next/navigation': path.join(root, 'tests/receipts/fixture/nav-shim.ts'), 'next/link': path.join(root, 'tests/receipts/fixture/link-shim.tsx') },
  define: { 'process.env.NODE_ENV': '"development"', 'process.env': '{}' } });
const css = await postcss([tailwind({ base: root })]).process(await readFile('app/globals.css', 'utf8'), { from: path.join(root, 'app/globals.css') });
await writeFile(path.join(output, 'style.css'), css.css);
await writeFile(path.join(output, 'index.html'), '<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="style.css"><div id="app"></div><script src="fixture.js"></script></html>');
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--host-resolver-rules=MAP * ~NOTFOUND', `--user-data-dir=${output}/profile`, '--remote-debugging-pipe'], { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
let seq = 0, buffer = ''; const waiting = new Map();
chrome.stdio[4].on('data', chunk => {
  buffer += chunk.toString(); let split;
  while ((split = buffer.indexOf('\0')) >= 0) {
    const text = buffer.slice(0, split); buffer = buffer.slice(split + 1); if (!text) continue;
    const event = JSON.parse(text);
    if (event.method === 'Runtime.exceptionThrown') console.error('BROWSER', event.params.exceptionDetails.exception?.description ?? event.params.exceptionDetails.text);
    const p = waiting.get(event.id);
    if (p) { waiting.delete(event.id); if (event.error) p.reject(Error(JSON.stringify(event.error))); else p.resolve(event.result); }
  }
});
function cdp(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => { const id = ++seq; waiting.set(id, { resolve, reject }); chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0'); });
}
const timeout = setTimeout(() => { chrome.kill(); console.error(`Fixture timed out: ${output}`); process.exitCode = 1; }, 60000);
try {
  for (const width of [375, 1024]) {
    const { targetId } = await cdp('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp('Target.attachToTarget', { targetId, flatten: true });
    await cdp('Emulation.setDeviceMetricsOverride', { width, height: 1000, deviceScaleFactor: 1, mobile: false }, sessionId);
    await cdp('Runtime.enable', {}, sessionId);
    await cdp('Page.navigate', { url: `file://${output}/index.html` }, sessionId);
    let result;
    for (let i = 0; i < 500; i++) {
      const { result: r } = await cdp('Runtime.evaluate', { expression: 'document.getElementById("result")?.textContent', returnByValue: true }, sessionId);
      if (r.value) { result = JSON.parse(r.value); break; }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!result) console.error(await cdp('Runtime.evaluate', { expression: 'document.body.innerHTML.slice(0,2000)', returnByValue: true }, sessionId));
    const { data } = await cdp('Page.captureScreenshot', { format: 'png' }, sessionId);
    await writeFile(`${output}/${width}.png`, Buffer.from(data, 'base64'));
    console.log(JSON.stringify({ width, result, screenshot: `${output}/${width}.png` }));
    assert.equal(result?.pass, true, result?.error ?? 'fixture did not finish'); assert.equal(result.width, width);
    await cdp('Target.closeTarget', { targetId });
  }
  console.log(`Mounted fixture artifacts: ${output}`);
} finally { clearTimeout(timeout); chrome.kill(); }
