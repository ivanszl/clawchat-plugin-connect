import type { ConnectPluginProbeEntry } from "../sdk";
import { probeCompatibleCodexExecutable } from "./codex-compatibility";

const codexProbe: ConnectPluginProbeEntry = {
  probe: probeCompatibleCodexExecutable,
};

export default codexProbe;
