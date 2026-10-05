# Hosted build-only cache results

Measured on 2026-10-05 using public `windows-latest` runners (4 logical CPUs, image20260925.250.1) and the real GitHub Actions cache service. Baseline is actions/setup-go90ad2b3; split is ad99411 from draft PR797. Both include @actions/cache6.3.0. All42 accepted jobs and168 build-only samples succeeded, with no cache restore/save warnings. No tests were run in the accepted benchmark. The cancelled test pilot is excluded and uses a different path-derived cache version.

- [Cold population: 14 jobs](https://github.com/qmuntal/setup-go-cache-bench-20261005/actions/runs/37318273231)
- [Warm cache: 140 samples](https://github.com/qmuntal/setup-go-cache-bench-20261005/actions/runs/37319456778)
- [Go version change: 14 samples](https://github.com/qmuntal/setup-go-cache-bench-20261005/actions/runs/37322876950)

## Warm-cache restore/setup wall time

Ten exact-hit samples per project/variant. Values below include the actual setup-go action, service lookup, download, extraction, and the small surrounding composite/shell-start overhead. Toolchain downloads occurred before the measured steps. Local module/build caches were removed before each sample. No cache bytes were uploaded in these jobs.

| Project | Declared requirements | Combined median | Split median | Change in elapsed time |
| --- | ---: | ---: | ---: | ---: |
| Cobra | 4 | 2.87 s | 2.96 s | 3.2% slower |
| Viper | 17 | 4.98 s | 3.84 s | 22.9% faster |
| Prometheus client | 23 | 5.62 s | 5.86 s | 4.3% slower |
| Gin | 35 | 8.21 s | 7.02 s | 14.5% faster |
| gRPC-Go | 43 | 9.41 s | 8.43 s | 10.4% faster |
| Hugo | 184 | 16.64 s | 12.68 s | 23.8% faster |
| Prometheus server | 251 | 57.06 s | 62.02 s | 8.7% slower |

Four projects improved and three regressed. Summing these medians gives104.78 s combined versus102.81 s split (1.9% less), but that synthetic sum is not a measured workflow-duration saving. Large module graphs do not guarantee lower restore latency.

## Go1.26.7 to Go1.26.8: actual cache writes

The combined key missed after the Go version changed. Every split job restored the exact module key and missed the build key, then saved only the new build entry. These are actual successful cache uploads; compressed byte counts come from persisted cache-service records matched to the job's saved keys. Post duration includes archive creation, reservation, upload, and finalization. There is only one version-change sample per variant/project, so durations below are observations, not stable estimates.

| Project | Combined upload | Split upload | Upload reduction | Combined post-save | Split post-save |
| --- | ---: | ---: | ---: | ---: | ---: |
| Cobra | 14.06 MiB | 13.45 MiB | 4.3% | 3.13 s | 1.50 s |
| Viper | 49.47 MiB | 27.86 MiB | 43.7% | 3.27 s | 3.25 s |
| Prometheus client | 123.65 MiB | 30.71 MiB | 75.2% | 6.92 s | 2.40 s |
| Gin | 98.46 MiB | 43.92 MiB | 55.4% | 5.10 s | 2.69 s |
| gRPC-Go | 172.32 MiB | 53.49 MiB | 69.0% | 6.68 s | 2.70 s |
| Hugo | 354.35 MiB | 82.83 MiB | 76.6% | 16.21 s | 4.30 s |
| Prometheus server | 881.93 MiB | 55.86 MiB | 93.7% | 26.33 s | 3.87 s |

Across all seven version-change jobs, uploads were1694.25 MiB combined versus308.11 MiB split:1386.13 MiB (81.8%) avoided. This aggregate is dominated by the dependency-heavy projects. The seed cache sizes plus the version-change uploads yield3388.02 MiB for the combined design versus2002.33 MiB for split:40.9% less retained storage for these two Go versions. These measured totals exclude the obsolete pilot caches, artifact uploads, and caches for the other design. They are not global cross-repository deduplication.

## Why upload savings do not guarantee end-to-end wins

Module reuse adds a cache download/extraction that the combined key miss does not do. The cost must be compared with avoided module downloads plus the cheaper save, not with the baseline miss lookup alone.

| Project | Combined miss setup + module download | Split module-hit setup + module download |
| --- | ---: | ---: |
| Cobra | 2.61 s | 2.63 s |
| Viper | 3.70 s | 3.73 s |
| Prometheus client | 4.65 s | 4.40 s |
| Gin | 5.65 s | 8.78 s |
| gRPC-Go | 8.65 s | 7.19 s |
| Hugo | 18.24 s | 14.67 s |
| Prometheus server | 39.77 s | 54.48 s |

For Prometheus, the module cache expanded to about2.60 GiB and its compressed module archive was much larger than the build archive. Module-hit restore took53.08 s, compared with1.16 s for the baseline miss plus38.61 s downloading modules. The split still avoided826.07 MiB of writes and shortened post-save by22.47 s, but the restore itself was not a win.

Cold/version-change compilation durations varied substantially across independent VMs. For example, Viper's upgrade build was50.44 s combined versus25.33 s split, and Prometheus was49.39 s versus75.93 s. Both build caches missed on upgrade, and these runs do not isolate a causal compiler speedup or slowdown from the cache layout. Do not attribute these one-sample build-time differences to the action, or turn the observed total times into a CI-speedup claim.

## Limits

- Ten warm samples are repeated on one VM per project/variant, not ten independent runner pairs. Source, image, CPU count, paths, and Go version match, but CPU/disk/network contention and host differences remain uncontrolled. No confidence intervals over independent runners are claimed.
- Cold save and Go-version-change save measurements have one pair per project. Their byte counts are concrete persisted archives, but the timing estimates are noisy.
- Modules are deliberately pre-filled with `go mod download`; this is not identical to an application that downloads only packages used by its build. Hugo and Prometheus use bounded build subsets, not full production release builds. No race build, test execution, external service, or deployment.
- Gin declares35 requirements; the selection initially counted34 because it missed the single-line indirect requirement. Metadata is corrected; snapshots, hashes, workloads, and accepted measurements are unchanged.
- The resolved `go list -m all` graph has6/26/42/56/86/435/746 non-main modules respectively; those counts are not all downloaded source modules. Cache disk/transfer bytes, not declared counts, are the relevant storage measurements.
- This design adds lookups and metadata for two entries, and parallel work can increase instantaneous resource demands. It lowers repeated module writes and storage here, but is not universally faster.

The collector and machine-readable results are in the benchmark-data directory. The original setup-go PR and working tree were not modified by these experiments.
