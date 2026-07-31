import { inject, provide, type InjectionKey } from "vue";
import type { SerializedSolidData, SerializedTreeNode } from "../../types";
import type { SceneManager, SelectionManager, StepLoader } from "../../core";
import { buildFlatTree, mergeSolidData } from "../../core/MeshSplitter";
import { splitSolidData } from "../../core/useMeshImportWorker";
import { computePerSolidInertia } from "../../core/useInertiaWorker";
import { recomputeLinkInertial, type SolidGeom } from "../../core/InertiaModel";
import type { MeshImportOptions } from "../../core/MeshImportWorker";
import { useStepViewerStore } from "../../stores/useStepViewerStore";
import { useURDFStore } from "../../stores/useURDFStore";

export interface GeometryEditDeps {
  getStepLoader: () => StepLoader | null;
  getSceneManager: () => SceneManager | null;
  getSelectionManager: () => SelectionManager | null;
  disposeUrdfModules: () => void;
  initUrdfModules: () => void;
  onGeometryChanged?: (solids: SerializedSolidData[], tree: SerializedTreeNode) => void;
}

export interface RebuildOptions {
  fitView?: boolean;
  treeName?: string;
  tree?: SerializedTreeNode | null;
}

export interface SplitResult {
  parts: number;
  sourceName: string;
}

export interface MergeResult {
  merged: number;
  name: string;
  solidId: string;
}

export interface GeometryEditApi {
  hasGeometry: () => boolean;
  currentSolidData: () => SerializedSolidData[];
  rebuild: (dataList: SerializedSolidData[], options?: RebuildOptions) => SerializedTreeNode;
  splitSolids: (solidIds: string[], options?: MeshImportOptions) => Promise<SplitResult[]>;
  mergeSolids: (solidIds: string[], name?: string) => Promise<MergeResult>;
  replaceGeometry: (
    dataList: SerializedSolidData[],
    options?: RebuildOptions & { keepStructure?: boolean; autoBind?: boolean },
  ) => { bound: number; unmatched: string[] };
  appendGeometry: (dataList: SerializedSolidData[], options?: RebuildOptions) => void;
}

export const GEOMETRY_EDIT_KEY: InjectionKey<GeometryEditApi> = Symbol("geometryEdit");

export function useGeometryEdit(deps: GeometryEditDeps): GeometryEditApi {
  const store = useStepViewerStore();
  const urdfStore = useURDFStore();

  function currentSolidData(): SerializedSolidData[] {
    const list: SerializedSolidData[] = [];
    for (const solid of store.solids) {
      if (solid.serializedData) list.push(solid.serializedData);
    }
    return list;
  }

  function hasGeometry(): boolean {
    return store.solids.length > 0 && store.solids.every((s) => !!s.serializedData);
  }

  function rebuild(dataList: SerializedSolidData[], options?: RebuildOptions): SerializedTreeNode {
    const loader = deps.getStepLoader();
    const sceneManager = deps.getSceneManager();
    if (!loader || !sceneManager) throw new Error("渲染器尚未就绪");

    const tree =
      options?.tree ??
      buildFlatTree(
        options?.treeName || store.currentFileName || "Model",
        dataList.map((d, i) => d.name || `Solid_${i}`),
      );

    deps.disposeUrdfModules();
    sceneManager.clearModels();

    const restored = loader.restoreScene(dataList, tree);
    sceneManager.addModel(restored.group);

    store.setSolids(restored.solids);
    store.setTreeNodes(restored.treeNodes);

    const selectionManager = deps.getSelectionManager();
    if (selectionManager) {
      selectionManager.clearSelection();
      selectionManager.setSolids(restored.solids);
      for (const solid of restored.solids) {
        if (!store.isSolidVisible(solid.id)) selectionManager.setVisibility(solid.id, false);
      }
      selectionManager.setOpacity(null, store.globalOpacity);
    }

    store.setSelectedFeatures([]);
    store.clearTreeSelection();

    deps.initUrdfModules();
    if (options?.fitView) sceneManager.fitToModel();
    sceneManager.markDirty();

    if (restored.solids.length === 0 || sceneManager.sceneTriangles === 0) {
      throw new Error("几何重建失败：没有生成任何可渲染的三角面");
    }

    deps.onGeometryChanged?.(dataList, tree);
    return tree;
  }

  function remapVisibility(mapping: Map<string, string[]>): void {
    const next = new Map<string, boolean>();
    for (const [oldId, visible] of store.solidVisibilityMap) {
      for (const id of mapping.get(oldId) ?? [oldId]) next.set(id, visible);
    }
    store.solidVisibilityMap = next;
  }

  async function splitSolids(
    solidIds: string[],
    options?: MeshImportOptions,
  ): Promise<SplitResult[]> {
    if (!hasGeometry()) throw new Error("部分实体缺少几何数据，无法拆解");

    const ordered = currentSolidData();
    const idOfIndex = store.solids.map((s) => s.id);
    const targets = new Set(solidIds);

    const nextData: SerializedSolidData[] = [];
    const mapping = new Map<string, string[]>();
    const results: SplitResult[] = [];

    for (let i = 0; i < ordered.length; i++) {
      const oldId = idOfIndex[i];
      const data = ordered[i];

      if (!targets.has(oldId)) {
        mapping.set(oldId, [`solid_${nextData.length}`]);
        nextData.push(data);
        continue;
      }

      const bound = urdfStore.boundSolidIds.has(oldId);
      const splitOptions: MeshImportOptions = bound
        ? { separateTouching: false, minTriangles: 0, ...options }
        : (options ?? {});

      const parts = await splitSolidData(data, splitOptions);
      if (parts.length <= 1) {
        mapping.set(oldId, [`solid_${nextData.length}`]);
        nextData.push(data);
        results.push({ parts: parts.length, sourceName: data.name });
        continue;
      }

      const newIds: string[] = [];
      for (const part of parts) {
        newIds.push(`solid_${nextData.length}`);
        nextData.push(part);
      }
      mapping.set(oldId, newIds);
      results.push({ parts: parts.length, sourceName: data.name });
    }

    const grew = nextData.length !== ordered.length;
    if (grew) {
      const volumeById = new Map<string, number>();
      try {
        const perSolid = await computePerSolidInertia(nextData);
        for (const r of perSolid) volumeById.set(`solid_${r.index}`, r.volume);
      } catch {}

      const { changedLinkIds } = urdfStore.remapSolidIds(mapping, { volumeById });
      remapVisibility(mapping);
      rebuild(nextData);
      await refreshLinkInertials(changedLinkIds);
    }

    return results;
  }

  async function mergeSolids(solidIds: string[], name?: string): Promise<MergeResult> {
    if (!hasGeometry()) throw new Error("部分实体缺少几何数据，无法合并");
    if (solidIds.length < 2) throw new Error("请至少选择两个 Solid");

    const ordered = currentSolidData();
    const idOfIndex = store.solids.map((s) => s.id);
    const targets = new Set(solidIds);

    const firstIndex = idOfIndex.findIndex((id) => targets.has(id));
    if (firstIndex < 0) throw new Error("未找到要合并的 Solid");

    const members = ordered.filter((_, i) => targets.has(idOfIndex[i]));
    if (members.length < 2) throw new Error("请至少选择两个有效的 Solid");

    const mergedName = name?.trim() || members[0].name || "Merged";
    const merged = mergeSolidData(members, mergedName);

    const nextData: SerializedSolidData[] = [];
    const mapping = new Map<string, string[]>();
    let mergedNewId = "";

    for (let i = 0; i < ordered.length; i++) {
      const oldId = idOfIndex[i];
      if (targets.has(oldId)) {
        if (i === firstIndex) {
          mergedNewId = `solid_${nextData.length}`;
          nextData.push(merged);
        }
        mapping.set(oldId, [mergedNewId]);
        continue;
      }
      mapping.set(oldId, [`solid_${nextData.length}`]);
      nextData.push(ordered[i]);
    }

    const { changedLinkIds } = urdfStore.remapSolidIds(mapping);
    remapVisibility(mapping);
    rebuild(nextData);
    await refreshLinkInertials(changedLinkIds);

    return { merged: members.length, name: mergedName, solidId: mergedNewId };
  }

  async function refreshLinkInertials(linkIds: string[]): Promise<void> {
    for (const linkId of linkIds) {
      const link = urdfStore.linkMap.get(linkId);
      if (!link || link.solidIds.length === 0) continue;

      const geoms: SolidGeom[] = [];
      for (const solidId of link.solidIds) {
        const solid = store.solidMap.get(solidId);
        if (solid?.serializedData) {
          geoms.push({ solidId, name: solid.name, data: solid.serializedData });
        }
      }
      if (geoms.length === 0) continue;

      try {
        const update = await recomputeLinkInertial(link, geoms);
        if (!update) continue;
        urdfStore.setLinkInertial(linkId, update.inertial);
        urdfStore.setLinkSolidMasses(linkId, update.solidMasses);
      } catch {}
    }
  }

  function replaceGeometry(
    dataList: SerializedSolidData[],
    options?: RebuildOptions & { keepStructure?: boolean; autoBind?: boolean },
  ): { bound: number; unmatched: string[] } {
    if (dataList.length === 0) throw new Error("没有可用的几何数据");

    if (options?.keepStructure) {
      urdfStore.clearSolidBindings();
    } else {
      urdfStore.clearAll();
    }

    store.solidVisibilityMap = new Map();
    rebuild(dataList, { fitView: true, ...options });

    if (options?.keepStructure && options.autoBind !== false) {
      const result = urdfStore.bindSolidsByName(
        store.solids.map((s) => ({ id: s.id, name: s.name })),
      );
      return { bound: result.bound, unmatched: result.unmatchedSolids };
    }

    return { bound: 0, unmatched: [] };
  }

  function appendGeometry(dataList: SerializedSolidData[], options?: RebuildOptions): void {
    if (dataList.length === 0) return;
    const ordered = currentSolidData();
    const mapping = new Map<string, string[]>();
    store.solids.forEach((solid, index) => mapping.set(solid.id, [`solid_${index}`]));
    urdfStore.remapSolidIds(mapping);
    rebuild([...ordered, ...dataList], options);
  }

  const api: GeometryEditApi = {
    hasGeometry,
    currentSolidData,
    rebuild,
    splitSolids,
    mergeSolids,
    replaceGeometry,
    appendGeometry,
  };

  provide(GEOMETRY_EDIT_KEY, api);
  return api;
}

export function useGeometryEditApi(): GeometryEditApi | null {
  return inject(GEOMETRY_EDIT_KEY, null);
}
