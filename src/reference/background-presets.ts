export type PresetName = "night-boulevard" | "sunset-hills" | "neon-alley";

export const STAGE_PIXEL_WIDTH = 1600;
export const STAGE_PIXEL_HEIGHT = 900;
export const STAGE_ASPECT = "16 / 9";

export function createPresetDataUrl(preset: PresetName): string {
  const canvas = document.createElement("canvas");
  canvas.width = STAGE_PIXEL_WIDTH;
  canvas.height = STAGE_PIXEL_HEIGHT;

  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("Unable to create preset canvas context.");
  }

  const gradient = context.createLinearGradient(0, 0, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);

  if (preset === "night-boulevard") {
    gradient.addColorStop(0, "#10243b");
    gradient.addColorStop(0.5, "#234a72");
    gradient.addColorStop(1, "#2f5980");
  } else if (preset === "sunset-hills") {
    gradient.addColorStop(0, "#311a3a");
    gradient.addColorStop(0.5, "#bf5c66");
    gradient.addColorStop(1, "#f2ad6a");
  } else {
    gradient.addColorStop(0, "#0b0d24");
    gradient.addColorStop(0.4, "#1f2550");
    gradient.addColorStop(1, "#184060");
  }

  context.fillStyle = gradient;
  context.fillRect(0, 0, STAGE_PIXEL_WIDTH, STAGE_PIXEL_HEIGHT);

  // Use irregular soft silhouettes instead of repeated bars to avoid synthetic striping.
  for (let i = 0; i < 14; i += 1) {
    const x = ((i * 127 + 63) % STAGE_PIXEL_WIDTH) - 120;
    const y = 60 + ((i * 37) % 120);
    const w = 120 + ((i * 29) % 160);
    const h = 320 + ((i * 41) % 260);
    const alpha = 0.06 + ((i * 7) % 8) * 0.01;
    context.fillStyle = `rgba(235, 245, 255, ${alpha.toFixed(3)})`;
    context.beginPath();
    context.ellipse(x + w * 0.5, y + h * 0.5, w * 0.45, h * 0.55, 0.08, 0, Math.PI * 2);
    context.fill();
  }

  context.fillStyle = "rgba(255, 255, 255, 0.08)";
  for (let i = 0; i < 160; i += 1) {
    const x = (i * 79) % STAGE_PIXEL_WIDTH;
    const y = (i * 53) % STAGE_PIXEL_HEIGHT;
    context.beginPath();
    context.arc(x, y, 1.2, 0, Math.PI * 2);
    context.fill();
  }

  return canvas.toDataURL("image/png");
}
