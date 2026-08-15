import { containsExplicitReplyMedia, containsNoReplySignal, stripNoReplySignals } from "../clawchat/no-reply";
import type { MaterializedRuntimeReply } from "../clawchat/output-visibility";
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
  noReplyProtocol?: boolean;
  project(event: RuntimeActivity): Promise<void>;
  materialize(event: RuntimeActivity): MaterializedRuntimeReply | null;
  deliver(event: RuntimeActivity, reply: MaterializedRuntimeReply): Promise<void>;
}

export interface ConnectTurnSurfaceCapabilities {
  createClient(options: { sessionRef: string }): ClientTurnSurface;
  createClawChat(options: Omit<ClawChatTurnSurfaceOptions, "project"> & { sessionRef: string }): ClawChatTurnSurface;
}

export class ClawChatTurnSurface implements TurnSurface {
  readonly origin = "clawchat" as const;
  private readonly buffered = new Map<string, { event: RuntimeActivity; reply: MaterializedRuntimeReply }>();

  constructor(private readonly options: ClawChatTurnSurfaceOptions) {}

  async accept(event: RuntimeActivity): Promise<void> {
    await this.options.project(event);
    const reply = this.options.materialize(event);
    if (!reply) {
      this.buffered.delete(event.id);
      return;
    }
    if (reply.requiredControl) await this.options.deliver(event, reply);
    else this.buffered.set(event.id, { event, reply });
  }

  async complete(): Promise<void> {
    const deliveries = [...this.buffered.values()];
    this.buffered.clear();
    const terminal = deliveries.findLast(
      ({ event }) => event.data?.outputKind === "final" && event.state === "complete",
    );
    if (this.options.noReplyProtocol && terminal && containsNoReplySignal(terminal.reply.text)) {
      if (containsExplicitReplyMedia(terminal.reply.text)) {
        await this.options.deliver(terminal.event, {
          ...terminal.reply,
          text: stripNoReplySignals(terminal.reply.text),
        });
      }
      return;
    }
    for (const { event, reply } of deliveries) {
      await this.options.deliver(event, reply);
    }
  }
}
