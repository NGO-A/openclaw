import { execFileSync } from "node:child_process";
import type { RouterHardware } from "./router.js";

export function detectNvidiaGpu(): RouterHardware | undefined {
  try {
    const output = execFileSync(
      "nvidia-smi",
      ["--query-gpu=name,memory.total,memory.free", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 1500, stdio: ["ignore", "pipe", "ignore"] },
    );
    const first = output
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean);
    if (!first) {
      return undefined;
    }
    const [nameRaw, totalRaw, freeRaw] = first.split(",").map((part) => part.trim());
    const totalMb = Number(totalRaw);
    const freeMb = Number(freeRaw);
    return {
      ...(nameRaw ? { gpuName: nameRaw } : {}),
      ...(Number.isFinite(totalMb) ? { totalVramGb: Math.round((totalMb / 1024) * 10) / 10 } : {}),
      ...(Number.isFinite(freeMb) ? { freeVramGb: Math.round((freeMb / 1024) * 10) / 10 } : {}),
    };
  } catch {
    return undefined;
  }
}
