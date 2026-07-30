/**
 * STEP 文件加载器
 * 使用 Web Worker + opencascade.js 解析 STEP 文件并转换为 Three.js 几何体
 *
 * 性能优化：
 * - opencascade.js 解析在 Worker 线程中执行，不阻塞主线程
 * - 使用 Comlink 进行 Worker 通信
 * - 主线程负责 Three.js 对象创建、BVH 构建、边缘线生成、特征重建
 */

import * as THREE from 'three'
import { EdgesGeometry, LineSegments, LineBasicMaterial } from 'three'
import * as Comlink from 'comlink'
import type {
  FileValidationResult,
  UploadProgress,
  SerializedSolidData,
  SerializedTreeNode,
  TreeNode,
  SolidObject,
  GeometryFeature
} from '../types'
import { FeatureType } from '../types'
import { initBVH, buildBVH } from './BVHAccelerator'
import type { StepParseWorkerApi } from './StepParseWorker'

interface PositionStats {
  empty: boolean
  min: THREE.Vector3
  max: THREE.Vector3
  center: THREE.Vector3
  centroid: THREE.Vector3
}

interface SolidInfo {
  index: number
  data: SerializedSolidData
  fingerprint: string
  centroid: THREE.Vector3
  stats: PositionStats
}

// Worker 状态管理
let worker: Worker | null = null
let workerProxy: Comlink.Remote<StepParseWorkerApi> | null = null
let workerReady = false
let workerInitPromise: Promise<void> | null = null

/**
 * 获取或创建 Worker 实例和 Comlink 代理（单例）
 */
function getWorkerProxy(): Comlink.Remote<StepParseWorkerApi> {
  if (!workerProxy) {
    worker = new Worker(
      new URL('./StepParseWorker.ts', import.meta.url),
      { type: 'module' }
    )
    workerProxy = Comlink.wrap<StepParseWorkerApi>(worker)
  }
  return workerProxy
}

/**
 * 预加载 OpenCascade WASM 模块（通过 Worker）
 * 可在应用初始化时调用，提前加载 WASM 避免首次上传延迟
 */
export async function preloadOcct(): Promise<void> {
  if (workerReady) return
  if (workerInitPromise) {
    await workerInitPromise
    return
  }

  workerInitPromise = (async () => {
    try {
      const proxy = getWorkerProxy()
      await proxy.init()
      workerReady = true
    } catch (err) {
      workerInitPromise = null
      throw err
    }
  })()

  await workerInitPromise
}

/**
 * 检查 OpenCascade Worker 是否已就绪
 */
export function isOcctLoaded(): boolean {
  return workerReady
}

/**
 * 销毁 Worker
 */
export function terminateWorker(): void {
  if (workerProxy) {
    workerProxy[Comlink.releaseProxy]()
    workerProxy = null
  }
  if (worker) {
    worker.terminate()
    worker = null
    workerReady = false
    workerInitPromise = null
  }
}

/**
 * STEP 文件加载器类
 */
export class StepLoader {
  /** 边缘线默认颜色 */
  private static readonly EDGE_COLOR = 0x333333
  /** 边缘线默认线宽 */
  private static readonly EDGE_LINE_WIDTH = 1

  constructor() {
    // 初始化 BVH 加速
    initBVH()
  }

  /**
   * 校验文件
   */
  validateFile(file: File): FileValidationResult {
    if (!file) {
      return { valid: false, error: '请选择文件' }
    }

    if (file.size === 0) {
      return { valid: false, error: '文件为空' }
    }

    const fileName = file.name.toLowerCase()
    const validExtensions = ['.step', '.stp']
    const hasValidExtension = validExtensions.some(ext => fileName.endsWith(ext))

    if (!hasValidExtension) {
      return { valid: false, error: '仅支持 .step 或 .stp 格式文件' }
    }

    // 文件大小限制 (500MB)
    const maxSize = 500 * 1024 * 1024
    if (file.size > maxSize) {
      return { valid: false, error: '文件大小超过 500MB 限制' }
    }

    return { valid: true, file }
  }

  /**
   * 加载 STEP 文件（使用 Worker 解析，不阻塞主线程）
   */
  async loadFile(
    file: File,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{ solids: SolidObject[]; group: THREE.Group; treeNodes: TreeNode[] }> {
    // 阶段 1：读取文件
    onProgress?.({
      status: 'uploading',
      progress: 5,
      message: '正在读取文件...'
    })

    const fileBuffer = await this.readFileAsArrayBuffer(file)

    // 阶段 2：在 Worker 中解析 STEP（不阻塞主线程）
    onProgress?.({
      status: 'parsing',
      progress: 10,
      message: '正在初始化 OpenCascade 引擎...'
    })

    const { solids: serializedSolids, tree } = await this.parseInWorker(fileBuffer, onProgress)

    // 阶段 3：在主线程构建 Three.js 对象
    onProgress?.({
      status: 'parsing',
      progress: 80,
      message: '正在构建 3D 模型...'
    })
    await this.yieldToMain()

    const { solids, group } = this.buildScene(serializedSolids)

    // 阶段 4：构建结构树
    const treeNodes = this.buildTreeNodes(tree)

    onProgress?.({
      status: 'success',
      progress: 100,
      message: '加载完成'
    })

    return { solids, group, treeNodes }
  }

  rebuildFromSerialized(serializedSolids: SerializedSolidData[]): {
    solids: SolidObject[]
    group: THREE.Group
  } {
    return this.buildScene(serializedSolids)
  }

  private buildScene(serializedSolids: SerializedSolidData[]): {
    solids: SolidObject[]
    group: THREE.Group
  } {
    const { solids, group } = this.buildThreeJSObjects(serializedSolids)

    solids.sort((a, b) => {
      const aIdx = parseInt(a.id.replace('solid_', ''))
      const bIdx = parseInt(b.id.replace('solid_', ''))
      return aIdx - bIdx
    })

    return { solids, group }
  }

  /**
   * 在 Worker 中执行 STEP 解析（通过 Comlink）
   */  private async parseInWorker(
    fileBuffer: ArrayBuffer,
    onProgress?: (progress: UploadProgress) => void
  ): Promise<{ solids: SerializedSolidData[]; tree: SerializedTreeNode }> {
    const proxy = getWorkerProxy()

    const progressCallback = onProgress
      ? Comlink.proxy((stage: string, percent: number) => {
        onProgress({
          status: 'parsing',
          progress: Math.min(Math.round(percent * 0.7) + 10, 78),
          message: stage
        })
      })
      : undefined

    const result = await proxy.parse(fileBuffer, progressCallback)
    return { solids: result.solids, tree: result.tree }
  }

  /**
   * 从序列化数据构建 Three.js 对象
   * ★ 材质缓存：相同颜色的 Solid 共享材质实例以减少 GPU 状态切换
   * ★ InstancedMesh：大量相同几何体合并为 InstancedMesh，Draw Calls 从 N → 1
   */
  private buildThreeJSObjects(serializedSolids: SerializedSolidData[]): {
    solids: SolidObject[]
    group: THREE.Group
  } {
    const group = new THREE.Group()
    const solids: SolidObject[] = []
    const materialCache = new Map<string, THREE.MeshStandardMaterial>()

    const INSTANCE_THRESHOLD = 3

    const solidInfos: SolidInfo[] = serializedSolids.map((sd, i) => {
      const stats = this.computePositionStats(sd.positions)
      return {
        index: i,
        data: sd,
        fingerprint: this.computeGeometryFingerprint(sd, stats),
        centroid: stats.centroid,
        stats
      }
    })

    const groups = new Map<string, SolidInfo[]>()
    for (const info of solidInfos) {
      const list = groups.get(info.fingerprint) || []
      list.push(info)
      groups.set(info.fingerprint, list)
    }

    for (const [, members] of groups) {
      if (members.length >= INSTANCE_THRESHOLD) {
        this.createInstancedSolids(members, materialCache, solids, group)
      } else {
        for (const member of members) {
          this.createRegularSolid(member.data, member.index, materialCache, solids, group)
        }
      }
    }

    return { solids, group }
  }

  private computePositionStats(positions: Float32Array): PositionStats {
    let minX = Infinity, minY = Infinity, minZ = Infinity
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
    let sumX = 0, sumY = 0, sumZ = 0
    const count = positions.length / 3

    for (let i = 0; i < positions.length; i += 3) {
      const x = positions[i], y = positions[i + 1], z = positions[i + 2]
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (z < minZ) minZ = z
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
      if (z > maxZ) maxZ = z
      sumX += x
      sumY += y
      sumZ += z
    }

    if (count === 0 || !isFinite(minX)) {
      return {
        empty: true,
        min: new THREE.Vector3(),
        max: new THREE.Vector3(),
        center: new THREE.Vector3(),
        centroid: new THREE.Vector3()
      }
    }

    const min = new THREE.Vector3(minX, minY, minZ)
    const max = new THREE.Vector3(maxX, maxY, maxZ)
    return {
      empty: false,
      min,
      max,
      center: new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5),
      centroid: new THREE.Vector3(sumX / count, sumY / count, sumZ / count)
    }
  }

  private computeGeometryFingerprint(solidData: SerializedSolidData, stats: PositionStats): string {
    const posCount = solidData.positions.length / 3
    const idxCount = solidData.indices.length
    const faceCount = solidData.faceGroups.length

    const w = (stats.max.x - stats.min.x).toFixed(2)
    const h = (stats.max.y - stats.min.y).toFixed(2)
    const d = (stats.max.z - stats.min.z).toFixed(2)

    const faceTypeCounts: Record<string, number> = {}
    for (const geom of solidData.faceGeometries) {
      faceTypeCounts[geom.type] = (faceTypeCounts[geom.type] || 0) + 1
    }
    const faceTypeStr = Object.entries(faceTypeCounts)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([t, c]) => `${t}${c}`)
      .join(',')

    return `${posCount}_${idxCount}_${faceCount}_${w}_${h}_${d}_${faceTypeStr}`
  }

  /**
   * 获取或创建缓存材质（相同颜色共享同一实例）
   */
  private getOrCreateMaterial(
    solidData: SerializedSolidData,
    cache: Map<string, THREE.MeshStandardMaterial>
  ): THREE.MeshStandardMaterial {
    let colorHex = '8899aa'
    if (solidData.color && solidData.color.length >= 3) {
      colorHex = new THREE.Color(solidData.color[0], solidData.color[1], solidData.color[2]).getHexString()
    }
    let mat = cache.get(colorHex)
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: parseInt(colorHex, 16),
        metalness: 0.3,
        roughness: 0.6,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1
      })
      cache.set(colorHex, mat)
    }
    return mat
  }

  // ========== Regular Mesh 创建 ==========

  /**
   * 创建单个普通 Mesh（原有逻辑，使用材质缓存）
   */
  private createRegularSolid(
    solidData: SerializedSolidData,
    solidIndex: number,
    materialCache: Map<string, THREE.MeshStandardMaterial>,
    solids: SolidObject[],
    group: THREE.Group
  ): void {
    const geometry = this.createGeometry(solidData)
    const material = this.getOrCreateMaterial(solidData, materialCache)
    const mesh = new THREE.Mesh(geometry, material)

    mesh.name = solidData.name || `Solid_${solidIndex}`
    mesh.userData = {
      meshIndex: solidIndex,
      solidIndex,
      faceGroups: solidData.faceGroups,
      faceGeometries: solidData.faceGeometries
    }

    buildBVH(geometry)

    const edgeLines = this.createEdgeLines(geometry)
    if (edgeLines) {
      mesh.add(edgeLines) // 作为子对象跟随变换
    }

    // 构建拓扑边线段（可拾取）
    const topologyEdges = this.createTopologyEdges(solidData)
    if (topologyEdges) {
      topologyEdges.visible = false // 默认隐藏，仅在边粒度模式下显示
      mesh.add(topologyEdges)
    }

    geometry.computeBoundingBox()
    const boundingBox = geometry.boundingBox
    const center = new THREE.Vector3()
    boundingBox?.getCenter(center)

    const features = this.buildFeatures(mesh, solidData, solidIndex)
    const edgeFeatures = this.buildEdgeFeatures(mesh, solidData, solidIndex)

    let colorHex: number | undefined
    if (solidData.color && solidData.color.length >= 3) {
      colorHex = new THREE.Color(solidData.color[0], solidData.color[1], solidData.color[2]).getHex()
    }

    const solid: SolidObject = {
      id: `solid_${solidIndex}`,
      name: mesh.name,
      mesh,
      edgeLines: edgeLines || undefined,
      topologyEdges: topologyEdges || undefined,
      edgeFeatures,
      treeNodeId: `solid_${solidIndex}`,
      boundingBox: boundingBox ? {
        min: boundingBox.min.clone(),
        max: boundingBox.max.clone(),
        center: center.clone()
      } : undefined,
      features,
      visible: true,
      opacity: 1,
      selected: false,
      color: colorHex,
      serializedData: solidData
    }

    solids.push(solid)
    group.add(mesh)
  }

  // ========== InstancedMesh 创建 ==========

  /**
   * 将一组相同几何体的 Solid 合并为 InstancedMesh
   * ★ 共享几何体中心化到原点，每个实例通过 Matrix4 平移到原始位置
   * ★ 材质使用白色基底，实际颜色由 instanceColor 控制
   * ★ 优化7: EdgesGeometry 只计算一次，所有实例的边缘线合并为单个 LineSegments（vertexColors）
   *   减少 N 次 EdgesGeometry 计算 + DrawCalls 从 N → 1
   */
  private createInstancedSolids(
    members: SolidInfo[],
    materialCache: Map<string, THREE.MeshStandardMaterial>,
    solids: SolidObject[],
    group: THREE.Group
  ): void {
    // 以第一个成员为参考创建共享几何体
    const ref = members[0]
    const sharedGeometry = this.createGeometry(ref.data)

    // 将共享几何体中心化到原点
    const refCentroid = ref.centroid
    const positions = sharedGeometry.getAttribute('position') as THREE.BufferAttribute
    for (let i = 0; i < positions.count; i++) {
      positions.setXYZ(
        i,
        positions.getX(i) - refCentroid.x,
        positions.getY(i) - refCentroid.y,
        positions.getZ(i) - refCentroid.z
      )
    }
    positions.needsUpdate = true
    sharedGeometry.computeVertexNormals()
    sharedGeometry.computeBoundingBox()

    // BVH 加速（共享几何体只构建一次）
    buildBVH(sharedGeometry)

    // InstancedMesh 材质：白色基底（instanceColor 提供实际颜色）
    const instanceMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.3,
      roughness: 0.6,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 1
    })

    const instancedMesh = new THREE.InstancedMesh(sharedGeometry, instanceMaterial, members.length)
    instancedMesh.name = `Instanced_${ref.data.name || 'Solid'}_x${members.length}`

    // 设置每个实例的变换矩阵和颜色
    const tempMatrix = new THREE.Matrix4()
    members.forEach((member, i) => {
      tempMatrix.makeTranslation(member.centroid.x, member.centroid.y, member.centroid.z)
      instancedMesh.setMatrixAt(i, tempMatrix)

      let color = new THREE.Color(0x8899aa)
      if (member.data.color && member.data.color.length >= 3) {
        color = new THREE.Color(member.data.color[0], member.data.color[1], member.data.color[2])
      }
      instancedMesh.setColorAt(i, color)
    })

    instancedMesh.instanceMatrix.needsUpdate = true
    if (instancedMesh.instanceColor) instancedMesh.instanceColor.needsUpdate = true

    group.add(instancedMesh)

    // ★ 优化7: EdgesGeometry 只计算一次，合并所有实例的边缘线为单个 LineSegments
    let mergedEdgeLines: LineSegments | null = null
    const edgeVertexRanges = new Map<number, [number, number]>()

    try {
      const sharedEdgesGeo = new EdgesGeometry(sharedGeometry, 30)
      const edgePosAttr = sharedEdgesGeo.getAttribute('position')

      if (edgePosAttr && edgePosAttr.count > 0) {
        const vertexCountPerInstance = edgePosAttr.count
        const totalVertices = vertexCountPerInstance * members.length
        const allPositions = new Float32Array(totalVertices * 3)
        const allColors = new Float32Array(totalVertices * 3)

        const defaultR = 0.2, defaultG = 0.2, defaultB = 0.2 // #333333

        for (let i = 0; i < members.length; i++) {
          const member = members[i]
          const posOffset = i * vertexCountPerInstance * 3
          const startVertex = i * vertexCountPerInstance

          // 复制并平移边缘顶点（共享几何体已中心化，加上实例质心位置）
          for (let v = 0; v < vertexCountPerInstance; v++) {
            allPositions[posOffset + v * 3] = edgePosAttr.getX(v) + member.centroid.x
            allPositions[posOffset + v * 3 + 1] = edgePosAttr.getY(v) + member.centroid.y
            allPositions[posOffset + v * 3 + 2] = edgePosAttr.getZ(v) + member.centroid.z
            allColors[posOffset + v * 3] = defaultR
            allColors[posOffset + v * 3 + 1] = defaultG
            allColors[posOffset + v * 3 + 2] = defaultB
          }

          edgeVertexRanges.set(i, [startVertex, vertexCountPerInstance])
        }

        const mergedGeo = new THREE.BufferGeometry()
        mergedGeo.setAttribute('position', new THREE.Float32BufferAttribute(allPositions, 3))
        mergedGeo.setAttribute('color', new THREE.Float32BufferAttribute(allColors, 3))

        const mergedMaterial = new LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.6,
          depthTest: true
        })

        mergedEdgeLines = new LineSegments(mergedGeo, mergedMaterial)
        mergedEdgeLines.name = 'mergedEdgeLines'
        mergedEdgeLines.renderOrder = 1
        group.add(mergedEdgeLines)
      }

      sharedEdgesGeo.dispose()
    } catch { /* ignore edge creation errors */ }

    // ★ 拓扑边线段 — 合并所有实例的拓扑边为单个 LineSegments
    let mergedTopologyEdges: LineSegments | null = null
    const topologyEdgeVertexRangesAll = new Map<number, Map<number, [number, number]>>() // instanceIdx -> Map<edgeIndex, range>

    try {
      const refEdgeData = ref.data
      if (refEdgeData.edgeGroups && refEdgeData.edgeGroups.length > 0 && refEdgeData.edgePolylines.length > 0) {
        const refPolylines = refEdgeData.edgePolylines
        const segmentsPerEdge: Float32Array[] = []
        let totalSegmentVerts = 0
        for (const eg of refEdgeData.edgeGroups) {
          const pairs = eg.polylineCount > 1 ? eg.polylineCount - 1 : 0
          const segs = new Float32Array(pairs * 6)
          for (let p = 0; p < pairs; p++) {
            const idx0 = (eg.polylineStart + p) * 3
            const idx1 = (eg.polylineStart + p + 1) * 3
            const o = p * 6
            segs[o] = refPolylines[idx0] - refCentroid.x
            segs[o + 1] = refPolylines[idx0 + 1] - refCentroid.y
            segs[o + 2] = refPolylines[idx0 + 2] - refCentroid.z
            segs[o + 3] = refPolylines[idx1] - refCentroid.x
            segs[o + 4] = refPolylines[idx1 + 1] - refCentroid.y
            segs[o + 5] = refPolylines[idx1 + 2] - refCentroid.z
          }
          segmentsPerEdge.push(segs)
          totalSegmentVerts += pairs * 2
        }

        const totalVerts = totalSegmentVerts * members.length
        const allPos = new Float32Array(totalVerts * 3)
        const allCol = new Float32Array(totalVerts * 3)
        const allEdgeIdx = new Float32Array(totalVerts)
        const defaultR = 0.4, defaultG = 0.4, defaultB = 0.4
        let globalOffset = 0

        for (let mi = 0; mi < members.length; mi++) {
          const member = members[mi]
          const rangesMap = new Map<number, [number, number]>()
          let edgeVOffset = globalOffset

          for (let ei = 0; ei < segmentsPerEdge.length; ei++) {
            const segs = segmentsPerEdge[ei]
            const segVertCount = segs.length / 3
            const startV = edgeVOffset

            for (let v = 0; v < segVertCount; v++) {
              const gi = edgeVOffset * 3
              allPos[gi] = segs[v * 3] + member.centroid.x
              allPos[gi + 1] = segs[v * 3 + 1] + member.centroid.y
              allPos[gi + 2] = segs[v * 3 + 2] + member.centroid.z
              allCol[gi] = defaultR
              allCol[gi + 1] = defaultG
              allCol[gi + 2] = defaultB
              allEdgeIdx[edgeVOffset] = ei
              edgeVOffset++
            }

            rangesMap.set(ei, [startV, segVertCount])
          }

          topologyEdgeVertexRangesAll.set(mi, rangesMap)
          globalOffset = edgeVOffset
        }

        const topoGeo = new THREE.BufferGeometry()
        topoGeo.setAttribute('position', new THREE.Float32BufferAttribute(allPos, 3))
        topoGeo.setAttribute('color', new THREE.Float32BufferAttribute(allCol, 3))
        topoGeo.setAttribute('edgeIndex', new THREE.Float32BufferAttribute(allEdgeIdx, 1))

        mergedTopologyEdges = new LineSegments(topoGeo, new LineBasicMaterial({
          vertexColors: true,
          transparent: true,
          opacity: 0.8,
          depthTest: true
        }))
        mergedTopologyEdges.name = 'mergedTopologyEdges'
        mergedTopologyEdges.renderOrder = 2
        mergedTopologyEdges.visible = false
        group.add(mergedTopologyEdges)
      }
    } catch { /* ignore */ }

    // 为每个实例创建 SolidObject
    members.forEach((member, i) => {
      const solidIndex = member.index

      // 构建特征列表（每个实例的 feature 使用其原始世界坐标）
      const features = this.buildFeatures(
        instancedMesh as unknown as THREE.Mesh,
        member.data,
        solidIndex
      )

      const bbox = member.stats.empty
        ? undefined
        : { min: member.stats.min, max: member.stats.max, center: member.stats.center }

      let colorHex: number | undefined
      if (member.data.color && member.data.color.length >= 3) {
        colorHex = new THREE.Color(member.data.color[0], member.data.color[1], member.data.color[2]).getHex()
      }

      const range = edgeVertexRanges.get(i)
      const topoRanges = topologyEdgeVertexRangesAll.get(i)

      // 构建边特征
      const edgeFeatures = this.buildEdgeFeatures(
        instancedMesh as unknown as THREE.Mesh,
        member.data,
        solidIndex
      )

      const solid: SolidObject = {
        id: `solid_${solidIndex}`,
        name: member.data.name || `Solid_${solidIndex}`,
        mesh: instancedMesh as unknown as THREE.Mesh,
        instanceId: i,
        edgeLines: mergedEdgeLines || undefined,
        edgeVertexRange: range,
        topologyEdges: mergedTopologyEdges || undefined,
        topologyEdgeVertexRanges: topoRanges,
        edgeFeatures,
        treeNodeId: `solid_${solidIndex}`,
        boundingBox: bbox,
        features,
        visible: true,
        opacity: 1,
        selected: false,
        color: colorHex,
        serializedData: member.data
      }

      solids.push(solid)
    })
  }

  /**
   * 创建 Three.js 几何体
   */
  private createGeometry(solidData: SerializedSolidData): THREE.BufferGeometry {
    const geometry = new THREE.BufferGeometry()

    geometry.setAttribute(
      'position',
      new THREE.Float32BufferAttribute(solidData.positions, 3)
    )

    if (solidData.normals && solidData.normals.length > 0) {
      geometry.setAttribute(
        'normal',
        new THREE.Float32BufferAttribute(solidData.normals, 3)
      )
      // 检查法线是否全 0（Worker 无法提取法线时填充 0）
      let allZero = true
      for (let i = 0; i < Math.min(solidData.normals.length, 30); i++) {
        if (solidData.normals[i] !== 0) { allZero = false; break }
      }
      if (allZero) {
        geometry.computeVertexNormals()
      }
    } else {
      geometry.computeVertexNormals()
    }

    if (solidData.indices && solidData.indices.length > 0) {
      geometry.setIndex(new THREE.BufferAttribute(solidData.indices, 1))
    }

    // 面索引属性（根据 faceGroups 构建）
    if (solidData.faceGroups && solidData.faceGroups.length > 0) {
      const vertexCount = solidData.positions.length / 3
      const faceIndices = new Float32Array(vertexCount)
      // 默认填充 -1
      faceIndices.fill(-1)

      const indexArray = solidData.indices
      for (const group of solidData.faceGroups) {
        for (let i = group.start; i < group.start + group.count; i++) {
          const vertIdx = indexArray[i]
          if (vertIdx !== undefined && vertIdx < vertexCount) {
            faceIndices[vertIdx] = group.faceIndex
          }
        }
      }

      geometry.setAttribute(
        'faceIndex',
        new THREE.Float32BufferAttribute(faceIndices, 1)
      )
    }

    return geometry
  }
  /**
   * 创建边缘线
   */
  private createEdgeLines(geometry: THREE.BufferGeometry): LineSegments | null {
    try {
      const edgesGeo = new EdgesGeometry(geometry, 30) // 30° 阈值
      if (edgesGeo.getAttribute('position')?.count === 0) return null

      const edgeMaterial = new LineBasicMaterial({
        color: StepLoader.EDGE_COLOR,
        linewidth: StepLoader.EDGE_LINE_WIDTH,
        transparent: true,
        opacity: 0.6,
        depthTest: true
      })

      const lines = new LineSegments(edgesGeo, edgeMaterial)
      lines.name = 'edgeLines'
      lines.renderOrder = 1
      return lines
    } catch {
      return null
    }
  }

  /**
   * 创建拓扑边线段（可拾取，从 OCCT Edge 数据构建）
   */
  private createTopologyEdges(solidData: SerializedSolidData): LineSegments | null {
    if (!solidData.edgeGroups || solidData.edgeGroups.length === 0) return null
    if (!solidData.edgePolylines || solidData.edgePolylines.length === 0) return null

    try {
      let segmentCount = 0
      for (const eg of solidData.edgeGroups) {
        if (eg.polylineCount > 1) segmentCount += eg.polylineCount - 1
      }
      if (segmentCount === 0) return null

      const vertexCount = segmentCount * 2
      const segments = new Float32Array(vertexCount * 3)
      const edgeIndices = new Float32Array(vertexCount)
      const polylines = solidData.edgePolylines

      let v = 0
      for (const eg of solidData.edgeGroups) {
        for (let p = 0; p < eg.polylineCount - 1; p++) {
          const idx0 = (eg.polylineStart + p) * 3
          const idx1 = (eg.polylineStart + p + 1) * 3
          const o = v * 3
          segments[o] = polylines[idx0]
          segments[o + 1] = polylines[idx0 + 1]
          segments[o + 2] = polylines[idx0 + 2]
          segments[o + 3] = polylines[idx1]
          segments[o + 4] = polylines[idx1 + 1]
          segments[o + 5] = polylines[idx1 + 2]
          edgeIndices[v] = eg.edgeIndex
          edgeIndices[v + 1] = eg.edgeIndex
          v += 2
        }
      }

      const geo = new THREE.BufferGeometry()
      geo.setAttribute('position', new THREE.Float32BufferAttribute(segments, 3))
      geo.setAttribute('edgeIndex', new THREE.Float32BufferAttribute(edgeIndices, 1))

      const mat = new LineBasicMaterial({
        color: 0x444444,
        transparent: true,
        opacity: 0.8,
        depthTest: true
      })

      const lines = new LineSegments(geo, mat)
      lines.name = 'topologyEdges'
      lines.renderOrder = 2
      return lines
    } catch {
      return null
    }
  }

  /**
   * 从 Worker 提供的 faceGeometries 构建 GeometryFeature 列表
   */
  private buildFeatures(
    mesh: THREE.Mesh,
    solidData: SerializedSolidData,
    solidIndex: number
  ): GeometryFeature[] {
    const features: GeometryFeature[] = []

    solidData.faceGeometries.forEach((geom, faceIdx) => {
      const featureType = this.mapFaceType(geom.type)

      const feature: GeometryFeature = {
        id: `feature_${solidIndex}_${faceIdx}`,
        type: featureType,
        mesh,
        faceIndex: faceIdx,
        solidId: `solid_${solidIndex}`,
        treeNodeId: `solid_${solidIndex}_face_${faceIdx}`
      }

      // 设置几何属性
      if (geom.center) {
        feature.center = new THREE.Vector3(geom.center[0], geom.center[1], geom.center[2])
      }
      if (geom.normal) {
        feature.normal = new THREE.Vector3(geom.normal[0], geom.normal[1], geom.normal[2]).normalize()
      }
      if (geom.axis) {
        feature.axis = new THREE.Vector3(geom.axis[0], geom.axis[1], geom.axis[2]).normalize()
      }
      if (geom.radius !== undefined) feature.radius = geom.radius
      if (geom.height !== undefined) feature.height = geom.height
      if (geom.startAngle !== undefined) feature.startAngle = geom.startAngle
      if (geom.endAngle !== undefined) feature.endAngle = geom.endAngle
      if (geom.semiAngle !== undefined) feature.semiAngle = geom.semiAngle
      if (geom.majorRadius !== undefined) feature.majorRadius = geom.majorRadius
      if (geom.minorRadius !== undefined) feature.minorRadius = geom.minorRadius

      // 原始颜色
      if (mesh.material instanceof THREE.MeshStandardMaterial) {
        feature.originalColor = (mesh.material as THREE.MeshStandardMaterial).color.getHex()
      }

      features.push(feature)
    })

    return features
  }

  /**
   * 映射面类型字符串到 FeatureType 枚举
   */
  private mapFaceType(typeStr: string): FeatureType {
    const map: Record<string, FeatureType> = {
      plane: FeatureType.PLANE,
      cylinder: FeatureType.CYLINDER,
      cone: FeatureType.CONE,
      sphere: FeatureType.SPHERE,
      torus: FeatureType.TORUS,
      circle: FeatureType.CIRCLE,
      arc: FeatureType.ARC,
      face: FeatureType.FACE
    }
    return map[typeStr] || FeatureType.FACE
  }

  /**
   * 从 Worker 提供的 edgeGeometries 构建边特征 GeometryFeature 列表
   */
  private buildEdgeFeatures(
    mesh: THREE.Mesh,
    solidData: SerializedSolidData,
    solidIndex: number
  ): GeometryFeature[] {
    const features: GeometryFeature[] = []
    if (!solidData.edgeGeometries) return features

    solidData.edgeGeometries.forEach((geom, edgeIdx) => {
      const feature: GeometryFeature = {
        id: `feature_${solidIndex}_edge_${edgeIdx}`,
        type: FeatureType.EDGE,
        mesh,
        edgeIndex: edgeIdx,
        solidId: `solid_${solidIndex}`,
        treeNodeId: `solid_${solidIndex}_edge_${edgeIdx}`,
        edgeCurveType: geom.curveType,
        length: geom.length
      }

      if (geom.startPoint) {
        feature.startPoint = new THREE.Vector3(geom.startPoint[0], geom.startPoint[1], geom.startPoint[2])
      }
      if (geom.endPoint) {
        feature.endPoint = new THREE.Vector3(geom.endPoint[0], geom.endPoint[1], geom.endPoint[2])
      }
      if (geom.center) {
        feature.center = new THREE.Vector3(geom.center[0], geom.center[1], geom.center[2])
      }
      if (geom.axis) {
        feature.axis = new THREE.Vector3(geom.axis[0], geom.axis[1], geom.axis[2]).normalize()
      }
      if (geom.radius !== undefined) feature.radius = geom.radius
      if (geom.startAngle !== undefined) feature.startAngle = geom.startAngle
      if (geom.endAngle !== undefined) feature.endAngle = geom.endAngle

      features.push(feature)
    })

    return features
  }

  /**
   * 构建 Vue 可用的 TreeNode[] 结构
   */
  private buildTreeNodes(serialTree: SerializedTreeNode): TreeNode[] {
    const convert = (node: SerializedTreeNode): TreeNode => {
      const treeNode: TreeNode = {
        id: node.id,
        name: node.name,
        type: node.type,
        solidIndex: node.solidIndex,
        faceIndex: node.faceIndex,
        edgeIndex: node.edgeIndex,
        color: node.color,
        visible: true
      }
      if (node.children && node.children.length > 0) {
        treeNode.children = node.children.map(convert)
      }
      return treeNode
    }

    // 如果根只有一个子节点，直接返回子节点列表
    const root = convert(serialTree)
    return root.children || [root]
  }

  /**
   * 让出主线程
   */
  private yieldToMain(): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, 0))
  }

  /**
   * 读取文件为 ArrayBuffer
   */
  private readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as ArrayBuffer)
      reader.onerror = () => reject(new Error('文件读取失败'))
      reader.readAsArrayBuffer(file)
    })
  }
}

export default StepLoader
