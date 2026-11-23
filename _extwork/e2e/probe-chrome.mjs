import path from 'node:path';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const ROOT = 'C:/Users/20823/Documents/deepseek-harness/default-workspace';
const EXT = path.join(ROOT, '_extwork/e2e/dummy-ext');
const PROFILE = path.join(ROOT, '_extwork/e2e/profile-dummy');

fs.rmSync(PROFILE, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: true,
  userDataDir: PROFILE,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--enable-logging=stderr',
    '--v=0',
  ],
});

try {
  console.log('browser launched:', await browser.version());
  const swTarget = await browser.waitForTarget(
    (t) => t.type() === 'service_worker' && t.url().startsWith('chrome-extension://'),
    { timeout: 20000 }
  );
  const extId = new URL(swTarget.url()).host;
  console.log('extension id:', extId, 'sw url:', swTarget.url());

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console.error: ' + m.text());
  });
  await page.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'domcontentloaded' });
  await new Promise((r) => setTimeout(r, 800));
  const text = await page.$eval('body', (b) => b.innerText);
  console.log('popup body:', JSON.stringify(text));
  console.log('errors:', errors);
  console.log('RESULT:', text.includes('DUMMY OK') && errors.length === 0 ? 'PASS' : 'FAIL');
} finally {
  await browser.close();
}
