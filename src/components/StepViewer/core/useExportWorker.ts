import * as Comlink from "comlink";
import type { ExportWorkerApi } from "./ExportWorker";
import type { SerializedSolidData } from "../types";

let worker: Worker | null = null;
let workerProxy: Comlink.Remote<ExportWorkerApi> | null = null;

function getProxy(): Comlink.Remote<ExportWorkerApi> {
  if (!workerProxy) {
    worker = new Worker(new URL("./ExportWorker.ts", import.meta.url), { type: "module" });
    workerProxy = Comlink.wrap<ExportWorkerApi>(worker);
  }
  return workerProxy;
}

export async function exportURDFInWorker(
  urdfXml: string,
  linkSolidMap: Record<string, SerializedSolidData[]>,
  linkRestInverseMap: Record<string, number[]>,
  unitScale: number,
  onProgress?: (stage: string, percent: number) => void,
  extraFiles?: Record<string, string>,
  collisionMeshMap?: Record<string, { positions: Float32Array; indices: Uint32Array }>,
): Promise<ArrayBuffer> {
  const proxy = getProxy();
  return proxy.exportURDF(
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
  workerProxy?.[Comlink.releaseProxy]();
  worker?.terminate();
  worker = null;
  workerProxy = null;
}
