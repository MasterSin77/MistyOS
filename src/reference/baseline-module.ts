export interface BaselineMetadata {
  sourceName: string;
  sourceUrl: string;
  version: string;
  frozen: boolean;
}

export const BASELINE_METADATA: BaselineMetadata = {
  sourceName: "raindrop-fx",
  sourceUrl: "https://github.com/SardineFish/raindrop-fx",
  version: "1.0.8",
  frozen: true
};
