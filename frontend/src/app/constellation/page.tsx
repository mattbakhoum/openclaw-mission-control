"use client";

import dynamic from "next/dynamic";

const Constellation = dynamic(
  () => import("@/components/constellation/Constellation").then((m) => m.Constellation),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center bg-black text-sm text-white/60">
        Loading memory constellation…
      </div>
    ),
  },
);

export default function ConstellationPage() {
  return <Constellation />;
}
