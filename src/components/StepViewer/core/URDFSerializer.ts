/**
 * URDF XML 序列化与反序列化
 */

import type { URDFRobot, URDFLink, URDFJoint, URDFOrigin, JointLimits, JointType, InertialParams, CollisionShape } from '../types'
import * as THREE from 'three'
import { rotateInertiaTensor } from './ZUpTransform'

/** 序列化选项 */
export interface SerializeOptions {
  /**
   * linkId → Link 静息世界矩阵的逆（将世界坐标转到 Link 局部坐标）
   * 提供时，惯性质心 COM 等世界坐标数据会被变换到 Link 局部空间
   */
  linkRestInverses?: Map<string, THREE.Matrix4>
  /**
   * 单位缩放系数，应用于所有线性尺寸（mm → m 时为 0.001）
   * 仅影响平移量，不影响角度/方向向量
   */
  unitScale?: number
  /**
   * 如果用户设置了 baseLinkOrientation，则将 base_link 坐标系奠 (T × R) 矩阵的逆
   * 用于变换 base_link 直接子关节的 origin，使其表达在 URDF 基坐标系下
   */
  basePoseInverse?: THREE.Matrix4
  /** base_link 对应的 linkId，配合 basePoseInverse 使用 */
  baseLinkId?: string
  /** linkId → 简化碰撞体，提供时 <collision> 使用基本几何而非完整网格 */
  collisionShapes?: Map<string, CollisionShape>
}

/**
 * 将 URDFRobot 序列化为标准 URDF XML 字符串
 */
export function serializeURDF(robot: URDFRobot, options?: SerializeOptions): string {
  const lines: string[] = []
  const s = options?.unitScale ?? 1
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(`<robot name="${escapeXml(robot.name)}">`)

  for (const link of robot.links) {
    const restInverse = options?.linkRestInverses?.get(link.id)
    lines.push(serializeLink(link, s, restInverse, options?.collisionShapes?.get(link.id)))
  }

  for (const joint of robot.joints) {
    lines.push(serializeJoint(joint, robot, s, options))
  }

  const loops = (robot.loops || []).filter(l => l.enabled)
  if (loops.length > 0) {
    lines.push('  <!--')
    lines.push('    闭链约束（URDF 为树结构，无法原生表达，以下仅为记录；')
    lines.push('    完整闭链请使用同目录导出的 MuJoCo robot.xml 中的 <equality> 段）')
    for (const loop of loops) {
      const a = robot.links.find(l => l.id === loop.linkAId)?.name || loop.linkAId
      const b = robot.links.find(l => l.id === loop.linkBId)?.name || loop.linkBId
      const anchor: [number, number, number] = [
        loop.anchor[0] * s, loop.anchor[1] * s, loop.anchor[2] * s
      ]
      lines.push(`    ${loop.name}: ${loop.type} ${a} <-> ${b} @ (${fmtVec3(anchor)})`)
    }
    lines.push('  -->')
  }

  lines.push('</robot>')
  return lines.join('\n')
}

function serializeLink(
  link: URDFLink,
  unitScale: number,
  restInverse?: THREE.Matrix4,
  collision?: CollisionShape
): string {
  const lines: string[] = []
  const s = unitScale
  lines.push(`  <link name="${escapeXml(link.name)}">`)

  if (link.inertial) {
    // 如果提供了 restInverse，将质心从世界坐标变换到 Link 局部坐标
    let comLocal = link.inertial.com
    if (restInverse) {
      const me = restInverse.elements
      const [cx, cy, cz] = comLocal
      comLocal = [
        me[0] * cx + me[4] * cy + me[8] * cz + me[12],
        me[1] * cx + me[5] * cy + me[9] * cz + me[13],
        me[2] * cx + me[6] * cy + me[10] * cz + me[14]
      ]
    }
    // 应用单位缩放（mm → m）
    const comScaled: [number, number, number] = [comLocal[0] * s, comLocal[1] * s, comLocal[2] * s]

    // 惯性张量：原始值在 STEP 世界坐标轴下（由 InertiaWorker 计算），URDF 要求在 link-local 轴下。
    // 若 restInverse 包含旋转（link frame ≠ world frame），必须执行轴旋转变换：
    //   I_local = R_wl · I_world · R_wl^T
    // 其中 R_wl 为 restInverse 的旋转部分（将世界向量映射到 link-local 向量）。
    // 仅平移（无旋转）时 R_wl = I，变换是恒等的，可统一调用。
    let inertiaLocal = link.inertial.inertia as [number, number, number, number, number, number]
    if (restInverse) {
      inertiaLocal = rotateInertiaTensor(inertiaLocal, restInverse)
    }

    const [ixx, ixy, ixz, iyy, iyz, izz] = inertiaLocal
    lines.push('    <inertial>')
    lines.push(`      <mass value="${fmtNum(link.inertial.mass)}"/>`)
    lines.push(`      <origin xyz="${fmtVec3(comScaled)}" rpy="0 0 0"/>`)
    // inertia 已转换到 link-local 轴、SI 单位 kg·m²，直接写入
    lines.push(`      <inertia ixx="${fmtNum(ixx)}" ixy="${fmtNum(ixy)}" ixz="${fmtNum(ixz)}" iyy="${fmtNum(iyy)}" iyz="${fmtNum(iyz)}" izz="${fmtNum(izz)}"/>`)
    lines.push('    </inertial>')
  } else {
    lines.push('    <inertial>')
    lines.push('      <mass value="0"/>')
    lines.push('      <origin xyz="0 0 0" rpy="0 0 0"/>')
    lines.push('      <inertia ixx="0" ixy="0" ixz="0" iyy="0" iyz="0" izz="0"/>')
    lines.push('    </inertial>')
  }

  // Visual — 引用 STL 网格
  if (link.solidIds.length > 0) {
    lines.push('    <visual>')
    lines.push('      <origin xyz="0 0 0" rpy="0 0 0"/>')
    lines.push('      <geometry>')
    lines.push(`        <mesh filename="meshes/${escapeXml(link.name)}.stl"/>`)
    lines.push('      </geometry>')
    lines.push('    </visual>')

    lines.push('    <collision>')
    if (collision) {
      const pose = collision.type === 'convex'
        ? { xyz: [0, 0, 0] as [number, number, number], rpy: [0, 0, 0] as [number, number, number] }
        : collisionPose(collision, s, restInverse)
      lines.push(`      <origin xyz="${fmtVec3(pose.xyz)}" rpy="${fmtVec3(pose.rpy)}"/>`)
      lines.push('      <geometry>')
      lines.push(`        ${collisionGeometryTag(collision, link.name, s)}`)
      lines.push('      </geometry>')
    } else {
      lines.push('      <origin xyz="0 0 0" rpy="0 0 0"/>')
      lines.push('      <geometry>')
      lines.push(`        <mesh filename="meshes/${escapeXml(link.name)}.stl"/>`)
      lines.push('      </geometry>')
    }
    lines.push('    </collision>')
  }

  lines.push('  </link>')
  return lines.join('\n')
}

function serializeJoint(joint: URDFJoint, robot: URDFRobot, unitScale: number, options?: SerializeOptions): string {  const lines: string[] = []
  const s = unitScale
  const parentLink = robot.links.find(l => l.id === joint.parentLinkId)
  const childLink = robot.links.find(l => l.id === joint.childLinkId)
  const parentName = parentLink?.name || joint.parentLinkId
  const childName = childLink?.name || joint.childLinkId

  // 是否是 base_link 直接子关节：需要将 origin 从 STEP 世界坐标变换到 URDF 基坐标系
  const isBaseChild = !!options?.basePoseInverse && !!options?.baseLinkId
    && joint.parentLinkId === options.baseLinkId

  let xyzFinal = joint.origin.xyz as [number, number, number]
  let rpyFinal = joint.origin.rpy as [number, number, number]

  // 合并 axisOffset 到 origin.xyz
  const axOff = joint.axisOffset || [0, 0, 0]
  xyzFinal = [
    xyzFinal[0] + axOff[0],
    xyzFinal[1] + axOff[1],
    xyzFinal[2] + axOff[2]
  ]

  if (isBaseChild) {
    const bpi = options!.basePoseInverse!
    const me = bpi.elements
    const [ox, oy, oz] = xyzFinal
    // 变换平移分量： bpi 全变换（平移 + 旋转）
    xyzFinal = [
      me[0] * ox + me[4] * oy + me[8] * oz + me[12],
      me[1] * ox + me[5] * oy + me[9] * oz + me[13],
      me[2] * ox + me[6] * oy + me[10] * oz + me[14]
    ]
    // 变换旋转分量： R_bpi × R(joint.rpy) → 提取新 RPY
    const rJoint = new THREE.Matrix4().makeRotationFromEuler(
      new THREE.Euler(joint.origin.rpy[0], joint.origin.rpy[1], joint.origin.rpy[2], 'ZYX')
    )
    const rBpi = new THREE.Matrix4().extractRotation(bpi)
    const rCombined = new THREE.Matrix4().multiplyMatrices(rBpi, rJoint)
    rpyFinal = matrixToRPY(rCombined)
  }

  // origin xyz 需要缩放，rpy 不变（弧度）
  const xyzScaled: [number, number, number] = [
    xyzFinal[0] * s,
    xyzFinal[1] * s,
    xyzFinal[2] * s
  ]

  if (joint.type === 'ball') {
    const d1 = `${joint.name}_ball_x`
    const d2 = `${joint.name}_ball_y`
    lines.push(dummyLink(d1))
    lines.push(dummyLink(d2))
    lines.push(subRevolute(`${joint.name}_rx`, parentName, d1, xyzScaled, rpyFinal, [1, 0, 0], joint, s))
    lines.push(subRevolute(`${joint.name}_ry`, d1, d2, [0, 0, 0], [0, 0, 0], [0, 1, 0], joint, s))
    lines.push(subRevolute(`${joint.name}_rz`, d2, childName, [0, 0, 0], [0, 0, 0], [0, 0, 1], joint, s))
    return lines.join('\n')
  }

  lines.push(`  <joint name="${escapeXml(joint.name)}" type="${joint.type}">`)
  lines.push(`    <parent link="${escapeXml(parentName)}"/>`)
  lines.push(`    <child link="${escapeXml(childName)}"/>`)
  lines.push(`    <origin xyz="${fmtVec3(xyzScaled)}" rpy="${fmtVec3(rpyFinal)}"/>`)
  if (joint.type !== 'floating') {
    lines.push(`    <axis xyz="${fmtVec3(joint.axis)}"/>`)
  }

  if (joint.type === 'revolute' || joint.type === 'prismatic') {
    lines.push(writeLimit(joint, s, true))
  } else if (joint.type === 'continuous' || joint.type === 'planar') {
    lines.push(writeLimit(joint, s, false))
  }

  lines.push('  </joint>')
  return lines.join('\n')
}

function writeLimit(joint: URDFJoint, unitScale: number, withRange: boolean): string {
  const isLinear = joint.type === 'prismatic' || joint.type === 'planar'
  const scale = isLinear ? unitScale : 1
  const range = withRange
    ? `lower="${fmtNum(joint.limits.lower * scale)}" upper="${fmtNum(joint.limits.upper * scale)}" `
    : ''
  return `    <limit ${range}effort="${fmtNum(joint.limits.effort)}" velocity="${fmtNum(joint.limits.velocity * scale)}"/>`
}

function dummyLink(name: string): string {
  return [
    `  <link name="${escapeXml(name)}">`,
    '    <inertial>',
    '      <mass value="1e-6"/>',
    '      <origin xyz="0 0 0" rpy="0 0 0"/>',
    '      <inertia ixx="1e-9" ixy="0" ixz="0" iyy="1e-9" iyz="0" izz="1e-9"/>',
    '    </inertial>',
    '  </link>'
  ].join('\n')
}

function subRevolute(
  name: string,
  parentName: string,
  childName: string,
  xyz: [number, number, number] | number[],
  rpy: [number, number, number] | number[],
  axis: [number, number, number],
  src: URDFJoint,
  unitScale: number
): string {
  return [
    `  <joint name="${escapeXml(name)}" type="revolute">`,
    `    <parent link="${escapeXml(parentName)}"/>`,
    `    <child link="${escapeXml(childName)}"/>`,
    `    <origin xyz="${fmtVec3(xyz)}" rpy="${fmtVec3(rpy)}"/>`,
    `    <axis xyz="${fmtVec3(axis)}"/>`,
    writeLimit({ ...src, type: 'revolute' }, unitScale, true),
    '  </joint>'
  ].join('\n')
}

/**
 * 解析 URDF XML 字符串为 URDFRobot
 */
export function deserializeURDF(xml: string): URDFRobot {
  const parser = new DOMParser()
  const doc = parser.parseFromString(xml, 'application/xml')
  const errorNode = doc.querySelector('parsererror')
  if (errorNode) {
    throw new Error('URDF XML 解析失败: ' + errorNode.textContent)
  }

  const robotEl = doc.querySelector('robot')
  if (!robotEl) {
    throw new Error('URDF XML 中未找到 <robot> 元素')
  }

  const robotName = robotEl.getAttribute('name') || 'robot'
  const links: URDFLink[] = []
  const joints: URDFJoint[] = []

  // 解析 Links
  const linkEls = robotEl.querySelectorAll(':scope > link')
  linkEls.forEach((el, idx) => {
    const name = el.getAttribute('name') || `Link_${idx + 1}`
    const link: URDFLink = {
      id: `link_${idx + 1}`,
      name,
      solidIds: [],
      inertial: null,
    }

    const inertialEl = el.querySelector('inertial')
    if (inertialEl) {
      link.inertial = parseInertial(inertialEl)
    }

    links.push(link)
  })

  // 构建 name → link id 映射
  const nameToId = new Map<string, string>()
  links.forEach(l => nameToId.set(l.name, l.id))

  // 解析 Joints
  const jointEls = robotEl.querySelectorAll(':scope > joint')
  jointEls.forEach((el, idx) => {
    const name = el.getAttribute('name') || `Joint_${idx + 1}`
    const type = (el.getAttribute('type') || 'fixed') as JointType
    const parentEl = el.querySelector('parent')
    const childEl = el.querySelector('child')
    const parentName = parentEl?.getAttribute('link') || ''
    const childName = childEl?.getAttribute('link') || ''

    const originEl = el.querySelector('origin')
    const origin = parseOrigin(originEl)

    const axisEl = el.querySelector('axis')
    const axis = parseVec3(axisEl?.getAttribute('xyz') || '0 0 1') as [number, number, number]

    const limitEl = el.querySelector('limit')
    const limits = parseLimits(limitEl)

    joints.push({
      id: `joint_${idx + 1}`,
      name,
      type,
      parentLinkId: nameToId.get(parentName) || parentName,
      childLinkId: nameToId.get(childName) || childName,
      origin,
      axis,
      limits,
      currentValue: 0,
      axisOffset: [0, 0, 0] as [number, number, number]
    })
  })

  return { name: robotName, links, joints, loops: [] }
}

// ============ 辅助函数 ============

export function collisionPose(
  shape: CollisionShape,
  unitScale: number,
  restInverse?: THREE.Matrix4
): { xyz: [number, number, number]; rpy: [number, number, number] } {
  const m = new THREE.Matrix4().makeRotationFromQuaternion(
    new THREE.Quaternion(shape.quat[0], shape.quat[1], shape.quat[2], shape.quat[3])
  )
  m.setPosition(shape.center[0], shape.center[1], shape.center[2])
  if (restInverse) m.premultiply(restInverse)

  const pos = new THREE.Vector3().setFromMatrixPosition(m)
  return {
    xyz: [pos.x * unitScale, pos.y * unitScale, pos.z * unitScale],
    rpy: matrixToRPY(new THREE.Matrix4().extractRotation(m))
  }
}

function collisionGeometryTag(shape: CollisionShape, linkName: string, s: number): string {
  switch (shape.type) {
    case 'box':
      return `<box size="${fmtVec3([
        shape.halfExtents[0] * 2 * s,
        shape.halfExtents[1] * 2 * s,
        shape.halfExtents[2] * 2 * s
      ])}"/>`
    case 'sphere':
      return `<sphere radius="${fmtNum(shape.radius * s)}"/>`
    case 'cylinder':
      return `<cylinder radius="${fmtNum(shape.radius * s)}" length="${fmtNum(shape.height * s)}"/>`
    default:
      return `<mesh filename="meshes/${escapeXml(linkName)}_collision.stl"/>`
  }
}

function parseInertial(el: Element): InertialParams {
  const massEl = el.querySelector('mass')
  const mass = parseFloat(massEl?.getAttribute('value') || '0')

  const originEl = el.querySelector('origin')
  const com = parseVec3(originEl?.getAttribute('xyz') || '0 0 0') as [number, number, number]

  const inertiaEl = el.querySelector('inertia')
  const ixx = parseFloat(inertiaEl?.getAttribute('ixx') || '0')
  const ixy = parseFloat(inertiaEl?.getAttribute('ixy') || '0')
  const ixz = parseFloat(inertiaEl?.getAttribute('ixz') || '0')
  const iyy = parseFloat(inertiaEl?.getAttribute('iyy') || '0')
  const iyz = parseFloat(inertiaEl?.getAttribute('iyz') || '0')
  const izz = parseFloat(inertiaEl?.getAttribute('izz') || '0')

  return { mass, com, inertia: [ixx, ixy, ixz, iyy, iyz, izz] }
}

function parseOrigin(el: Element | null): URDFOrigin {
  if (!el) return { xyz: [0, 0, 0], rpy: [0, 0, 0] }
  return {
    xyz: parseVec3(el.getAttribute('xyz') || '0 0 0') as [number, number, number],
    rpy: parseVec3(el.getAttribute('rpy') || '0 0 0') as [number, number, number]
  }
}

function parseLimits(el: Element | null): JointLimits {
  if (!el) return { lower: -3.14159, upper: 3.14159, effort: 100, velocity: 1 }
  return {
    lower: parseFloat(el.getAttribute('lower') || '-3.14159'),
    upper: parseFloat(el.getAttribute('upper') || '3.14159'),
    effort: parseFloat(el.getAttribute('effort') || '100'),
    velocity: parseFloat(el.getAttribute('velocity') || '1')
  }
}

function parseVec3(str: string): [number, number, number] {
  const parts = str.trim().split(/\s+/).map(Number)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

function fmtNum(n: number): string {
  return Number.isFinite(n) ? parseFloat(n.toFixed(8)).toString() : '0'
}

function fmtVec3(v: [number, number, number] | number[]): string {
  return `${fmtNum(v[0])} ${fmtNum(v[1])} ${fmtNum(v[2])}`
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 从旋转矩阵提取 ZYX intrinsic RPY（即 Three.js 'ZYX' Euler）
 */
function matrixToRPY(m: THREE.Matrix4): [number, number, number] {
  const euler = new THREE.Euler().setFromRotationMatrix(m, 'ZYX')
  return [euler.x, euler.y, euler.z]
}
