export interface SharedSurfaceState {
  readonly width: number;
  readonly height: number;
  readonly wetnessRead: GPUTexture;
  readonly wetnessWrite: GPUTexture;
  swap(): void;
  currentReadView(): GPUTextureView;
  currentWriteView(): GPUTextureView;
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

  let read = wetnessA;
  let write = wetnessB;

  return {
    width,
    height,
    get wetnessRead(): GPUTexture {
      return read;
    },
    get wetnessWrite(): GPUTexture {
      return write;
    },
    swap(): void {
      const tmp = read;
      read = write;
      write = tmp;
    },
    currentReadView(): GPUTextureView {
      return read.createView();
    },
    currentWriteView(): GPUTextureView {
      return write.createView();
    }
  };
}
