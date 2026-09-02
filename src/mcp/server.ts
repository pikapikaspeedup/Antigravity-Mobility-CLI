#!/usr/bin/env node

/**
 * Antigravity MCP Server
 * Exposes internal agent registries and dispatch capabilities to external LLMs.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { fileURLToPath } from "url";
import path from "path";
import type { InterventionAction } from "../lib/agents/group-runtime.js";

// 1. MCP stdio requires stdout to be EXCLUSIVELY JSON-RPC.
//    Redirect all pino-pretty output to stderr by setting this env var
//    BEFORE any module imports trigger logger initialization.
process.env.ANTIGRAVITY_MCP = '1';

// 2. Calculate project root and enforce it BEFORE any local imports
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "../../");
process.chdir(projectRoot);

const server = new McpServer({
  name: "antigravity-mcp-server",
  version: "1.0.0"
});

async function main() {
// 2. Dynamically import everything else so that `process.cwd()` is correctly set first
const { listProjects, getProject } = await import("../lib/agents/project-registry.js");
const { getRun } = await import("../lib/agents/run-registry.js");
const { interveneRun, cancelRun } = await import("../lib/agents/group-runtime.js");



// Tool: antigravity_list_projects
server.registerTool(
  "antigravity_list_projects",
  {
    title: "List Projects",
    description: "List all active and completed projects with their high-level pipeline status.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(100).default(20).describe("Maximum results to return"),
      offset: z.number().int().min(0).default(0).describe("Number of results to skip")
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    }
  },
  async ({ limit, offset }) => {
    try {
      const projects = listProjects();
      const paginated = projects.slice(offset, offset + limit);
      
      const output = {
        total: projects.length,
        count: paginated.length,
        offset,
        projects: paginated.map((p: any) => ({
          projectId: p.projectId,
          name: p.name,
          status: p.status,
          pipelineState: p.pipelineState ? {
             status: p.pipelineState.status,
             currentStageIndex: p.pipelineState.currentStageIndex,
             templateId: p.pipelineState.templateId
          } : null,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt
        }))
      };

      return {
        content: [{ type: "text", text: JSON.stringify(output, null, 2) }],
        structuredContent: output
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// Tool: antigravity_get_project
server.registerTool(
  "antigravity_get_project",
  {
    title: "Get Project Details",
    description: "Get detailed status of a specific project, including its pipeline stages and corresponding runs.",
    inputSchema: z.object({
      projectId: z.string().describe("The ID of the project to retrieve")
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ projectId }) => {
    try {
      const project = getProject(projectId);
      if (!project) {
        return { content: [{ type: "text", text: `Error: Project not found: ${projectId}` }] };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(project, null, 2) }],
        structuredContent: project as any
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// Tool: antigravity_get_run
server.registerTool(
  "antigravity_get_run",
  {
    title: "Get Agent Run Details",
    description: "Get the detailed status of an agent run (roles, review decisions, supervisor logs).",
    inputSchema: z.object({
      runId: z.string().describe("The ID of the run to retrieve")
    }),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  },
  async ({ runId }) => {
    try {
      const run = getRun(runId);
      if (!run) {
        return { content: [{ type: "text", text: `Error: Run not found: ${runId}` }] };
      }
      
      // We can return the full JSON, but let's provide a summary in text too
      let textContent = `Status: ${run.status}  Round: ${run.currentRound || "?"}  Group: ${run.groupId}\n`;
      if (run.lastError) textContent += `Error: ${run.lastError}\n`;
      const roles = run.roles || [];
      textContent += `Total role entries: ${roles.length}\n`;
      roles.forEach((r: any, i: number) => {
        textContent += `  [${i}] ${r.roleId.padEnd(30)} R${r.round || "?"} ${r.status} decision=${r.reviewDecision || "-"}\n`;
      });
      const sups = run.supervisorReviews || [];
      if (sups.length > 0) {
         const latest = sups[sups.length - 1];
         textContent += `Latest supervisor: ${latest.decision?.status || "?"} — ${(latest.decision?.analysis || "").slice(0, 120)}\n`;
      }
      
      textContent += `\nFull JSON:\n${JSON.stringify(run, null, 2)}`;

      return {
        content: [{ type: "text", text: textContent }],
        structuredContent: run as any
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// Tool: antigravity_intervene_run
server.registerTool(
  "antigravity_intervene_run",
  {
    title: "Intervene on Run",
    description: "Perform an intervention (retry, restart_role, nudge, cancel) on a stuck or failed run.",
    inputSchema: z.object({
      runId: z.string().describe("The ID of the run to intervene on"),
      action: z.enum(["retry", "restart_role", "nudge", "cancel"]).describe("The intervention action to take"),
      prompt: z.string().optional().describe("Optional prompt/message for the intervention (e.g. feedback for retry)"),
      roleId: z.string().optional().describe("Optional specific roleId to target")
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
  },
  async ({ runId, action, prompt, roleId }) => {
    try {
      const result = action === "cancel"
        ? (await cancelRun(runId), { status: "cancelled", action })
        : await interveneRun(runId, action as InterventionAction, prompt, roleId);
      return {
        content: [{ type: "text", text: `Intervention SUCCESS: \n${JSON.stringify(result, null, 2)}` }],
        structuredContent: result
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

// Tool: antigravity_dispatch_pipeline
server.registerTool(
  "antigravity_dispatch_pipeline",
  {
    title: "Dispatch Pipeline or Group",
    description: "Start a new agent run using a pipeline template or single group ID.",
    inputSchema: z.object({
      workspace: z.string().optional().describe("Ignored. Antigravity 2.0 hub does not use workspaces."),
      prompt: z.string().describe("Goal or prompt for the pipeline/run"),
      projectId: z.string().optional().describe("Optional projectId to attach this run to"),
      templateId: z.string().optional().describe("Template ID (e.g. development-template-1). If provided, it starts a pipeline."),
      groupId: z.string().optional().describe("Group ID (e.g. product-spec). Use this for single-group runs instead of full pipelines."),
      sourceRunIds: z.array(z.string()).optional().describe("For groups that require upstream artifacts")
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
  },
  async ({ workspace, prompt, projectId, templateId, groupId, sourceRunIds }) => {
    try {
      // Forward everything to the Next.js API — let the server handle
      // all template resolution, stage inference, and group lookup.
      // Do NOT pre-resolve here; that would bypass server-side auto-inference
      // for non-first-stage dispatches (e.g. templateId + sourceRunIds).
      if (!groupId && !templateId) {
        throw new Error("Missing required parameter: must provide either groupId or templateId");
      }
      
      // Forward to the Next.js local API to decouple execution from MCP process
      const res = await fetch('http://127.0.0.1:3000/api/agent-runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          groupId,
          workspace,
          prompt,
          projectId,
          templateId,
          sourceRunIds,
        })
      });

      if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`API Dispatch Failed (${res.status}): ${errorText}`);
      }

      const result = await res.json();
      
      return {
        content: [{ type: "text", text: `Dispatch SUCCESS. Run ID: ${result.runId}` }],
        structuredContent: result
      };
    } catch (e) {
      return { content: [{ type: "text", text: `Error: ${e instanceof Error ? e.message : String(e)}` }] };
    }
  }
);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Antigravity MCP Server running via stdio");
}

main().catch(console.error);
