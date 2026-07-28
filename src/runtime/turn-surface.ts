import type { MaterializedRuntimeReply } from "../output-visibility";
import type { RuntimeActivity } from "./types";

export interface TurnSurface {
  readonly origin: "client" | "clawchat";
  accept(event: RuntimeActivity): Promise<void>;
  complete(): Promise<void>;
}

export interface ClientTurnSurfaceOptions {
  project(event: RuntimeActivity): Promise<void>;
}

export class ClientTurnSurface implements TurnSurface {
  readonly origin = "client" as const;

  constructor(private readonly options: ClientTurnSurfaceOptions) {}

  async accept(event: RuntimeActivity): Promise<void> {
    await this.options.project(event);
  }

  async complete(): Promise<void> {}

  async fail(error: unknown): Promise<void> {
    await this.options.project({
      id: `client-failure:${Date.now()}`,
      position: `${Date.now()}`,
      parentId: null,
      kind: "error",
      text: `Connect Client turn failed: ${error instanceof Error ? error.message : String(error)}`,
      state: "error",
      source: "live",
      data: { outputKind: "final" },
    });
  }
}

export interface ClawChatTurnSurfaceOptions {
  project(event: RuntimeActivity): Promise<void>;
  materialize(event: RuntimeActivity): MaterializedRuntimeReply | null;
  deliver(reply: MaterializedRuntimeReply): Promise<void>;
}

export class ClawChatTurnSurface implements TurnSurface {
  readonly origin = "clawchat" as const;
  private readonly buffered: MaterializedRuntimeReply[] = [];

  constructor(private readonly options: ClawChatTurnSurfaceOptions) {}

  async accept(event: RuntimeActivity): Promise<void> {
    await this.options.project(event);
    const reply = this.options.materialize(event);
    if (!reply) return;
    if (reply.requiredControl) await this.options.deliver(reply);
    else this.buffered.push(reply);
  }

  async complete(): Promise<void> {
    for (const reply of this.buffered.splice(0)) await this.options.deliver(reply);
  }
}
