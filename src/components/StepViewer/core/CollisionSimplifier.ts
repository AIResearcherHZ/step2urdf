import * as THREE from 'three'
import { ConvexHull } from 'three/examples/jsm/math/ConvexHull.js'
import type {
  CollisionShape,
  CollisionShapeType,
  CollisionMode,
  CollisionHull,
  CollisionConflict,
  CollisionBuildResult
} from '../types'

const MAX_FIT_POINTS = 4000
const MAX_HULL_POINTS = 700
const EPS = 1e-9

export interface SolidGeometryInput {
  positions: Float32Array
  indices: Uint32Array
}

export interface LinkGeometryInput {
  linkId: string
  solids: SolidGeometryInput[]
  preferredAxes: [number, number, number][]
  mode: CollisionMode
}

export interface SeparateOptions {
  margin: number
  minScale: number
  maxIterations?: number
  deltaConfigs?: Map<string, THREE.Matrix4>[]
}

export function fitLinkShape(input: LinkGeometryInput): CollisionShape | null {
  const merged = mergeSolids(input.solids)
  if (!merged || merged.pts.length < 9) return null

  const meshVolume = merged.volume
  const box = fitBox(merged.pts)
  if (!box) return null

  const axes: number[][] = [
    [box.rot[0], box.rot[1], box.rot[2]],
    [box.rot[3], box.rot[4], box.rot[5]],
    [box.rot[6], box.rot[7], box.rot[8]]
  ]
  for (const a of input.preferredAxes) {
    const len = Math.hypot(a[0], a[1], a[2])
    if (len > EPS) axes.push([a[0] / len, a[1] / len, a[2] / len])
  }

  const cylinder = fitCylinder(merged.pts, axes)
  const sphere = fitSphere(merged.pts)

  let type: CollisionShapeType = input.mode === 'auto' ? 'box' : input.mode

  if (input.mode === 'auto') {
    const scored: { type: CollisionShapeType; cost: number }[] = [
      { type: 'box', cost: box.volume * 0.92 },
      { type: 'cylinder', cost: cylinder.volume },
      { type: 'sphere', cost: sphere.volume * 1.05 }
    ]
    scored.sort((a, b) => a.cost - b.cost)
    type = scored[0].type
    const bestVolume = type === 'box' ? box.volume : type === 'cylinder' ? cylinder.volume : sphere.volume
    if (meshVolume > EPS && bestVolume > meshVolume * 2.2) {
      type = 'convex'
    }
  }

  const shape = assembleShape(input.linkId, type, box, cylinder, sphere, merged.pts, meshVolume)
  return shape
}

export function separateShapes(shapes: CollisionShape[], options: SeparateOptions): CollisionBuildResult {
  const margin = Math.max(options.margin, 0)
  const minScale = Math.min(Math.max(options.minScale, 0.05), 1)
  const maxIterations = options.maxIterations ?? 12
  const configs = options.deltaConfigs && options.deltaConfigs.length > 0
    ? options.deltaConfigs
    : [new Map<string, THREE.Matrix4>()]

  let conflicts: CollisionConflict[] = []
  let iterations = 0

  for (let iter = 0; iter < maxIterations; iter++) {
    iterations = iter + 1
    conflicts = []
    let resolvedAny = false

    for (const config of configs) {
      const proxies = shapes.map(s => makeProxy(s, config.get(s.linkId)))

      for (let i = 0; i < shapes.length; i++) {
        for (let j = i + 1; j < shapes.length; j++) {
          if (sameDelta(config.get(shapes[i].linkId), config.get(shapes[j].linkId))) {
            if (config !== configs[0]) continue
          }
          const hit = testOBB(proxies[i], proxies[j], margin)
          if (!hit) continue

          conflicts.push({ linkAId: shapes[i].linkId, linkBId: shapes[j].linkId, depth: hit.depth })

          const half = hit.depth / 2
          const okA = shrinkShape(shapes[i], hit.axis, half, config.get(shapes[i].linkId), minScale, 1)
          const okB = shrinkShape(shapes[j], hit.axis, half, config.get(shapes[j].linkId), minScale, -1)
          if (okA || okB) resolvedAny = true
        }
      }
    }

    if (conflicts.length === 0) break
    if (!resolvedAny) break
  }

  return { shapes, conflicts, iterations }
}

export function shapeLocalMatrix(shape: CollisionShape): THREE.Matrix4 {
  const q = new THREE.Quaternion(shape.quat[0], shape.quat[1], shape.quat[2], shape.quat[3])
  const m = new THREE.Matrix4().makeRotationFromQuaternion(q)
  m.setPosition(shape.center[0], shape.center[1], shape.center[2])
  return m
}

function assembleShape(
  linkId: string,
  type: CollisionShapeType,
  box: BoxFit,
  cylinder: CylinderFit,
  sphere: SphereFit,
  pts: Float64Array,
  meshVolume: number
): CollisionShape {
  const boxQuat = quatFromRot(box.rot)

  if (type === 'box') {
    return {
      linkId,
      type,
      center: [box.center[0], box.center[1], box.center[2]],
      quat: boxQuat,
      halfExtents: [box.half[0], box.half[1], box.half[2]],
      originalHalfExtents: [box.half[0], box.half[1], box.half[2]],
      radius: 0,
      height: 0,
      meshVolume,
      shapeVolume: box.volume,
      shrunk: false
    }
  }

  if (type === 'cylinder') {
    const q = quatFromZAxis(cylinder.axis)
    const half: [number, number, number] = [cylinder.radius, cylinder.radius, cylinder.height / 2]
    return {
      linkId,
      type,
      center: [cylinder.center[0], cylinder.center[1], cylinder.center[2]],
      quat: q,
      halfExtents: half,
      originalHalfExtents: [...half] as [number, number, number],
      radius: cylinder.radius,
      height: cylinder.height,
      meshVolume,
      shapeVolume: cylinder.volume,
      shrunk: false
    }
  }

  if (type === 'sphere') {
    const half: [number, number, number] = [sphere.radius, sphere.radius, sphere.radius]
    return {
      linkId,
      type,
      center: [sphere.center[0], sphere.center[1], sphere.center[2]],
      quat: [0, 0, 0, 1],
      halfExtents: half,
      originalHalfExtents: [...half] as [number, number, number],
      radius: sphere.radius,
      height: 0,
      meshVolume,
      shapeVolume: sphere.volume,
      shrunk: false
    }
  }

  const hull = buildHull(pts)
  return {
    linkId,
    type: 'convex',
    center: [box.center[0], box.center[1], box.center[2]],
    quat: boxQuat,
    halfExtents: [box.half[0], box.half[1], box.half[2]],
    originalHalfExtents: [box.half[0], box.half[1], box.half[2]],
    radius: 0,
    height: 0,
    hull: hull ?? undefined,
    meshVolume,
    shapeVolume: hull ? hullVolume(hull) : box.volume,
    shrunk: false
  }
}

interface MergedGeometry {
  pts: Float64Array
  volume: number
}

function mergeSolids(solids: SolidGeometryInput[]): MergedGeometry | null {
  let totalPoints = 0
  let volume = 0
  for (const s of solids) {
    totalPoints += s.positions.length / 3
    volume += meshVolume(s.positions, s.indices)
  }
  if (totalPoints === 0) return null

  const stride = Math.max(1, Math.ceil(totalPoints / MAX_FIT_POINTS))
  const out: number[] = []
  for (const s of solids) {
    const n = s.positions.length / 3
    for (let i = 0; i < n; i += stride) {
      out.push(s.positions[i * 3], s.positions[i * 3 + 1], s.positions[i * 3 + 2])
    }
  }
  return { pts: Float64Array.from(out), volume: Math.abs(volume) }
}

function meshVolume(positions: Float32Array, indices: Uint32Array): number {
  let v = 0
  for (let t = 0; t < indices.length; t += 3) {
    const i0 = indices[t] * 3, i1 = indices[t + 1] * 3, i2 = indices[t + 2] * 3
    const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2]
    const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2]
    const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2]
    v += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
  }
  return Math.abs(v)
}

interface BoxFit {
  center: number[]
  half: number[]
  rot: number[]
  volume: number
}

interface CylinderFit {
  center: number[]
  axis: number[]
  radius: number
  height: number
  volume: number
}

interface SphereFit {
  center: number[]
  radius: number
  volume: number
}

function fitBox(pts: Float64Array): BoxFit | null {
  const n = pts.length / 3
  if (n === 0) return null

  const mean = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    mean[0] += pts[i * 3]
    mean[1] += pts[i * 3 + 1]
    mean[2] += pts[i * 3 + 2]
  }
  mean[0] /= n; mean[1] /= n; mean[2] /= n

  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0]
  for (let i = 0; i < n; i++) {
    const x = pts[i * 3] - mean[0]
    const y = pts[i * 3 + 1] - mean[1]
    const z = pts[i * 3 + 2] - mean[2]
    cov[0] += x * x; cov[1] += x * y; cov[2] += x * z
    cov[4] += y * y; cov[5] += y * z
    cov[8] += z * z
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5]
  for (let i = 0; i < 9; i++) cov[i] /= n

  const eig = jacobiEigen3(cov)
  const candidates: number[][] = [eig, [1, 0, 0, 0, 1, 0, 0, 0, 1]]

  let best: BoxFit | null = null
  for (const base of candidates) {
    const refined = refineRotation(pts, base)
    if (!best || refined.volume < best.volume) best = refined
  }
  return best
}

function refineRotation(pts: Float64Array, base: number[]): BoxFit {
  let rot = orthonormalize(base)
  let best = extentsIn(pts, rot)

  for (let pass = 0; pass < 2; pass++) {
    const step = pass === 0 ? Math.PI / 90 : Math.PI / 360
    const range = pass === 0 ? 45 : 12
    for (let axis = 0; axis < 3; axis++) {
      let improvedRot = rot
      let improved = best
      for (let k = -range; k <= range; k++) {
        if (k === 0) continue
        const cand = rotateAround(rot, axis, k * step)
        const fit = extentsIn(pts, cand)
        if (fit.volume < improved.volume - EPS) {
          improved = fit
          improvedRot = cand
        }
      }
      rot = improvedRot
      best = improved
    }
  }
  return best
}

function extentsIn(pts: Float64Array, rot: number[]): BoxFit {
  const n = pts.length / 3
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < n; i++) {
    const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
    for (let a = 0; a < 3; a++) {
      const d = rot[a * 3] * x + rot[a * 3 + 1] * y + rot[a * 3 + 2] * z
      if (d < min[a]) min[a] = d
      if (d > max[a]) max[a] = d
    }
  }

  const half = [
    Math.max((max[0] - min[0]) / 2, EPS),
    Math.max((max[1] - min[1]) / 2, EPS),
    Math.max((max[2] - min[2]) / 2, EPS)
  ]
  const mid = [(max[0] + min[0]) / 2, (max[1] + min[1]) / 2, (max[2] + min[2]) / 2]
  const center = [
    rot[0] * mid[0] + rot[3] * mid[1] + rot[6] * mid[2],
    rot[1] * mid[0] + rot[4] * mid[1] + rot[7] * mid[2],
    rot[2] * mid[0] + rot[5] * mid[1] + rot[8] * mid[2]
  ]

  return { center, half, rot, volume: 8 * half[0] * half[1] * half[2] }
}

function fitCylinder(pts: Float64Array, axes: number[][]): CylinderFit {
  let best: CylinderFit | null = null

  for (const axis of axes) {
    const [u, v] = orthoBasis(axis)
    const n = pts.length / 3
    let minA = Infinity, maxA = -Infinity
    const proj = new Float64Array(n * 2)

    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2]
      const a = axis[0] * x + axis[1] * y + axis[2] * z
      if (a < minA) minA = a
      if (a > maxA) maxA = a
      proj[i * 2] = u[0] * x + u[1] * y + u[2] * z
      proj[i * 2 + 1] = v[0] * x + v[1] * y + v[2] * z
    }

    const circle = minEnclosingCircle(proj)
    const height = Math.max(maxA - minA, EPS)
    const radius = Math.max(circle.r, EPS)
    const midA = (maxA + minA) / 2
    const center = [
      axis[0] * midA + u[0] * circle.x + v[0] * circle.y,
      axis[1] * midA + u[1] * circle.x + v[1] * circle.y,
      axis[2] * midA + u[2] * circle.x + v[2] * circle.y
    ]
    const volume = Math.PI * radius * radius * height
    if (!best || volume < best.volume) {
      best = { center, axis: [...axis], radius, height, volume }
    }
  }

  return best!
}

function minEnclosingCircle(proj: Float64Array): { x: number; y: number; r: number } {
  const n = proj.length / 2
  let cx = 0, cy = 0
  for (let i = 0; i < n; i++) { cx += proj[i * 2]; cy += proj[i * 2 + 1] }
  cx /= n; cy /= n

  let r = 0
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(proj[i * 2] - cx, proj[i * 2 + 1] - cy)
    if (d > r) r = d
  }

  for (let iter = 0; iter < 48; iter++) {
    let far = -1, farD = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(proj[i * 2] - cx, proj[i * 2 + 1] - cy)
      if (d > farD) { farD = d; far = i }
    }
    if (far < 0 || farD <= r + EPS) break
    const move = (farD - r) / 2
    const dx = (proj[far * 2] - cx) / farD
    const dy = (proj[far * 2 + 1] - cy) / farD
    cx += dx * move
    cy += dy * move
    r += move
  }

  return { x: cx, y: cy, r }
}

function fitSphere(pts: Float64Array): SphereFit {
  const n = pts.length / 3
  let cx = 0, cy = 0, cz = 0
  for (let i = 0; i < n; i++) {
    cx += pts[i * 3]; cy += pts[i * 3 + 1]; cz += pts[i * 3 + 2]
  }
  cx /= n; cy /= n; cz /= n

  let r = 0
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(pts[i * 3] - cx, pts[i * 3 + 1] - cy, pts[i * 3 + 2] - cz)
    if (d > r) r = d
  }

  for (let iter = 0; iter < 48; iter++) {
    let far = -1, farD = 0
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(pts[i * 3] - cx, pts[i * 3 + 1] - cy, pts[i * 3 + 2] - cz)
      if (d > farD) { farD = d; far = i }
    }
    if (far < 0 || farD <= r + EPS) break
    const move = (farD - r) / 2
    cx += (pts[far * 3] - cx) / farD * move
    cy += (pts[far * 3 + 1] - cy) / farD * move
    cz += (pts[far * 3 + 2] - cz) / farD * move
    r += move
  }

  r = Math.max(r, EPS)
  return { center: [cx, cy, cz], radius: r, volume: (4 / 3) * Math.PI * r * r * r }
}

function buildHull(pts: Float64Array): CollisionHull | null {
  const n = pts.length / 3
  if (n < 4) return null

  const stride = Math.max(1, Math.ceil(n / MAX_HULL_POINTS))
  const vectors: THREE.Vector3[] = []
  for (let i = 0; i < n; i += stride) {
    vectors.push(new THREE.Vector3(pts[i * 3], pts[i * 3 + 1], pts[i * 3 + 2]))
  }
  if (vectors.length < 4) return null

  try {
    const hull = new ConvexHull().setFromPoints(vectors)
    const positions: number[] = []
    const indices: number[] = []
    const keyMap = new Map<string, number>()

    const addVertex = (p: THREE.Vector3): number => {
      const key = `${p.x.toFixed(4)}_${p.y.toFixed(4)}_${p.z.toFixed(4)}`
      const existing = keyMap.get(key)
      if (existing !== undefined) return existing
      const id = positions.length / 3
      positions.push(p.x, p.y, p.z)
      keyMap.set(key, id)
      return id
    }

    for (const face of hull.faces) {
      const ring: number[] = []
      let edge = face.edge
      do {
        ring.push(addVertex(edge.head().point))
        edge = edge.next
      } while (edge !== face.edge)

      for (let k = 1; k < ring.length - 1; k++) {
        indices.push(ring[0], ring[k], ring[k + 1])
      }
    }

    if (indices.length === 0) return null
    return { positions: Float32Array.from(positions), indices: Uint32Array.from(indices) }
  } catch {
    return null
  }
}

function hullVolume(hull: CollisionHull): number {
  return meshVolume(hull.positions, hull.indices)
}

interface Proxy {
  center: THREE.Vector3
  axes: THREE.Vector3[]
  half: number[]
}

function makeProxy(shape: CollisionShape, delta?: THREE.Matrix4): Proxy {
  const m = shapeLocalMatrix(shape)
  if (delta) m.premultiply(delta)

  const center = new THREE.Vector3().setFromMatrixPosition(m)
  const e = m.elements
  const axes = [
    new THREE.Vector3(e[0], e[1], e[2]).normalize(),
    new THREE.Vector3(e[4], e[5], e[6]).normalize(),
    new THREE.Vector3(e[8], e[9], e[10]).normalize()
  ]
  return { center, axes, half: [...shape.halfExtents] }
}

function testOBB(a: Proxy, b: Proxy, margin: number): { axis: THREE.Vector3; depth: number } | null {
  const t = new THREE.Vector3().subVectors(b.center, a.center)
  const candidates: THREE.Vector3[] = []

  for (let i = 0; i < 3; i++) candidates.push(a.axes[i].clone())
  for (let i = 0; i < 3; i++) candidates.push(b.axes[i].clone())
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const c = new THREE.Vector3().crossVectors(a.axes[i], b.axes[j])
      if (c.lengthSq() > 1e-12) candidates.push(c.normalize())
    }
  }

  let bestGap = -Infinity
  let bestAxis: THREE.Vector3 | null = null
  const scale = Math.max(...a.half, ...b.half, 1)
  const tol = 1e-6 * scale

  for (const axis of candidates) {
    const rA = a.half[0] * Math.abs(axis.dot(a.axes[0]))
      + a.half[1] * Math.abs(axis.dot(a.axes[1]))
      + a.half[2] * Math.abs(axis.dot(a.axes[2]))
    const rB = b.half[0] * Math.abs(axis.dot(b.axes[0]))
      + b.half[1] * Math.abs(axis.dot(b.axes[1]))
      + b.half[2] * Math.abs(axis.dot(b.axes[2]))
    const d = t.dot(axis)
    const gap = Math.abs(d) - rA - rB

    if (gap >= margin - tol) return null
    if (gap > bestGap) {
      bestGap = gap
      bestAxis = d < 0 ? axis.clone().negate() : axis.clone()
    }
  }

  if (!bestAxis) return null
  return { axis: bestAxis, depth: margin - bestGap }
}

function shrinkShape(
  shape: CollisionShape,
  worldAxis: THREE.Vector3,
  amount: number,
  delta: THREE.Matrix4 | undefined,
  minScale: number,
  sign: number
): boolean {
  if (amount <= EPS) return false

  const dir = worldAxis.clone().multiplyScalar(sign)
  if (delta) {
    const rot = new THREE.Matrix4().extractRotation(delta).transpose()
    dir.applyMatrix4(rot).normalize()
  }

  const q = new THREE.Quaternion(shape.quat[0], shape.quat[1], shape.quat[2], shape.quat[3])
  const inv = q.clone().invert()
  const local = dir.clone().applyQuaternion(inv)

  if (shape.type === 'sphere') {
    const limit = shape.originalHalfExtents[0] * minScale
    const cut = Math.min(amount / 2, Math.max(shape.radius - limit, 0))
    if (cut <= EPS) return false
    shape.radius -= cut
    shape.halfExtents = [shape.radius, shape.radius, shape.radius]
    shape.center = offsetCenter(shape.center, dir, -cut)
    shape.shapeVolume = (4 / 3) * Math.PI * Math.pow(shape.radius, 3)
    shape.shrunk = true
    return true
  }

  if (shape.type === 'cylinder') {
    const axial = Math.abs(local.z) * (shape.height / 2)
    const radial = Math.hypot(local.x, local.y) * shape.radius
    const alongAxis = axial >= radial
    if (alongAxis) {
      const limit = shape.originalHalfExtents[2] * 2 * minScale
      const cut = Math.min(amount, Math.max(shape.height - limit, 0))
      if (cut <= EPS) return false
      shape.height -= cut
      shape.halfExtents = [shape.radius, shape.radius, shape.height / 2]
      const zWorld = new THREE.Vector3(0, 0, Math.sign(local.z) || 1).applyQuaternion(q)
      shape.center = offsetCenter(shape.center, zWorld, -cut / 2)
    } else {
      const limit = shape.originalHalfExtents[0] * minScale
      const cut = Math.min(amount / 2, Math.max(shape.radius - limit, 0))
      if (cut <= EPS) return false
      shape.radius -= cut
      shape.halfExtents = [shape.radius, shape.radius, shape.halfExtents[2]]
      shape.center = offsetCenter(shape.center, dir, -cut)
    }
    shape.shapeVolume = Math.PI * shape.radius * shape.radius * shape.height
    shape.shrunk = true
    return true
  }

  const comps = [
    Math.abs(local.x) * shape.halfExtents[0],
    Math.abs(local.y) * shape.halfExtents[1],
    Math.abs(local.z) * shape.halfExtents[2]
  ]
  let k = 0
  if (comps[1] > comps[k]) k = 1
  if (comps[2] > comps[k]) k = 2
  const s = Math.sign([local.x, local.y, local.z][k]) || 1

  const limit = shape.originalHalfExtents[k] * minScale
  const cut = Math.min(amount, Math.max(shape.halfExtents[k] * 2 - limit * 2, 0))
  if (cut <= EPS) return false

  const half = [...shape.halfExtents] as [number, number, number]
  half[k] -= cut / 2
  shape.halfExtents = half

  const axisLocal = new THREE.Vector3(k === 0 ? s : 0, k === 1 ? s : 0, k === 2 ? s : 0)
  const axisWorld = axisLocal.applyQuaternion(q)
  shape.center = offsetCenter(shape.center, axisWorld, -cut / 2)

  if (shape.type === 'convex' && shape.hull) {
    clipHull(shape.hull, axisLocal.clone().normalize(), q, cut)
  }

  shape.shapeVolume = shape.type === 'convex' && shape.hull
    ? hullVolume(shape.hull)
    : 8 * half[0] * half[1] * half[2]
  shape.shrunk = true
  return true
}

function clipHull(
  hull: CollisionHull,
  axisLocal: THREE.Vector3,
  q: THREE.Quaternion,
  cut: number
): void {
  const axisWorld = axisLocal.clone().applyQuaternion(q).normalize()
  const pos = hull.positions
  let maxD = -Infinity
  for (let i = 0; i < pos.length; i += 3) {
    const d = pos[i] * axisWorld.x + pos[i + 1] * axisWorld.y + pos[i + 2] * axisWorld.z
    if (d > maxD) maxD = d
  }
  const plane = maxD - cut
  for (let i = 0; i < pos.length; i += 3) {
    const d = pos[i] * axisWorld.x + pos[i + 1] * axisWorld.y + pos[i + 2] * axisWorld.z
    if (d > plane) {
      const over = d - plane
      pos[i] -= axisWorld.x * over
      pos[i + 1] -= axisWorld.y * over
      pos[i + 2] -= axisWorld.z * over
    }
  }
}

function offsetCenter(
  center: [number, number, number],
  dir: THREE.Vector3,
  distance: number
): [number, number, number] {
  return [
    center[0] + dir.x * distance,
    center[1] + dir.y * distance,
    center[2] + dir.z * distance
  ]
}

function sameDelta(a?: THREE.Matrix4, b?: THREE.Matrix4): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  for (let i = 0; i < 16; i++) {
    if (Math.abs(a.elements[i] - b.elements[i]) > 1e-9) return false
  }
  return true
}

function quatFromRot(rot: number[]): [number, number, number, number] {
  const m = new THREE.Matrix4().set(
    rot[0], rot[3], rot[6], 0,
    rot[1], rot[4], rot[7], 0,
    rot[2], rot[5], rot[8], 0,
    0, 0, 0, 1
  )
  const q = new THREE.Quaternion().setFromRotationMatrix(m)
  return [q.x, q.y, q.z, q.w]
}

function quatFromZAxis(axis: number[]): [number, number, number, number] {
  const z = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize()
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), z)
  return [q.x, q.y, q.z, q.w]
}

function orthoBasis(axis: number[]): [number[], number[]] {
  const n = new THREE.Vector3(axis[0], axis[1], axis[2]).normalize()
  const ref = Math.abs(n.z) < 0.9 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(1, 0, 0)
  const u = new THREE.Vector3().crossVectors(ref, n).normalize()
  const v = new THREE.Vector3().crossVectors(n, u).normalize()
  return [[u.x, u.y, u.z], [v.x, v.y, v.z]]
}

function orthonormalize(rot: number[]): number[] {
  const x = new THREE.Vector3(rot[0], rot[1], rot[2]).normalize()
  let y = new THREE.Vector3(rot[3], rot[4], rot[5])
  y.sub(x.clone().multiplyScalar(x.dot(y)))
  if (y.lengthSq() < 1e-12) y = new THREE.Vector3(0, 0, 1).cross(x)
  y.normalize()
  const z = new THREE.Vector3().crossVectors(x, y).normalize()
  return [x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z]
}

function rotateAround(rot: number[], axisIndex: number, angle: number): number[] {
  const axis = new THREE.Vector3(
    rot[axisIndex * 3],
    rot[axisIndex * 3 + 1],
    rot[axisIndex * 3 + 2]
  ).normalize()
  const q = new THREE.Quaternion().setFromAxisAngle(axis, angle)
  const out: number[] = []
  for (let a = 0; a < 3; a++) {
    const v = new THREE.Vector3(rot[a * 3], rot[a * 3 + 1], rot[a * 3 + 2]).applyQuaternion(q)
    out.push(v.x, v.y, v.z)
  }
  return orthonormalize(out)
}

function jacobiEigen3(m: number[]): number[] {
  const a = [...m]
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1]

  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) off += a[i * 3 + j] * a[i * 3 + j]
    }
    if (off < 1e-18) break

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = a[p * 3 + q]
        if (Math.abs(apq) < 1e-18) continue
        const theta = (a[q * 3 + q] - a[p * 3 + p]) / (2 * apq)
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1)
        const s = t * c

        for (let k = 0; k < 3; k++) {
          const akp = a[k * 3 + p], akq = a[k * 3 + q]
          a[k * 3 + p] = c * akp - s * akq
          a[k * 3 + q] = s * akp + c * akq
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p * 3 + k], aqk = a[q * 3 + k]
          a[p * 3 + k] = c * apk - s * aqk
          a[q * 3 + k] = s * apk + c * aqk
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k * 3 + p], vkq = v[k * 3 + q]
          v[k * 3 + p] = c * vkp - s * vkq
          v[k * 3 + q] = s * vkp + c * vkq
        }
      }
    }
  }

  const cols = [
    [v[0], v[3], v[6], a[0]],
    [v[1], v[4], v[7], a[4]],
    [v[2], v[5], v[8], a[8]]
  ]
  cols.sort((x, y) => y[3] - x[3])
  return orthonormalize([
    cols[0][0], cols[0][1], cols[0][2],
    cols[1][0], cols[1][1], cols[1][2],
    cols[2][0], cols[2][1], cols[2][2]
  ])
}
