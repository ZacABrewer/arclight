import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { LogFile, LogPage, LogQuery, LogRecord } from '@media-tron/shared';
import { isLogFileName, listLogFiles, type LogBuffer } from '../../logging.js';

export type LogsErrorCode = 'NOT_FOUND';

export class LogsError extends Error {
  constructor(
    readonly code: LogsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'LogsError';
  }
}

export interface LogsSource {
  buffer: LogBuffer;
  logDir: string;
  fileName: string;
}

/** Reads the logger's ring buffer and log folder (see src/logging.ts). */
export class LogsService {
  constructor(private readonly source: LogsSource) {}

  query(q: Partial<LogQuery>): LogPage {
    return this.source.buffer.query(q);
  }

  clear(): void {
    this.source.buffer.clear();
  }

  subscribe(listener: (record: LogRecord) => void): () => void {
    return this.source.buffer.subscribe(listener);
  }

  files(): LogFile[] {
    return listLogFiles(this.source.logDir, this.source.fileName);
  }

  /** Absolute path of a log file by name; only the active file and its rotations resolve. */
  resolveFile(name: string): { path: string; sizeBytes: number } {
    if (!isLogFileName(name, this.source.fileName)) throw new LogsError('NOT_FOUND', `No log file named ${name}`);
    const path = join(this.source.logDir, name);
    if (!existsSync(path)) throw new LogsError('NOT_FOUND', `No log file named ${name}`);
    return { path, sizeBytes: statSync(path).size };
  }
}
