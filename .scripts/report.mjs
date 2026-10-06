import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const reportRoot = path.join(root, 'reports');
const assets = path.join(root, 'report-assets');
await fs.mkdir(reportRoot, {recursive: true});
await fs.mkdir(assets, {recursive: true});
const load = async file => JSON.parse((await fs.readFile(path.join(root, file), 'utf8')).replace(/^\uFEFF/, ''));
// Use the committed sanitized data, not ignored artifacts or live cache
// records that can disappear as GitHub evicts old entries.
const [rows, jobs, samples] = await Promise.all(
  ['rows', 'jobs', 'samples'].map(name => load(`benchmark-data/${name}.json`))
);
const projects = await load('projects.json');
const api = endpoint => JSON.parse(execFileSync('gh', ['api', endpoint], {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024}));
const evidence = [];
for (const project of projects) {
  const tree = api(`repos/${project.repository}/git/trees/${project.sha}?recursive=1`).tree;
  const files = [];
  for (const file of tree.filter(file => file.type === 'blob' && (/^\.github\/workflows\/.*\.ya?ml$/.test(file.path) || file.path === 'supported_go_versions.json' || file.path === 'go.mod'))) {
    const blob = api(`repos/${project.repository}/git/blobs/${file.sha}`);
    const content = Buffer.from(blob.content, 'base64').toString('utf8');
    if (file.path.startsWith('.github/') && !content.includes('setup-go')) continue;
    files.push({path: file.path, sha: file.sha, url: `https://github.com/${project.repository}/blob/${project.sha}/${file.path}`, content});
  }
  const metadata = api(`repos/${project.repository}`);
  evidence.push({project: project.slug, repository: project.repository, sha: project.sha, stars: metadata.stargazers_count, retrievedDate: '2026-10-06', files});
}
await fs.writeFile(path.join(reportRoot, 'upstream-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');

const median = values => {
  const sorted = [...values].sort((a,b) => a-b);
  return (sorted[Math.floor((sorted.length-1)/2)] + sorted[Math.ceil((sorted.length-1)/2)]) / 2;
};
const percentile = (values, q) => [...values].sort((a,b) => a-b)[Math.ceil(values.length*q)-1];
const describe = values => ({n: values.length, median: median(values), mean: values.reduce((a,b)=>a+b,0)/values.length, p95NearestRank: percentile(values, .95), min: Math.min(...values), max: Math.max(...values)});
const computed = projects.map(project => {
  const warm = variant => samples.filter(s=>s.project===project.slug && s.phase==='warm' && s.variant===variant).sort((a,b)=>a.sample-b.sample);
  const b=warm('baseline'), s=warm('split');
  if(b.length!==10 || s.length!==10 || [...b,...s].some(x=>x.cacheHit!=='true')) throw Error('Warm samples invalid: '+project.slug);
  const seed=rows.find(r=>r.project===project.slug && r.phase==='seed');
  const upgrade=rows.find(r=>r.project===project.slug && r.phase==='upgrade');
  const seedJob=jobs.find(j=>j.project===project.slug && j.variant==='split' && j.phase==='seed');
  const modIndex=seedJob.savedKeys.findIndex(k=>k.startsWith('setup-go-modules-'));
  if(modIndex<0 || seedJob.compressedBytes.length!==2)throw Error('Seed entries invalid');
  const M=seedJob.compressedBytes[modIndex]/1024**2;
  const B=seedJob.compressedBytes[1-modIndex]/1024**2;
  const before=seed.baseline.uploadedMiB+upgrade.baseline.uploadedMiB;
  const after=seed.split.uploadedMiB+upgrade.split.uploadedMiB;
  const lifecycle = variant => upgrade[variant].restoreSeconds+upgrade[variant].downloadSeconds+upgrade[variant].postSeconds;
  const deltas=b.map((x,i)=>s[i].restoreSeconds-x.restoreSeconds);
  const warmBuild = variant => warm(variant).map(x=>x.buildSeconds);
  return {
    ...project, compressedModuleMiB:M,compressedSeedBuildMiB:B,
    compressedModulesFraction:M/(M+B),storageBeforeMiB:before,storageAfterMiB:after,
    storageSavedMiB:before-after,storageReductionPercent:100*(1-after/before),
    uploadBeforeMiB:upgrade.baseline.uploadedMiB,uploadAfterMiB:upgrade.split.uploadedMiB,
    uploadReductionPercent:100*(1-upgrade.split.uploadedMiB/upgrade.baseline.uploadedMiB),
    warmRestore:{baseline:describe(b.map(x=>x.restoreSeconds)),split:describe(s.map(x=>x.restoreSeconds))},
    warmBuild:{baseline:describe(warmBuild('baseline')),split:describe(warmBuild('split'))},
    warmBeforePost:{baseline:describe(b.map(x=>x.beforePostSeconds)),split:describe(s.map(x=>x.beforePostSeconds))},
    warmNumberMatchedDescriptive:{n:10,medianDeltaSeconds:median(deltas),splitWins:deltas.filter(x=>x<0).length,ties:deltas.filter(x=>x===0).length,baselineWins:deltas.filter(x=>x>0).length},
    upgrade:{baseline:upgrade.baseline,split:upgrade.split,cacheAndDependenciesBeforeSeconds:lifecycle('baseline'),cacheAndDependenciesAfterSeconds:lifecycle('split'),cacheAndDependenciesReductionPercent:100*(1-lifecycle('split')/lifecycle('baseline'))},
    projectedThreeVariants:{beforeMiB:3*(M+B),afterMiB:M+3*B,reductionPercent:100*(2*M)/(3*(M+B))}
  };
});
const total = {
  storageBeforeMiB:computed.reduce((a,x)=>a+x.storageBeforeMiB,0),
  storageAfterMiB:computed.reduce((a,x)=>a+x.storageAfterMiB,0),
  uploadBeforeMiB:computed.reduce((a,x)=>a+x.uploadBeforeMiB,0),
  uploadAfterMiB:computed.reduce((a,x)=>a+x.uploadAfterMiB,0)
};
await fs.writeFile(path.join(reportRoot, 'analysis.json'), JSON.stringify({measurementDate:'2026-10-05',analysisDate:'2026-10-06',projects:computed,total,sampleCount:samples.length,jobCount:jobs.length},null,2)+'\n');
const fields=['slug','compressedModuleMiB','compressedSeedBuildMiB','storageBeforeMiB','storageAfterMiB','storageReductionPercent','uploadBeforeMiB','uploadAfterMiB','uploadReductionPercent'];
await fs.writeFile(path.join(reportRoot,'project-results.csv'), fields.join(',')+'\n'+computed.map(p=>fields.map(k=>p[k]).join(',')).join('\n')+'\n');
const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;');
const labels={cobra:'Cobra',viper:'Viper',client_golang:'Prometheus client',gin:'Gin',grpc:'gRPC-Go',hugo:'Hugo',prometheus:'Prometheus server'};
function chart(file,title,beforeKey,afterKey,unit){
 const width=1000,rowHeight=70,height=130+computed.length*rowHeight,left=190,barWidth=590;
 const max=Math.max(...computed.map(x=>Math.max(beforeKey(x),afterKey(x))));
 const pieces=[`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title desc"><title id="title">${esc(title)}</title><desc id="desc">Measured combined versus split cache values for seven projects. Exact numbers are provided in the adjacent report table.</desc><rect width="100%" height="100%" fill="#fff"/><g font-family="Arial, sans-serif" fill="#172033"><text x="24" y="34" font-size="22" font-weight="bold">${esc(title)}</text><rect x="24" y="54" width="16" height="16" fill="#64748b"/><text x="48" y="68" font-size="14">Combined</text><rect x="160" y="54" width="16" height="16" fill="#2563eb"/><text x="184" y="68" font-size="14">Split</text>`];
 computed.forEach((p,i)=>{const y=105+i*rowHeight;pieces.push(`<text x="24" y="${y+22}" font-size="15">${esc(labels[p.slug])}</text>`);[beforeKey(p),afterKey(p)].forEach((v,j)=>{pieces.push(`<rect x="${left}" y="${y+j*25}" width="${v/max*barWidth}" height="19" rx="3" fill="${j?'#2563eb':'#64748b'}"/><text x="${left+v/max*barWidth+8}" y="${y+j*25+15}" font-size="13">${v.toFixed(2)} ${esc(unit)}</text>`)});});
 pieces.push('</g></svg>');return fs.writeFile(path.join(assets,file),pieces.join('\n')+'\n');
}
await chart('two-version-storage.svg','Retained cache storage across two Go versions',p=>p.storageBeforeMiB,p=>p.storageAfterMiB,'MiB');
await chart('second-version-upload.svg','Cache uploads when populating the second Go version',p=>p.uploadBeforeMiB,p=>p.uploadAfterMiB,'MiB');
await chart('warm-restore.svg','Warm-cache setup median: wins and regressions',p=>p.warmRestore.baseline.median,p=>p.warmRestore.split.median,'s');
console.log(JSON.stringify({total,projects:computed.map(x=>({slug:x.slug,warm:x.warmRestore,upgradeCacheAndDependencies:[x.upgrade.cacheAndDependenciesBeforeSeconds,x.upgrade.cacheAndDependenciesAfterSeconds],threeVersionProjection:x.projectedThreeVariants})),samples:samples.length,jobs:jobs.length},null,2));
