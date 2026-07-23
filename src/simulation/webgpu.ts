import type { EngineConvolver } from './fft2d'
import type { SimulationConfig } from './types'

const DENSITY_SHADER = /* wgsl */`
struct Params {
  points: u32,
  grid_size: u32,
  alpha_orbitals: u32,
  beta_orbitals: u32,
  kinetic_scale: f32,
  _padding0: u32,
  _padding1: u32,
  _padding2: u32,
}
@group(0) @binding(0) var<storage, read> coefficients: array<f32>;
@group(0) @binding(1) var<storage, read_write> fields: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

fn coefficient(orbital: u32, x: i32, y: i32) -> f32 {
  let size = i32(params.grid_size);
  if (x < 0 || y < 0 || x >= size || y >= size) { return 0.0; }
  return coefficients[orbital * params.points + u32(y) * params.grid_size + u32(x)];
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let lane = id.y;
  let total_orbitals = params.alpha_orbitals + params.beta_orbitals;
  if (index >= params.points || lane >= 2u + total_orbitals) { return; }

  if (lane < 2u) {
    let orbitals = select(params.alpha_orbitals, params.beta_orbitals, lane == 1u);
    let offset = select(0u, params.alpha_orbitals, lane == 1u);
    var rho = 0.0;
    for (var orbital = 0u; orbital < orbitals; orbital += 1u) {
      let value = coefficients[(offset + orbital) * params.points + index];
      rho += value * value;
    }
    fields[lane * params.points + index] = rho;
    return;
  }

  let orbital = lane - 2u;
  let x = i32(index % params.grid_size);
  let y = i32(index / params.grid_size);
  let laplacian = -coefficient(orbital, x + 2, y) + 16.0 * coefficient(orbital, x + 1, y) - 30.0 * coefficient(orbital, x, y) + 16.0 * coefficient(orbital, x - 1, y) - coefficient(orbital, x - 2, y)
    - coefficient(orbital, x, y + 2) + 16.0 * coefficient(orbital, x, y + 1) - 30.0 * coefficient(orbital, x, y) + 16.0 * coefficient(orbital, x, y - 1) - coefficient(orbital, x, y - 2);
  fields[(2u + orbital) * params.points + index] = params.kinetic_scale * laplacian;
}
`

const PACK_REAL_SHADER = /* wgsl */`
struct Params { field_size: u32, padded_size: u32, _padding0: u32, _padding1: u32 }
@group(0) @binding(0) var<storage, read> field: array<f32>;
@group(0) @binding(1) var<storage, read_write> complex_field: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let points = params.padded_size * params.padded_size;
  if (index >= points) { return; }
  let x = index % params.padded_size;
  let y = index / params.padded_size;
  var value = 0.0;
  if (x < params.field_size && y < params.field_size) {
    value = field[y * params.field_size + x];
  }
  complex_field[index] = vec2<f32>(value, 0.0);
}
`

const BIT_REVERSE_SHADER = /* wgsl */`
struct Params { size: u32, bits: u32, horizontal: u32, _padding: u32 }
@group(0) @binding(0) var<storage, read> source: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output_values: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn reverse_bits(value: u32) -> u32 {
  var input = value;
  var reversed = 0u;
  for (var bit = 0u; bit < params.bits; bit += 1u) {
    reversed = (reversed << 1u) | (input & 1u);
    input = input >> 1u;
  }
  return reversed;
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let points = params.size * params.size;
  if (index >= points) { return; }
  let x = index % params.size;
  let y = index / params.size;
  let destination = select(reverse_bits(y) * params.size + x, y * params.size + reverse_bits(x), params.horizontal == 1u);
  output_values[destination] = source[index];
}
`

const FFT_STAGE_SHADER = /* wgsl */`
struct Params { size: u32, stage_size: u32, horizontal: u32, inverse: u32 }
@group(0) @binding(0) var<storage, read> source: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> output_values: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn multiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let points = params.size * params.size;
  if (index >= points) { return; }
  let x = index % params.size;
  let y = index / params.size;
  let coordinate = select(y, x, params.horizontal == 1u);
  let half = params.stage_size / 2u;
  let group_start = (coordinate / params.stage_size) * params.stage_size;
  let offset = coordinate % half;
  let even_coordinate = group_start + offset;
  let odd_coordinate = even_coordinate + half;
  let even_index = select(even_coordinate * params.size + x, y * params.size + even_coordinate, params.horizontal == 1u);
  let odd_index = select(odd_coordinate * params.size + x, y * params.size + odd_coordinate, params.horizontal == 1u);
  let direction = select(-1.0, 1.0, params.inverse == 1u);
  let angle = direction * 6.283185307179586 * f32(offset) / f32(params.stage_size);
  let twiddle = vec2<f32>(cos(angle), sin(angle));
  let product = multiply(source[odd_index], twiddle);
  let upper = coordinate % params.stage_size < half;
  output_values[index] = select(source[even_index] - product, source[even_index] + product, upper);
}
`

const SPECTRAL_SHADER = /* wgsl */`
struct Params { size: u32, mode: u32, spacing: f32, shift: f32 }
@group(0) @binding(0) var<storage, read_write> values: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read> kernel: array<vec2<f32>>;
@group(0) @binding(2) var<uniform> params: Params;

fn multiply(a: vec2<f32>, b: vec2<f32>) -> vec2<f32> {
  return vec2<f32>(a.x * b.x - a.y * b.y, a.x * b.y + a.y * b.x);
}

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let points = params.size * params.size;
  if (index >= points) { return; }
  if (params.mode == 0u) {
    values[index] = multiply(values[index], kernel[index]);
    return;
  }
  let x = index % params.size;
  let y = index / params.size;
  let sx = select(i32(x), i32(x) - i32(params.size), x > params.size / 2u);
  let sy = select(i32(y), i32(y) - i32(params.size), y > params.size / 2u);
  let length = f32(params.size) * params.spacing;
  let kx = 6.283185307179586 * f32(sx) / length;
  let ky = 6.283185307179586 * f32(sy) / length;
  values[index] *= 1.0 / (params.shift + 0.5 * (kx * kx + ky * ky));
}
`

const EXTRACT_REAL_SHADER = /* wgsl */`
struct Params { field_size: u32, padded_size: u32, scale: f32, _padding: u32 }
@group(0) @binding(0) var<storage, read> complex_field: array<vec2<f32>>;
@group(0) @binding(1) var<storage, read_write> field: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let points = params.field_size * params.field_size;
  if (index >= points) { return; }
  let x = index % params.field_size;
  let y = index / params.field_size;
  field[index] = complex_field[y * params.padded_size + x].x * params.scale;
}
`

interface DensityBuffers {
  input: GPUBuffer
  output: GPUBuffer
  readback: GPUBuffer
  uniform: GPUBuffer
  bindGroup: GPUBindGroup
  inputBytes: number
  outputBytes: number
}

export class WebGpuDensityAccelerator {
  private buffers: DensityBuffers | null = null

  private constructor(private readonly device: GPUDevice, private readonly pipeline: GPUComputePipeline, readonly adapterLabel: string) {}

  static async create() {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable in this browser.')
    const adapter = await globalThis.navigator.gpu.requestAdapter({ featureLevel: 'compatibility' })
    if (!adapter) throw new Error('No compatible WebGPU adapter was found.')
    const device = await adapter.requestDevice()
    const module = device.createShaderModule({ code: DENSITY_SHADER })
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    const info = adapter.info
    const adapterLabel = [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' · ') || 'WebGPU adapter'
    return new WebGpuDensityAccelerator(device, pipeline, adapterLabel)
  }

  get lost() {
    return this.device.lost
  }

  async createConvolver(config: SimulationConfig) {
    return WebGpuFieldConvolver.create(this.device, config)
  }

  async densities(alpha: Float64Array[], beta: Float64Array[], points: number, gridSize: number, spacing: number) {
    const packed = packSpinOrbitals(alpha, beta, points)
    const outputBytes = points * (2 + packed.alphaCount + packed.betaCount) * 4
    const buffers = this.ensureBuffers(packed.coefficients.byteLength, outputBytes)
    this.device.queue.writeBuffer(buffers.input, 0, packed.coefficients as Float32Array<ArrayBuffer>)
    const uniformValues = new ArrayBuffer(32)
    new Uint32Array(uniformValues, 0, 4).set([points, gridSize, packed.alphaCount, packed.betaCount])
    new Float32Array(uniformValues, 16, 1)[0] = -0.5 / (12 * spacing * spacing)
    this.device.queue.writeBuffer(buffers.uniform, 0, uniformValues)
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, buffers.bindGroup)
    pass.dispatchWorkgroups(Math.ceil(points / 128), 2 + packed.alphaCount + packed.betaCount)
    pass.end()
    encoder.copyBufferToBuffer(buffers.output, 0, buffers.readback, 0, outputBytes)
    this.device.queue.submit([encoder.finish()])
    await buffers.readback.mapAsync(GPUMapMode.READ)
    const result = unpackOrbitalFields(new Float32Array(buffers.readback.getMappedRange()), points, packed.alphaCount, packed.betaCount)
    buffers.readback.unmap()
    return result
  }

  private ensureBuffers(inputBytes: number, outputBytes: number) {
    if (this.buffers?.inputBytes === inputBytes && this.buffers.outputBytes === outputBytes) return this.buffers
    this.buffers?.input.destroy()
    this.buffers?.output.destroy()
    this.buffers?.readback.destroy()
    this.buffers?.uniform.destroy()
    const input = this.device.createBuffer({ size: align4(inputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const output = this.device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readback = this.device.createBuffer({ size: align4(outputBytes), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const uniform = this.device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    })
    this.buffers = { input, output, readback, uniform, bindGroup, inputBytes, outputBytes }
    return this.buffers
  }
}

type FftDirection = 0 | 1

class WebGpuFieldConvolver implements EngineConvolver {
  private readonly fieldSize: number
  private readonly paddedSize: number
  private readonly spacing: number
  private readonly fieldPoints: number
  private readonly paddedPoints: number
  private readonly input: GPUBuffer
  private readonly complexA: GPUBuffer
  private readonly complexB: GPUBuffer
  private readonly kernelSpectrum: GPUBuffer
  private readonly output: GPUBuffer
  private readonly readback: GPUBuffer
  private readonly packUniform: GPUBuffer
  private readonly bitReverseUniforms: [GPUBuffer, GPUBuffer]
  private readonly stageUniforms = new Map<string, GPUBuffer>()
  private readonly convolveUniform: GPUBuffer
  private readonly preconditionUniform: GPUBuffer
  private readonly convolveExtractUniform: GPUBuffer
  private readonly preconditionExtractUniform: GPUBuffer
  private pending: Promise<void> = Promise.resolve()

  private constructor(
    private readonly device: GPUDevice,
    private readonly packPipeline: GPUComputePipeline,
    private readonly bitReversePipeline: GPUComputePipeline,
    private readonly stagePipeline: GPUComputePipeline,
    private readonly spectralPipeline: GPUComputePipeline,
    private readonly extractPipeline: GPUComputePipeline,
    config: SimulationConfig,
  ) {
    this.fieldSize = config.gridSize
    this.paddedSize = config.gridSize * 2
    this.spacing = 2 * config.domainRadius / config.gridSize
    this.fieldPoints = this.fieldSize * this.fieldSize
    this.paddedPoints = this.paddedSize * this.paddedSize
    this.input = device.createBuffer({ size: this.fieldPoints * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const complexBytes = this.paddedPoints * 8
    this.complexA = device.createBuffer({ size: complexBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
    this.complexB = device.createBuffer({ size: complexBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC })
    this.kernelSpectrum = device.createBuffer({ size: complexBytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    this.output = device.createBuffer({ size: this.fieldPoints * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    this.readback = device.createBuffer({ size: this.fieldPoints * 4, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    this.packUniform = createUniform(device, new Uint32Array([this.fieldSize, this.paddedSize, 0, 0]))
    const bits = Math.log2(this.paddedSize)
    this.bitReverseUniforms = [
      createUniform(device, new Uint32Array([this.paddedSize, bits, 0, 0])),
      createUniform(device, new Uint32Array([this.paddedSize, bits, 1, 0])),
    ]
    for (const inverse of [0, 1] as FftDirection[]) {
      for (const horizontal of [0, 1] as FftDirection[]) {
        for (let stageSize = 2; stageSize <= this.paddedSize; stageSize *= 2) {
          this.stageUniforms.set(`${inverse}:${horizontal}:${stageSize}`, createUniform(device, new Uint32Array([this.paddedSize, stageSize, horizontal, inverse])))
        }
      }
    }
    this.convolveUniform = createSpectralUniform(device, this.paddedSize, 0, this.spacing, 0)
    this.preconditionUniform = createSpectralUniform(device, this.paddedSize, 1, this.spacing, 1)
    const inverseScale = 1 / this.paddedPoints
    this.convolveExtractUniform = createExtractUniform(device, this.fieldSize, this.paddedSize, inverseScale * this.spacing * this.spacing)
    this.preconditionExtractUniform = createExtractUniform(device, this.fieldSize, this.paddedSize, inverseScale)
  }

  static async create(device: GPUDevice, config: SimulationConfig) {
    const pipelines = await Promise.all([
      createPipeline(device, PACK_REAL_SHADER),
      createPipeline(device, BIT_REVERSE_SHADER),
      createPipeline(device, FFT_STAGE_SHADER),
      createPipeline(device, SPECTRAL_SHADER),
      createPipeline(device, EXTRACT_REAL_SHADER),
    ])
    const convolver = new WebGpuFieldConvolver(device, pipelines[0]!, pipelines[1]!, pipelines[2]!, pipelines[3]!, pipelines[4]!, config)
    await convolver.initializeKernel(config.softening, config.referenceLength)
    return convolver
  }

  convolve(field: Float64Array) {
    return this.enqueue(() => this.run(field, false, 0))
  }

  precondition(field: Float64Array, shift = 1) {
    return this.enqueue(() => this.run(field, true, shift))
  }

  private enqueue(operation: () => Promise<Float64Array>) {
    const result = this.pending.then(operation)
    this.pending = result.then(() => undefined, () => undefined)
    return result
  }

  private async initializeKernel(epsilon: number, referenceLength: number) {
    const values = new Float32Array(this.paddedPoints * 2)
    for (let y = 0; y < this.paddedSize; y += 1) {
      const sy = y <= this.paddedSize / 2 ? y : y - this.paddedSize
      for (let x = 0; x < this.paddedSize; x += 1) {
        const sx = x <= this.paddedSize / 2 ? x : x - this.paddedSize
        const r2 = (sx * this.spacing) ** 2 + (sy * this.spacing) ** 2
        values[2 * (y * this.paddedSize + x)] = -0.5 * Math.log((r2 + epsilon * epsilon) / (referenceLength * referenceLength))
      }
    }
    this.device.queue.writeBuffer(this.complexA, 0, values)
    const encoder = this.device.createCommandEncoder()
    const spectrum = this.encodeTransform(encoder, this.complexA, false)
    encoder.copyBufferToBuffer(spectrum, 0, this.kernelSpectrum, 0, this.paddedPoints * 8)
    this.device.queue.submit([encoder.finish()])
    await this.device.queue.onSubmittedWorkDone()
  }

  private async run(field: Float64Array, precondition: boolean, shift: number) {
    if (field.length !== this.fieldPoints) throw new Error('WebGPU convolution field has the wrong size.')
    this.device.queue.writeBuffer(this.input, 0, Float32Array.from(field))
    if (precondition) this.device.queue.writeBuffer(this.preconditionUniform, 12, new Float32Array([shift]))
    const encoder = this.device.createCommandEncoder()
    this.encodePass(encoder, this.packPipeline, [this.input, this.complexA], this.packUniform, this.paddedPoints)
    let spectrum = this.encodeTransform(encoder, this.complexA, false)
    this.encodeSpectral(encoder, spectrum, precondition ? this.preconditionUniform : this.convolveUniform)
    spectrum = this.encodeTransform(encoder, spectrum, true)
    this.encodePass(
      encoder,
      this.extractPipeline,
      [spectrum, this.output],
      precondition ? this.preconditionExtractUniform : this.convolveExtractUniform,
      this.fieldPoints,
    )
    encoder.copyBufferToBuffer(this.output, 0, this.readback, 0, this.fieldPoints * 4)
    this.device.queue.submit([encoder.finish()])
    await this.readback.mapAsync(GPUMapMode.READ)
    const result = Float64Array.from(new Float32Array(this.readback.getMappedRange()))
    this.readback.unmap()
    return result
  }

  private encodeTransform(encoder: GPUCommandEncoder, start: GPUBuffer, inverse: boolean) {
    let source = start
    let target = source === this.complexA ? this.complexB : this.complexA
    for (const horizontal of [1, 0] as FftDirection[]) {
      this.encodePass(encoder, this.bitReversePipeline, [source, target], this.bitReverseUniforms[horizontal], this.paddedPoints)
      ;[source, target] = [target, source]
      for (let stageSize = 2; stageSize <= this.paddedSize; stageSize *= 2) {
        const uniform = this.stageUniforms.get(`${inverse ? 1 : 0}:${horizontal}:${stageSize}`)!
        this.encodePass(encoder, this.stagePipeline, [source, target], uniform, this.paddedPoints)
        ;[source, target] = [target, source]
      }
    }
    return source
  }

  private encodeSpectral(encoder: GPUCommandEncoder, values: GPUBuffer, uniform: GPUBuffer) {
    const bindGroup = this.device.createBindGroup({
      layout: this.spectralPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: values } },
        { binding: 1, resource: { buffer: this.kernelSpectrum } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.spectralPipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(this.paddedPoints / 128))
    pass.end()
  }

  private encodePass(encoder: GPUCommandEncoder, pipeline: GPUComputePipeline, buffers: [GPUBuffer, GPUBuffer], uniform: GPUBuffer, points: number) {
    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: buffers[0] } },
        { binding: 1, resource: { buffer: buffers[1] } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    })
    const pass = encoder.beginComputePass()
    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(points / 128))
    pass.end()
  }
}

export function packSpinOrbitals(alpha: Float64Array[], beta: Float64Array[], points: number) {
  const coefficients = new Float32Array(points * (alpha.length + beta.length))
  let offset = 0
  for (const orbital of [...alpha, ...beta]) {
    coefficients.set(orbital, offset)
    offset += points
  }
  return { coefficients, alphaCount: alpha.length, betaCount: beta.length }
}

export function unpackSpinDensities(values: Float32Array, points: number) {
  return {
    alpha: Float64Array.from(values.subarray(0, points)),
    beta: Float64Array.from(values.subarray(points, points * 2)),
  }
}

export function unpackOrbitalFields(values: Float32Array, points: number, alphaCount: number, betaCount: number) {
  const density = unpackSpinDensities(values, points)
  const kineticOffset = points * 2
  const kinetic = Array.from({ length: alphaCount + betaCount }, (_, orbital) => (
    Float64Array.from(values.subarray(kineticOffset + orbital * points, kineticOffset + (orbital + 1) * points))
  ))
  return {
    ...density,
    alphaKinetic: kinetic.slice(0, alphaCount),
    betaKinetic: kinetic.slice(alphaCount, alphaCount + betaCount),
  }
}

function align4(value: number) {
  return Math.ceil(value / 4) * 4
}

async function createPipeline(device: GPUDevice, code: string) {
  const module = device.createShaderModule({ code })
  const compilation = await module.getCompilationInfo()
  const errors = compilation.messages.filter((message) => message.type === 'error')
  if (errors.length > 0) {
    throw new Error(errors.map((message) => `WGSL ${message.lineNum}:${message.linePos} ${message.message}`).join('\n'))
  }
  return device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
}

function createUniform(device: GPUDevice, values: ArrayBufferView) {
  const buffer = device.createBuffer({ size: align16(values.byteLength), usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buffer, 0, values as Uint32Array<ArrayBuffer>)
  return buffer
}

function createSpectralUniform(device: GPUDevice, size: number, mode: number, spacing: number, shift: number) {
  const values = new ArrayBuffer(16)
  new Uint32Array(values, 0, 2).set([size, mode])
  new Float32Array(values, 8, 2).set([spacing, shift])
  return createUniform(device, new Uint8Array(values))
}

function createExtractUniform(device: GPUDevice, fieldSize: number, paddedSize: number, scale: number) {
  const values = new ArrayBuffer(16)
  new Uint32Array(values, 0, 2).set([fieldSize, paddedSize])
  new Float32Array(values, 8, 1)[0] = scale
  return createUniform(device, new Uint8Array(values))
}

function align16(value: number) {
  return Math.ceil(value / 16) * 16
}
