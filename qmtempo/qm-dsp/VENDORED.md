# Vendored: Queen Mary DSP

Source: https://github.com/c4dm/qm-dsp — **GPL-2.0-or-later** (see `COPYING`).
`ext/kissfft/` is KissFFT by Mark Borgerding, BSD-3-Clause (see `ext/kissfft/COPYING`).

Only the beat-tracking path is kept. The tree here is **not** byte-identical to upstream; if you
need to re-vendor, take a fresh upstream copy and re-apply the cuts below rather than diffing
against this.

## What is kept

The 38 sources the build compiles, plus every header they reach transitively — `dsp/`, `maths/`,
`base/` and `ext/kissfft/`. Both licence files and both upstream READMEs.

## What was cut, and why

| Removed | Why |
|---|---|
| `ext/clapack/`, `ext/cblas/`, `include/clapack.h`, `include/cblas.h` | Only the segmentation and key-detection modules need LAPACK, and nothing on the beat-tracking path calls them. The Makefile already excluded them from compilation. |
| `tests/` | Upstream's own unit tests, for modules we mostly do not compile. |
| `thread/`, `hmm/`, `maths/pca/`, `maths/MedianFilter.h` | Unreachable from the beat tracker. |
| `.hgignore`, `.hgtags`, `.gitignore`, `.travis.yml`, `Doxyfile`, `CONTRIBUTING.md` | Upstream's VCS, CI and docs tooling. Nothing to do with a box. |
| `ext/kissfft/` extras — `Makefile`, `CHANGELOG`, `TIPS`, `kissfft.hh`, `.hg*` | The C sources are compiled directly by our own Makefile; the C++ header and upstream's build are unused. |

## Verified

Pruned and unpruned builds were compiled and run against the same 8kHz mono PCM and produced
byte-identical output (`121.3347 119.9876 0.2185 30 29` on a 120 BPM click track).
