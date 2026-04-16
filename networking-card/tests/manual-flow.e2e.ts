import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

const cwd = process.cwd();
const devVarsPath = path.join(cwd, '.dev.vars');
const localPersistPath = path.join(cwd, '.wrangler/state/e2e');
const token = 'e2e-token';
const baseUrl = 'http://localhost:8788';

async function runCommand(args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('npx', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('exit', (code) => {
      if (code === 0) {
        resolve(stdout || stderr);
        return;
      }

      reject(new Error(`Command failed (${args.join(' ')}):\n${stdout}\n${stderr}`));
    });
  });
}

async function waitForServer(url: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // Server not ready yet.
    }

    await delay(300);
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function withTemporaryDevVars(contents: string, fn: () => Promise<void>) {
  let previousContents: string | null = null;

  try {
    previousContents = await readFile(devVarsPath, 'utf8');
  } catch {
    previousContents = null;
  }

  await writeFile(devVarsPath, contents, 'utf8');

  try {
    await fn();
  } finally {
    if (previousContents === null) {
      await rm(devVarsPath, { force: true });
    } else {
      await writeFile(devVarsPath, previousContents, 'utf8');
    }
  }
}

async function main() {
  const devVars = [
    'GOOGLE_CLIENT_ID=test-google-client-id',
    'RESEND_API_KEY=test-resend-api-key',
    'DISCORD_WEBHOOK_URL=https://discord.example.test/webhook',
    'DISABLE_OUTBOUND_NOTIFICATIONS=true',
  ].join('\n');

  await withTemporaryDevVars(devVars, async () => {
    await rm(localPersistPath, { recursive: true, force: true });
    for (const migration of ['migrations/0001_init.sql', 'migrations/0002_hardening.sql', 'migrations/0003_contact_methods.sql', 'migrations/0004_contact_events.sql', 'migrations/0005_vcard_profile.sql']) {
      await runCommand([
        'wrangler',
        'd1',
        'execute',
        'DB',
        '--local',
        '--persist-to',
        localPersistPath,
        '--file',
        migration,
      ]);
    }
    await runCommand([
      'wrangler',
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      localPersistPath,
      '--command',
      [
        'DELETE FROM contacts;',
        'DELETE FROM taps;',
        'DELETE FROM cards;',
        `INSERT INTO cards (token, label) VALUES ('${token}', 'card-e2e');`,
      ].join(' '),
    ]);

    const devServer = spawn(
      'npx',
      ['wrangler', 'pages', 'dev', 'public', '--port', '8788', '--persist-to', localPersistPath],
      {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      },
    );

    let logs = '';
    devServer.stdout.on('data', (chunk) => {
      logs += chunk.toString();
    });
    devServer.stderr.on('data', (chunk) => {
      logs += chunk.toString();
    });

    try {
      await waitForServer(`${baseUrl}/hi/${token}`);

      const browser = await chromium.launch();
      const page = await browser.newPage();

      try {
        await page.goto(`${baseUrl}/hi/${token}`, { waitUntil: 'networkidle' });

        await assert.doesNotReject(async () => {
          await page.getByRole('link', { name: 'Save David’s contact' }).waitFor();
        });

        await assert.doesNotReject(async () => {
          await page.locator('#g_id_onload').waitFor({ state: 'attached' });
        });
        assert.equal(
          await page.locator('#g_id_onload').getAttribute('data-callback'),
          'handleGisResponse',
        );
        assert.equal(
          await page.locator('#g_id_onload').getAttribute('data-use_fedcm_for_button'),
          'true',
        );
        await assert.doesNotReject(async () => {
          await page.locator('.g_id_signin').waitFor({ state: 'attached' });
        });

        await page.getByRole('button', { name: 'Or enter your info manually' }).click();
        await page.getByLabel('Name').fill('E2E Manual Tester');
        await page.getByLabel('Email').fill('e2e.manual@example.com');
        await page.getByLabel('Company (optional)').fill('Dazbeez QA');
        await page.getByRole('button', { name: 'Send' }).click();

        await page.waitForURL(/\/thanks\?contact_id=\d+/, { timeout: 10_000 });
        await assert.doesNotReject(async () => {
          await page.getByRole('link', { name: 'Save my contact' }).waitFor();
        });
        await assert.doesNotReject(async () => {
          await page.getByRole('link', { name: 'What I do' }).waitFor();
        });

        const dbOutput = await runCommand([
          'wrangler',
          'd1',
          'execute',
          'DB',
          '--local',
          '--persist-to',
          localPersistPath,
          '--json',
          '--command',
          'SELECT name, email, source FROM contacts ORDER BY id DESC LIMIT 1;',
        ]);
        const parsed = JSON.parse(dbOutput) as Array<{
          results: Array<{ name: string; email: string; source: string }>;
        }>;
        const lastContact = parsed[0]?.results?.[0];

        assert.deepEqual(lastContact, {
          name: 'E2E Manual Tester',
          email: 'e2e.manual@example.com',
          source: 'manual',
        });
      } finally {
        await page.close();
        await browser.close();
      }
    } finally {
      devServer.kill('SIGTERM');
      await new Promise((resolve) => devServer.once('exit', resolve));
      if (logs.includes('ERROR')) {
        process.stderr.write(logs);
      }
    }
  });

  process.stdout.write('Manual NFC e2e flow passed.\n');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
