/**
 * Utility functions for checking dataset version compatibility
 */

const DATASET_URL =
  process.env.DATASET_URL || "https://huggingface.co/datasets";

/**
 * Sentinel org name used in routes to identify locally-served datasets.
 * URL pattern: /__local__/{datasetName}/episode_{N}
 */
export const LOCAL_ORG = "__local__";

/**
 * Returns the base URL for the local-files API endpoint.
 * On the server (no `window`), an absolute URL is required for fetch().
 * On the client, a relative path is sufficient.
 */
function getLocalApiBase(): string {
  if (typeof window === "undefined") {
    // Server-side: prefer explicit env var, fall back to localhost:3000
    return (
      process.env.NEXTAUTH_URL ??
      process.env.NEXT_PUBLIC_BASE_URL ??
      "http://localhost:3000"
    );
  }
  return "";
}

export function isLocalDataset(repoId: string): boolean {
  return repoId.startsWith(`${LOCAL_ORG}/`);
}

function localDatasetName(repoId: string): string {
  return repoId.slice(LOCAL_ORG.length + 1);
}

/**
 * Dataset information structure from info.json
 */
type FeatureInfo = {
  dtype: string;
  shape: number[];
  names: string[] | Record<string, unknown> | null;
  info?: Record<string, unknown>;
};

export interface DatasetInfo {
  codebase_version: string;
  robot_type: string | null;
  total_episodes: number;
  total_frames: number;
  total_tasks: number;
  chunks_size: number;
  data_files_size_in_mb: number;
  video_files_size_in_mb: number;
  fps: number;
  splits: Record<string, string>;
  data_path: string;
  video_path: string;
  features: Record<string, FeatureInfo>;
}

// In-memory cache for dataset info (5 min TTL, max 200 entries)
const datasetInfoCache = new Map<
  string,
  { data: DatasetInfo; expiry: number }
>();
const CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = Math.max(
  8,
  parseInt(process.env.MAX_DATASET_INFO_CACHE_ENTRIES ?? "64", 10) || 64,
);

function pruneDatasetInfoCache(now: number) {
  // Remove expired entries first.
  for (const [key, value] of datasetInfoCache) {
    if (now >= value.expiry) {
      datasetInfoCache.delete(key);
    }
  }

  // Then cap overall cache size to prevent unbounded growth.
  while (datasetInfoCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = datasetInfoCache.keys().next().value;
    if (!oldestKey) break;
    datasetInfoCache.delete(oldestKey);
  }
}

export async function getDatasetInfo(repoId: string): Promise<DatasetInfo> {
  const now = Date.now();
  pruneDatasetInfoCache(now);

  const cached = datasetInfoCache.get(repoId);
  if (cached && now < cached.expiry) {
    // Keep insertion order fresh so the cache behaves closer to LRU.
    datasetInfoCache.delete(repoId);
    datasetInfoCache.set(repoId, cached);
    console.log(`[perf] getDatasetInfo cache HIT for ${repoId}`);
    return cached.data;
  }
  console.log(`[perf] getDatasetInfo cache MISS for ${repoId} — fetching`);

  try {
    const testUrl = isLocalDataset(repoId)
      ? `${getLocalApiBase()}/api/local-files/${localDatasetName(repoId)}/meta/info.json`
      : `${DATASET_URL}/${repoId}/resolve/main/meta/info.json`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(testUrl, {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch dataset info: ${response.status}`);
    }

    const data = await response.json();

    if (!data.features) {
      throw new Error(
        "Dataset info.json does not have the expected features structure",
      );
    }

    datasetInfoCache.set(repoId, {
      data: data as DatasetInfo,
      expiry: Date.now() + CACHE_TTL_MS,
    });
    pruneDatasetInfoCache(Date.now());
    return data as DatasetInfo;
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(
      `Dataset ${repoId} is not compatible with this visualizer. ` +
        "Failed to read dataset information from the main revision.",
    );
  }
}

const SUPPORTED_VERSIONS = ["v3.0", "v2.1", "v2.0"];

/**
 * Returns both the validated version string and the dataset info in one call,
 * avoiding a duplicate info.json fetch.
 */
export async function getDatasetVersionAndInfo(
  repoId: string,
): Promise<{ version: string; info: DatasetInfo }> {
  const info = await getDatasetInfo(repoId);
  const version = info.codebase_version;
  if (!version) {
    throw new Error("Dataset info.json does not contain codebase_version");
  }
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(
      `Dataset ${repoId} has codebase version ${version}, which is not supported. ` +
        "This tool only works with dataset versions 3.0, 2.1, or 2.0. " +
        "Please use a compatible dataset version.",
    );
  }
  return { version, info };
}

export async function getDatasetVersion(repoId: string): Promise<string> {
  const { version } = await getDatasetVersionAndInfo(repoId);
  return version;
}

export function buildVersionedUrl(
  repoId: string,
  version: string,
  path: string,
): string {
  if (isLocalDataset(repoId)) {
    return `${getLocalApiBase()}/api/local-files/${localDatasetName(repoId)}/${path}`;
  }
  return `${DATASET_URL}/${repoId}/resolve/main/${path}`;
}
