import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve, basename } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = resolve('.tmp/model-comparison-20261019');
const packages = JSON.parse(readFileSync(join(root, 'decision-wheels.json'), 'utf8'));
const destination = join(root, 'wheels'); mkdirSync(destination, { recursive: true });
const records = [];
async function curl(args) {
  return await new Promise(done => {
    const child = spawn('curl.exe', ['-fsSL', '--retry', '2', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '300', ...args],
      { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => done(-1)); child.once('close', done);
  });
}
async function checksum(file) {
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
async function finishPartial(url, part, start, end) {
  const have = statSync(part).size, needed = end - start + 1;
  if (have > needed) throw new Error('Oversized cached range');
  const pieces = [];
  for (let offset = start + have; offset <= end; offset += 1024 * 1024)
    pieces.push({ start: offset, end: Math.min(end, offset + 1024 * 1024 - 1) });
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, pieces.length) }, async () => {
    while (next < pieces.length) {
      const piece = pieces[next++], file = `${part}.tail-${piece.start}`, size = piece.end - piece.start + 1;
      if (existsSync(file) && statSync(file).size === size) continue;
      if (await curl(['--max-time', '60', '--range', `${piece.start}-${piece.end}`, '--max-filesize', String(size), url, '-o', file]) !== 0 || statSync(file).size !== size)
        throw new Error('Small range failed');
    }
  }));
  const stream = createWriteStream(part, { flags: 'a' });
  for (const piece of pieces) for await (const chunk of createReadStream(`${part}.tail-${piece.start}`))
    if (!stream.write(chunk)) await once(stream, 'drain');
  stream.end(); await once(stream, 'finish');
  for (const piece of pieces) unlinkSync(`${part}.tail-${piece.start}`);
  if (statSync(part).size !== needed) throw new Error('Incomplete resumed range');
}
async function download(pkg) {
  if (pkg.wheels.length !== 1) throw new Error(`Ambiguous platform lock: ${pkg.name}`);
  const artifact = pkg.wheels[0], url = new URL(artifact.url);
  if (url.protocol !== 'https:' || url.hostname !== 'files.pythonhosted.org' || !artifact.hashes.sha256) throw new Error('Unpinned package origin');
  const path = join(destination, basename(url.pathname));
  if (!existsSync(path) || statSync(path).size !== artifact.size || await checksum(path) !== artifact.hashes.sha256) {
    if (artifact.size < 64 * 1024 * 1024) {
      if (await curl([url.href, '-o', path]) !== 0) throw new Error(`Download failed: ${pkg.name}`);
    } else {
      const directory = `${path}.parts`; mkdirSync(directory, { recursive: true });
      const jobs = [];
      for (let start = 0; start < artifact.size; start += 32 * 1024 * 1024)
        jobs.push({ start, end: Math.min(artifact.size - 1, start + 32 * 1024 * 1024 - 1) });
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
        while (next < jobs.length) {
          const job = jobs[next++], part = join(directory, String(job.start)), length = job.end - job.start + 1;
          if (existsSync(part) && statSync(part).size === length) continue;
          if (existsSync(part) && statSync(part).size > 0) {
            await finishPartial(url.href, part, job.start, job.end); continue;
          }
          if (await curl(['--range', `${job.start}-${job.end}`, '--max-filesize', String(length), url.href, '-o', part]) !== 0 || statSync(part).size !== length)
            throw new Error(`Range failed: ${pkg.name} ${job.start}`);
        }
      }));
      const stream = createWriteStream(path);
      for (const job of jobs) for await (const chunk of createReadStream(join(directory, String(job.start))))
        if (!stream.write(chunk)) await once(stream, 'drain');
      stream.end(); await once(stream, 'finish');
      if (await checksum(path) !== artifact.hashes.sha256) throw new Error(`Package hash mismatch: ${pkg.name}`);
      for (const job of jobs) unlinkSync(join(directory, String(job.start)));
      rmdirSync(directory);
    }
  }
  const hash = await checksum(path);
  if (statSync(path).size !== artifact.size || hash !== artifact.hashes.sha256) throw new Error(`Unverified package: ${pkg.name}`);
  records.push({ name: pkg.name, version: pkg.version, file: basename(path), sha256: hash, bytes: artifact.size });
  writeFileSync(join(root, 'wheels-verified.json'), JSON.stringify(records, null, 2) + '\n');
  console.log(`WHEEL ${pkg.name} ${pkg.version}`);
}
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => { while (next < packages.length) await download(packages[next++]); }));
