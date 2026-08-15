import { statfsSync } from "node:fs";

export type StorageDecision = "allow" | "warn" | "block";

export type VolumeUsage = {
  path: string;
  usedPercent: number;
  totalBytes: number;
  freeBytes: number;
};

export type StorageStatus = {
  decision: StorageDecision;
  volumes: VolumeUsage[];
};

export type StatfsResult = {
  blocks: number;
  bsize: number;
  bfree: number;
};

export type StorageGuardDeps = {
  paths?: string[];
  statfs?: (path: string) => StatfsResult;
  warnPercent?: number;
  blockPercent?: number;
};

const DEFAULT_PATHS = ["DATA_PATH", "EXPORT_PATH", "BACKUP_PATH"] as const;

function resolvePaths(env: NodeJS.ProcessEnv): string[] {
  return DEFAULT_PATHS.map((key) => env[key]).filter((value): value is string => Boolean(value));
}

function volumeUsage(path: string, stat: StatfsResult): VolumeUsage {
  const totalBytes = stat.blocks * stat.bsize;
  const freeBytes = stat.bfree * stat.bsize;
  const usedBytes = totalBytes - freeBytes;
  const usedPercent = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
  return { path, usedPercent, totalBytes, freeBytes };
}

function decisionForUsage(
  volumes: VolumeUsage[],
  warnPercent: number,
  blockPercent: number,
): StorageDecision {
  const peak = volumes.reduce((max, volume) => Math.max(max, volume.usedPercent), 0);
  if (peak >= blockPercent) {
    return "block";
  }
  if (peak >= warnPercent) {
    return "warn";
  }
  return "allow";
}

export function canAcquireStorage(
  deps: StorageGuardDeps = {},
  env: NodeJS.ProcessEnv = process.env,
): StorageStatus {
  const paths = deps.paths ?? resolvePaths(env);
  const statfs = deps.statfs ?? ((path: string) => statfsSync(path));
  const warnPercent = deps.warnPercent ?? 80;
  const blockPercent = deps.blockPercent ?? 90;

  const volumes: VolumeUsage[] = [];
  for (const path of paths) {
    try {
      volumes.push(volumeUsage(path, statfs(path)));
    } catch {
      continue;
    }
  }

  if (volumes.length === 0) {
    return { decision: "allow", volumes: [] };
  }

  return {
    decision: decisionForUsage(volumes, warnPercent, blockPercent),
    volumes,
  };
}
