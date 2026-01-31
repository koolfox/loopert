#!/usr/bin/env node
/**
 * Fetch upstream Ralph assets (prompt + shell harness) from snarktank/ralph.
 * Saves into scripts/ralph-upstream/.
 */
import https from 'https';
import fs from 'fs';
import path from 'path';

const files = [
  {
    url: 'https://raw.githubusercontent.com/snarktank/ralph/main/ralph.sh',
    dest: path.join('scripts', 'ralph-upstream', 'ralph.sh'),
    mode: 0o755
  },
  {
    url: 'https://raw.githubusercontent.com/snarktank/ralph/main/prompt.md',
    dest: path.join('scripts', 'ralph-upstream', 'prompt.md')
  }
];

function fetchFile({ url, dest, mode }) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const file = fs.createWriteStream(dest);
    https
      .get(url, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`Failed to fetch ${url}: ${res.statusCode}`));
          return;
        }
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (mode) fs.chmodSync(dest, mode);
            resolve();
          });
        });
      })
      .on('error', (err) => reject(err));
  });
}

async function main() {
  for (const f of files) {
    console.log(`Fetching ${f.url} -> ${f.dest}`);
    await fetchFile(f);
  }
  console.log('Upstream Ralph assets fetched.');
}

main().catch((err) => {
  console.error('fetch failed', err);
  process.exit(1);
});
