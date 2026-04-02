import { NextRequest, NextResponse } from "next/server";
import path from "path";
import { createReadStream } from "fs";
import { stat } from "fs/promises";
import { Readable } from "stream";

const ALLOWED_EXTENSIONS = new Set([".parquet", ".mp4", ".json"]);

const CONTENT_TYPES: Record<string, string> = {
  ".parquet": "application/octet-stream",
  ".mp4": "video/mp4",
  ".json": "application/json",
};

async function isSingleDatasetRoot(dir: string): Promise<boolean> {
  try {
    const s = await stat(path.join(dir, "meta", "info.json"));
    return s.isFile();
  } catch {
    return false;
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
): Promise<NextResponse> {
  const localPath = process.env.LOCAL_DATASETS_PATH;
  if (!localPath) {
    return NextResponse.json(
      { error: "LOCAL_DATASETS_PATH is not configured" },
      { status: 503 },
    );
  }

  const { path: segments } = await params;

  // Security: resolve and verify the path stays within LOCAL_DATASETS_PATH
  const baseDir = path.resolve(localPath);

  // If LOCAL_DATASETS_PATH is itself a single dataset, the first URL segment is
  // the dataset name (basename). Skip it so we resolve directly inside baseDir.
  const singleDataset = await isSingleDatasetRoot(baseDir);
  const fileSegments = singleDataset ? segments.slice(1) : segments;
  const relativeFilePath = fileSegments.join("/");

  if (!relativeFilePath) {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  const targetPath = path.resolve(baseDir, relativeFilePath);

  if (!targetPath.startsWith(baseDir + path.sep)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const ext = path.extname(targetPath).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return NextResponse.json(
      { error: "File type not allowed" },
      { status: 403 },
    );
  }

  let fileStats: Awaited<ReturnType<typeof stat>>;
  try {
    fileStats = await stat(targetPath);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }

  if (!fileStats.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }

  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";
  const fileSize = fileStats.size;

  // Handle byte-range requests for video streaming / seeking
  const rangeHeader = request.headers.get("range");
  if (rangeHeader && ext === ".mp4") {
    const match = /bytes=(\d+)-(\d*)/.exec(rangeHeader);
    if (!match) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }

    const start = parseInt(match[1], 10);
    const rawEnd = match[2] ? parseInt(match[2], 10) : -1;
    const end = rawEnd >= 0 ? Math.min(rawEnd, fileSize - 1) : fileSize - 1;

    if (start > end || start >= fileSize) {
      return new NextResponse(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${fileSize}` },
      });
    }

    const chunkSize = end - start + 1;
    const nodeStream = createReadStream(targetPath, { start, end });
    const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

    return new NextResponse(webStream, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${fileSize}`,
        "Accept-Ranges": "bytes",
        "Content-Length": chunkSize.toString(),
        "Content-Type": contentType,
      },
    });
  }

  const nodeStream = createReadStream(targetPath);
  const webStream = Readable.toWeb(nodeStream) as unknown as ReadableStream;

  return new NextResponse(webStream, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": fileSize.toString(),
      "Accept-Ranges": "bytes",
    },
  });
}
