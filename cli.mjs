// Setup helper. Secrets are written to files readable only by you, never printed.
//   node cli.mjs init                       admin key -> data/admin-key.txt
//   node cli.mjs password                   set the admin password (asked for wallet changes); reads it from stdin
//   node cli.mjs preview-code              set the coming-soon preview code; reads it from stdin
//   node cli.mjs add-site <id>              API key + webhook secret for a site -> data/site-<id>.txt
//   node cli.mjs set-file <name> <path>     point at a key file: blockfrost_key_file or resend_key_file
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { sha256 } from './core/util.mjs';

const DATA = process.env.PAY_DATA || join(new URL('.', import.meta.url).pathname, 'data');
mkdirSync(DATA, { recursive: true, mode: 0o700 });
const file = join(DATA, 'secrets.json');
const sec = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { sites: {} };
const saveSec = () => writeFileSync(file, JSON.stringify(sec, null, 2) + '\n', { mode: 0o600 });
const token = (p) => p + randomBytes(24).toString('base64url');
const [cmd, a, b] = process.argv.slice(2);

if (cmd === 'init') {
  const key = token('padm_');
  sec.admin_key_sha256 = sha256(key);
  saveSec();
  writeFileSync(join(DATA, 'admin-key.txt'), key + '\n', { mode: 0o600 });
  console.log('Admin key written to ' + join(DATA, 'admin-key.txt') + ' (keep it private).');
} else if (cmd === 'password') {
  const pw = readFileSync(0, 'utf8').replace(/\r?\n$/, '');
  if (pw.length < 10) { console.error('Use at least 10 characters.'); process.exit(1); }
  const salt = randomBytes(16);
  sec.admin_password = `scrypt:${salt.toString('hex')}:${scryptSync(pw, salt, 32).toString('hex')}`;
  saveSec();
  console.log('Admin password saved.');
} else if (cmd === 'preview-code') {   // the "coming soon" preview code (read from stdin, stored only as a scrypt hash)
  const code = readFileSync(0, 'utf8').trim().toLowerCase();
  if (code.length < 6) { console.error('Use at least 6 characters.'); process.exit(1); }
  const salt = randomBytes(16);
  sec.gate_code = `scrypt:${salt.toString('hex')}:${scryptSync(code, salt, 32).toString('hex')}`;
  sec.gate_cookie_secret ||= randomBytes(32).toString('hex');
  saveSec();
  console.log('Preview code saved.');
} else if (cmd === 'add-site') {
  if (!/^[a-z0-9-]{2,30}$/.test(a || '')) { console.error('Site id: 2-30 lowercase letters, digits or dashes.'); process.exit(1); }
  const key = token('pk_'), hook = token('whsec_');
  sec.sites[a] = { api_key_sha256: sha256(key), webhook_secret: hook };
  saveSec();
  writeFileSync(join(DATA, `site-${a}.txt`), `API key: ${key}\nWebhook secret: ${hook}\n`, { mode: 0o600 });
  console.log(`Site "${a}" added. Its API key and webhook secret are in ${join(DATA, `site-${a}.txt`)}; give them to the site, then delete that file.`);
} else if (cmd === 'set-file' && ['blockfrost_key_file', 'resend_key_file'].includes(a) && b) {
  sec[a] = b; saveSec(); console.log(`${a} set.`);
} else {
  console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(0, 6).join('\n'));
}
