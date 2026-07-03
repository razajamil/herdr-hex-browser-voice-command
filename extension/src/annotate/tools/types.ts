import type { Canvas } from 'fabric';

export type ToolName = 'pen' | 'rect' | 'text' | 'arrow';

// What a tool is handed when it's active. The `begin`/`commit`/`cancel` trio lets a tool wrap a
// multi-step interaction (e.g. drag-to-draw a rectangle) so the intermediate object churn isn't
// recorded to undo history or pushed to the daemon — only the finished result is.
export interface ToolContext {
  readonly canvas: Canvas;
  begin(): void; // pause change tracking for an in-progress interaction
  commit(): void; // resume tracking and record the finished result
  cancel(): void; // resume tracking without recording (interaction produced nothing)
}

export interface Tool {
  readonly name: ToolName;
  activate(ctx: ToolContext): void;
  deactivate(ctx: ToolContext): void;
}
