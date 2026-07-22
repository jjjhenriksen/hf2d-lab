# Contributing

Thank you for helping improve the 2D Hartree–Fock Lab.

## Development setup

You need Node.js 22 or newer. The checked-in WASM artifact is sufficient for ordinary UI development:

```sh
npm ci
npm run dev
```

Rebuilding the numerical kernel also requires stable Rust, the `wasm32-unknown-unknown` target, and `wasm-pack` 0.13 or newer.

## Before opening a pull request

Run the complete local verification suite:

```sh
cargo test --manifest-path engine-wasm/Cargo.toml
npm run check
```

Keep changes focused. Numerical changes should include a regression test and state the relevant energy, density, or force tolerance. Interface changes should be keyboard accessible and checked at desktop and phone widths.

This project models a two-dimensional universe. Avoid describing its results as predictive three-dimensional chemistry.
