export type SmartRouterConfig = {
  enabled?: boolean;
  quickModel?: string;
  normalModel?: string;
  deepModel?: string;
  codeModel?: string;
  visionModel?: string;
  longContextModel?: string;
  localHelperProvider?: string;
  localHelperModel?: string;
  localSupportModel?: string;
  localCodeModel?: string;
  allowLocalSupport?: boolean;
  allowLocalSimpleCode?: boolean;
  allowLocalFinal?: boolean;
  enableLongContextRoute?: boolean;
  longContextTokenThreshold?: number;
  minFreeVramGbForLocal?: number;
  trace?: {
    enabled?: boolean;
    maxEntries?: number;
  };
  fallback?: {
    enabled?: boolean;
    maxAttempts?: number;
    allowAfterFirstToken?: boolean;
    authFallback?: boolean;
    rateLimitFallback?: boolean;
    toolCallFallback?: boolean;
  };
  nvidiaCatalog?: {
    enabled?: boolean;
    refreshHours?: number;
  };
};

export type RouterHardware = {
  gpuName?: string;
  totalVramGb?: number;
  freeVramGb?: number;
};

export type RouterAttachment = {
  kind: "image" | "video" | "audio" | "document" | "other";
  mimeType?: string;
};

export type RouterDecision = {
  routeClass:
    | "quick"
    | "normal"
    | "deep"
    | "code"
    | "vision"
    | "long-context"
    | "local-helper"
    | "local-code";
  selectedModel?: string;
  selectedProvider?: string;
  candidates: Array<{ model: string; eligible: boolean; reason?: string; score?: number }>;
  reasons: string[];
  promptStored: false;
  hardware?: RouterHardware;
};

const DEFAULT_LONG_CONTEXT_TOKEN_THRESHOLD = 120_000;

const DEEP_PATTERN =
  /\b(deep think|think hard|architect|serious plan|high[- ]stakes|security review|root cause|debug deeply)\b/i;
const CODE_PATTERN =
  /\b(code|implement|patch|refactor|typescript|javascript|python|rust|go|test|build|lint|stack trace|diff|pr)\b/i;
const QUICK_PATTERN = /\b(quick|just answer|small edit|simple|briefly|tl;dr)\b/i;
const SUPPORT_PATTERN =
  /\b(summarize|classify|extract|triage|draft|rewrite|format|list|table|outline)\b/i;

export function normalizeSmartRouterConfig(input: unknown): SmartRouterConfig {
  if (!input || typeof input !== "object") {
    return {};
  }
  return input as SmartRouterConfig;
}

export function estimatePromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

export function localGpuEligible(config: SmartRouterConfig, hardware?: RouterHardware): boolean {
  const minFree = config.minFreeVramGbForLocal ?? 4;
  return Boolean(hardware?.freeVramGb !== undefined && hardware.freeVramGb >= minFree);
}

function addCandidate(
  candidates: RouterDecision["candidates"],
  model: string | undefined,
  eligible: boolean,
  reason: string,
  score: number,
) {
  if (!model) {
    return;
  }
  candidates.push({ model, eligible, reason, score });
}

function splitProviderModel(modelRef: string | undefined): {
  selectedProvider?: string;
  selectedModel?: string;
} {
  const model = modelRef?.trim();
  if (!model) {
    return {};
  }
  const slash = model.indexOf("/");
  if (slash <= 0) {
    return { selectedModel: model };
  }
  return { selectedProvider: model.slice(0, slash), selectedModel: model };
}

export function selectRoute(params: {
  prompt: string;
  attachments?: RouterAttachment[];
  config?: SmartRouterConfig;
  defaultModel?: string;
  hardware?: RouterHardware;
}): RouterDecision {
  const config = params.config ?? {};
  const candidates: RouterDecision["candidates"] = [];
  const reasons: string[] = [];
  const prompt = params.prompt ?? "";
  const hasVisionAttachment =
    params.attachments?.some((entry) => entry.kind === "image" || entry.kind === "video") ?? false;
  const tokenEstimate = estimatePromptTokens(prompt);
  const longContextThreshold =
    config.longContextTokenThreshold ?? DEFAULT_LONG_CONTEXT_TOKEN_THRESHOLD;
  const gpuOk = localGpuEligible(config, params.hardware);

  let routeClass: RouterDecision["routeClass"] = "normal";
  let selectedModel = config.normalModel ?? params.defaultModel;

  if (hasVisionAttachment && config.visionModel) {
    routeClass = "vision";
    selectedModel = config.visionModel;
    reasons.push("vision attachment detected");
  } else if (
    config.enableLongContextRoute !== false &&
    tokenEstimate >= longContextThreshold &&
    config.longContextModel
  ) {
    routeClass = "long-context";
    selectedModel = config.longContextModel;
    reasons.push(`estimated prompt tokens ${tokenEstimate} >= ${longContextThreshold}`);
  } else if (DEEP_PATTERN.test(prompt) && config.deepModel) {
    routeClass = "deep";
    selectedModel = config.deepModel;
    reasons.push("deep planning/debug phrase detected");
  } else if (CODE_PATTERN.test(prompt) && config.codeModel) {
    routeClass = "code";
    selectedModel = config.codeModel;
    reasons.push("coding phrase detected");
  } else if (QUICK_PATTERN.test(prompt) && config.quickModel) {
    routeClass = "quick";
    selectedModel = config.quickModel;
    reasons.push("quick/brief phrase detected");
  } else if (
    config.allowLocalSupport &&
    gpuOk &&
    SUPPORT_PATTERN.test(prompt) &&
    (config.localSupportModel ?? config.localHelperModel)
  ) {
    routeClass = "local-helper";
    selectedModel = config.localSupportModel ?? config.localHelperModel;
    reasons.push("local support task and GPU has enough free VRAM");
  } else if (
    config.allowLocalSimpleCode &&
    gpuOk &&
    CODE_PATTERN.test(prompt) &&
    config.localCodeModel
  ) {
    routeClass = "local-code";
    selectedModel = config.localCodeModel;
    reasons.push("simple local code task and GPU has enough free VRAM");
  } else {
    reasons.push("normal route fallback");
  }

  addCandidate(
    candidates,
    config.visionModel,
    hasVisionAttachment,
    hasVisionAttachment ? "vision capable route" : "no vision attachment",
    90,
  );
  addCandidate(
    candidates,
    config.longContextModel,
    tokenEstimate >= longContextThreshold,
    "long context threshold",
    80,
  );
  addCandidate(candidates, config.deepModel, DEEP_PATTERN.test(prompt), "deep route heuristic", 75);
  addCandidate(candidates, config.codeModel, CODE_PATTERN.test(prompt), "code route heuristic", 70);
  addCandidate(
    candidates,
    config.quickModel,
    QUICK_PATTERN.test(prompt),
    "quick route heuristic",
    60,
  );
  addCandidate(
    candidates,
    config.localSupportModel ?? config.localHelperModel,
    Boolean(config.allowLocalSupport && gpuOk),
    gpuOk ? "local GPU eligible" : "local GPU not eligible",
    50,
  );
  addCandidate(
    candidates,
    config.localCodeModel,
    Boolean(config.allowLocalSimpleCode && gpuOk),
    gpuOk ? "local GPU eligible for simple code" : "local GPU not eligible",
    45,
  );

  return {
    routeClass,
    selectedModel,
    ...splitProviderModel(selectedModel),
    candidates,
    reasons,
    promptStored: false,
    ...(params.hardware ? { hardware: params.hardware } : {}),
  };
}
