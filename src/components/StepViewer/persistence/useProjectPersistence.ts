import { ref, shallowRef, watch, onBeforeUnmount, type Ref } from "vue";
import type { CameraConfig, SerializedSolidData, SerializedTreeNode } from "../types";
import { useStepViewerStore } from "../stores/useStepViewerStore";
import { useURDFStore } from "../stores/useURDFStore";
import {
  deleteProjectRecord,
  findLatestDraft,
  getProject,
  listProjects,
  newProjectId,
  promoteProject,
  renameProjectRecord,
  upsertProject,
} from "./db";
import {
  deleteProjectDir,
  isOpfsAvailable,
  projectDirSize,
  readProjectBytes,
  readProjectFile,
  readProjectText,
  requestPersistence,
  sha256Hex,
  withProjectLock,
  writeProjectBytes,
  writeProjectStream,
} from "./opfs";
import { decodeGeometryCache, encodeGeometryCache } from "./geometryCache";
import { packProject, saveProjectFile, unpackProject } from "./projectFile";
import {
  applyUrdfSection,
  applyViewportSection,
  captureSnapshot,
  computeStats,
  fromCameraSection,
} from "./snapshot";
import { ProjectFormatError, type ProjectRecord, type ProjectSnapshot } from "./types";

const FILE_STEP = "model.step";
const FILE_GEOMETRY = "geometry.bin";
const FILE_SNAPSHOT = "snapshot.json";
const FILE_THUMBNAIL = "thumb.png";
const AUTOSAVE_DEBOUNCE_MS = 2000;

export interface PersistenceHost {
  getCamera(): CameraConfig | null;
  setCamera(config: Partial<CameraConfig>): void;
  captureThumbnail(): Promise<Blob | null>;
  parseStep(bytes: Uint8Array, fileName: string): Promise<{
    solids: SerializedSolidData[];
    tree: SerializedTreeNode | null;
  }>;
  rebuildScene(
    solids: SerializedSolidData[],
    tree: SerializedTreeNode | null,
  ): Promise<void>;
  clearWorkspace(): void;
  onStatus?: (message: string, percent: number) => void;
}

export interface ProjectContext {
  id: string;
  createdAt: string;
  sourceFileName: string;
  sourceFileSize: number;
  sourceHash: string;
  name: string;
  autosave: boolean;
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "project";
}

export function useProjectPersistence(host: PersistenceHost) {
  const viewer = useStepViewerStore();
  const urdf = useURDFStore();

  const available = ref(isOpfsAvailable());
  const context = shallowRef<ProjectContext | null>(null);
  const projects = ref<ProjectRecord[]>([]);
  const draft = ref<ProjectRecord | null>(null);
  const saving = ref(false);
  const lastSavedAt = ref<number | null>(null);
  const busy = ref(false);
  const suspended = ref(false);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingSave = false;

  async function refreshList(): Promise<void> {
    if (!available.value) return;
    try {
      projects.value = await listProjects();
    } catch {
      projects.value = [];
    }
  }

  async function detectDraft(): Promise<ProjectRecord | null> {
    if (!available.value) return null;
    try {
      draft.value = (await findLatestDraft()) ?? null;
    } catch {
      draft.value = null;
    }
    return draft.value;
  }

  function buildSnapshot(): ProjectSnapshot | null {
    const ctx = context.value;
    if (!ctx) return null;
    return captureSnapshot(viewer, urdf, {
      name: ctx.name,
      createdAt: ctx.createdAt,
      sourceFileName: ctx.sourceFileName,
      sourceFileSize: ctx.sourceFileSize,
      sourceHash: ctx.sourceHash,
      camera: host.getCamera(),
    });
  }

  async function writeSnapshot(ctx: ProjectContext): Promise<void> {
    const snapshot = buildSnapshot();
    if (!snapshot) return;

    await withProjectLock(ctx.id, async () => {
      await writeProjectBytes(ctx.id, FILE_SNAPSHOT, JSON.stringify(snapshot));
    });

    const existing = await getProject(ctx.id);
    await upsertProject({
      id: ctx.id,
      name: ctx.name,
      sourceFileName: ctx.sourceFileName,
      sourceFileSize: ctx.sourceFileSize,
      sourceHash: ctx.sourceHash,
      createdAt: existing?.createdAt ?? (Date.parse(ctx.createdAt) || Date.now()),
      updatedAt: Date.now(),
      stats: computeStats(viewer, urdf),
      thumbnail: existing?.thumbnail,
      autosave: ctx.autosave,
    });

    lastSavedAt.value = Date.now();
  }

  async function flushSave(): Promise<void> {
    if (!available.value || suspended.value) return;
    const ctx = context.value;
    if (!ctx) return;
    if (saving.value) {
      pendingSave = true;
      return;
    }

    saving.value = true;
    try {
      await writeSnapshot(ctx);
      await refreshList();
    } catch (error) {
      console.warn("自动保存失败:", error);
    } finally {
      saving.value = false;
      if (pendingSave) {
        pendingSave = false;
        void flushSave();
      }
    }
  }

  function scheduleSave(): void {
    if (!available.value || suspended.value || !context.value) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void flushSave();
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  async function beginProject(file: File): Promise<ProjectContext | null> {
    if (!available.value) return null;

    void requestPersistence();

    const id = newProjectId();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const hash = await sha256Hex(bytes);

    const ctx: ProjectContext = {
      id,
      createdAt: new Date().toISOString(),
      sourceFileName: file.name,
      sourceFileSize: file.size,
      sourceHash: hash,
      name: baseName(file.name),
      autosave: true,
    };

    await withProjectLock(id, async () => {
      await writeProjectBytes(id, FILE_STEP, bytes);
    });

    context.value = ctx;
    return ctx;
  }

  async function cacheGeometry(
    solids: SerializedSolidData[],
    tree: SerializedTreeNode | null,
  ): Promise<void> {
    const ctx = context.value;
    if (!ctx || !available.value) return;
    try {
      const blob = encodeGeometryCache(solids, tree);
      await withProjectLock(ctx.id, async () => {
        await writeProjectStream(ctx.id, FILE_GEOMETRY, blob.stream());
      });
    } catch (error) {
      console.warn("几何缓存写入失败:", error);
    }
  }

  async function saveThumbnail(): Promise<void> {
    const ctx = context.value;
    if (!ctx || !available.value) return;
    try {
      const blob = await host.captureThumbnail();
      if (!blob) return;
      await writeProjectBytes(ctx.id, FILE_THUMBNAIL, blob);
      const existing = await getProject(ctx.id);
      if (existing) await upsertProject({ ...existing, thumbnail: blob });
      await refreshList();
    } catch {}
  }

  async function saveProject(name?: string): Promise<boolean> {
    const ctx = context.value;
    if (!ctx || !available.value) return false;

    const finalName = (name ?? ctx.name).trim() || ctx.name;
    context.value = { ...ctx, name: finalName, autosave: false };

    busy.value = true;
    try {
      await writeSnapshot(context.value);
      await promoteProject(ctx.id, finalName);
      await saveThumbnail();
      await refreshList();
      await detectDraft();
      return true;
    } finally {
      busy.value = false;
    }
  }

  async function openProject(id: string): Promise<boolean> {
    if (!available.value) return false;

    const record = await getProject(id);
    if (!record) throw new Error("项目记录不存在");

    busy.value = true;
    suspended.value = true;
    try {
      host.onStatus?.("正在读取项目...", 10);
      const snapshotText = await readProjectText(id, FILE_SNAPSHOT);
      if (!snapshotText) throw new Error("项目数据缺失，可能已被浏览器清理");

      const snapshot: ProjectSnapshot = JSON.parse(snapshotText);

      host.clearWorkspace();

      host.onStatus?.("正在加载几何缓存...", 30);
      const cacheFile = await readProjectFile(id, FILE_GEOMETRY);
      let solids: SerializedSolidData[] | null = null;
      let tree: SerializedTreeNode | null = null;

      if (cacheFile) {
        const decoded = decodeGeometryCache(await cacheFile.arrayBuffer());
        if (decoded) {
          solids = decoded.solids;
          tree = decoded.tree;
        }
      }

      if (!solids) {
        host.onStatus?.("几何缓存不可用，正在重新解析 STEP...", 40);
        const stepBytes = await readProjectBytes(id, FILE_STEP);
        if (!stepBytes) throw new Error("项目中的 STEP 数据缺失");
        const parsed = await host.parseStep(stepBytes, record.sourceFileName);
        solids = parsed.solids;
        tree = parsed.tree;
      }

      host.onStatus?.("正在重建场景...", 75);
      viewer.setFileName(record.sourceFileName);
      await host.rebuildScene(solids, tree);

      applyUrdfSection(urdf, snapshot);
      applyViewportSection(viewer, snapshot);

      const camera = fromCameraSection(snapshot.viewport.camera);
      if (camera) host.setCamera(camera);

      context.value = {
        id,
        createdAt: snapshot.manifest.createdAt,
        sourceFileName: record.sourceFileName,
        sourceFileSize: record.sourceFileSize,
        sourceHash: record.sourceHash,
        name: record.name,
        autosave: record.autosave,
      };

      if (!cacheFile && solids) void cacheGeometry(solids, tree);

      host.onStatus?.("加载完成", 100);
      return true;
    } finally {
      suspended.value = false;
      busy.value = false;
    }
  }

  async function importProjectFile(file: Blob): Promise<boolean> {
    const loaded = await unpackProject(file);

    busy.value = true;
    suspended.value = true;
    try {
      void requestPersistence();

      host.clearWorkspace();
      host.onStatus?.("正在解析项目中的 STEP 模型...", 20);

      const { snapshot, stepBytes } = loaded;
      const parsed = await host.parseStep(stepBytes, snapshot.manifest.sourceFileName);

      host.onStatus?.("正在重建场景...", 75);
      viewer.setFileName(snapshot.manifest.sourceFileName);
      await host.rebuildScene(parsed.solids, parsed.tree);

      applyUrdfSection(urdf, snapshot);
      applyViewportSection(viewer, snapshot);

      const camera = fromCameraSection(snapshot.viewport.camera);
      if (camera) host.setCamera(camera);

      const id = newProjectId();
      context.value = {
        id,
        createdAt: snapshot.manifest.createdAt,
        sourceFileName: snapshot.manifest.sourceFileName,
        sourceFileSize: snapshot.manifest.sourceFileSize,
        sourceHash: snapshot.manifest.sourceHash,
        name: snapshot.manifest.name,
        autosave: false,
      };

      if (available.value) {
        await withProjectLock(id, async () => {
          await writeProjectBytes(id, FILE_STEP, stepBytes as BlobPart);
        });
        await writeSnapshot(context.value);
        void cacheGeometry(parsed.solids, parsed.tree);
        if (loaded.thumbnail) {
          await writeProjectBytes(id, FILE_THUMBNAIL, loaded.thumbnail);
          const existing = await getProject(id);
          if (existing) await upsertProject({ ...existing, thumbnail: loaded.thumbnail });
        }
        await refreshList();
      }

      host.onStatus?.("加载完成", 100);
      return true;
    } finally {
      suspended.value = false;
      busy.value = false;
    }
  }

  async function exportProjectFile(): Promise<boolean> {
    const ctx = context.value;
    const snapshot = buildSnapshot();
    if (!ctx || !snapshot) throw new Error("当前没有可导出的项目");

    busy.value = true;
    try {
      const stepBytes = available.value ? await readProjectBytes(ctx.id, FILE_STEP) : null;
      if (!stepBytes) throw new Error("找不到原始 STEP 数据，无法导出自包含项目文件");

      const thumbnail = (await host.captureThumbnail()) ?? undefined;
      const blob = await packProject(snapshot, stepBytes, thumbnail);
      return await saveProjectFile(blob, ctx.name);
    } finally {
      busy.value = false;
    }
  }

  async function removeProject(id: string): Promise<void> {
    await deleteProjectRecord(id);
    await deleteProjectDir(id);
    if (context.value?.id === id) context.value = null;
    await refreshList();
    await detectDraft();
  }

  async function renameProject(id: string, name: string): Promise<void> {
    await renameProjectRecord(id, name);
    if (context.value?.id === id) context.value = { ...context.value, name };
    await refreshList();
  }

  async function discardDraft(): Promise<void> {
    if (!draft.value) return;
    await removeProject(draft.value.id);
    draft.value = null;
  }

  async function measureProject(id: string): Promise<number> {
    return projectDirSize(id);
  }

  const stopWatch = watch(
    () => [
      urdf.robot,
      urdf.collisionConfig,
      urdf.collisionOverrides,
      urdf.totalMass,
      urdf.exportFormat,
      urdf.baseLinkOrigin,
      urdf.baseLinkRPY,
      viewer.modelRotationElements,
    ],
    () => scheduleSave(),
    { deep: true },
  );

  function handleBeforeUnload(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
      void flushSave();
    }
  }

  if (typeof window !== "undefined") {
    window.addEventListener("beforeunload", handleBeforeUnload);
  }

  onBeforeUnmount(() => {
    stopWatch();
    if (debounceTimer) clearTimeout(debounceTimer);
    if (typeof window !== "undefined") {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    }
  });

  return {
    available,
    context: context as Ref<ProjectContext | null>,
    projects,
    draft,
    saving,
    busy,
    lastSavedAt,

    refreshList,
    detectDraft,
    beginProject,
    cacheGeometry,
    saveThumbnail,
    saveProject,
    openProject,
    importProjectFile,
    exportProjectFile,
    removeProject,
    renameProject,
    discardDraft,
    measureProject,
    flushSave,
    ProjectFormatError,
  };
}
