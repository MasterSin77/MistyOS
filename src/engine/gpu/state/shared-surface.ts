export interface SharedSurfaceState {
  readonly width: number;
  readonly height: number;
  readonly wetnessRead: GPUTexture;
  readonly wetnessWrite: GPUTexture;
  readonly flowRead: GPUTexture;
  readonly flowWrite: GPUTexture;
  readonly disturbanceRead: GPUTexture;
  readonly disturbanceWrite: GPUTexture;
  swap(): void;
  currentReadView(): GPUTextureView;
  currentWriteView(): GPUTextureView;
  currentFlowReadView(): GPUTextureView;
  currentFlowWriteView(): GPUTextureView;
  currentDisturbanceReadView(): GPUTextureView;
  currentDisturbanceWriteView(): GPUTextureView;
}

export function createSharedSurfaceState(device: GPUDevice, width: number, height: number): SharedSurfaceState {
  const usage = GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC;

  const wetnessA = device.createTexture({
    label: "wetness-state-a",
    size: { width, height },
    format: "r32float",
    usage
  });

  const wetnessB = device.createTexture({
    label: "wetness-state-b",
    size: { width, height },
    format: "r32float",
    usage
  });

  const flowA = device.createTexture({
    label: "flow-state-a",
    size: { width, height },
    format: "rg32float",
    usage
  });

  const flowB = device.createTexture({
    label: "flow-state-b",
    size: { width, height },
    format: "rg32float",
    usage
  });

  const disturbanceA = device.createTexture({
    label: "disturbance-state-a",
    size: { width, height },
    format: "r32float",
    usage
  });

  const disturbanceB = device.createTexture({
    label: "disturbance-state-b",
    size: { width, height },
    format: "r32float",
    usage
  });

  let read = wetnessA;
  let write = wetnessB;
  let flowRead = flowA;
  let flowWrite = flowB;
  let disturbanceRead = disturbanceA;
  let disturbanceWrite = disturbanceB;

  return {
    width,
    height,
    get wetnessRead(): GPUTexture {
      return read;
    },
    get wetnessWrite(): GPUTexture {
      return write;
    },
    get flowRead(): GPUTexture {
      return flowRead;
    },
    get flowWrite(): GPUTexture {
      return flowWrite;
    },
    get disturbanceRead(): GPUTexture {
      return disturbanceRead;
    },
    get disturbanceWrite(): GPUTexture {
      return disturbanceWrite;
    },
    swap(): void {
      const tmp = read;
      read = write;
      write = tmp;

      const flowTmp = flowRead;
      flowRead = flowWrite;
      flowWrite = flowTmp;

      const disturbanceTmp = disturbanceRead;
      disturbanceRead = disturbanceWrite;
      disturbanceWrite = disturbanceTmp;
    },
    currentReadView(): GPUTextureView {
      return read.createView();
    },
    currentWriteView(): GPUTextureView {
      return write.createView();
    },
    currentFlowReadView(): GPUTextureView {
      return flowRead.createView();
    },
    currentFlowWriteView(): GPUTextureView {
      return flowWrite.createView();
    },
    currentDisturbanceReadView(): GPUTextureView {
      return disturbanceRead.createView();
    },
    currentDisturbanceWriteView(): GPUTextureView {
      return disturbanceWrite.createView();
    }
  };
}
