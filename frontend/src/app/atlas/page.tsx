"use client";

import dynamic from "next/dynamic";

const Atlas = dynamic(
  () => import("@/components/constellation/Atlas").then((m) => m.Atlas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center bg-black text-sm text-white/60">
        Loading sort atlas…
      </div>
    ),
  },
);

export default function AtlasPage() {
  return <Atlas />;
}
