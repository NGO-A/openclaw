import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { detectNvidiaGpu } from "./src/hardware.js";
import {
  estimatePromptTokens,
  normalizeSmartRouterConfig,
  selectRoute,
  type RouterHardware,
} from "./src/router.js";
import { appendTraceRecord, readRecentTraceRecords } from "./src/trace.js";

export default definePluginEntry({
  id: "smart-model-router",
  name: "Smart Model Router",
  description:
    "Manifest-backed smart model router with local GPU awareness and safe route tracing.",
  register(api) {
    const config = normalizeSmartRouterConfig(api.pluginConfig);
    if (config.enabled === false) {
      api.logger.info("smart-model-router disabled by plugin config");
      return;
    }

    let hardware: RouterHardware | undefined;

    api.on(
      "gateway_start",
      () => {
        hardware = detectNvidiaGpu();
        if (hardware?.gpuName) {
          api.logger.info(
            `smart-model-router detected GPU: ${hardware.gpuName} (${hardware.freeVramGb ?? "?"}/${hardware.totalVramGb ?? "?"} GB free/total)`,
          );
        }
      },
      { priority: 20, timeoutMs: 2_000 },
    );

    api.on(
      "before_model_resolve",
      (event, ctx) => {
        const started = Date.now();
        const decision = selectRoute({
          prompt: event.prompt,
          attachments: event.attachments,
          config,
          defaultModel: ctx.modelId,
          hardware,
        });

        if (ctx.runId) {
          api.setRunContext({
            runId: ctx.runId,
            namespace: "decision",
            value: {
              routeClass: decision.routeClass,
              selectedModel: decision.selectedModel ?? null,
              selectedProvider: decision.selectedProvider ?? null,
              candidates: decision.candidates,
              reasons: decision.reasons,
              promptStored: false,
            },
          });
        }

        if (config.trace?.enabled !== false) {
          appendTraceRecord(
            {
              ts: new Date().toISOString(),
              requestId: ctx.runId,
              sessionId: ctx.sessionId,
              sessionKey: ctx.sessionKey,
              selectedModel: decision.selectedModel,
              selectedProvider: decision.selectedProvider,
              routeClass: decision.routeClass,
              candidates: decision.candidates,
              reasons: decision.reasons,
              promptStored: false,
              latencyMs: Date.now() - started,
              tokenEstimate: estimatePromptTokens(event.prompt),
            },
            { maxEntries: config.trace?.maxEntries },
          );
        }

        if (!decision.selectedModel) {
          return;
        }
        return {
          ...(decision.selectedProvider ? { providerOverride: decision.selectedProvider } : {}),
          modelOverride: decision.selectedModel,
        };
      },
      { priority: 80, timeoutMs: 100 },
    );

    api.on(
      "model_call_ended",
      (event, ctx) => {
        if (config.trace?.enabled === false) {
          return;
        }
        const decision = ctx.runId
          ? (api.getRunContext({ runId: ctx.runId, namespace: "decision" }) as
              | Record<string, unknown>
              | undefined)
          : undefined;
        appendTraceRecord(
          {
            ts: new Date().toISOString(),
            requestId: event.runId,
            sessionId: event.sessionId,
            sessionKey: event.sessionKey,
            selectedModel: `${event.provider}/${event.model}`,
            selectedProvider: event.provider,
            routeClass: (decision?.routeClass as never) ?? "normal",
            candidates: (decision?.candidates as never) ?? [],
            reasons: [
              ...((decision?.reasons as string[] | undefined) ?? []),
              `model call ${event.outcome}${event.errorCategory ? `: ${event.errorCategory}` : ""}`,
            ],
            promptStored: false,
            latencyMs: event.durationMs,
          },
          { maxEntries: config.trace?.maxEntries },
        );
      },
      { priority: 10, timeoutMs: 100 },
    );

    api.registerGatewayMethod("router.status", async ({ respond }) => {
      respond(true, {
        ok: true,
        plugin: "smart-model-router",
        enabled: true,
        hardware,
        config: {
          allowLocalSupport: config.allowLocalSupport === true,
          allowLocalSimpleCode: config.allowLocalSimpleCode === true,
          allowLocalFinal: config.allowLocalFinal === true,
          trace: config.trace?.enabled !== false,
        },
        recent: readRecentTraceRecords({ limit: 5 }),
      });
    });

    api.registerGatewayMethod("router.explain", async ({ respond }) => {
      respond(true, {
        ok: true,
        last: readRecentTraceRecords({ limit: 1 })[0] ?? null,
      });
    });
  },
});
