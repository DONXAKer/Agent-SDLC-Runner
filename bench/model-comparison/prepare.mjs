import { mkdirSync, writeFileSync, readFileSync, existsSync, createReadStream, createWriteStream, statSync, openSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { resolve, join } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';

const output = resolve(process.argv.slice(2).find(a => !a.startsWith('--')) ?? '.tmp/model-comparison-20261019');
mkdirSync(output, { recursive: true });
const get = url => JSON.parse(execFileSync('curl.exe', ['-fsSL', '--retry', '3', '--max-time', '60', url], { encoding: 'utf8', maxBuffer: 20_000_000 }));
async function rangedDownload(url, path, size, fd) {
  const offset = existsSync(path) ? statSync(path).size : 0;
  if (offset === size) return 0;
  if (offset > size) return 63;
  const chunkSize = 64 * 1024 * 1024;
  const jobs = [];
  for (let start = offset; start < size; start += chunkSize) jobs.push({ start, end: Math.min(size - 1, start + chunkSize - 1) });
  const directory = `${path}.parts`; mkdirSync(directory, { recursive: true });
  let next = 0, failed = 0;
  await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, async () => {
    while (next < jobs.length && !failed) {
      const job = jobs[next++], part = join(directory, String(job.start));
      const expected = job.end - job.start + 1;
      if (existsSync(part) && statSync(part).size === expected) continue;
      const code = await new Promise(done => {
        const child = spawn('curl.exe', ['-fsSL', '--retry', '2', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '300',
          '--range', `${job.start}-${job.end}`, '--max-filesize', String(expected), url, '-o', part],
        { windowsHide: true, stdio: ['ignore', fd, fd] });
        child.once('error', () => done(-1)); child.once('close', done);
      });
      if (code !== 0 || !existsSync(part) || statSync(part).size !== expected) failed = code || 63;
    }
  }));
  if (failed) return failed;
  const stream = createWriteStream(path, { flags: 'a' });
  let streamError;
  stream.on('error', error => { streamError = error; });
  for (const job of jobs) {
    for await (const chunk of createReadStream(join(directory, String(job.start)))) {
      if (streamError) throw streamError;
      if (!stream.write(chunk)) await once(stream, 'drain');
    }
  }
  stream.end(); await once(stream, 'finish');
  return 0;
}
const definitions = [
  { id: 'neohorse', repo: 'mradermacher/NeoHorse-1-9B-GGUF', kind: 'ollama', pattern: /Q6_K\.gguf$/ },
  { id: 'blend', repo: 'JetBrains/Qwen3.8-3.6-27B-blend-GGUF', kind: 'ollama', pattern: /Q4_K_M\.gguf$/ },
  { id: 'intern2', repo: 'internlm/Intern-Decision-2B', kind: 'intern' },
  { id: 'intern4', repo: 'internlm/Intern-Decision-4B', kind: 'intern' },
  { id: 'standard3', repo: 'StandardThinking/StandardOne-3B', kind: 'standard', revision: 'v2.2' },
  { id: 'standard8', repo: 'StandardThinking/StandardOne-8B', kind: 'standard', revision: 'v2.2' },
  { id: 'nimble2', repo: 'bespokelabs/Bespoke-Nimble-9B-v2', kind: 'nimble' },
  { id: 'nimble-base', repo: 'Qwen/Qwen3.5-9B', kind: 'base', revision: 'c202236235762e1c871ad0ccb60c8ee5ba337b9a' },
];
const manifestPath = join(output, 'preparation.json');
const prior = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
const manifest = prior ?? { createdAt: new Date().toISOString(), models: [] };
for (const def of definitions) {
  const previous = manifest.models.find(m => m.id === def.id);
  if (previous && previous.repo === def.repo) continue;
  if (previous) manifest.models.splice(manifest.models.indexOf(previous), 1);
  try {
    const meta = get(`https://huggingface.co/api/models/${def.repo}${def.revision ? '/revision/' + def.revision : ''}?blobs=true`);
    if (!meta.sha || !meta.siblings) throw new Error(meta.error ?? 'No model revision');
    const files = meta.siblings.filter(f => def.pattern ? def.pattern.test(f.rfilename) :
      !/^(?:evidence|benchmarks|docs|\.cache)\//.test(f.rfilename) && !/\.(?:gguf|bin|h5|msgpack|onnx)$/i.test(f.rfilename));
    if (!files.length) throw new Error('Requested format absent');
    manifest.models.push({ ...def, pattern: undefined, revision: meta.sha, status: 'pending', directory: join(output, 'models', def.id),
      files: files.map(f => ({ name: f.rfilename, size: f.size, sha256: f.lfs?.sha256 ?? null })) });
  } catch (e) { manifest.models.push({ id: def.id, repo: def.repo, kind: def.kind, status: 'unavailable', reason: String(e) }); }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
}
if (!process.argv.includes('--download') && !process.argv.includes('--verify')) {
  console.log(JSON.stringify(manifest.models.map(m => ({ id: m.id, status: m.status, files: m.files?.length,
    bytes: m.files?.reduce((n,f) => n + (f.size ?? 0), 0), reason: m.reason })), null, 2));
  process.exit(0);
}
for (const model of manifest.models) {
  if (model.status === 'unavailable' || model.status === 'downloaded' && !process.argv.includes('--verify')) continue;
  console.log(`DOWNLOAD ${model.id} ${model.files.length} files`);
  mkdirSync(model.directory, { recursive: true });
  for (const file of model.files) {
    const path = join(model.directory, file.name);
    mkdirSync(resolve(path, '..'), { recursive: true });
    if (process.argv.includes('--verify') && (!file.downloaded || !existsSync(path))) {
      model.status = 'incomplete'; model.reason = `File not downloaded: ${file.name}`; break;
    }
    if (file.downloaded && file.actualSha256 && existsSync(path)) continue;
    const fd = openSync(join(output, 'downloads.log'), 'a');
    const url = `https://huggingface.co/${model.repo}/resolve/${model.revision}/${file.name}`;
    const code = file.downloaded && existsSync(path) ? 0 : file.size > 128 * 1024 * 1024 ? await rangedDownload(url, path, file.size, fd) : await new Promise(done => {
      const child = spawn('curl.exe', ['-fL', '--retry', '2', '--retry-all-errors', '--connect-timeout', '30', '--max-time', '600', '--speed-time', '60', '--speed-limit', '1024',
        '-C', '-', url, '-o', path],
      { windowsHide: true, stdio: ['ignore', fd, fd] });
      child.once('error', () => done(-1)); child.once('close', done);
    });
    closeSync(fd);
    if (code !== 0) { model.status = 'download-failed'; model.reason = `curl exit ${code}: ${file.name}`; break; }
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    file.actualSha256 = hash.digest('hex'); file.actualSize = statSync(path).size;
    if ((file.size !== undefined && file.actualSize !== file.size) || (file.sha256 && file.sha256 !== file.actualSha256)) {
      model.status = 'integrity-failed'; model.reason = `Size/hash mismatch: ${file.name}`; break;
    }
    file.downloaded = true;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  }
  if (model.files.every(f => f.downloaded)) { model.status = 'downloaded'; delete model.reason; }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`DONE ${model.id} ${model.status}`);
}
