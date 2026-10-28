import type { Hit } from "../retrieve/types";

/**
 * Gives every chunk the agent sees a stable id (S1, S2, ...) for the whole run, no matter which tool
 * surfaced it or how many times. The model cites these ids; we map them back to chunks.
 */
export class SourceRegistry {
  private byChunk = new Map<number, string>();
  readonly sources: Hit[] = [];

  register(hit: Hit): string {
    const existing = this.byChunk.get(hit.chunkId);
    if (existing) return existing;
    this.sources.push(hit);
    const id = `S${this.sources.length}`;
    this.byChunk.set(hit.chunkId, id);
    return id;
  }

  get(id: string): Hit | undefined {
    const n = Number(id.replace(/^S/, ""));
    return Number.isInteger(n) ? this.sources[n - 1] : undefined;
  }

  render(hit: Hit): string {
    const id = this.register(hit);
    const section = hit.headingPath.replace(/"/g, "'").replace(/[<>]/g, "");
    return `<source id="${id}" path="${hit.path}" section="${section}">\n${hit.content}\n</source>`;
  }
}
