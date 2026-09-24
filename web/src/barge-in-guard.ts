type Mode = "idle" | "candidate" | "accepted";

/**
 * A tentative VAD start ducks output. The active turn is cancelled only after
 * VAD confirms speech, so a short echo/noise blip can resume the same reply.
 */
export class BargeInGuard {
  private mode: Mode = "idle";
  private interruptOnConfirm = false;

  speechStart(hasActiveTurn: boolean) {
    this.mode = "candidate";
    this.interruptOnConfirm = hasActiveTurn;
    return { duck: hasActiveTurn, begin: true, accepted: false };
  }

  speechRealStart() {
    if (this.mode === "candidate") {
      this.mode = "accepted";
      return { interrupt: this.interruptOnConfirm, begin: false, accepted: true };
    }
    return { interrupt: false, begin: false, accepted: this.mode === "accepted" };
  }

  speechEnd() {
    const accepted = this.mode === "accepted";
    this.reset();
    return accepted;
  }

  reset() {
    this.mode = "idle";
    this.interruptOnConfirm = false;
  }
}
