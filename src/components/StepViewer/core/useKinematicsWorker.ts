import * as Comlink from 'comlink'
import type { KinematicsWorkerApi } from './KinematicsWorker'
import type { KinematicsResult } from '../types'

let worker: Worker | null = null
let workerProxy: Comlink.Remote<KinematicsWorkerApi> | null = null

function getProxy(): Comlink.Remote<KinematicsWorkerApi> {
  if (!workerProxy) {
    worker = new Worker(
      new URL('./KinematicsWorker.ts', import.meta.url),
      { type: 'module' }
    )
    workerProxy = Comlink.wrap<KinematicsWorkerApi>(worker)
  }
  return workerProxy
}

export async function computeRelativeTransform(
  parentWorldMatrix: ArrayLike<number>,
  snapPosition: [number, number, number],
  snapNormal: [number, number, number],
  frameBasis?: ArrayLike<number>
): Promise<KinematicsResult> {
  const proxy = getProxy()

  const matBuf = new Float32Array(16)
  for (let i = 0; i < 16; i++) matBuf[i] = parentWorldMatrix[i]

  const posBuf = new Float32Array(snapPosition)
  const normBuf = new Float32Array(snapNormal)
  const frameBuf = frameBasis ? new Float32Array(Array.from(frameBasis)) : undefined

  try {
    const result = await proxy.computeRelativeTransform(
      Comlink.transfer(matBuf, [matBuf.buffer]),
      Comlink.transfer(posBuf, [posBuf.buffer]),
      Comlink.transfer(normBuf, [normBuf.buffer]),
      frameBuf ? Comlink.transfer(frameBuf, [frameBuf.buffer]) : undefined
    )
    return result
  } catch {
    return { xyz: [0, 0, 0], rpy: [0, 0, 0] }
  }
}

export function disposeKinematicsWorker(): void {
  if (workerProxy) {
    workerProxy[Comlink.releaseProxy]()
    workerProxy = null
  }
  if (worker) {
    worker.terminate()
    worker = null
  }
}
