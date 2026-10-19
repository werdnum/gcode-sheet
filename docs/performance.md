# Runtime and PNG encoding measurements

Measured on 2026-10-19 against `469bea0`, after the parser and physical-slot fixes. Fixing PNG filtering to Paeth speeds up the default Node package without changing decoded pixels. An optional Bun package provides a further speed improvement, with higher peak memory on some inputs. Node.js 24 remains the default.

## End-to-end results

Wall times are medians of five fresh processes per case, interleaving variants. Each process parses the file, builds and renders all four views, writes the PNG and summary, and exits. The host was x86_64 Linux on an AMD EPYC 9V74, with a four-CPU quota and Mesa llvmpipe configured with `LP_NUM_THREADS=4`. All runs used the default 800-pixel panels and labels.

| Input | Detail | Previous Node 24 | Paeth + Node 24 | Paeth + Node 26 | Paeth + Bun |
|---|---|---:|---:|---:|---:|
| Caliper, 0.18 MB payload | full | 0.391 s | 0.322 s | 0.304 s | 0.287 s |
| Prusa MMU fixture, 13.05 MB | full | 1.203 s | 1.132 s | 1.043 s | 0.940 s |
| Prusa MMU fixture, 13.05 MB | shell | 0.754 s | 0.668 s | 0.650 s | 0.568 s |
| Prusa large fixture, 27.79 MB payload | full | 2.169 s | 2.132 s | 2.036 s | 1.867 s |
| Prusa large fixture, 27.79 MB payload | shell | 1.047 s | 0.985 s | 0.977 s | 0.792 s |

The Node change reduces total time by about 2–18% here. Bun with the same change reduces total time by about 14–27% relative to the previous Node version, or 11–20% relative to the updated Node version. These measurements describe this host and these inputs; graphics-heavy workloads remain limited by Mesa.

| Input / detail | Paeth + Node 24 peak RSS | Paeth + Node 26 peak RSS | Paeth + Bun peak RSS |
|---|---:|---:|---:|
| Caliper / full | 140 MiB | 161 MiB | 144 MiB |
| MMU / full | 267 MiB | 288 MiB | 296 MiB |
| MMU / shell | 229 MiB | 249 MiB | 254 MiB |
| Large / full | 322 MiB | 349 MiB | 330 MiB |
| Large / shell | 259 MiB | 272 MiB | 266 MiB |

Peak RSS is the median of per-process high-water marks, including native graphics allocations. Node 26.12.0 was faster than Node 24.19.0 in these repeated runs but used more memory. Bun 1.4.2 was faster still, with workload-dependent memory use. The flake's pinned Bun version matches the benchmark; its native addon compatibility is checked on both supported architectures.

## What changed and what was ruled out

`pngjs` normally scores five filter candidates for every row. Fixed Paeth filtering cut isolated PNG encoding from roughly 140 ms to 60 ms on the caliper image. Across the benchmark outputs, PNG sizes changed by approximately −5% to +1.4%. All decoded pixels and JSON summaries matched the previous version on all five cases and all three runtimes.

A CPU profile of the large full-detail case attributed roughly half the sampled time to native draw calls. Reworking upload-scene traversal and avoiding duplicate camera-tracker updates did not show a stable end-to-end improvement on these inputs, so those experiments were discarded. Raising llvmpipe's thread count from four to eight helped modestly on this host; reducing it to one increased both time and peak memory. The existing default remains four because that setting depends on the host's CPU limits and workload.

## Inputs and reproduction

The MMU input is `resources/test_data/test_multimaterial.gcode` from [PrusaSlicer at `30ef5919`](https://github.com/prusa3d/PrusaSlicer/tree/30ef59195e0f3ee6f270b185bb5f9fb5f349f81f/resources/test_data). The large input is the decoded G-code blocks from `test.bgcode` in the same directory. The caliper input is the decoded G-code blocks from this repository's bundled `.bgcode` fixture. For the decoded payload benchmarks, thumbnail and metadata blocks were omitted; binary-to-text conversion time is excluded. Sizes, SHA-256 hashes and all timing/memory samples are retained in [runtime-benchmark.json](runtime-benchmark.json).

To compare the packaged runtimes on your own files:

```bash
NODE_PACKAGE=$(nix build . --no-link --print-out-paths)
BUN_PACKAGE=$(nix build .#bun --no-link --print-out-paths)

GCODE_SHEET_BIN="$NODE_PACKAGE/bin/gcode-sheet" BENCH_REPEATS=5 \
  ./bench/run.sh part.gcode another.bgcode
GCODE_SHEET_BIN="$BUN_PACKAGE/bin/gcode-sheet" BENCH_REPEATS=5 \
  ./bench/run.sh part.gcode another.bgcode
```

The script accepts explicit input files without generating the Benchy fixtures, reports full and shell detail, and measures median wall time and peak RSS. Binary inputs include decoding time. Runtime, Mesa version, CPU allocation and file contents all affect results. `nix flake check -L` runs the 17 CLI regressions and caliper checks under both runtimes, then compares their decoded PNG pixels and JSON summaries in both colour modes.
