import { util } from 'fabric';
import type { Canvas, FabricObject } from 'fabric';

// Snapshot-based undo. We serialize only the annotation objects (not the background screenshot),
// so undo never re-decodes the snapshot, and we leave the background untouched. Bounded so a long
// session can't grow memory without limit.
const MAX_SNAPSHOTS = 60;

export class History {
  private stack: object[][] = [[]]; // index 0 is the empty starting state
  private restoring = false;

  constructor(private readonly canvas: Canvas) {}

  get isRestoring(): boolean {
    return this.restoring;
  }

  // Push the current annotation set as a new undo step.
  record(): void {
    if (this.restoring) return;
    this.stack.push(this.canvas.getObjects().map((o) => o.toObject()));
    if (this.stack.length > MAX_SNAPSHOTS) this.stack.shift();
  }

  async undo(): Promise<void> {
    if (this.restoring || this.stack.length <= 1) return;
    this.stack.pop();
    await this.restore(this.stack[this.stack.length - 1]);
  }

  // Remove all annotations as a single undoable step.
  async clear(): Promise<void> {
    if (this.restoring || this.canvas.getObjects().length === 0) return;
    await this.restore([]);
    this.record();
  }

  private async restore(snapshot: object[]): Promise<void> {
    this.restoring = true;
    try {
      this.canvas.remove(...this.canvas.getObjects());
      if (snapshot.length) {
        const objects = await util.enlivenObjects<FabricObject>(snapshot);
        objects.forEach((o) => this.canvas.add(o));
      }
      this.canvas.discardActiveObject();
      this.canvas.requestRenderAll();
    } finally {
      this.restoring = false;
    }
  }
}
