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
- WebGPU hybrid mode batches alpha/beta density reduction and every occupied-orbital kinetic stencil, then runs FFT convolution and kinetic preconditioning through reusable float32 GPU buffers. It reports float32 precision explicitly, uses a documented `2e-5` SCF residual floor, and retains convergence-gated force acceptance. Rust/WASM remains the portable float64 reference path.

The solver uses a fourth-order finite-difference kinetic operator, exact occupied-orbital exchange convolutions, residual-based orbital optimization with kinetic preconditioning, and a convergence-gated Velocity Verlet step. Unconverged geometries are rejected without advancing time.

### WebGPU validation

Performance comparisons use the H₂ analogue in Chrome, discard the first solve after changing a backend or grid, and report the median of five worker-reported SCF durations. The 128² fixture runs to convergence with the default 200-iteration cap. Because the current 256² fixture does not converge on either backend within that cap, its throughput comparison uses exactly 20 iterations and requires both paths to report the same nonconverged state.

Backend comparisons must keep the total-energy difference within `5e-5` au, the integrated-density difference within `1e-5` electrons, and the residual difference within `5e-5`; each converged result must also satisfy its reported precision floor. Accepted-step behavior must agree, and an accepted step must advance time by the configured `Δt`. Benchmark reports should include the browser, WebGPU adapter label, raw timing samples, convergence state, energy, residual, and density integral.

The **Iteration speed** control accepts any positive target rate, with 0.25, 0.5, 1, 2, and 4 steps per second retained as suggestions. **Unlimited speed** removes the artificial pacing delay and starts each accepted step as soon as the worker can proceed. Neither mode changes the physical timestep or relaxes SCF convergence.

The physical **Time step Δt** is editable in both guided experiments and the open sandbox while the simulation is paused. Changing it reinitializes the current setup at `t = 0` so every accepted force evaluation still begins from a converged electronic state.

The **Damping γ** control is also editable while paused. `γ = 0` preserves molecular dynamics, while positive values exponentially dissipate nuclear velocities; large values provide a relaxation workflow toward local potential-energy minima without bypassing SCF convergence.

Recommended numerical ranges are advisory rather than hard limits. The inspector accepts finite, physically valid values outside those ranges and displays an inline instability warning; structural constraints such as positive masses, compatible spin occupations, supported grid sizes, and resource caps remain enforced.

## Data

Session export produces an `hf2d-session/v1` ZIP containing the configuration, checkpoint metadata, density and orbital buffers, trajectory and convergence CSV files, backend metadata, and a PNG preview. The last stable configuration is autosaved locally in IndexedDB.

## Limits

The validated configuration schema accepts up to 16 nuclei, 24 electrons, and 64²/128² grids plus an experimental 256² option. The interface supports RHF singlets and UHF spin multiplicities; ROHF, TDHF/Ehrenfest dynamics, correlation methods, thermostats, periodic boundaries, and geometry optimization are outside v1.

## Contributing

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and [SECURITY.md](SECURITY.md) for responsible vulnerability reporting.
