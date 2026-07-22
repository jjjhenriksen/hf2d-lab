/* tslint:disable */
/* eslint-disable */

export class ReferenceCore {
    free(): void;
    [Symbol.dispose](): void;
    convolve(field: Float64Array): Float64Array;
    density(orbitals: Float64Array, orbital_count: number): Float64Array;
    kinetic(field: Float64Array): Float64Array;
    constructor(field_size: number, spacing: number, epsilon: number, reference_length: number);
    precondition(field: Float64Array, shift: number): Float64Array;
}

export function logarithmic_kernel(r_squared: number, epsilon: number, reference_length: number): number;

export function pair_force(q_a: number, q_b: number, dx: number, dy: number, epsilon: number): Float64Array;

export function spin_occupations(electrons: number, multiplicity: number, restricted: boolean): Uint32Array;

export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_referencecore_free: (a: number, b: number) => void;
    readonly logarithmic_kernel: (a: number, b: number, c: number) => number;
    readonly pair_force: (a: number, b: number, c: number, d: number, e: number) => [number, number];
    readonly referencecore_convolve: (a: number, b: number, c: number) => [number, number, number, number];
    readonly referencecore_density: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly referencecore_kinetic: (a: number, b: number, c: number) => [number, number, number, number];
    readonly referencecore_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly referencecore_precondition: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly spin_occupations: (a: number, b: number, c: number) => [number, number, number, number];
    readonly version: () => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
