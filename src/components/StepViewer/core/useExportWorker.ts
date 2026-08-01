import * as Comlink from "comlink";
import type { ExportWorkerApi } from "./ExportWorker";
import type { SerializedSolidData } from "../types";
import { createWorkerClient } from "./workerClient";

const client = createWorkerClient<ExportWorkerApi>(
  () => new Worker(new URL("./ExportWorker.ts", import.meta.url), { type: "module" }),
);

export async function exportURDFInWorker(
  urdfXml: string,
  linkSolidMap: Record<string, SerializedSolidData[]>,
  linkRestInverseMap: Record<string, number[]>,
  unitScale: number,
  onProgress?: (stage: string, percent: number) => void,
  extraFiles?: Record<string, string>,
  collisionMeshMap?: Record<string, { positions: Float32Array; indices: Uint32Array }>,
): Promise<ArrayBuffer> {
  return client
    .get()
    .exportURDF(
      urdfXml,
      linkSolidMap,
      linkRestInverseMap,
      unitScale,
      onProgress ? Comlink.proxy(onProgress) : undefined,
      extraFiles,
      collisionMeshMap,
    );
}

export function disposeExportWorker(): void {
  client.dispose();
}
