import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repo = 'qmuntal/setup-go-cache-bench-20261005';
const directory = path.join(root, 'results');
await fs.mkdir(directory, {recursive: true});
const gh = args => execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, env: {...process.env, GH_PAGER: 'cat'}});
const api = endpoint => JSON.parse(gh(['api', endpoint]));
const load = async file => JSON.parse((await fs.readFile(file, 'utf8')).replace(/^\uFEFF/, ''));
const runs = api(`repos/${repo}/actions/workflows/benchmark.yml/runs?per_page=30`).workflow_runs;
const runId = process.argv.slice(2).find(argument => /^\d+$/.test(argument));
if (runId) {
  const run = runs.find(item => String(item.id) === runId) ?? api(`repos/${repo}/actions/runs/${runId}`);
  if (run.status !== 'completed') throw new Error(`Run ${runId} is still ${run.status}`);
  const dest = path.join(directory, String(run.id));
  await fs.mkdir(dest, {recursive: true});
  gh(['run', 'download', String(run.id), '--repo', repo, '--dir', dest]);
  const jobs = [];
  for (let page = 1; ; page++) {
    const batch = api(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100&page=${page}`).jobs;
    jobs.push(...batch);
    if (batch.length < 100) break;
  }
  await fs.writeFile(path.join(dest, 'jobs.json'), JSON.stringify(jobs, null, 2));
  await fs.writeFile(path.join(dest, 'run.json'), JSON.stringify(run, null, 2));
  await fs.writeFile(path.join(dest, 'logs.txt'), gh(['run', 'view', String(run.id), '--repo', repo, '--log']));
  console.log(`Downloaded ${jobs.length} jobs for ${run.display_title}: ${run.conclusion}`);
}

const caches = api(`repos/${repo}/actions/caches?per_page=100`);
await fs.writeFile(path.join(directory, 'caches.json'), JSON.stringify(caches, null, 2));
const samples = [];
const jobs = [];
for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
  if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
  const dest = path.join(directory, entry.name);
  if (!await fs.stat(path.join(dest, 'jobs.json')).catch(() => false)) continue;
  const runJobs = await load(path.join(dest, 'jobs.json'));
  const logs = await fs.readFile(path.join(dest, 'logs.txt'), 'utf8');
  for (const artifact of await fs.readdir(dest, {withFileTypes: true})) {
    if (!artifact.isDirectory()) continue;
    for (const file of await fs.readdir(path.join(dest, artifact.name))) {
      if (!/^sample-\d+\.json$/.test(file)) continue;
      const sample = await load(path.join(dest, artifact.name, file));
      if (sample.workload === 'build-v2') samples.push(sample);
    }
  }
  for (const job of runJobs) {
    const [project, variant, phase] = job.name.split(' / ');
    const duration = step => (Date.parse(step.completed_at) - Date.parse(step.started_at)) / 1000;
    const post = job.steps.filter(step => /^Post Sample/.test(step.name));
    const jobLines = logs.split('\n').filter(line => line.startsWith(`${job.name}\t`));
    const postStart = jobLines.findIndex(line => line.includes('Post job cleanup.'));
    const postLines = postStart >= 0 ? jobLines.slice(postStart) : [];
    const postText = postLines.join('\n');
    const savedKeys = [...postText.matchAll(/Cache saved with the key:\s*(\S+)/g)].map(match => match[1]);
    // Composite action logs can be labeled UNKNOWN STEP. Match the saved key
    // to the cache record instead of depending on runner display names.
    const compressedBytes = savedKeys.map(key => {
      const matches = caches.actions_caches.filter(cache => cache.key === key);
      matches.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      return matches.find(cache => Date.parse(cache.created_at) >= Date.parse(job.started_at) && Date.parse(cache.created_at) <= Date.parse(job.completed_at))?.size_in_bytes;
    });
    if (compressedBytes.some(bytes => bytes === undefined)) throw new Error(`Missing persisted cache record for ${job.name}`);
    const postDurations = [...postText.matchAll(/##\[end-action id=__[^;]*\.(?:baseline|split);outcome=success;conclusion=success;duration_ms=(\d+)\]/g)].map(match => Number(match[1]) / 1000);
    const failures = jobLines.filter(line => /Restore .* cache failed|Save .* cache failed|Restore cache failed|Unable to save cache|Failed to save|Error:|\[error\]/i.test(line));
    jobs.push({project, variant, phase, runId: job.run_id, jobId: job.id, conclusion: job.conclusion, postSeconds: postDurations.length ? postDurations.reduce((a, b) => a + b, 0) : post.reduce((sum, step) => sum + duration(step), 0), jobSeconds: (Date.parse(job.completed_at) - Date.parse(job.started_at)) / 1000, compressedBytes, uploadedBytes: compressedBytes.reduce((a, b) => a + b, 0), savedKeys, failures});
  }
}

const median = values => { const sorted = [...values].sort((a,b) => a-b); return sorted.length ? (sorted[Math.floor((sorted.length-1)/2)] + sorted[Math.ceil((sorted.length-1)/2)]) / 2 : null; };
const projects = await load(path.join(root, 'projects.json'));
const rows = [];
for (const project of projects) {
  for (const phase of ['seed', 'warm', 'upgrade']) {
    const row = {project: project.slug, declaredRequirements: project.requirements, phase};
    for (const variant of ['baseline', 'split']) {
      const matching = samples.filter(sample => sample.project === project.slug && sample.phase === phase && sample.variant === variant);
      const job = jobs.filter(job => job.project === project.slug && job.phase === phase && job.variant === variant).at(-1);
      row[variant] = {n: matching.length, conclusion: job?.conclusion, restoreSeconds: median(matching.map(sample => sample.restoreSeconds)), downloadSeconds: median(matching.map(sample => sample.downloadSeconds)), buildSeconds: median(matching.map(sample => sample.buildSeconds)), beforePostSeconds: median(matching.map(sample => sample.beforePostSeconds)), fullHitCount: matching.filter(sample => sample.cacheHit === 'true').length, postSeconds: job?.postSeconds, uploadedMiB: job?.uploadedBytes / 1024**2, savedKeys: job?.savedKeys, modulesMiB: median(matching.map(sample => sample.inventory.modules.bytes / 1024**2)), buildMiB: median(matching.map(sample => sample.inventory.build.bytes / 1024**2)), failures: job?.failures};
    }
    if (row.baseline.n && row.split.n) {
      row.restoreReductionPercent = 100 * (1 - row.split.restoreSeconds / row.baseline.restoreSeconds);
      row.beforePostReductionPercent = 100 * (1 - row.split.beforePostSeconds / row.baseline.beforePostSeconds);
      if (phase !== 'warm') {
        row.totalSecondsBefore = row.baseline.beforePostSeconds + row.baseline.postSeconds;
        row.totalSecondsAfter = row.split.beforePostSeconds + row.split.postSeconds;
        row.totalReductionPercent = 100 * (1 - row.totalSecondsAfter / row.totalSecondsBefore);
      }
    }
    rows.push(row);
  }
}
await fs.writeFile(path.join(directory, 'summary.json'), JSON.stringify({rows, jobs, samples, caches}, null, 2));
if (process.argv.includes('--publish-data')) {
  const publish = path.join(root, 'benchmark-data');
  await fs.mkdir(publish, {recursive: true});
  for (const [name, value] of Object.entries({rows, jobs, samples, caches})) {
    await fs.writeFile(path.join(publish, `${name}.json`), JSON.stringify(value, null, 2));
  }
  console.log('Exported public measurement metadata; raw logs and signed cache URLs are not included.');
}
for (const row of rows) console.log(JSON.stringify(row));
