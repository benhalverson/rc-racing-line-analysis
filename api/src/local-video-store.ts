import { createWriteStream } from "node:fs";
import { link, mkdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export type LocalVideoMetadata = { name: string; mimeType: string; lastModified: number };

/** Keeps browser-selected source bytes on the local machine for Node frame decoding. */
export class LocalVideoStore {
  /** Uses a dedicated local directory, never a remote storage provider. */
  constructor(readonly root: string) {}

  /** Resolves only opaque local video references within the controlled directory. */
  resolvePath(reference: string): string {
    const id = reference.replace(/^local-disk:\/\//, "");
    if (!/^[a-zA-Z0-9-]{1,100}$/.test(id)) throw new Error("invalid local video reference");
    return join(resolve(this.root), `${id}.video`);
  }

  /** Verifies a local reference exists before binding it to a draft. */
  async assertExists(reference: string): Promise<void> {
    if (!reference.startsWith("local-disk://")) throw new Error("local video reference is required");
    if (!(await stat(this.resolvePath(reference))).isFile()) throw new Error("local video is unavailable");
  }

  /** Streams source bytes to an immutable disk reference without buffering the video in memory. */
  async importStream(stream: ReadableStream<Uint8Array>, metadata: LocalVideoMetadata, requestedId?: string) {
    const id = requestedId ?? crypto.randomUUID();
    const path = this.resolvePath(id);
    if (!metadata.name.trim() || !Number.isFinite(metadata.lastModified) || metadata.lastModified < 0) throw new Error("invalid video metadata");
    await mkdir(resolve(this.root), { recursive: true });
    const temporary = `${path}.${crypto.randomUUID()}.tmp`;
    try {
      await pipeline(Readable.fromWeb(stream as import("node:stream/web").ReadableStream), createWriteStream(temporary, { flags: "wx" }));
      // Exclusive hard-link publication refuses to overwrite already referenced source bytes.
      await link(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    const info = await stat(path);
    return { videoPath: `local-disk://${id}`, localVideoRef: { id, name: metadata.name, mimeType: metadata.mimeType || "video/mp4", size: info.size, lastModified: metadata.lastModified } };
  }

  /** Imports a browser File through the same streaming production contract. */
  async importVideo(file: File, requestedId?: string) {
    return this.importStream(file.stream(), { name: file.name, mimeType: file.type, lastModified: file.lastModified }, requestedId);
  }
}
