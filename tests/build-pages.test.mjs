import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { buildPages } from '../scripts/build-pages.mjs';

const assets = ['index.html', 'party-api.js', 'party-host.js', 'party-host.css'];
async function fixture(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'gender-build-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all(assets.map(file => writeFile(path.join(root, file), `fixture for ${file}`)));
  await writeFile(path.join(root, 'party-config.js'), 'not the generated config');
  await writeFile(path.join(root, 'README.md'), 'not a public runtime asset');
  return root;
}
async function readConfig(output) {
  const context = { window: {} };
  vm.runInNewContext(await readFile(path.join(output, 'party-config.js'), 'utf8'), context);
  return context.window.PARTY_CONFIG;
}
const requiredEnv = {
  VITE_FIREBASE_API_KEY: 'public-api-key',
  VITE_FIREBASE_AUTH_DOMAIN: 'example.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'example-project',
  VITE_FIREBASE_APP_ID: '1:123:web:456'
};

test('empty environment publishes complete standalone runtime only', async t => {
  const root = await fixture(t);
  const result = await buildPages({ root, env: {} });
  assert.equal(result.configured, false);
  assert.deepEqual((await readdir(result.output)).sort(), [...assets, '.nojekyll', 'party-config.js'].sort());
  const config = await readConfig(result.output);
  assert.equal(config.provider, 'firebase');
  assert.equal(config.hostEmail, 'pradeepb@icai.org');
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.values(config.firebase).every(value => value === ''));
  for (const file of assets) assert.equal(await readFile(path.join(result.output, file), 'utf8'), `fixture for ${file}`);
});

test('complete required config activates Firebase without optional values', async t => {
  const root = await fixture(t);
  const result = await buildPages({ root, env: requiredEnv });
  assert.equal(result.configured, true);
  const { firebase } = await readConfig(result.output);
  assert.equal(firebase.apiKey, 'public-api-key');
  assert.equal(firebase.projectId, 'example-project');
  assert.equal(firebase.storageBucket, '');
  assert.equal(firebase.messagingSenderId, '');
});

test('partial config fails by naming absent keys without printing supplied values or deleting a prior build', async t => {
  const root = await fixture(t);
  const prior = path.join(root, '_site');
  await mkdir(prior);
  await writeFile(path.join(prior, 'keep'), 'prior output');
  await assert.rejects(buildPages({ root, env: { VITE_FIREBASE_API_KEY: 'DO_NOT_LOG_THIS' } }), error => {
    assert.match(error.message, /VITE_FIREBASE_AUTH_DOMAIN/);
    assert.match(error.message, /VITE_FIREBASE_PROJECT_ID/);
    assert.match(error.message, /VITE_FIREBASE_APP_ID/);
    assert.doesNotMatch(error.message, /DO_NOT_LOG_THIS/);
    return true;
  });
  assert.equal(await readFile(path.join(prior, 'keep'), 'utf8'), 'prior output');
});

test('optional-only config is rejected instead of silently appearing configured', async t => {
  const root = await fixture(t);
  await assert.rejects(buildPages({ root, env: { VITE_FIREBASE_STORAGE_BUCKET: 'bucket' } }), /VITE_FIREBASE_API_KEY/);
});

test('generated JavaScript safely preserves values and trims accidental spaces', async t => {
  const root = await fixture(t);
  const oddValue = 'a";window.attacked=true;//\n\u2028\u2029z';
  const result = await buildPages({ root, env: {
    ...requiredEnv,
    VITE_FIREBASE_API_KEY: oddValue,
    VITE_FIREBASE_PROJECT_ID: '  example-project  ',
    VITE_FIREBASE_STORAGE_BUCKET: 'example.appspot.com',
    VITE_FIREBASE_MESSAGING_SENDER_ID: '123'
  } });
  const context = { window: {} };
  vm.runInNewContext(await readFile(path.join(result.output, 'party-config.js'), 'utf8'), context);
  assert.equal(context.window.attacked, undefined);
  assert.equal(context.window.PARTY_CONFIG.firebase.apiKey, oddValue);
  assert.equal(context.window.PARTY_CONFIG.firebase.projectId, 'example-project');
  assert.equal(context.window.PARTY_CONFIG.firebase.storageBucket, 'example.appspot.com');
  assert.equal(context.window.PARTY_CONFIG.firebase.messagingSenderId, '123');
});

test('rebuild removes stale public assets', async t => {
  const root = await fixture(t);
  const first = await buildPages({ root, env: {} });
  await writeFile(path.join(first.output, 'stale.js'), 'old code');
  await writeFile(path.join(root, 'party-host.js'), 'updated host');
  const next = await buildPages({ root, env: requiredEnv });
  assert.equal((await readdir(next.output)).includes('stale.js'), false);
  assert.equal(await readFile(path.join(next.output, 'party-host.js'), 'utf8'), 'updated host');
});

test('missing runtime input fails before replacing the prior deployment', async t => {
  const root = await fixture(t);
  const first = await buildPages({ root, env: {} });
  await rm(path.join(root, 'party-api.js'));
  await assert.rejects(buildPages({ root, env: requiredEnv }), /ENOENT/);
  assert.equal(await readFile(path.join(first.output, 'party-api.js'), 'utf8'), 'fixture for party-api.js');
});
