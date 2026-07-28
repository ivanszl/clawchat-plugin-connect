export type RuntimeInteractionTerminalState = "resolved" | "failed" | "expired";

export interface RuntimeInteractionSettlementOptions<Response, Candidate = Response> {
  validate(candidate: Candidate): Response;
}

export class RuntimeInteractionSettlement<Response, Candidate = Response> {
  private current: "pending" | "claimed" | RuntimeInteractionTerminalState = "pending";

  constructor(private readonly options: RuntimeInteractionSettlementOptions<Response, Candidate>) {}

  async claim(candidate: Candidate, deliver: (response: Response) => Promise<void>): Promise<boolean> {
    const response = this.options.validate(candidate);
    if (this.current !== "pending") return false;
    this.current = "claimed";
    try {
      await deliver(response);
      this.current = "resolved";
      return true;
    } catch (error) {
      this.current = "failed";
      throw error;
    }
  }

  expire(): boolean {
    if (this.current !== "pending") return false;
    this.current = "expired";
    return true;
  }

  terminalState(): RuntimeInteractionTerminalState | null {
    return this.current === "resolved" || this.current === "failed" || this.current === "expired" ? this.current : null;
  }
}
