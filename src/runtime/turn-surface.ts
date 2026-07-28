import type { MaterializedRuntimeReply, RuntimeOutputEvent } from "../output-visibility";

export interface TurnSurface {
  readonly origin: "client" | "clawchat";
  accept(event: RuntimeOutputEvent): Promise<void>;
  complete(): Promise<void>;
}

export interface ClientTurnSurfaceOptions {
  project(event: RuntimeOutputEvent): Promise<void>;
}

export class ClientTurnSurface implements TurnSurface {
  readonly origin = "client" as const;

  constructor(private readonly options: ClientTurnSurfaceOptions) {}

  async accept(event: RuntimeOutputEvent): Promise<void> {
    await this.options.project(event);
  }

  async complete(): Promise<void> {}
}

export interface ClawChatTurnSurfaceOptions {
  project(event: RuntimeOutputEvent): Promise<void>;
  materialize(event: RuntimeOutputEvent): MaterializedRuntimeReply | null;
  deliver(reply: MaterializedRuntimeReply): Promise<void>;
}

export class ClawChatTurnSurface implements TurnSurface {
  readonly origin = "clawchat" as const;
  private readonly buffered: MaterializedRuntimeReply[] = [];

  constructor(private readonly options: ClawChatTurnSurfaceOptions) {}

  async accept(event: RuntimeOutputEvent): Promise<void> {
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
