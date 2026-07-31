import * as THREE from "three";
import {
  computeBoundsTree,
  disposeBoundsTree,
  acceleratedRaycast,
  type MeshBVHOptions,
} from "three-mesh-bvh";

let bvhInitialized = false;

export function initBVH(): void {
  if (bvhInitialized) return;

  const BufferGeometryProto = THREE.BufferGeometry.prototype as any;
  BufferGeometryProto.computeBoundsTree = computeBoundsTree;
  BufferGeometryProto.disposeBoundsTree = disposeBoundsTree;

  THREE.Mesh.prototype.raycast = acceleratedRaycast;

  bvhInitialized = true;
  console.log("BVH 加速已初始化");
}

export function buildBVH(geometry: THREE.BufferGeometry, options?: MeshBVHOptions): void {
  if (!bvhInitialized) {
    initBVH();
  }

  const defaultOptions: MeshBVHOptions = {
    targetLeafSize: 10,
    strategy: 0,
    ...options,
  };

  try {
    console.time("BVH 构建");
    (geometry as any).computeBoundsTree(defaultOptions);
    console.timeEnd("BVH 构建");
  } catch (error) {
    console.warn("BVH 构建失败，将使用默认射线检测:", error);
  }
}
