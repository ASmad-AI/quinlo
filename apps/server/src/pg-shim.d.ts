/**
 * Minimal type declarations for the `pg` driver, covering only the surface
 * the Postgres adapter uses. This avoids pulling in @types/pg.
 */
declare module "pg" {
  export interface QueryResultRow {
    [column: string]: unknown;
  }

  export interface PoolClient {
    query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
    release(): void;
  }

  export interface PoolConfig {
    connectionString?: string;
    max?: number;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    on(event: "error", listener: (err: Error) => void): this;
    query(text: string, values?: unknown[]): Promise<{ rows: QueryResultRow[] }>;
  }
}
