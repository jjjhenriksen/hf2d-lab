declare module 'fft.js' {
  export default class FFT {
    constructor(size: number)
    createComplexArray(): number[]
    toComplexArray(input: ArrayLike<number>, storage?: number[]): number[]
    fromComplexArray(input: ArrayLike<number>, storage?: number[]): number[]
    transform(output: number[], input: ArrayLike<number>): void
    realTransform(output: number[], input: ArrayLike<number>): void
    inverseTransform(output: number[], input: ArrayLike<number>): void
    completeSpectrum(spectrum: number[]): void
  }
}
