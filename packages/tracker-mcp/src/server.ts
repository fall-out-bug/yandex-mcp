import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerTools } from "./tools.js"

export const SERVER_NAME = "tracker-mcp"
export const SERVER_VERSION = "0.1.0"

/** Build the MCP server with all Tracker tools registered. */
export function createServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerTools(server)
  return server
}
