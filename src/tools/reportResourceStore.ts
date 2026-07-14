import { randomUUID } from "node:crypto";

const MAX_REPORT_RESOURCES = 64;
const REPORT_TTL_MS = 60 * 60 * 1000;
const LARGE_RESULT_BYTES = 32 * 1024;
const REPORT_ACTION = /(?:^|_)(?:report|export|summary|capabilities)(?:_|$)/i;

export interface StoredReportResource {
  id: string;
  uri: string;
  name: string;
  text: string;
  size: number;
  createdAt: number;
  expiresAt: number;
}

const reports = new Map<string, StoredReportResource>();

function removeExpired(now = Date.now()): void {
  for (const [id, report] of reports) {
    if (report.expiresAt <= now) {
      reports.delete(id);
    }
  }
}

function enforceCapacity(): void {
  while (reports.size >= MAX_REPORT_RESOURCES) {
    const oldestId = reports.keys().next().value as string | undefined;
    if (!oldestId) return;
    reports.delete(oldestId);
  }
}

export function maybeStoreReportResource(
  action: string,
  serializedResult: string,
): StoredReportResource | undefined {
  const size = Buffer.byteLength(serializedResult, "utf8");
  if (size < LARGE_RESULT_BYTES && !REPORT_ACTION.test(action)) {
    return undefined;
  }

  removeExpired();
  enforceCapacity();
  const id = randomUUID();
  const now = Date.now();
  const report: StoredReportResource = {
    id,
    uri: `civil3d://reports/${id}`,
    name: `Civil 3D ${action} result`,
    text: serializedResult,
    size,
    createdAt: now,
    expiresAt: now + REPORT_TTL_MS,
  };
  reports.set(id, report);
  return report;
}

export function getReportResource(id: string): StoredReportResource | undefined {
  removeExpired();
  return reports.get(id);
}

export function listReportResources(): StoredReportResource[] {
  removeExpired();
  return [...reports.values()];
}
