import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import * as THREE from 'three'
import type {
  URDFRobot,
  URDFLink,
  URDFJoint,
  JointType,
  URDFOrigin,
  JointLimits,
  InertialParams,
  BindingModeState,
  JointWizardStep
} from '../types'

const BASE_LINK_ID = 'link_base'

let _nextLinkId = 1
let _nextJointId = 1

export interface URDFTreeNode {
  id: string
  label: string
  nodeType: 'link' | 'joint'
  jointType?: JointType
  solidCount: number
  isBase: boolean
  children: URDFTreeNode[]
}

export const useURDFStore = defineStore('urdf', () => {
  const robot = ref<URDFRobot>({
    name: 'robot',
    links: [
      { id: BASE_LINK_ID, name: 'base_link', solidIds: [], inertial: null }
    ],
    joints: []
  })

  const exporting = ref(false)
  const exportProgress = ref('')

  const selectedLinkId = ref<string | null>(null)
  const selectedJointId = ref<string | null>(null)

  const bindingMode = ref<BindingModeState>({ active: false, targetLinkId: null })

  const jointWizardVisible = ref(false)
  const jointWizardStep = ref<JointWizardStep>('select-links')

  const edgePickEditJointId = ref<string | null>(null)

  const showFrames = ref(true)
  const urdfEditorVisible = ref(false)

  const linkWorldTransforms = ref(new Map<string, THREE.Matrix4>())

  const axisHelperScale = ref<number>(1.0)

  const basePickMode = ref(false)
  const baseLinkOrigin = ref<[number, number, number] | null>(null)
  const baseLinkRPY = ref<[number, number, number] | null>(null)
  const totalMass = ref(10)

  const linkMap = computed(() => {
    const map = new Map<string, URDFLink>()
    robot.value.links.forEach(l => map.set(l.id, l))
    return map
  })

  const jointMap = computed(() => {
    const map = new Map<string, URDFJoint>()
    robot.value.joints.forEach(j => map.set(j.id, j))
    return map
  })

  const linkByName = computed(() => {
    const map = new Map<string, URDFLink>()
    robot.value.links.forEach(l => map.set(l.name, l))
    return map
  })

  const childJointMap = computed(() => {
    const map = new Map<string, URDFJoint>()
    robot.value.joints.forEach(j => map.set(j.childLinkId, j))
    return map
  })

  const parentJointMap = computed(() => {
    const map = new Map<string, URDFJoint[]>()
    robot.value.joints.forEach(j => {
      const list = map.get(j.parentLinkId) || []
      list.push(j)
      map.set(j.parentLinkId, list)
    })
    return map
  })

  const rootLinks = computed(() => {
    const childIds = new Set(robot.value.joints.map(j => j.childLinkId))
    return robot.value.links.filter(l => !childIds.has(l.id))
  })

  const leafLinks = computed(() => {
    const parentIds = new Set(robot.value.joints.map(j => j.parentLinkId))
    return robot.value.links.filter(l => !parentIds.has(l.id))
  })

  function buildLinkNode(linkId: string): URDFTreeNode {
    const link = linkMap.value.get(linkId)
    const childJoints = parentJointMap.value.get(linkId) || []
    return {
      id: linkId,
      label: link?.name ?? linkId,
      nodeType: 'link',
      solidCount: link?.solidIds.length ?? 0,
      isBase: isBaseLink(linkId),
      jointType: undefined,
      children: childJoints.map(j => ({
        id: j.id,
        label: j.name,
        nodeType: 'joint' as const,
        jointType: j.type,
        solidCount: 0,
        isBase: false,
        children: linkMap.value.has(j.childLinkId) ? [buildLinkNode(j.childLinkId)] : []
      }))
    }
  }

  const treeData = computed<URDFTreeNode[]>(() => rootLinks.value.map(l => buildLinkNode(l.id)))

  const activeJoints = computed(() => {
    return robot.value.joints.filter(j => j.type !== 'fixed')
  })

  const boundSolidIds = computed(() => {
    const ids = new Set<string>()
    robot.value.links.forEach(l => l.solidIds.forEach(id => ids.add(id)))
    return ids
  })

  function isBaseLink(linkId: string): boolean {
    return linkId === BASE_LINK_ID
  }

  function addLink(name?: string): URDFLink {
    const id = `link_${_nextLinkId++}`
    const link: URDFLink = {
      id,
      name: name || `Link_${_nextLinkId - 1}`,
      solidIds: [],
      inertial: null,
    }
    robot.value.links.push(link)
    selectedLinkId.value = id
    return link
  }

  function removeLink(linkId: string): { ok: boolean; reason?: string } {
    if (isBaseLink(linkId)) {
      return { ok: false, reason: 'base_link 不能被删除' }
    }
    robot.value.joints = robot.value.joints.filter(
      j => j.parentLinkId !== linkId && j.childLinkId !== linkId
    )
    robot.value.links = robot.value.links.filter(l => l.id !== linkId)
    if (selectedLinkId.value === linkId) {
      selectedLinkId.value = null
    }
    return { ok: true }
  }

  function renameLink(linkId: string, newName: string): void {
    const link = linkMap.value.get(linkId)
    if (link) {
      link.name = newName
    }
  }

  function renameJoint(jointId: string, newName: string): void {
    const joint = jointMap.value.get(jointId)
    if (joint) {
      joint.name = newName
    }
  }

  function bindSolid(linkId: string, solidId: string): void {
    const link = linkMap.value.get(linkId)
    if (link && !link.solidIds.includes(solidId)) {
      link.solidIds.push(solidId)
    }
  }

  function unbindSolid(linkId: string, solidId: string): void {
    const link = linkMap.value.get(linkId)
    if (link) {
      link.solidIds = link.solidIds.filter(id => id !== solidId)
      if (link.solidMasses) delete link.solidMasses[solidId]
    }
  }

  function validateJoint(parentLinkId: string, childLinkId: string, excludeJointId?: string): string | null {
    if (parentLinkId === childLinkId) {
      return '父子连杆不能相同'
    }
    if (childLinkId === BASE_LINK_ID) {
      return 'base_link 不能作为 Child（它是根连杆）'
    }
    const existing = robot.value.joints.find(
      j => j.childLinkId === childLinkId && j.id !== excludeJointId
    )
    if (existing) {
      return `该连杆已作为 "${existing.name}" 的 Child，禁止构成运动学闭环`
    }
    return null
  }

  function addJoint(config: {
    name?: string
    type: JointType
    parentLinkId: string
    childLinkId: string
    origin: URDFOrigin
    axis: [number, number, number]
    axisOffset?: [number, number, number]
    limits?: JointLimits
  }): { ok: true; joint: URDFJoint } | { ok: false; reason: string } {
    const err = validateJoint(config.parentLinkId, config.childLinkId)
    if (err) return { ok: false, reason: err }

    const id = `joint_${_nextJointId++}`
    const joint: URDFJoint = {
      id,
      name: config.name || `Joint_${_nextJointId - 1}`,
      type: config.type,
      parentLinkId: config.parentLinkId,
      childLinkId: config.childLinkId,
      origin: config.origin,
      axis: config.axis,
      axisOffset: config.axisOffset || [0, 0, 0],
      limits: config.limits || (
        config.type === 'prismatic'
          ? { lower: -100, upper: 100, effort: 100, velocity: 100 }
          : { lower: -3.14159, upper: 3.14159, effort: 10, velocity: 1 }
      ),
      currentValue: 0
    }
    robot.value.joints.push(joint)
    selectedJointId.value = id
    return { ok: true, joint }
  }

  function removeJoint(jointId: string): void {
    robot.value.joints = robot.value.joints.filter(j => j.id !== jointId)
    if (selectedJointId.value === jointId) {
      selectedJointId.value = null
    }
  }

  function updateJoint(jointId: string, updates: Partial<Omit<URDFJoint, 'id'>>): void {
    const joint = jointMap.value.get(jointId)
    if (joint) {
      Object.assign(joint, updates)
    }
  }

  function setJointValue(jointId: string, value: number): void {
    const joint = jointMap.value.get(jointId)
    if (joint) {
      joint.currentValue = Math.max(joint.limits.lower, Math.min(joint.limits.upper, value))
    }
  }

  function resetJoints(): void {
    robot.value.joints.forEach(j => { j.currentValue = 0 })
  }

  function randomizeJoints(): void {
    robot.value.joints.forEach(j => {
      if (j.type !== 'fixed') {
        j.currentValue = j.limits.lower + Math.random() * (j.limits.upper - j.limits.lower)
      }
    })
  }

  function setLinkInertial(linkId: string, inertial: InertialParams): void {
    const link = linkMap.value.get(linkId)
    if (link) {
      link.inertial = inertial
    }
  }

  function setLinkSolidMasses(linkId: string, masses: Record<string, number>): void {
    const link = linkMap.value.get(linkId)
    if (link) {
      link.solidMasses = { ...masses }
    }
  }

  function startBindingMode(linkId: string): void {
    bindingMode.value = { active: true, targetLinkId: linkId }
  }

  function stopBindingMode(): void {
    bindingMode.value = { active: false, targetLinkId: null }
  }

  function importRobot(imported: URDFRobot): void {
    if (!imported.links.some(l => l.name === 'base_link')) {
      imported.links.unshift({
        id: BASE_LINK_ID,
        name: 'base_link',
        solidIds: [],
        inertial: null,
      })
    }
    robot.value = imported
    selectedLinkId.value = null
    selectedJointId.value = null
    baseLinkOrigin.value = null
    basePickMode.value = false
    _nextLinkId = imported.links.length + 1
    _nextJointId = imported.joints.length + 1
  }

  function findOrphanLinks(): string[] {
    const childIds = new Set(robot.value.joints.map(j => j.childLinkId))
    return robot.value.links
      .filter(l => !isBaseLink(l.id) && !childIds.has(l.id))
      .map(l => l.name)
  }

  function clearAll(): void {
    robot.value = {
      name: 'robot',
      links: [
        { id: BASE_LINK_ID, name: 'base_link', solidIds: [], inertial: null }
      ],
      joints: []
    }
    selectedLinkId.value = null
    selectedJointId.value = null
    bindingMode.value = { active: false, targetLinkId: null }
    jointWizardVisible.value = false
    jointWizardStep.value = 'select-links'
    edgePickEditJointId.value = null
    baseLinkOrigin.value = null
    baseLinkRPY.value = null
    basePickMode.value = false
    showFrames.value = true
    axisHelperScale.value = 1.0
    linkWorldTransforms.value = new Map()
    exporting.value = false
    exportProgress.value = ''
    _nextLinkId = 1
    _nextJointId = 1
  }

  return {
    BASE_LINK_ID,

    robot,
    selectedLinkId,
    selectedJointId,
    bindingMode,
    jointWizardVisible,
    jointWizardStep,
    edgePickEditJointId,
    showFrames,
    urdfEditorVisible,
    exporting,
    exportProgress,
    linkWorldTransforms,
    axisHelperScale,
    basePickMode,
    baseLinkOrigin,
    baseLinkRPY,
    totalMass,

    linkMap,
    jointMap,
    linkByName,
    childJointMap,
    parentJointMap,
    rootLinks,
    leafLinks,
    activeJoints,
    boundSolidIds,
    treeData,

    isBaseLink,
    addLink,
    removeLink,
    renameLink,
    renameJoint,
    bindSolid,
    unbindSolid,

    validateJoint,
    addJoint,
    removeJoint,
    updateJoint,
    setJointValue,
    resetJoints,
    randomizeJoints,

    setLinkInertial,
    setLinkSolidMasses,

    startBindingMode,
    stopBindingMode,

    findOrphanLinks,

    importRobot,
    clearAll
  }
})
