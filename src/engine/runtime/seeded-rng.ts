export interface SeededRng {
  nextFloat(): number;
}

export function createXorShift32(seed: number): SeededRng {
  let state = seed >>> 0;

  return {
    nextFloat(): number {
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      return ((state >>> 0) & 0xffffffff) / 0x100000000;
    }
  };
}
