import type { ConnectPluginProbeEntry } from "../sdk";
import { probeOfficialWorkBuddyRuntimes } from "./workbuddy-compatibility";

const probe: ConnectPluginProbeEntry = {
  probe: probeOfficialWorkBuddyRuntimes,
};

export default probe;
