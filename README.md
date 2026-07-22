# 2D Hartree–Fock Lab

A serverless scientific workbench for restricted and unrestricted Hartree–Fock Born–Oppenheimer molecular dynamics in a model two-dimensional universe.

[![CI](https://github.com/jjjhenriksen/hf2d-lab/actions/workflows/ci.yml/badge.svg)](https://github.com/jjjhenriksen/hf2d-lab/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-0d758c.svg)](LICENSE)

**[Launch the live simulator](https://jacquelinehenriksen.com/hf2d-lab/)**

The interaction convention is

```text
Gε(r) = -½ log((r² + ε²) / r₀²)
```

in dimensionless 2D atomic units. This is model physics, not predictive three-dimensional chemistry; Hartree–Fock also omits electron correlation.

## Run locally

The generated WASM module is checked in, so the UI can start after installing JavaScript dependencies:

```sh
npm install
npm run dev
```

Rebuilding the Rust reference kernel or running the production build requires the stable Rust toolchain, the `wasm32-unknown-unknown` target, and `wasm-pack`:

```sh
npm run wasm:build
npm run check
```

## Numerical paths

- The float64 Rust/WASM module performs zero-padded FFT convolution and kinetic preconditioning for the real-space RHF/UHF solver.
- A TypeScript implementation remains as the portable diagnostic fallback and as a directly testable reference.
- WebGPU is capability-detected and supplies a float32 density compute kernel. SCF and force acceptance remain on the float64 WASM path so a precision change is never hidden.

The solver uses a fourth-order finite-difference kinetic operator, exact occupied-orbital exchange convolutions, residual-based orbital optimization with kinetic preconditioning, and a convergence-gated Velocity Verlet step. Unconverged geometries are rejected without advancing time.

The **Iteration speed** control paces accepted molecular-dynamics steps from 0.25 to 4 steps per second. It never changes the physical timestep or relaxes SCF convergence; if a solve takes longer than the requested interval, the next accepted step starts immediately.

## Data

Session export produces an `hf2d-session/v1` ZIP containing the configuration, checkpoint metadata, density and orbital buffers, trajectory and convergence CSV files, backend metadata, and a PNG preview. The last stable configuration is autosaved locally in IndexedDB.

## Limits

The validated configuration schema accepts up to 16 nuclei, 24 electrons, and 64²/128² grids. The 256² option is marked experimental. The interface supports RHF singlets and UHF spin multiplicities; ROHF, TDHF/Ehrenfest dynamics, correlation methods, thermostats, periodic boundaries, and geometry optimization are outside v1.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
