import { NextResponse } from "next/server";
import path from "path";
import { readdir, stat } from "fs/promises";

async function isDatasetRoot(dir: string): Promise<boolean> {
  try {
    const s = await stat(path.join(dir, "meta", "info.json"));
    return s.isFile();
  } catch {
    return false;
  }
}

export async function GET(): Promise<NextResponse> {
  const localPath = process.env.LOCAL_DATASETS_PATH;
  if (!localPath) {
    return NextResponse.json({ datasets: [], configured: false });
  }

  try {
    const baseDir = path.resolve(localPath);

    // If LOCAL_DATASETS_PATH is itself a single dataset, return it by basename.
    if (await isDatasetRoot(baseDir)) {
      return NextResponse.json({
        datasets: [path.basename(baseDir)],
        configured: true,
        singleDataset: true,
      });
    }

    const entries = await readdir(baseDir, { withFileTypes: true });
    const datasets: string[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (await isDatasetRoot(path.join(baseDir, entry.name))) {
        datasets.push(entry.name);
      }
    }

    return NextResponse.json({ datasets, configured: true });
  } catch {
    return NextResponse.json({ datasets: [], configured: true });
  }
}
