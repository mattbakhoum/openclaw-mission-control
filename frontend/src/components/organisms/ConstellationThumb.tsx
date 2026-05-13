"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Canvas, useFrame } from "@react-three/fiber";
import * as THREE from "three";

type Node = {
  id: string;
  x: number;
  y: number;
  z: number;
  project: string;
};

const PROJECT_COLORS: Record<string, string> = {
  bakhoum_ops: "#e08560",
  hermes: "#5fc7a5",
  cortez: "#c95fa5",
  household: "#e0c85f",
  salty: "#5f8ee0",
  "home-vault": "#e8a25e",
  "work-vault": "#7be0c8",
  "private-vault": "#d68fb5",
  _root: "#a89ec8",
  _notion: "#c1c3e8",
  _sort: "#c4b08a",
};

function Stars({ nodes }: { nodes: Node[] }) {
  const points = useMemo(() => {
    const positions = new Float32Array(nodes.length * 3);
    const colors = new Float32Array(nodes.length * 3);
    const c = new THREE.Color();
    nodes.forEach((n, i) => {
      positions[i * 3] = n.x * 0.8;
      positions[i * 3 + 1] = n.y * 0.8;
      positions[i * 3 + 2] = n.z * 0.8;
      c.set(PROJECT_COLORS[n.project] ?? "#9d8fb8");
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    g.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    return g;
  }, [nodes]);

  const matRef = useMemo(
    () =>
      new THREE.PointsMaterial({
        size: 1.6,
        sizeAttenuation: true,
        vertexColors: true,
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      }),
    [],
  );

  return <points geometry={points} material={matRef} />;
}

function AutoRotate() {
  useFrame((state) => {
    state.camera.position.x = Math.cos(state.clock.elapsedTime * 0.18) * 90;
    state.camera.position.z = Math.sin(state.clock.elapsedTime * 0.18) * 90;
    state.camera.position.y = 25 + Math.sin(state.clock.elapsedTime * 0.12) * 8;
    state.camera.lookAt(0, 0, 0);
  });
  return null;
}

export function ConstellationThumb() {
  const [nodes, setNodes] = useState<Node[]>([]);

  useEffect(() => {
    fetch("/constellation.json")
      .then((r) => r.json())
      .then((d) => setNodes(d?.nodes ?? []))
      .catch(() => setNodes([]));
  }, []);

  return (
    <Link
      href="/constellation"
      className="group surface-card relative block h-44 overflow-hidden rounded-xl transition hover:-translate-y-0.5 hover:shadow-lush"
    >
      <div className="absolute inset-0 bg-black">
        <Canvas
          camera={{ position: [80, 30, 80], fov: 50 }}
          dpr={[1, 2]}
          gl={{ antialias: true, alpha: false }}
        >
          <color attach="background" args={["#06050a"]} />
          <fog attach="fog" args={["#06050a", 60, 200]} />
          <Suspense fallback={null}>
            {nodes.length ? <Stars nodes={nodes} /> : null}
            <AutoRotate />
          </Suspense>
        </Canvas>
      </div>
      {/* CRT corner ticks */}
      <span className="pointer-events-none absolute left-2 top-2 h-3 w-3 border-l border-t border-[color:rgba(224,133,96,0.6)]" />
      <span className="pointer-events-none absolute right-2 top-2 h-3 w-3 border-r border-t border-[color:rgba(224,133,96,0.6)]" />
      <span className="pointer-events-none absolute left-2 bottom-2 h-3 w-3 border-l border-b border-[color:rgba(224,133,96,0.6)]" />
      <span className="pointer-events-none absolute right-2 bottom-2 h-3 w-3 border-r border-b border-[color:rgba(224,133,96,0.6)]" />
      {/* Label overlay */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
        <div>
          <p className="font-mono text-[9px] uppercase tracking-[0.25em] text-white/40">
            memory constellation
          </p>
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-white/80">
            {nodes.length.toLocaleString()} nodes · live
          </p>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-[color:rgba(224,133,96,0.9)]">
          enter →
        </span>
      </div>
    </Link>
  );
}
