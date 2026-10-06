# Disposable setup-go cache benchmark

Seven pinned upstream Go source snapshots with original notices and licenses. These are scratch copies, not maintained forks. Upstream GitHub workflows use `actions/setup-go`.

| Project | Declared requirements | Source tag |
| --- | ---: | --- |
| spf13/cobra | 4 | v1.10.2 |
| spf13/viper | 17 | v1.21.0 |
| prometheus/client_golang | 23 | v1.24.1 |
| gin-gonic/gin | 35 | v1.12.0 |
| grpc/grpc-go | 43 | v1.84.0 |
| gohugoio/hugo | 184 | v0.159.0 |
| prometheus/prometheus | 251 | v3.15.0 |

See projects.json for exact commit provenance and bounded build-package selections. `go mod download` pre-fills modules according to Go's default semantics: explicit requirements for Go1.17+ module files, or all transitively required modules for older files. The resolved graph can contain more modules than are downloaded; `go list -m -json all` records that graph after the timed build. `go build` populates compiled cache entries without running tests. No test suite, race build, or external service deployment is run. Hugo uses a Go-1.25-compatible release so every project can use the same Go toolchains.

## Method

Compare immutable action commits: combined `90ad2b35f69faf97585ad74d28fa006d2739b7af` and split `ad9941188fbcb38febe37eac394b80bd9bc34fc8`. The harness does not modify either action. Both use @actions/cache6.3.0. Every workload uses Windows hosted runners, identical explicit cache paths, CGO disabled, and the same source revision and dependency hash. Go toolchains are installed before measured samples to avoid counting download differences as cache savings.

Dispatch seed first on Go1.26.7 (one cold sample per project/action), then warm (ten full-hit samples) and upgrade on Go1.26.8 (one module-reuse/build-miss sample). Upgrade measurements include full module downloading and rebuilding on the combined-cache side. Cold and upgrade saves are measured once per project, not portrayed as ten-pair timing estimates. Repeated full-hit comparisons clear local module/build directories before every sample. Build-v2 uses a new path-derived cache version so archives from the cancelled test-based pilot cannot influence the measurements.

Each sample runs the unmodified real setup-go action; its post action saves through the real GitHub cache service at job end. JSON artifacts include action/restore wall time, module download time, build time, hit output, and disk-cache file counts and bytes. The GitHub jobs API and logs provide post-save duration and compressed transfer bytes; the cache API supplies persisted archive sizes. Two action variants are isolated by job, not by changing module file hashes. Paired samples are indexed within matching project/scenario jobs; distinct VMs mean their CPU/noise cannot be controlled as tightly as local pairs.

The repository contains public upstream code only. Workflow permissions are read-only except the normal Actions cache-service access. No secrets, deployments, or publication steps. Do not enable upstream copied workflows; only the root benchmark workflow executes. No automatic deletion of the scratch repository or its caches is performed.

## Results

The [split-cache benchmark and adoption report](reports/setup-go-split-cache-benchmark-report.md) adds an executive summary, verified upstream CI case studies, storage/upload charts, latency wins and regressions, and reproducible JSON/CSV analysis. It uses the existing October 5 hosted measurements; it does not claim a fresh independent-run experiment.

See [RESULTS.md](RESULTS.md) for measured warm-cache timing and actual upload/storage bytes, including regressions and sampling limits. A cancelled test-based pilot is excluded from every reported figure.
