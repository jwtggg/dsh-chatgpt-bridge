/**
 * MCP server surface: data-plane and control-plane dsh_* tools ChatGPT calls.
 * Every tool maps onto a Bridge operation; nothing here reaches the filesystem,
 * the shell, or DSH internals directly. Outputs are JSON text blocks; failures
 * are reported as isError results with { error: { code, message } }.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Bridge } from './bridge.js';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
/**
 * Every tool that belongs to the supervised-Goal continuation protocol.
 * `disableGoalTools` removes exactly these, leaving the plain session surface.
 */
export declare const GOAL_TOOLS: readonly string[];
export declare function createMcpServer(bridge: Bridge, cfg: ResolvedBridgeConfig, log: BridgeLogger): McpServer;
