import { z } from "zod";
import { withApplicationConnection } from "../../utils/ConnectionManager.js";
import type { DomainToolDefinition } from "../domainRuntime.js";

const GenericResponseSchema = z.object({}).passthrough();

const SlopeGeometryArgs = z.object({ action: z.literal("geometry_calculate"), alignmentName: z.string().optional(), profileName: z.string().optional(), surfaceName: z.string().optional(), cutSlopeRatio: z.number().positive().optional(), fillSlopeRatio: z.number().positive().optional(), benchWidth: z.number().nonnegative().optional(), benchHeightInterval: z.number().positive().optional(), stationStart: z.number().optional(), stationEnd: z.number().optional(), stationInterval: z.number().positive().optional(), roadwayWidth: z.number().nonnegative().optional() });

export const SLOPE_ANALYSIS_DOMAIN_DEFINITION: DomainToolDefinition = {
  domain: "slope_analysis",
  actions: {
    geometry_calculate: { action: "geometry_calculate", inputSchema: SlopeGeometryArgs, responseSchema: GenericResponseSchema, capabilities: ["query", "analyze"], requiresActiveDrawing: true, safeForRetry: true, pluginMethods: ["calculateSlopeGeometry"], execute: async (args) => await withApplicationConnection(async (appClient) => await appClient.sendCommand("calculateSlopeGeometry", { alignmentName: args.alignmentName ?? null, profileName: args.profileName ?? null, surfaceName: args.surfaceName ?? null, cutSlopeRatio: args.cutSlopeRatio ?? 2.0, fillSlopeRatio: args.fillSlopeRatio ?? 3.0, benchWidth: args.benchWidth ?? 0, benchHeightInterval: args.benchHeightInterval ?? 20, stationStart: args.stationStart ?? null, stationEnd: args.stationEnd ?? null, stationInterval: args.stationInterval ?? 10, roadwayWidth: args.roadwayWidth ?? null })) },
  },
  exposures: [
    { toolName: "civil3d_slope_analysis", displayName: "Civil 3D Slope Analysis", description: "Calculates slope geometry through a single domain tool. Geotechnical stability checks require an engineer-approved external analysis model and are not advertised as a Civil 3D managed-API operation.", inputShape: { action: z.enum(["geometry_calculate"]), alignmentName: z.string().optional(), profileName: z.string().optional(), surfaceName: z.string().optional(), cutSlopeRatio: z.number().optional(), fillSlopeRatio: z.number().optional(), benchWidth: z.number().optional(), benchHeightInterval: z.number().optional(), stationStart: z.number().optional(), stationEnd: z.number().optional(), stationInterval: z.number().optional(), roadwayWidth: z.number().optional() }, supportedActions: ["geometry_calculate"], resolveAction: (rawArgs) => ({ action: String(rawArgs.action ?? ""), args: rawArgs }) },
    { toolName: "civil3d_slope_geometry_calculate", displayName: "Civil 3D Slope Geometry Calculate", description: "Calculates daylight and slope geometry along an alignment.", inputShape: { alignmentName: z.string().optional(), profileName: z.string().optional(), surfaceName: z.string().optional(), cutSlopeRatio: z.number().positive().optional(), fillSlopeRatio: z.number().positive().optional(), benchWidth: z.number().nonnegative().optional(), benchHeightInterval: z.number().positive().optional(), stationStart: z.number().optional(), stationEnd: z.number().optional(), stationInterval: z.number().positive().optional(), roadwayWidth: z.number().nonnegative().optional() }, supportedActions: ["geometry_calculate"], resolveAction: (rawArgs) => ({ action: "geometry_calculate", args: { action: "geometry_calculate", ...rawArgs } }) },
  ],
};
