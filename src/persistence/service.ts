import { ConnectStateStore } from "./state";
import type { ConnectStateOptions } from "./state-types";

export { CONNECT_SQLITE_APPLICATION_ID, CONNECT_SQLITE_SCHEMA_VERSION } from "./sqlite-provider";

export interface PersistenceService {
  readonly state: ConnectStateStore;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

class SqlitePersistenceService implements PersistenceService {
  readonly state: ConnectStateStore;

  constructor(options: ConnectStateOptions = {}) {
    this.state = new ConnectStateStore(options);
  }

  async initialize(): Promise<void> {
    await this.state.initialize();
  }

  async close(): Promise<void> {
    await this.state.close();
  }
}

export function createSqlitePersistenceService(options: ConnectStateOptions = {}): PersistenceService {
  return new SqlitePersistenceService(options);
}
