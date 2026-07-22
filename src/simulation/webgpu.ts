const DENSITY_SHADER = /* wgsl */`
struct Params { points: u32, orbitals: u32, offset: u32, _padding: u32 }
@group(0) @binding(0) var<storage, read> coefficients: array<f32>;
@group(0) @binding(1) var<storage, read_write> density: array<f32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(128)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if (index >= params.points) { return; }
  var rho = 0.0;
  for (var orbital = 0u; orbital < params.orbitals; orbital += 1u) {
    let value = coefficients[params.offset + orbital * params.points + index];
    rho += value * value;
  }
  density[index] = rho;
}
`

export class WebGpuDensityAccelerator {
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

  async density(orbitals: Float32Array, points: number, count: number, offset = 0) {
    const input = this.device.createBuffer({ size: align4(orbitals.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
    const output = this.device.createBuffer({ size: align4(points * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC })
    const readback = this.device.createBuffer({ size: align4(points * 4), usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
    const uniform = this.device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    this.device.queue.writeBuffer(input, 0, orbitals as Float32Array<ArrayBuffer>)
    this.device.queue.writeBuffer(uniform, 0, new Uint32Array([points, count, offset, 0]))
    const bindGroup = this.device.createBindGroup({
      layout: this.pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: input } },
        { binding: 1, resource: { buffer: output } },
        { binding: 2, resource: { buffer: uniform } },
      ],
    })
    const encoder = this.device.createCommandEncoder()
    const pass = encoder.beginComputePass()
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.dispatchWorkgroups(Math.ceil(points / 128))
    pass.end()
    encoder.copyBufferToBuffer(output, 0, readback, 0, points * 4)
    this.device.queue.submit([encoder.finish()])
    await readback.mapAsync(GPUMapMode.READ)
    const result = new Float32Array(readback.getMappedRange().slice(0))
    readback.unmap()
    input.destroy()
    output.destroy()
    readback.destroy()
    uniform.destroy()
    return result
  }
}

function align4(value: number) {
  return Math.ceil(value / 4) * 4
}
