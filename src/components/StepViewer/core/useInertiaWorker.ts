import * as Comlink from "comlink";
import type { InertiaWorkerApi } from "./InertiaWorker";
import type {
  SerializedSolidData,
  InertialParams,
  SolidInertiaResult,
  SolidMassEntry,
} from "../types";

let worker: Worker | null = null;
let workerProxy: Comlink.Remote<InertiaWorkerApi> | null = null;
let initPromise: Promise<void> | null = null;

async function getProxy(): Promise<Comlink.Remote<InertiaWorkerApi>> {
  if (!workerProxy) {
    worker = new Worker(new URL("./InertiaWorker.ts", import.meta.url), { type: "module" });
    workerProxy = Comlink.wrap<InertiaWorkerApi>(worker);
  }
  if (!initPromise) {
    initPromise = workerProxy.init();
  }
  await initPromise;
  return workerProxy;
}

function toPlainSolidData(solidDataList: SerializedSolidData[]): SerializedSolidData[] {
  return solidDataList.map((d) => ({
    name: d.name ?? "",
    positions: d.positions,
    normals: d.normals ?? new Float32Array(0),
    indices: d.indices,
    faceGroups: [],
    faceGeometries: [],
    edgeGroups: [],
    edgeGeometries: [],
    edgePolylines: new Float32Array(0),
    massProps: d.massProps,
  }));
}

export async function computePerSolidInertia(
  solidDataList: SerializedSolidData[],
): Promise<SolidInertiaResult[]> {
  const proxy = await getProxy();
  return proxy.computePerSolidInertia(toPlainSolidData(solidDataList));
}

export function combineSolidInertia(entries: SolidMassEntry[]): InertialParams {
  const valid = entries.filter((e) => e.mass > 0 && e.refMass > 0);
  if (valid.length === 0) {
    return { mass: 0, com: [0, 0, 0], inertia: [0, 0, 0, 0, 0, 0] };
  }

  let mass = 0;
  let cx = 0,
    cy = 0,
    cz = 0;
  for (const e of valid) {
    mass += e.mass;
    cx += e.mass * e.com[0];
    cy += e.mass * e.com[1];
    cz += e.mass * e.com[2];
  }
  const com: [number, number, number] = [cx / mass, cy / mass, cz / mass];

  const inertia: InertialParams["inertia"] = [0, 0, 0, 0, 0, 0];
  for (const e of valid) {
    const k = e.mass / e.refMass;
    const dx = (e.com[0] - com[0]) * 1e-3;
    const dy = (e.com[1] - com[1]) * 1e-3;
    const dz = (e.com[2] - com[2]) * 1e-3;
    inertia[0] += e.inertiaAtCom[0] * k + e.mass * (dy * dy + dz * dz);
    inertia[1] += e.inertiaAtCom[1] * k - e.mass * dx * dy;
    inertia[2] += e.inertiaAtCom[2] * k - e.mass * dx * dz;
    inertia[3] += e.inertiaAtCom[3] * k + e.mass * (dx * dx + dz * dz);
    inertia[4] += e.inertiaAtCom[4] * k - e.mass * dy * dz;
    inertia[5] += e.inertiaAtCom[5] * k + e.mass * (dx * dx + dy * dy);
  }

  return { mass, com, inertia };
}

export function disposeInertiaWorker(): void {
  if (workerProxy) {
    workerProxy[Comlink.releaseProxy]();
    workerProxy = null;
  }
  if (worker) {
    worker.terminate();
    worker = null;
  }
  initPromise = null;
}
