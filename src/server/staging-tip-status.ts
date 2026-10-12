/** Last staging-tip source report. Kept out of releases.ts so settings can read it without loading the release stack. */

export interface StagingTipStatus {
  project: string;
  source: 'peer' | 'health' | 'local';
  sha: string | null;
  peer: string | null;
}

let report: StagingTipStatus[] = [];

export function setStagingTipStatuses(rows: StagingTipStatus[]): void {
  report = rows;
}

export function stagingTipStatuses(): StagingTipStatus[] {
  return report;
}
