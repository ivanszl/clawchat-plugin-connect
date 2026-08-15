import type { ConnectPluginProbeEntry } from "../sdk";
import { probeCompatibleOpenCodeExecutable } from "./opencode-compatibility";

const probe: ConnectPluginProbeEntry = {
  probe: probeCompatibleOpenCodeExecutable,
};

export default probe;
