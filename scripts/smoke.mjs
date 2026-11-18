/**
 * scripts/smoke.mjs — post-deploy smoke test against a live deployment.
 *
 * Usage:
 *   node scripts/smoke.mjs https://<worker>.<account>.workers.dev
 *   node scripts/smoke.mjs http://127.0.0.1:8787
 */
const base = (process.argv[2] || '').replace(/\/+$/, '');
if (!base) {
  console.error('usage: node scripts/smoke.mjs https://<worker>.<account>.workers.dev');
  process.exit(1);
}

const checks = [];

async function check(name, fn) {
  try {
    await fn();
    console.log('ok   ' + name);
  } catch (err) {
    console.error('FAIL ' + name + ': ' + err.message);
    checks.push(name);
  }
}

await check('GET /api/health', async () => {
  const body = await (await fetch(base + '/api/health')).json();
  if (!body.ok) throw new Error('ok=false');
});

await check('GET / serves the translator page', async () => {
  const res = await fetch(base + '/');
  const text = await res.text();
  if (!res.ok) throw new Error('status ' + res.status);
  if (!text.includes('<html') || !text.includes('translate')) throw new Error('unexpected HTML');
});

await check('GET /api/languages', async () => {
  const body = await (await fetch(base + '/api/languages')).json();
  if (!body.ok || !body.data || !body.data.count) throw new Error('bad payload');
  console.log('     ' + body.data.count + ' languages');
});

await check('POST /api/translate (hello -> zh-CN)', async () => {
  const res = await fetch(base + '/api/translate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ q: 'hello', sl: 'auto', tl: 'zh-CN' }),
  });
  const body = await res.json();
  if (!body.ok || !body.data || !body.data.translatedText) {
    throw new Error(JSON.stringify(body).slice(0, 200));
  }
  console.log('     hello -> ' + body.data.translatedText);
});

await check('GET /api/translate rejects missing tl', async () => {
  const body = await (await fetch(base + '/api/translate?q=hello')).json();
  if (body.ok || body.error.code !== 'BAD_REQUEST') throw new Error('expected 400 BAD_REQUEST');
});

if (checks.length) {
  console.error('smoke FAILED: ' + checks.join(', '));
  process.exit(1);
}
console.log('smoke passed');
