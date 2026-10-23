export type Json = Record<string, any>;
export interface Resource {
  id: string;
  name: string;
  shortName?: string;
  type: string;
  revision: string;
  content?: string;
  readonly?: boolean;
  config?: Json;
  analysis?: { status: string; error?: string; summary?: string };
}
export interface Workspace {
  id: string;
  name: string;
  executionRoot: string;
  pinned?: boolean;
  resourceIds: string[];
  resourceVersions?: Record<string, string>;
  updatedAt: number;
}
export interface Conversation {
  id: string;
  title: string;
  type: "chat" | "project";
  workspaceId?: string;
  workspace?: string;
  mode: "act" | "plan" | "goal";
  permissionMode: "read-only" | "workspace-write";
  channel: string;
  model: string;
  turns?: Turn[];
}
export interface Turn {
  runId: string;
  message: string;
  reply: string;
  status: string;
  error?: string;
  events: Json[];
  nativeExecution?: Json;
  verified?: boolean;
}
export interface Channel {
  id: string;
  label: string;
  api: string;
  baseURL: string;
  model: string;
  models: { id: string; name: string }[];
  authConfigured?: boolean;
}
export interface Health {
  state: string;
  model: string;
  channel: string;
  authConfigured: boolean;
  channels: Channel[];
  capabilities: string[];
  lastError?: string;
  agentEngine?: string;
}
export interface DesktopBridge {
  args: string[];
  request: (
    request: { method: string; path: string; body?: Json },
    onEvent?: (event: Json) => void,
  ) => Promise<Json>;
  invoke: (method: string, values?: any[]) => Promise<any>;
  runtimeStatus: () => Promise<Json>;
  retryRuntime: () => Promise<Json>;
  exportDiagnostics: () => Promise<Json>;
  onHostState: (callback: (status: Json) => void) => () => void;
  onEvent: (callback: (name: string, detail: Json) => void) => () => void;
}
declare global {
  interface Window {
    EMBUDDIES_DESKTOP?: DesktopBridge;
  }
}

export type Layer = {
  kind: string;
  workspace?: Workspace;
  resource?: Resource;
  conversation?: Conversation;
  x?: number;
  y?: number;
};
