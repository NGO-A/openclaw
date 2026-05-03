import { describe, expect, it } from "vitest";
import { estimatePromptTokens, localGpuEligible, selectRoute } from "./router.js";

describe("smart-model-router route selection", () => {
  it("routes deep planning prompts to the deep model", () => {
    const decision = selectRoute({
      prompt: "deep think and architect this migration",
      config: { deepModel: "openai-codex/gpt-5.5", normalModel: "google/gemini-2.5-flash" },
    });
    expect(decision.routeClass).toBe("deep");
    expect(decision.selectedProvider).toBe("openai-codex");
    expect(decision.selectedModel).toBe("openai-codex/gpt-5.5");
    expect(decision.promptStored).toBe(false);
  });

  it("routes vision attachments to the configured vision model", () => {
    const decision = selectRoute({
      prompt: "what is in this image?",
      attachments: [{ kind: "image", mimeType: "image/png" }],
      config: { visionModel: "google/gemini-2.5-pro", normalModel: "openai-codex/gpt-5.5" },
    });
    expect(decision.routeClass).toBe("vision");
    expect(decision.selectedModel).toBe("google/gemini-2.5-pro");
  });

  it("uses local helper only when enabled and enough free VRAM exists", () => {
    const decision = selectRoute({
      prompt: "summarize this log into bullet points",
      config: {
        allowLocalSupport: true,
        localHelperModel: "ollama/qwen2.5-coder:7b-instruct-q4",
        minFreeVramGbForLocal: 4,
        normalModel: "google/gemini-2.5-flash",
      },
      hardware: { gpuName: "RTX A2000", totalVramGb: 12, freeVramGb: 8 },
    });
    expect(decision.routeClass).toBe("local-helper");
    expect(decision.selectedModel).toBe("ollama/qwen2.5-coder:7b-instruct-q4");
  });

  it("keeps local final routes disabled by default", () => {
    const decision = selectRoute({
      prompt: "normal user task",
      config: {
        allowLocalSupport: true,
        localHelperModel: "ollama/qwen2.5-coder:7b-instruct-q4",
        normalModel: "openai-codex/gpt-5.5",
      },
      hardware: { gpuName: "RTX A2000", totalVramGb: 12, freeVramGb: 8 },
    });
    expect(decision.routeClass).toBe("normal");
    expect(decision.selectedModel).toBe("openai-codex/gpt-5.5");
  });

  it("estimates prompt tokens conservatively", () => {
    expect(estimatePromptTokens("12345678")).toBe(2);
  });

  it("checks minimum free VRAM for local routes", () => {
    expect(localGpuEligible({ minFreeVramGbForLocal: 4 }, { freeVramGb: 3.9 })).toBe(false);
    expect(localGpuEligible({ minFreeVramGbForLocal: 4 }, { freeVramGb: 4 })).toBe(true);
  });
});
