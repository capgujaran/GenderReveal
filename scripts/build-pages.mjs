import { access, copyFile, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = ['index.html', 'party-api.js', 'party-host.js', 'party-host.css'];
const variables = {
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  appId: 'VITE_FIREBASE_APP_ID'
};
const required = ['apiKey', 'authDomain', 'projectId', 'appId'];

export async function buildPages({ root = sourceRoot, env = process.env } = {}) {
  const firebase = Object.fromEntries(
    Object.entries(variables).map(([key, variable]) => [key, (env[variable] || '').trim()])
  );
  const configured = Object.values(firebase).some(Boolean);
  const missing = required.filter(key => !firebase[key]);
  if (configured && missing.length) {
    throw new Error(`Firebase configuration is incomplete. Set these repository variables: ${missing.map(key => variables[key]).join(', ')}. No configuration values were printed.`);
  }

  // Check inputs before replacing a previous build. Only runtime assets are published.
  await Promise.all(assets.map(file => access(path.join(root, file))));
  const output = path.join(root, '_site');
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  await Promise.all(assets.map(file => copyFile(path.join(root, file), path.join(output, file))));
  const config = {
    provider: 'firebase',
    hostEmail: 'pradeepb@icai.org',
    firebase
  };
  const serialized = JSON.stringify(config, null, 2).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  await writeFile(path.join(output, 'party-config.js'), `// Generated public Firebase web-app configuration.\nwindow.PARTY_CONFIG = Object.freeze(${serialized});\n`);
  await writeFile(path.join(output, '.nojekyll'), '');
  return { output, configured };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { configured } = await buildPages();
    console.log(configured
      ? 'Built _site with Firebase client configuration. Publish the Firestore rules and enable the required sign-in providers before using hosted games.'
      : 'Built _site for standalone play. Hosted games remain unavailable until the Firebase repository variables are configured.');
  } catch (error) {
    console.error(`Build failed: ${error.message}`);
    process.exitCode = 1;
  }
}
