import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
    ListToolsRequestSchema,
    CallToolRequestSchema,
    ErrorCode,
    McpError,
    type Tool
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

type ToolHandler<T extends z.ZodRawShape> = (
    args: z.infer<z.ZodObject<T>>
) => Promise<{
    content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>;
    isError?: boolean;
}>;

export class McpServer {
    private server: Server;
    private tools: Map<
        string,
        {
            description?: string;
            parameters: z.ZodObject<any>;
            handler: ToolHandler<any>;
        }
    > = new Map();

    constructor(info: { name: string; version: string }) {
        this.server = new Server(info, {
            capabilities: {
                tools: {},
            },
        });

        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: Array.from(this.tools.entries()).map(([name, tool]): Tool => ({
                    name,
                    description: tool.description,
                    inputSchema: zodToJsonSchema(tool.parameters) as Tool["inputSchema"],
                })),
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            const tool = this.tools.get(request.params.name);
            if (!tool) {
                throw new McpError(ErrorCode.MethodNotFound, `Tool not found: ${request.params.name}`);
            }

            const args = tool.parameters.safeParse(request.params.arguments);
            if (!args.success) {
                throw new McpError(ErrorCode.InvalidParams, `Invalid arguments: ${args.error.message}`);
            }

            return await tool.handler(args.data);
        });
    }

    tool<T extends z.ZodRawShape>(
        name: string,
        description: string,
        parameters: T,
        handler: ToolHandler<T>
    ) {
        this.tools.set(name, {
            description,
            parameters: z.object(parameters),
            handler,
        });
    }

    async connect(transport: Transport) {
        return this.server.connect(transport);
    }
}
