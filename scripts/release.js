'use strict';
// Builds a release archive that can never contain secrets or local state.
//   npm run release            -> dist/mintpilot-<version>.zip (or .tar.gz when `zip` is unavailable)
//   npm run release -- --check -> only verify; exit 1 on any problem
//
// File list: `git ls-files` when this is a git checkout (exactly what is committed), otherwise an
// allowlist of source/documentation paths. Then two independent gates:
//   1. path gate    — .env files, databases, keys, logs, node_modules, build output, local data;
//   2. content gate — Telegram bot tokens, PEM private keys, and non-placeholder values of secret
//                     environment variables written inside any file.
// Any hit aborts the release and lists the offending files.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const ALLOW_ROOTS = ['src', 'test', 'contracts', 'docs', 'scripts', 'docker', '.github'];
const ALLOW_FILES = ['package.json', 'package-lock.json', 'README.md', 'CHANGELOG.md', 'SECURITY.md', 'RAILWAY_DEPLOY.md',
  'Dockerfile', '.dockerignore', '.gitignore', '.env.example', 'eslint.config.js', 'hardhat.config.js', 'data/.gitkeep', 'data/eligible-addresses.json'];

const FORBIDDEN_PATHS = [
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, 'environment file'],
  [/\.(sqlite|sqlite3|db)(-wal|-shm|-journal)?$/i, 'database file'],
  [/\.(pem|key|p12|pfx|keystore)$/i, 'key material'],
  [/(^|\/)node_modules\//, 'node_modules'],
  [/\.log$/i, 'log file'],
  [/(^|\/)(artifacts|cache|coverage|dist)\//, 'build output'],
  [/^data\/(?!\.gitkeep$|eligible-addresses\.json$)/, 'local data']
];
const SECRET_VARS = ['TELEGRAM_BOT_TOKEN', 'AUTOMATION_MASTER_KEY', 'OPENSEA_API_KEY', 'ETHERSCAN_API_KEY', 'METRICS_TOKEN', 'DEPLOYER_PRIVATE_KEY'];
const CONTENT_RULES = [
  [/\b\d{8,10}:AA[A-Za-z0-9_-]{30,40}\b/, 'Telegram bot token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'PEM private key'],
  [new RegExp(`^\\s*(${SECRET_VARS.join('|')})\\s*=\\s*(?!<|\\s*$|REPLACE|your|example|changeme|\\$\\{)[^\\s#]{8,}`, 'm'), 'secret value assigned in a file']
];

function listFiles() {
  if (fs.existsSync(path.join(ROOT, '.git'))) {
    try { return execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0').filter(Boolean); } catch { /* fall through */ }
  }
  const out = [];
  const walk = (rel) => {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return;
    const st = fs.statSync(abs);
    if (st.isDirectory()) { for (const name of fs.readdirSync(abs)) walk(path.posix.join(rel, name)); return; }
    out.push(rel);
  };
  ALLOW_ROOTS.forEach(walk);
  ALLOW_FILES.filter((f) => fs.existsSync(path.join(ROOT, f))).forEach((f) => out.push(f));
  return [...new Set(out)].sort();
}

function audit(files) {
  const problems = [];
  for (const file of files) {
    const rule = FORBIDDEN_PATHS.find(([re]) => re.test(file));
    if (rule) { problems.push(`${file}: ${rule[1]}`); continue; }
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs) || fs.statSync(abs).size > 5 * 1024 * 1024) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const [re, label] of CONTENT_RULES) if (re.test(text)) problems.push(`${file}: ${label}`);
  }
  return problems;
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const files = listFiles();
  const problems = audit(files);
  if (problems.length) {
    console.error(`Release blocked: ${problems.length} problem(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`Release audit passed: ${files.length} files, no secrets or local state.`);
  if (checkOnly) return;
  const dist = path.join(ROOT, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const base = `mintpilot-${pkg.version}`;
  const listFile = path.join(dist, `${base}.files`);
  fs.writeFileSync(listFile, files.join('\n') + '\n');
  let out;
  try {
    out = path.join(dist, `${base}.zip`);
    fs.rmSync(out, { force: true });
    execFileSync('zip', ['-X', '-q', out, '-@'], { cwd: ROOT, input: files.join('\n') + '\n' });
  } catch {
    out = path.join(dist, `${base}.tar.gz`);
    execFileSync('tar', ['-czf', out, '-T', listFile], { cwd: ROOT });
  } finally { fs.rmSync(listFile, { force: true }); }
  console.log(`Wrote ${path.relative(ROOT, out)}`);
}

if (require.main === module) main();
module.exports = { audit, FORBIDDEN_PATHS, CONTENT_RULES };
