import FFT from 'fft.js'

type ComplexArray = number[]

export interface FieldConvolver {
  convolve(field: Float64Array): Float64Array
  precondition(field: Float64Array, shift?: number): Float64Array
}

export class OpenBoundaryConvolver {
  readonly fieldSize: number
  readonly paddedSize: number
  readonly spacing: number
  private readonly fft: FFT
  private readonly kernelSpectrum: ComplexArray

  constructor(fieldSize: number, spacing: number, epsilon: number, referenceLength: number) {
    this.fieldSize = fieldSize
    this.paddedSize = fieldSize * 2
    this.spacing = spacing
    this.fft = new FFT(this.paddedSize)

    const kernel = new Float64Array(this.paddedSize * this.paddedSize)
    for (let y = 0; y < this.paddedSize; y += 1) {
      const sy = y <= this.paddedSize / 2 ? y : y - this.paddedSize
      for (let x = 0; x < this.paddedSize; x += 1) {
        const sx = x <= this.paddedSize / 2 ? x : x - this.paddedSize
        const r2 = (sx * spacing) ** 2 + (sy * spacing) ** 2
        kernel[y * this.paddedSize + x] = -0.5 * Math.log((r2 + epsilon * epsilon) / (referenceLength * referenceLength))
      }
    }
    this.kernelSpectrum = this.transformReal(kernel)
  }

  convolve(field: Float64Array) {
    if (field.length !== this.fieldSize * this.fieldSize) throw new Error('Convolution field has the wrong size.')
    const padded = new Float64Array(this.paddedSize * this.paddedSize)
    for (let y = 0; y < this.fieldSize; y += 1) {
      padded.set(field.subarray(y * this.fieldSize, (y + 1) * this.fieldSize), y * this.paddedSize)
    }
    const spectrum = this.transformReal(padded)
    for (let i = 0; i < spectrum.length; i += 2) {
      const ar = spectrum[i]!
      const ai = spectrum[i + 1]!
      const br = this.kernelSpectrum[i]!
      const bi = this.kernelSpectrum[i + 1]!
      spectrum[i] = ar * br - ai * bi
      spectrum[i + 1] = ar * bi + ai * br
    }
    const resultPadded = this.inverseReal(spectrum)
    const result = new Float64Array(field.length)
    const area = this.spacing * this.spacing
    for (let y = 0; y < this.fieldSize; y += 1) {
      for (let x = 0; x < this.fieldSize; x += 1) {
        result[y * this.fieldSize + x] = resultPadded[y * this.paddedSize + x]! * area
      }
    }
    return result
  }

  precondition(field: Float64Array, shift = 1) {
    if (field.length !== this.fieldSize * this.fieldSize) throw new Error('Preconditioner field has the wrong size.')
    const padded = new Float64Array(this.paddedSize * this.paddedSize)
    for (let y = 0; y < this.fieldSize; y += 1) padded.set(field.subarray(y * this.fieldSize, (y + 1) * this.fieldSize), y * this.paddedSize)
    const spectrum = this.transformReal(padded)
    const length = this.paddedSize * this.spacing
    for (let y = 0; y < this.paddedSize; y += 1) {
      const sy = y <= this.paddedSize / 2 ? y : y - this.paddedSize
      const ky = 2 * Math.PI * sy / length
      for (let x = 0; x < this.paddedSize; x += 1) {
        const sx = x <= this.paddedSize / 2 ? x : x - this.paddedSize
        const kx = 2 * Math.PI * sx / length
        const factor = 1 / (shift + 0.5 * (kx * kx + ky * ky))
        const index = 2 * (y * this.paddedSize + x)
        spectrum[index] = spectrum[index]! * factor
        spectrum[index + 1] = spectrum[index + 1]! * factor
      }
    }
    const real = this.inverseReal(spectrum)
    const result = new Float64Array(field.length)
    for (let y = 0; y < this.fieldSize; y += 1) {
      for (let x = 0; x < this.fieldSize; x += 1) result[y * this.fieldSize + x] = real[y * this.paddedSize + x]!
    }
    return result
  }

  private transformReal(input: Float64Array) {
    const complex = new Array<number>(input.length * 2).fill(0)
    for (let i = 0; i < input.length; i += 1) complex[2 * i] = input[i]!
    return this.transformComplex(complex, false)
  }

  private inverseReal(input: ComplexArray) {
    const complex = this.transformComplex(input.slice(), true)
    const result = new Float64Array(complex.length / 2)
    for (let i = 0; i < result.length; i += 1) result[i] = complex[2 * i]!
    return result
  }

  private transformComplex(data: ComplexArray, inverse: boolean) {
    const size = this.paddedSize
    const rowIn = this.fft.createComplexArray()
    const rowOut = this.fft.createComplexArray()
    for (let y = 0; y < size; y += 1) {
      const offset = 2 * y * size
      for (let x = 0; x < size; x += 1) {
        rowIn[2 * x] = data[offset + 2 * x]!
        rowIn[2 * x + 1] = data[offset + 2 * x + 1]!
      }
      if (inverse) this.fft.inverseTransform(rowOut, rowIn)
      else this.fft.transform(rowOut, rowIn)
      for (let x = 0; x < size; x += 1) {
        data[offset + 2 * x] = rowOut[2 * x]!
        data[offset + 2 * x + 1] = rowOut[2 * x + 1]!
      }
    }

    const colIn = this.fft.createComplexArray()
    const colOut = this.fft.createComplexArray()
    for (let x = 0; x < size; x += 1) {
      for (let y = 0; y < size; y += 1) {
        const index = 2 * (y * size + x)
        colIn[2 * y] = data[index]!
        colIn[2 * y + 1] = data[index + 1]!
      }
      if (inverse) this.fft.inverseTransform(colOut, colIn)
      else this.fft.transform(colOut, colIn)
      for (let y = 0; y < size; y += 1) {
        const index = 2 * (y * size + x)
        data[index] = colOut[2 * y]!
        data[index + 1] = colOut[2 * y + 1]!
      }
    }
    return data
  }
}
