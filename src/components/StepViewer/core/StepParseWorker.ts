import * as Comlink from "comlink";
import type {
  WorkerRequest,
  WorkerResponse,
  SerializedSolidData,
  SerializedTreeNode,
  SolidMassProps,
  FaceGroupInfo,
  FaceGeometryData,
  EdgeGroupInfo,
  EdgeGeometryData,
} from "../types";

const MESH_BATCH_SIZE = 32;
const DEFLECTION_RATIO = 5e-4;
const DEFLECTION_MIN = 0.02;
const DEFLECTION_MAX = 1.0;
const ANGULAR_DEFLECTION = 0.5;

let oc: any = null;
let progressCb: ProgressCallback | null = null;

export type ProgressCallback = (stage: string, percent: number) => void;

function post(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (msg.type === "progress" && progressCb) {
    try {
      progressCb(msg.stage, msg.percent);
    } catch {}
  }
  if (transfer && transfer.length > 0) {
    (self as unknown as Worker).postMessage(msg, transfer);
  } else {
    self.postMessage(msg);
  }
}

async function initOC(): Promise<any> {
  if (oc) return oc;

  post({ type: "progress", stage: "正在加载 OpenCascade WASM 引擎...", percent: 5 });

  try {
    const initOpenCascade = (await import("opencascade.js")).default;
    oc = await initOpenCascade();
    return oc;
  } catch (error) {
    throw new Error(
      `OpenCascade WASM 初始化失败: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function withGC<T>(fn: (register: <O>(obj: O) => O) => T): T {
  const toDelete: any[] = [];
  const register = <O>(obj: O): O => {
    toDelete.push(obj);
    return obj;
  };
  try {
    return fn(register);
  } finally {
    for (let i = toDelete.length - 1; i >= 0; i--) {
      const obj = toDelete[i];
      try {
        if (obj && typeof obj.delete === "function") obj.delete();
      } catch {}
    }
  }
}

function readStepFile(fileBuffer: ArrayBuffer): any {
  return withGC((r) => {
    const fileName = "model.step";

    oc.FS.createDataFile("/", fileName, new Uint8Array(fileBuffer), true, true, true);

    post({ type: "progress", stage: "正在读取 STEP 文件...", percent: 15 });

    const reader = r(new oc.STEPControl_Reader_1());
    const readResult = reader.ReadFile(fileName);

    try {
      oc.FS.unlink(`/${fileName}`);
    } catch {}

    if (readResult !== oc.IFSelect_ReturnStatus.IFSelect_RetDone) {
      throw new Error("STEP 文件读取失败，请检查文件是否损坏");
    }

    post({ type: "progress", stage: "正在转换模型数据...", percent: 25 });

    reader.TransferRoots(r(new oc.Message_ProgressRange_1()));

    return reader.OneShape();
  });
}

function computeDeflection(shape: any): number {
  return withGC((r) => {
    try {
      const box = r(new oc.Bnd_Box_1());
      oc.BRepBndLib.Add(shape, box, false);
      if (box.IsVoid()) return DEFLECTION_MIN;
      const lo = r(box.CornerMin());
      const hi = r(box.CornerMax());
      const diag = Math.hypot(hi.X() - lo.X(), hi.Y() - lo.Y(), hi.Z() - lo.Z());
      if (!isFinite(diag) || diag <= 0) return DEFLECTION_MIN;
      return Math.min(Math.max(diag * DEFLECTION_RATIO, DEFLECTION_MIN), DEFLECTION_MAX);
    } catch {
      return DEFLECTION_MIN;
    }
  });
}

function computeMassProps(solidShape: any): SolidMassProps | undefined {
  return withGC((r) => {
    try {
      const props = r(new oc.GProp_GProps_1());
      oc.BRepGProp.VolumeProperties_1(solidShape, props, true, false, false);

      const volume = props.Mass();
      if (!isFinite(volume) || volume <= 0) return undefined;

      const centre = r(props.CentreOfMass());
      const cx = centre.X(),
        cy = centre.Y(),
        cz = centre.Z();
      if (!isFinite(cx) || !isFinite(cy) || !isFinite(cz)) return undefined;

      const m = r(props.MatrixOfInertia());
      const ixx = m.Value(1, 1),
        iyy = m.Value(2, 2),
        izz = m.Value(3, 3);
      const ixy = m.Value(1, 2),
        ixz = m.Value(1, 3),
        iyz = m.Value(2, 3);
      if (!isFinite(ixx) || !isFinite(iyy) || !isFinite(izz)) return undefined;

      const s = 1e-15;
      return {
        volume,
        com: [cx, cy, cz],
        inertiaAtCom: [ixx * s, ixy * s, ixz * s, iyy * s, iyz * s, izz * s],
      };
    } catch {
      return undefined;
    }
  });
}

function extractFaceGeometry(face: any): FaceGeometryData {
  return withGC((r) => {
    const adaptor = r(new oc.BRepAdaptor_Surface_2(face, false));
    const surfType = adaptor.GetType();
    const ga = oc.GeomAbs_SurfaceType;

    const result: FaceGeometryData = { type: "face" };

    try {
      if (surfType === ga.GeomAbs_Plane) {
        result.type = "plane";
        const plane = r(adaptor.Plane());
        const loc = r(plane.Location());
        const dir = r(r(plane.Axis()).Direction());
        result.center = [loc.X(), loc.Y(), loc.Z()];
        result.normal = [dir.X(), dir.Y(), dir.Z()];
      } else if (surfType === ga.GeomAbs_Cylinder) {
        const cyl = r(adaptor.Cylinder());
        const ax = r(cyl.Axis());
        const loc = r(ax.Location());
        const dir = r(ax.Direction());
        result.center = [loc.X(), loc.Y(), loc.Z()];
        result.axis = [dir.X(), dir.Y(), dir.Z()];
        result.normal = [dir.X(), dir.Y(), dir.Z()];
        result.radius = cyl.Radius();

        const uMin = adaptor.FirstUParameter();
        const uMax = adaptor.LastUParameter();
        const vMin = adaptor.FirstVParameter();
        const vMax = adaptor.LastVParameter();
        result.uBounds = [uMin, uMax];
        result.vBounds = [vMin, vMax];
        result.startAngle = uMin;
        result.endAngle = uMax;

        if (isFinite(vMin) && isFinite(vMax)) {
          result.height = Math.abs(vMax - vMin);
        }

        result.type = Math.abs(uMax - uMin) < Math.PI * 1.99 ? "arc" : "cylinder";
      } else if (surfType === ga.GeomAbs_Cone) {
        result.type = "cone";
        const cone = r(adaptor.Cone());
        const apex = r(cone.Apex());
        const dir = r(r(cone.Axis()).Direction());
        result.center = [apex.X(), apex.Y(), apex.Z()];
        result.axis = [dir.X(), dir.Y(), dir.Z()];
        result.normal = [dir.X(), dir.Y(), dir.Z()];
        result.semiAngle = cone.SemiAngle();
        result.radius = cone.RefRadius();
      } else if (surfType === ga.GeomAbs_Sphere) {
        result.type = "sphere";
        const sphere = r(adaptor.Sphere());
        const center = r(sphere.Location());
        result.center = [center.X(), center.Y(), center.Z()];
        result.radius = sphere.Radius();
      } else if (surfType === ga.GeomAbs_Torus) {
        result.type = "torus";
        const torus = r(adaptor.Torus());
        const center = r(torus.Location());
        const dir = r(r(torus.Axis()).Direction());
        result.center = [center.X(), center.Y(), center.Z()];
        result.axis = [dir.X(), dir.Y(), dir.Z()];
        result.normal = [dir.X(), dir.Y(), dir.Z()];
        result.majorRadius = torus.MajorRadius();
        result.minorRadius = torus.MinorRadius();
        result.radius = torus.MajorRadius();
      }
    } catch {
      result.type = "face";
    }

    return result;
  });
}

function checkCircularPlaneFace(
  positions: Float32Array,
  startVertex: number,
  vertexCount: number,
): FaceGeometryData | null {
  if (vertexCount < 6) return null;

  let cx = 0,
    cy = 0,
    cz = 0;
  for (let i = 0; i < vertexCount; i++) {
    const vi = (startVertex + i) * 3;
    cx += positions[vi];
    cy += positions[vi + 1];
    cz += positions[vi + 2];
  }
  cx /= vertexCount;
  cy /= vertexCount;
  cz /= vertexCount;

  let sumDist = 0;
  for (let i = 0; i < vertexCount; i++) {
    const vi = (startVertex + i) * 3;
    sumDist += Math.hypot(positions[vi] - cx, positions[vi + 1] - cy, positions[vi + 2] - cz);
  }
  const avgDist = sumDist / vertexCount;
  if (avgDist < 0.001) return null;

  const tolerance = avgDist * 0.1;
  for (let i = 0; i < vertexCount; i++) {
    const vi = (startVertex + i) * 3;
    const d = Math.hypot(positions[vi] - cx, positions[vi + 1] - cy, positions[vi + 2] - cz);
    if (Math.abs(d - avgDist) >= tolerance) return null;
  }

  return { type: "circle", center: [cx, cy, cz], radius: avgDist };
}

function extractEdgeGeometry(edge: any): EdgeGeometryData {
  return withGC((r) => {
    const adaptor = r(new oc.BRepAdaptor_Curve_2(edge));
    const curveTypeEnum = adaptor.GetType();
    const ga = oc.GeomAbs_CurveType;

    let curveType = "other";
    let radius: number | undefined;
    let center: number[] | undefined;
    let axis: number[] | undefined;

    try {
      if (curveTypeEnum === ga.GeomAbs_Line) {
        curveType = "line";
      } else if (curveTypeEnum === ga.GeomAbs_Circle) {
        curveType = "circle";
        const circ = r(adaptor.Circle());
        radius = circ.Radius();
        const c = r(circ.Location());
        center = [c.X(), c.Y(), c.Z()];
        const dir = r(r(circ.Axis()).Direction());
        axis = [dir.X(), dir.Y(), dir.Z()];
      } else if (curveTypeEnum === ga.GeomAbs_Ellipse) {
        curveType = "ellipse";
      } else if (curveTypeEnum === ga.GeomAbs_BSplineCurve) {
        curveType = "bspline";
      } else if (curveTypeEnum === ga.GeomAbs_BezierCurve) {
        curveType = "bezier";
      }
    } catch {}

    const uFirst = adaptor.FirstParameter();
    const uLast = adaptor.LastParameter();

    let startPoint: number[] = [0, 0, 0];
    let endPoint: number[] = [0, 0, 0];
    try {
      const pStart = r(new oc.gp_Pnt_1());
      adaptor.D0(uFirst, pStart);
      startPoint = [pStart.X(), pStart.Y(), pStart.Z()];

      const pEnd = r(new oc.gp_Pnt_1());
      adaptor.D0(uLast, pEnd);
      endPoint = [pEnd.X(), pEnd.Y(), pEnd.Z()];
    } catch {}

    let length = 0;
    try {
      length = oc.GCPnts_AbscissaPoint.Length_3(adaptor);
    } catch {
      length = Math.hypot(
        endPoint[0] - startPoint[0],
        endPoint[1] - startPoint[1],
        endPoint[2] - startPoint[2],
      );
    }

    return {
      curveType,
      length: isFinite(length) ? length : 0,
      startPoint,
      endPoint,
      radius,
      center,
      axis,
      startAngle: uFirst,
      endAngle: uLast,
    };
  });
}

function discretizeEdge(edge: any): Float32Array | null {
  return withGC((r) => {
    const adaptor = r(new oc.BRepAdaptor_Curve_2(edge));

    try {
      const deflector = r(new oc.GCPnts_TangentialDeflection_2(adaptor, 0.1, 0.1, 2, 200, 0.0001));
      const nbPoints = deflector.NbPoints();
      if (nbPoints < 2) return null;
      const out = new Float32Array(nbPoints * 3);
      for (let i = 1; i <= nbPoints; i++) {
        const p = deflector.Value(i);
        const o = (i - 1) * 3;
        out[o] = p.X();
        out[o + 1] = p.Y();
        out[o + 2] = p.Z();
        p.delete();
      }
      return out;
    } catch {}

    try {
      const uFirst = adaptor.FirstParameter();
      const uLast = adaptor.LastParameter();
      const nbSamples = 20;
      const out = new Float32Array((nbSamples + 1) * 3);
      const p = r(new oc.gp_Pnt_1());
      for (let i = 0; i <= nbSamples; i++) {
        adaptor.D0(uFirst + ((uLast - uFirst) * i) / nbSamples, p);
        const o = i * 3;
        out[o] = p.X();
        out[o + 1] = p.Y();
        out[o + 2] = p.Z();
      }
      return out;
    } catch {
      return null;
    }
  });
}

function extractEdgesFromSolid(solidShape: any): {
  edgeGroups: EdgeGroupInfo[];
  edgeGeometries: EdgeGeometryData[];
  edgePolylines: Float32Array;
} {
  return withGC((r) => {
    const edgeGroups: EdgeGroupInfo[] = [];
    const edgeGeometries: EdgeGeometryData[] = [];
    const chunks: Float32Array[] = [];
    let totalFloats = 0;

    const edgeMap = r(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(solidShape, oc.TopAbs_ShapeEnum.TopAbs_EDGE, edgeMap);

    const edgeFaceMap = r(new oc.TopTools_IndexedDataMapOfShapeListOfShape_1());
    oc.TopExp.MapShapesAndAncestors(
      solidShape,
      oc.TopAbs_ShapeEnum.TopAbs_EDGE,
      oc.TopAbs_ShapeEnum.TopAbs_FACE,
      edgeFaceMap,
    );

    const faceMap = r(new oc.TopTools_IndexedMapOfShape_1());
    oc.TopExp.MapShapes_1(solidShape, oc.TopAbs_ShapeEnum.TopAbs_FACE, faceMap);

    const nbEdges = edgeMap.Extent();
    let polylineOffset = 0;

    for (let i = 1; i <= nbEdges; i++) {
      try {
        const key = r(edgeMap.FindKey(i));
        const edge = r(oc.TopoDS.Edge_1(key));

        if (oc.BRep_Tool.Degenerated(edge)) continue;

        const polyline = discretizeEdge(edge);
        if (!polyline || polyline.length < 6) continue;

        const geom = extractEdgeGeometry(edge);

        const adjacentFaceIndices: number[] = [];
        try {
          if (edgeFaceMap.Contains(key)) {
            const faceList = r(edgeFaceMap.FindFromKey(key));
            const iter = r(new oc.TopTools_ListIteratorOfListOfShape_2(faceList));
            for (; iter.More(); iter.Next()) {
              const faceIdx = faceMap.FindIndex(iter.Value());
              if (faceIdx > 0) adjacentFaceIndices.push(faceIdx - 1);
            }
          }
        } catch {}

        const polylineCount = polyline.length / 3;
        edgeGroups.push({
          edgeIndex: edgeGroups.length,
          polylineStart: polylineOffset,
          polylineCount,
          adjacentFaceIndices,
        });
        edgeGeometries.push(geom);
        chunks.push(polyline);
        totalFloats += polyline.length;
        polylineOffset += polylineCount;
      } catch {}
    }

    const edgePolylines = new Float32Array(totalFloats);
    let writeOffset = 0;
    for (const chunk of chunks) {
      edgePolylines.set(chunk, writeOffset);
      writeOffset += chunk.length;
    }

    return { edgeGroups, edgeGeometries, edgePolylines };
  });
}

function extractSingleSolid(solidShape: any, solidIndex: number): SerializedSolidData | null {
  return withGC((r) => {
    const faces: any[] = [];
    const faceExplorer = r(
      new oc.TopExp_Explorer_2(
        solidShape,
        oc.TopAbs_ShapeEnum.TopAbs_FACE,
        oc.TopAbs_ShapeEnum.TopAbs_SHAPE,
      ),
    );
    for (; faceExplorer.More(); faceExplorer.Next()) {
      faces.push(r(oc.TopoDS.Face_1(faceExplorer.Current())));
    }

    let totalNodes = 0;
    let totalTriangles = 0;
    const meshed: {
      face: any;
      tri: any;
      transformation: any;
      nbNodes: number;
      nbTriangles: number;
    }[] = [];

    for (const face of faces) {
      const location = r(new oc.TopLoc_Location_1());
      const handle = r(oc.BRep_Tool.Triangulation(face, location, 0));
      if (handle.IsNull()) continue;
      const tri = handle.get();
      const nbNodes = tri.NbNodes();
      const nbTriangles = tri.NbTriangles();
      if (nbNodes === 0 || nbTriangles === 0) continue;
      meshed.push({
        face,
        tri,
        transformation: r(location.Transformation()),
        nbNodes,
        nbTriangles,
      });
      totalNodes += nbNodes;
      totalTriangles += nbTriangles;
    }

    if (totalNodes === 0) return null;

    const positions = new Float32Array(totalNodes * 3);
    const normals = new Float32Array(totalNodes * 3);
    const indices = new Uint32Array(totalTriangles * 3);
    const faceGroups: FaceGroupInfo[] = [];
    const faceGeometries: FaceGeometryData[] = [];
    const normalScratch = r(new oc.gp_Vec3f_1());

    let vertexOffset = 0;
    let indexOffset = 0;

    for (const entry of meshed) {
      const { tri, transformation, nbNodes, nbTriangles } = entry;

      const a11 = transformation.Value(1, 1),
        a12 = transformation.Value(1, 2);
      const a13 = transformation.Value(1, 3),
        a14 = transformation.Value(1, 4);
      const a21 = transformation.Value(2, 1),
        a22 = transformation.Value(2, 2);
      const a23 = transformation.Value(2, 3),
        a24 = transformation.Value(2, 4);
      const a31 = transformation.Value(3, 1),
        a32 = transformation.Value(3, 2);
      const a33 = transformation.Value(3, 3),
        a34 = transformation.Value(3, 4);

      const isReversed = entry.face.Orientation_1() === oc.TopAbs_Orientation.TopAbs_REVERSED;

      for (let i = 1; i <= nbNodes; i++) {
        const node = tri.Node(i);
        const x = node.X(),
          y = node.Y(),
          z = node.Z();
        node.delete();
        const o = (vertexOffset + i - 1) * 3;
        positions[o] = a11 * x + a12 * y + a13 * z + a14;
        positions[o + 1] = a21 * x + a22 * y + a23 * z + a24;
        positions[o + 2] = a31 * x + a32 * y + a33 * z + a34;
      }

      if (tri.HasNormals()) {
        const sign = isReversed ? -1 : 1;
        for (let i = 1; i <= nbNodes; i++) {
          const o = (vertexOffset + i - 1) * 3;
          try {
            tri.Normal_2(i, normalScratch);
            const nx = normalScratch.x_1(),
              ny = normalScratch.y_1(),
              nz = normalScratch.z_1();
            let tx = a11 * nx + a12 * ny + a13 * nz;
            let ty = a21 * nx + a22 * ny + a23 * nz;
            let tz = a31 * nx + a32 * ny + a33 * nz;
            const len = Math.hypot(tx, ty, tz);
            if (len > 0) {
              tx /= len;
              ty /= len;
              tz /= len;
            }
            normals[o] = tx * sign;
            normals[o + 1] = ty * sign;
            normals[o + 2] = tz * sign;
          } catch {
            normals[o] = 0;
            normals[o + 1] = sign;
            normals[o + 2] = 0;
          }
        }
      }

      const groupStart = indexOffset;
      for (let i = 1; i <= nbTriangles; i++) {
        const triangle = tri.Triangle(i);
        let n1 = triangle.Value(1);
        let n2 = triangle.Value(2);
        const n3 = triangle.Value(3);
        triangle.delete();
        if (isReversed) {
          const tmp = n1;
          n1 = n2;
          n2 = tmp;
        }
        indices[indexOffset] = n1 - 1 + vertexOffset;
        indices[indexOffset + 1] = n2 - 1 + vertexOffset;
        indices[indexOffset + 2] = n3 - 1 + vertexOffset;
        indexOffset += 3;
      }

      faceGroups.push({
        start: groupStart,
        count: nbTriangles * 3,
        faceIndex: faceGeometries.length,
      });

      let geom = extractFaceGeometry(entry.face);
      if (geom.type === "plane") {
        const circleCheck = checkCircularPlaneFace(positions, vertexOffset, nbNodes);
        if (circleCheck) {
          circleCheck.normal = geom.normal;
          geom = circleCheck;
        }
      }
      faceGeometries.push(geom);

      vertexOffset += nbNodes;
    }

    const edgeData = extractEdgesFromSolid(solidShape);

    return {
      name: `Solid_${solidIndex}`,
      positions,
      normals,
      indices,
      faceGroups,
      faceGeometries,
      edgeGroups: edgeData.edgeGroups,
      edgeGeometries: edgeData.edgeGeometries,
      edgePolylines: edgeData.edgePolylines,
      massProps: computeMassProps(solidShape),
    };
  });
}

function getEdgeDisplayName(curveType: string): string {
  const names: Record<string, string> = {
    line: "直线",
    circle: "圆弧",
    ellipse: "椭圆弧",
    bspline: "B样条曲线",
    bezier: "贝塞尔曲线",
    other: "曲线",
  };
  return names[curveType] || "边";
}

function buildSolidTreeNode(
  solidIndex: number,
  solidData: SerializedSolidData,
): SerializedTreeNode {
  return {
    id: `solid_${solidIndex}`,
    name: solidData.name || `Solid_${solidIndex}`,
    type: "solid",
    solidIndex,
    children: solidData.edgeGeometries.map((geom, edgeIdx) => ({
      id: `solid_${solidIndex}_edge_${edgeIdx}`,
      name: `${getEdgeDisplayName(geom.curveType)}_${edgeIdx}`,
      type: "edge" as const,
      solidIndex,
      edgeIndex: edgeIdx,
    })),
  };
}

interface PendingNode {
  candidateIndex?: number;
  id: string;
  name: string;
  type: SerializedTreeNode["type"];
  children: PendingNode[];
}

function parseStepFile(fileBuffer: ArrayBuffer): {
  solids: SerializedSolidData[];
  tree: SerializedTreeNode;
  transferList: Transferable[];
} {
  const shape = readStepFile(fileBuffer);

  try {
    post({ type: "progress", stage: "正在分析模型结构...", percent: 35 });

    const candidates: any[] = [];
    let compoundIndex = 0;

    const collect = (s: any, depth: number): PendingNode | null => {
      const sType = s.ShapeType();

      if (
        sType === oc.TopAbs_ShapeEnum.TopAbs_SOLID ||
        sType === oc.TopAbs_ShapeEnum.TopAbs_SHELL ||
        sType === oc.TopAbs_ShapeEnum.TopAbs_FACE
      ) {
        const candidateIndex = candidates.length;
        candidates.push(s);
        return { candidateIndex, id: "", name: "", type: "solid", children: [] };
      }

      if (
        sType === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND ||
        sType === oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID
      ) {
        const compId = compoundIndex++;
        const children: PendingNode[] = [];
        const iter = new oc.TopoDS_Iterator_2(s, true, true);
        for (; iter.More(); iter.Next()) {
          const child = collect(iter.Value(), depth + 1);
          if (child) children.push(child);
        }
        iter.delete();
        if (children.length === 0) return null;
        if (depth === 0) {
          return { id: "root", name: "Model", type: "root", children };
        }
        return {
          id: `compound_${compId}`,
          name: `Component_${compId}`,
          type: "compound",
          children,
        };
      }

      return null;
    };

    const shapeType = shape.ShapeType();
    const isCompound =
      shapeType === oc.TopAbs_ShapeEnum.TopAbs_COMPOUND ||
      shapeType === oc.TopAbs_ShapeEnum.TopAbs_COMPSOLID;
    const pendingRoot = isCompound
      ? collect(shape, 0)
      : {
          id: "root",
          name: "Model",
          type: "root" as const,
          children: [collect(shape, 1)].filter(Boolean) as PendingNode[],
        };

    const deflection = computeDeflection(shape);
    const solids: SerializedSolidData[] = [];
    const indexMap = new Int32Array(candidates.length).fill(-1);

    for (let start = 0; start < candidates.length; start += MESH_BATCH_SIZE) {
      const chunk = candidates.slice(start, start + MESH_BATCH_SIZE);

      withGC((r) => {
        const builder = r(new oc.BRep_Builder());
        const compound = r(new oc.TopoDS_Compound());
        builder.MakeCompound(compound);
        for (const s of chunk) builder.Add(compound, s);
        r(
          new oc.BRepMesh_IncrementalMesh_2(compound, deflection, false, ANGULAR_DEFLECTION, false),
        );
      });

      for (let i = 0; i < chunk.length; i++) {
        const solidData = extractSingleSolid(chunk[i], solids.length);
        if (solidData) {
          indexMap[start + i] = solids.length;
          solids.push(solidData);
        }
      }

      for (const s of chunk) {
        try {
          oc.BRepTools.Clean(s, true);
        } catch {}
      }

      const done = Math.min(start + chunk.length, candidates.length);
      post({
        type: "progress",
        stage: `正在处理实体 ${done}/${candidates.length}...`,
        percent: Math.min(40 + Math.round((done / Math.max(candidates.length, 1)) * 45), 85),
      });
    }

    const materialize = (node: PendingNode): SerializedTreeNode | null => {
      if (node.candidateIndex !== undefined) {
        const solidIndex = indexMap[node.candidateIndex];
        if (solidIndex < 0) return null;
        return buildSolidTreeNode(solidIndex, solids[solidIndex]);
      }
      const children = node.children
        .map(materialize)
        .filter((n): n is SerializedTreeNode => n !== null);
      if (children.length === 0) return null;
      return { id: node.id, name: node.name, type: node.type, children };
    };

    const tree = (pendingRoot && materialize(pendingRoot)) || {
      id: "root",
      name: "Model",
      type: "root" as const,
      children: [],
    };

    post({ type: "progress", stage: "正在传输数据...", percent: 90 });

    const transferList: Transferable[] = [];
    for (const solid of solids) {
      transferList.push(solid.positions.buffer);
      transferList.push(solid.normals.buffer);
      transferList.push(solid.indices.buffer);
      if (solid.edgePolylines.byteLength > 0) {
        transferList.push(solid.edgePolylines.buffer);
      }
    }

    return { solids, tree, transferList };
  } finally {
    try {
      shape.delete();
    } catch {}
  }
}

export const workerApi = {
  async init(): Promise<void> {
    await initOC();
  },

  async parse(
    fileBuffer: ArrayBuffer,
    onProgress?: ProgressCallback,
  ): Promise<{ solids: SerializedSolidData[]; tree: SerializedTreeNode }> {
    progressCb = onProgress ?? null;
    try {
      await initOC();
      const { solids, tree } = parseStepFile(fileBuffer);
      return { solids, tree };
    } finally {
      progressCb = null;
    }
  },
};

export type StepParseWorkerApi = typeof workerApi;

Comlink.expose(workerApi);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  if (event.data && typeof event.data === "object" && !("type" in event.data)) return;

  const request = event.data;

  try {
    switch (request.type) {
      case "init": {
        await initOC();
        post({ type: "ready" });
        break;
      }

      case "parse": {
        await initOC();
        const { solids, tree, transferList } = parseStepFile(request.fileBuffer);
        post({ type: "progress", stage: "传输数据中...", percent: 95 });
        post({ type: "result", solids, tree, success: true }, transferList);
        break;
      }
    }
  } catch (error) {
    post({
      type: "error",
      message: error instanceof Error ? error.message : "未知解析错误",
    });
  }
};

post({ type: "progress", stage: "Worker 已就绪", percent: 0 });
