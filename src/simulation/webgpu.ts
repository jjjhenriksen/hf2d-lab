const DENSITY_SHADER = /* wgsl */`
struct Params { points: u32, alpha_orbitals: u32, beta_orbitals: u32, _padding: u32 }
@group(0) @binding(0) var<storage, read> coefficients: array<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  let spin = id.y;
  if (index >= params.points || spin >= 2u) { return; }
  let orbitals = select(params.alpha_orbitals, params.beta_orbitals, spin == 1u);
  let offset = select(0u, params.alpha_orbitals * params.points, spin == 1u);
  var rho = 0.0;
  for (var orbital = 0u; orbital < orbitals; orbital += 1u) {
    let value = coefficients[offset + orbital * params.points + index];
    rho += value * value;
  }
  density[spin * params.points + index] = rho;
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

  private constructor(private readonly device: GPUDevice, private readonly pipeline: GPUComputePipeline) {}

  static async create() {
    if (!globalThis.navigator?.gpu) throw new Error('WebGPU is unavailable in this browser.')
    const adapter = await globalThis.navigator.gpu.requestAdapter({ featureLevel: 'compatibility' })
    if (!adapter) throw new Error('No compatible WebGPU adapter was found.')
    const device = await adapter.requestDevice()
    const module = device.createShaderModule({ code: DENSITY_SHADER })
    const pipeline = await device.createComputePipelineAsync({ layout: 'auto', compute: { module, entryPoint: 'main' } })
    return new WebGpuDensityAccelerator(device, pipeline)
  }

  get lost() {
    return this.device.lost
  }

  async densities(alpha: Float64Array[], beta: Float64Array[], points: number) {
    const packed = packSpinOrbitals(alpha, beta, points)
    const buffers = this.ensureBuffers(packed.coefficients.byteLength, points * 2 * 4)
    this.device.queue.writeBuffer(buffers.input, 0, packed.coefficients as Float32Array<ArrayBuffer>)
    this.device.queue.writeBuffer(buffers.uniform, 0, new Uint32Array([points, packed.alphaCount, packed.betaCount, 0]))
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, buffers.bindGroup)
    pass.dispatchWorkgroups(Math.ceil(points / 128), 2)
    pass.end()
    encoder.copyBufferToBuffer(buffers.output, 0, buffers.readback, 0, points * 2 * 4)
    this.device.queue.submit([encoder.finish()])
    await buffers.readback.mapAsync(GPUMapMode.READ)
    const result = unpackSpinDensities(new Float32Array(buffers.readback.getMappedRange()), points)
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
    const uniform = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
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

function align4(value: number) {
  return Math.ceil(value / 4) * 4
}
