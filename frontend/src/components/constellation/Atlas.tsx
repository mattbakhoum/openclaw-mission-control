"use client";

/**
 * Atlas -- sister visualization of Constellation.tsx, but reads the
 * sort_atlas.json corpus instead of constellation.json and colors nodes by
 * file_type instead of project.
 *
 * Tech debt: this file forks NodeCloud / EdgeLines / AutoRotator / CameraTween
 * / DustField from Constellation.tsx. The shapes are the same; only the color
 * accessor differs. If a third scene gets added (e.g. iCloud atlas), extract
 * scene-parts.tsx and parameterize on `colorFor`. For two scenes the fork is
 * cheaper to maintain than the abstraction.
 */

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrbitControls, Stars } from "@react-three/drei";
import { EffectComposer, Bloom, Vignette } from "@react-three/postprocessing";
import { KernelSize } from "postprocessing";
import * as THREE from "three";
import { ChevronLeft, Clipboard, Layers, Telescope, Network } from "lucide-react";
import Link from "next/link";

type AtlasNode = {
  id: string;
  x: number;
  y: number;
  z: number;
  collection: string;
  user_id: string;
  agent_id: string;
  project: string;
  source_path: string | null;
  section_heading: string | null;
  file_type: string;
  file_name: string | null;
  preview: string;
};

type AtlasData = {
  generated_at: string;
  method: string;
  collection: string;
  stats: {
    total: number;
    collections: string[];
    projects: string[];
    agents: string[];
    file_types: string[];
  };
  nodes: AtlasNode[];
};

// Per-file-type palette. Saturated, distinguishable, readable on black.
const FILE_TYPE_COLORS: Record<string, string> = {
  pdf: "#7b6fd4",     // indigo
  docx: "#5f8ee0",    // blue
  image: "#e8a25e",   // peach
  audio: "#e08560",   // coral
  html: "#5fc7a5",    // teal
  txt: "#b39ddb",     // lavender
  md: "#7be0c8",      // mint
  video: "#9d8fb8",   // dusty
  unknown: "#6f5da8",
};

// Age-based palette: how recently was the file's source touched? Bucketed.
// (For v1 we don't have age on the node yet -- placeholder so the toggle
// still works without crashing.)
const AGE_COLORS: Record<string, string> = {
  recent: "#e08560",
  month: "#e8a25e",
  quarter: "#7be0c8",
  year: "#5f8ee0",
  ancient: "#6f5da8",
  unknown: "#9d8fb8",
};

type ColorMode = "file_type" | "age";

function colorFor(node: AtlasNode, mode: ColorMode): string {
  if (mode === "file_type") {
    return FILE_TYPE_COLORS[node.file_type] ?? FILE_TYPE_COLORS.unknown;
  }
  // Age mode is a stub for now -- there's no age field on the node yet.
  return AGE_COLORS.unknown;
}

function NodeCloud({
  nodes,
  colorMode,
  hoveredId,
  highlightedIds,
  onHover,
  onSelect,
}: {
  nodes: AtlasNode[];
  colorMode: ColorMode;
  hoveredId: string | null;
  highlightedIds: Set<string> | null;
  onHover: (id: string | null) => void;
  onSelect: (node: AtlasNode) => void;
}) {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  const dummy = useMemo(() => new THREE.Object3D(), []);
  const colorObj = useMemo(() => new THREE.Color(), []);
  const baseScale = 0.95;
  const hoverScale = 2.0;
  const dimScale = 0.55;

  useEffect(() => {
    if (!meshRef.current) return;
    const hasSearch = highlightedIds !== null && highlightedIds.size > 0;
    nodes.forEach((n, i) => {
      dummy.position.set(n.x, n.y, n.z);
      const isHover = n.id === hoveredId;
      const isMatch = hasSearch ? highlightedIds!.has(n.id) : true;
      const s = isHover ? hoverScale : isMatch ? baseScale : dimScale;
      dummy.scale.set(s, s, s);
      dummy.updateMatrix();
      meshRef.current!.setMatrixAt(i, dummy.matrix);
      colorObj.set(colorFor(n, colorMode));
      if (hasSearch && !isMatch) colorObj.multiplyScalar(0.22);
      meshRef.current!.setColorAt(i, colorObj);
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  }, [nodes, colorMode, hoveredId, highlightedIds, dummy, colorObj]);

  useFrame((state) => {
    if (!meshRef.current) return;
    const t = state.clock.elapsedTime;
    nodes.forEach((n, i) => {
      if (n.id === hoveredId) {
        dummy.position.set(n.x, n.y, n.z);
        const pulse = hoverScale + Math.sin(t * 6) * 0.15;
        dummy.scale.set(pulse, pulse, pulse);
        dummy.updateMatrix();
        meshRef.current!.setMatrixAt(i, dummy.matrix);
      }
    });
    meshRef.current.instanceMatrix.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, nodes.length]}
      onPointerOver={(e) => {
        e.stopPropagation();
        const id = nodes[e.instanceId ?? -1]?.id;
        if (id) onHover(id);
      }}
      onPointerOut={() => onHover(null)}
      onClick={(e) => {
        e.stopPropagation();
        const n = nodes[e.instanceId ?? -1];
        if (n) onSelect(n);
      }}
    >
      <sphereGeometry args={[1, 24, 24]} />
      <meshStandardMaterial
        emissive={new THREE.Color("#ffffff")}
        emissiveIntensity={0.9}
        toneMapped={false}
        roughness={0.4}
        metalness={0.1}
      />
    </instancedMesh>
  );
}

function EdgeLines({ nodes, colorMode }: { nodes: AtlasNode[]; colorMode: ColorMode }) {
  // For atlas, cluster lines by file_type (not by project).
  const lines = useMemo(() => {
    const segments: { a: AtlasNode; b: AtlasNode; color: string }[] = [];
    const byType: Record<string, AtlasNode[]> = {};
    nodes.forEach((n) => {
      (byType[n.file_type] ??= []).push(n);
    });
    Object.values(byType).forEach((cluster) => {
      cluster.forEach((n) => {
        const sorted = cluster
          .filter((m) => m.id !== n.id)
          .map((m) => ({ m, d: Math.hypot(m.x - n.x, m.y - n.y, m.z - n.z) }))
          .sort((a, b) => a.d - b.d)
          .slice(0, 2);
        sorted.forEach(({ m }) => {
          segments.push({ a: n, b: m, color: colorFor(n, colorMode) });
        });
      });
    });
    return segments;
  }, [nodes, colorMode]);

  const geometry = useMemo(() => {
    const positions = new Float32Array(lines.length * 6);
    const colors = new Float32Array(lines.length * 6);
    const c = new THREE.Color();
    lines.forEach((seg, i) => {
      positions[i * 6 + 0] = seg.a.x;
      positions[i * 6 + 1] = seg.a.y;
      positions[i * 6 + 2] = seg.a.z;
      positions[i * 6 + 3] = seg.b.x;
      positions[i * 6 + 4] = seg.b.y;
      positions[i * 6 + 5] = seg.b.z;
      c.set(seg.color);
      colors[i * 6 + 0] = c.r;
      colors[i * 6 + 1] = c.g;
      colors[i * 6 + 2] = c.b;
      colors[i * 6 + 3] = c.r;
      colors[i * 6 + 4] = c.g;
      colors[i * 6 + 5] = c.b;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [lines]);

  return (
    <lineSegments geometry={geometry}>
      <lineBasicMaterial vertexColors transparent opacity={0.18} toneMapped={false} />
    </lineSegments>
  );
}

function AutoRotator({ enabled }: { enabled: boolean }) {
  const { camera } = useThree();
  const angleRef = useRef(0);
  useFrame((_, delta) => {
    if (!enabled) return;
    angleRef.current += delta * 0.05;
    const r = 110;
    camera.position.x = Math.cos(angleRef.current) * r;
    camera.position.z = Math.sin(angleRef.current) * r;
    camera.position.y = 30 + Math.sin(angleRef.current * 0.7) * 12;
    camera.lookAt(0, 0, 0);
  });
  return null;
}

function CameraTween({ target }: { target: AtlasNode | null }) {
  const { camera } = useThree();
  const goalRef = useRef<THREE.Vector3 | null>(null);
  useEffect(() => {
    if (target) {
      const dir = new THREE.Vector3(target.x, target.y, target.z).normalize();
      goalRef.current = new THREE.Vector3(target.x, target.y, target.z).add(
        dir.multiplyScalar(28),
      );
    } else {
      goalRef.current = null;
    }
  }, [target]);
  useFrame(() => {
    if (!goalRef.current) return;
    camera.position.lerp(goalRef.current, 0.06);
    camera.lookAt(target ? new THREE.Vector3(target.x, target.y, target.z) : new THREE.Vector3());
    if (camera.position.distanceTo(goalRef.current) < 0.4) {
      goalRef.current = null;
    }
  });
  return null;
}

function DustField() {
  const ref = useRef<THREE.Points>(null);
  const count = 600;
  const positions = useMemo(() => {
    const arr = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 80 + Math.random() * 120;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      arr[i * 3 + 0] = r * Math.sin(phi) * Math.cos(theta);
      arr[i * 3 + 1] = r * Math.sin(phi) * Math.sin(theta);
      arr[i * 3 + 2] = r * Math.cos(phi);
    }
    return arr;
  }, []);
  useFrame((_, delta) => {
    if (!ref.current) return;
    ref.current.rotation.y += delta * 0.012;
  });
  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    return g;
  }, [positions]);
  return (
    <points ref={ref} geometry={geometry}>
      <pointsMaterial
        size={0.35}
        color="#e8c79a"
        transparent
        opacity={0.45}
        sizeAttenuation
        toneMapped={false}
      />
    </points>
  );
}

export function Atlas() {
  const [data, setData] = useState<AtlasData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>("file_type");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selected, setSelected] = useState<AtlasNode | null>(null);
  const [autoRotate, setAutoRotate] = useState(true);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  useEffect(() => {
    fetch("/sort_atlas.json")
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then(setData)
      .catch((e) => setLoadError(String(e)));
  }, []);

  const hovered = useMemo(
    () => (hoveredId && data ? data.nodes.find((n) => n.id === hoveredId) ?? null : null),
    [hoveredId, data],
  );

  // File-type filter (analogous to project filter on Constellation).
  const [activeTypes, setActiveTypes] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (data) setActiveTypes(new Set(data.stats.file_types));
  }, [data]);

  const visibleNodes = useMemo(() => {
    if (!data) return [];
    if (activeTypes.size === 0) return data.nodes;
    return data.nodes.filter((n) => activeTypes.has(n.file_type));
  }, [data, activeTypes]);

  const toggleType = (t: string) => {
    setActiveTypes((prev) => {
      const next = new Set(prev);
      if (next.has(t)) next.delete(t);
      else next.add(t);
      return next;
    });
  };

  const copyPath = (path: string | null) => {
    if (!path) return;
    void navigator.clipboard.writeText(path).then(() => {
      setCopyHint(path);
      setTimeout(() => setCopyHint(null), 1600);
    });
  };

  return (
    <div
      className="relative h-screen w-full overflow-hidden bg-black text-white"
      onPointerDown={() => setAutoRotate(false)}
    >
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,rgba(123,111,212,0.18),transparent_60%),radial-gradient(ellipse_at_bottom,rgba(34,28,21,0.6),transparent_55%)]" />
      <div className="constellation-scanline" />
      <div className="pointer-events-none absolute left-3 top-3 z-10 h-4 w-4 border-l border-t border-[color:rgba(123,111,212,0.5)]" />
      <div className="pointer-events-none absolute right-3 top-3 z-10 h-4 w-4 border-r border-t border-[color:rgba(123,111,212,0.5)]" />
      <div className="pointer-events-none absolute left-3 bottom-3 z-10 h-4 w-4 border-l border-b border-[color:rgba(123,111,212,0.5)]" />
      <div className="pointer-events-none absolute right-3 bottom-3 z-10 h-4 w-4 border-r border-b border-[color:rgba(123,111,212,0.5)]" />
      <div className="pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.4em] text-white/30">
        bakhoum
        <span className="mx-2 text-[color:rgba(123,111,212,0.7)]">·</span>atlas
        <span className="mx-2 text-[color:rgba(123,111,212,0.7)]">·</span>sort
      </div>

      <Canvas
        camera={{ position: [80, 40, 80], fov: 50, near: 0.1, far: 1000 }}
        dpr={[1, 2]}
        gl={{ antialias: true, powerPreference: "high-performance" }}
      >
        <color attach="background" args={["#06050a"]} />
        <fog attach="fog" args={["#06050a", 90, 280]} />
        <ambientLight intensity={0.25} />
        <pointLight position={[40, 60, 40]} intensity={1.2} color="#ffd5b8" />
        <pointLight position={[-50, -30, -40]} intensity={0.5} color="#8aa9d6" />

        <Suspense fallback={null}>
          <Stars radius={220} depth={80} count={2200} factor={3.2} saturation={0} fade speed={0.4} />

          {data ? (
            <>
              <EdgeLines nodes={visibleNodes} colorMode={colorMode} />
              <NodeCloud
                nodes={visibleNodes}
                colorMode={colorMode}
                hoveredId={hoveredId}
                highlightedIds={null}
                onHover={setHoveredId}
                onSelect={(n) => {
                  setSelected(n);
                  setAutoRotate(false);
                }}
              />
            </>
          ) : null}

          <DustField />
          <AutoRotator enabled={autoRotate && !hoveredId && !selected} />
          <CameraTween target={selected} />

          <EffectComposer multisampling={0}>
            <Bloom
              intensity={1.4}
              luminanceThreshold={0.1}
              luminanceSmoothing={0.7}
              mipmapBlur
              kernelSize={KernelSize.LARGE}
            />
            <Vignette eskil={false} offset={0.15} darkness={0.85} />
          </EffectComposer>
        </Suspense>

        <OrbitControls
          enablePan
          enableZoom
          enableRotate
          minDistance={20}
          maxDistance={350}
          onStart={() => setAutoRotate(false)}
        />
      </Canvas>

      <div className="pointer-events-none absolute left-0 top-0 z-10 flex w-full items-start justify-between p-6">
        <div className="pointer-events-auto">
          <Link
            href="/dashboard"
            className="mb-3 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-black/40 px-2.5 py-1 text-[11px] font-medium text-white/70 backdrop-blur transition hover:bg-black/60 hover:text-white"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            Back to dashboard
          </Link>
          <div className="flex items-center gap-2">
            <Telescope className="h-4 w-4 text-[color:rgb(123,111,212)]" />
            <h1 className="font-mono text-[11px] uppercase tracking-[0.25em] text-white/60">
              Sort Atlas
            </h1>
          </div>
          <p className="mt-1 max-w-md text-sm text-white/85">
            {data
              ? `${data.stats.total} chunks across ${data.stats.file_types.length} file types, projected 768d → 3D.`
              : loadError
              ? `Failed to load atlas: ${loadError}`
              : "Booting…"}
          </p>
        </div>

        <div className="pointer-events-auto flex flex-col gap-2 rounded-lg border border-white/10 bg-black/40 p-3 backdrop-blur">
          <div className="flex items-center gap-2">
            <Layers className="h-3.5 w-3.5 text-white/60" />
            <span className="font-mono text-[10px] uppercase tracking-widest text-white/50">
              Color
            </span>
            <div className="flex overflow-hidden rounded-md border border-white/10">
              {(["file_type", "age"] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setColorMode(mode)}
                  className={`px-2 py-1 text-[11px] font-medium transition ${
                    colorMode === mode
                      ? "bg-[color:rgb(123,111,212)] text-black"
                      : "text-white/70 hover:bg-white/5"
                  }`}
                >
                  {mode.replace("_", " ")}
                </button>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-[11px] text-white/70">
            <input
              type="checkbox"
              checked={autoRotate}
              onChange={(e) => setAutoRotate(e.target.checked)}
              className="accent-[color:rgb(123,111,212)]"
            />
            Auto-drift camera
          </label>
        </div>
      </div>

      {data ? (
        <div className="pointer-events-none absolute bottom-0 left-0 z-10 flex w-full items-end justify-between gap-4 p-6">
          <div className="pointer-events-auto flex items-center gap-3 rounded-lg border border-white/10 bg-black/40 px-4 py-2.5 backdrop-blur">
            <Network className="h-3.5 w-3.5 text-[color:rgb(123,111,212)]" />
            <div className="flex gap-6 font-mono text-[11px] uppercase tracking-widest text-white/70">
              <Stat label="nodes" value={String(data.stats.total)} />
              <Stat label="file types" value={String(data.stats.file_types.length)} />
              <Stat label="collection" value={data.collection} />
              <Stat
                label="generated"
                value={new Date(data.generated_at).toLocaleString(undefined, {
                  hour: "2-digit",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                })}
              />
            </div>
          </div>

          <div className="pointer-events-auto rounded-lg border border-white/10 bg-black/40 p-3 backdrop-blur">
            <div className="mb-1.5 font-mono text-[10px] uppercase tracking-widest text-white/40">
              Filter / Legend (file type)
            </div>
            <div className="flex flex-col gap-1 text-[11px] text-white/80">
              {data.stats.file_types.map((t) => {
                const isOn = activeTypes.has(t);
                const color = FILE_TYPE_COLORS[t] ?? FILE_TYPE_COLORS.unknown;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => toggleType(t)}
                    className={`flex items-center gap-2 rounded px-1 py-0.5 text-left transition ${
                      isOn ? "hover:bg-white/5" : "opacity-30 hover:opacity-60"
                    }`}
                  >
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: color, boxShadow: isOn ? `0 0 8px ${color}` : "none" }}
                    />
                    <span className="font-mono">{t}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : null}

      {hovered && !selected ? (
        <div className="pointer-events-none absolute left-1/2 top-20 z-10 -translate-x-1/2 rounded-lg border border-white/10 bg-black/70 px-4 py-2 text-center text-xs backdrop-blur">
          <div className="font-mono text-[10px] uppercase tracking-widest text-white/40">
            {hovered.file_type} · {hovered.file_name}
          </div>
          <div className="text-white/90">
            {hovered.section_heading ?? hovered.source_path ?? hovered.id.slice(0, 8)}
          </div>
        </div>
      ) : null}

      {selected ? (
        <div className="absolute right-0 top-0 z-20 flex h-full w-[420px] flex-col border-l border-white/10 bg-black/80 p-6 backdrop-blur">
          <button
            type="button"
            onClick={() => setSelected(null)}
            className="self-end font-mono text-[11px] uppercase tracking-widest text-white/50 hover:text-white"
          >
            close ×
          </button>
          <div className="mt-2 font-mono text-[10px] uppercase tracking-widest text-white/40">
            Sort atlas · {selected.file_type}
          </div>
          <div className="mt-1 break-words text-base font-semibold text-white">
            {selected.file_name ?? selected.id.slice(0, 12)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-2 text-[11px]">
            <Field label="file type" value={selected.file_type} />
            <Field label="project" value={selected.project} />
            <Field label="agent" value={selected.agent_id} />
            <Field label="user" value={selected.user_id} />
          </div>
          {selected.section_heading ? (
            <Field label="section" value={selected.section_heading} className="mt-2" />
          ) : null}
          {selected.source_path ? (
            <div className="mt-2">
              <div className="font-mono text-[9px] uppercase tracking-widest text-white/40">
                source
              </div>
              <div className="mt-0.5 flex items-start gap-2">
                <code className="flex-1 break-all rounded bg-white/[0.04] px-2 py-1 text-[11px] text-white/80">
                  {selected.source_path}
                </code>
                <button
                  type="button"
                  onClick={() => copyPath(selected.source_path)}
                  className="inline-flex items-center gap-1 rounded border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] text-white/70 hover:bg-white/[0.08]"
                  title="Copy path -- paste into Finder/Explorer to reveal"
                >
                  <Clipboard className="h-3 w-3" />
                  Reveal
                </button>
              </div>
              {copyHint ? (
                <div className="mt-1 font-mono text-[10px] text-[color:rgb(123,111,212)]">
                  copied — paste into Finder or Explorer
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="mt-4 flex-1 overflow-y-auto rounded-md border border-white/5 bg-white/[0.03] p-3 text-[12px] leading-relaxed text-white/80">
            {selected.preview || "(no preview)"}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col items-start">
      <span className="text-[9px] text-white/40">{label}</span>
      <span className="text-[13px] font-semibold normal-case tracking-normal text-white">
        {value}
      </span>
    </div>
  );
}

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="font-mono text-[9px] uppercase tracking-widest text-white/40">{label}</div>
      <div className="break-words text-[12px] text-white/80">{value}</div>
    </div>
  );
}
