export interface ReferenceIntegrationContract {
  readonly sourceName: string;
  readonly sourceUrl: string;
  readonly sourceVersion: string;
  readonly readable: boolean;
  readonly frozen: boolean;
}

export const REFERENCE_INTEGRATION: ReferenceIntegrationContract = {
  sourceName: "raindrop-fx",
  sourceUrl: "https://github.com/SardineFish/raindrop-fx",
  sourceVersion: "1.0.8",
  readable: true,
  frozen: true
};

const BASELINE_APPROVAL_KEY = "rain-engine-behavioral-reference-approved-v1";

export function hasHumanApprovedBaseline(): boolean {
  return window.localStorage.getItem(BASELINE_APPROVAL_KEY) === "true";
}

export function setHumanApprovedBaseline(approved: boolean): void {
  window.localStorage.setItem(BASELINE_APPROVAL_KEY, approved ? "true" : "false");
}

export function assertReferenceApproved(contract: ReferenceIntegrationContract): void {
  if (!contract.readable) {
    throw new Error("Reference baseline must be readable before candidate engine work.");
  }

  if (!contract.frozen) {
    throw new Error("Reference baseline must be frozen after approval.");
  }

  if (!hasHumanApprovedBaseline()) {
    throw new Error("Human baseline approval is required before candidate engine execution.");
  }
}
