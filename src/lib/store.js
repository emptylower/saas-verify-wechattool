import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const INITIAL_STATE = {
  bindings: [],
  pendingBindIntents: [],
  attempts: []
};

export function createId() {
  return crypto.randomUUID();
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.queue = Promise.resolve();
  }

  async ensureFile() {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      await access(this.filePath);
    } catch {
      await writeFile(this.filePath, `${JSON.stringify(INITIAL_STATE, null, 2)}\n`, 'utf8');
    }
  }

  async readState() {
    await this.ensureFile();
    const raw = await readFile(this.filePath, 'utf8');
    return JSON.parse(raw);
  }

  async writeState(state) {
    const temporaryPath = `${this.filePath}.${createId()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  transaction(work) {
    const operation = this.queue.then(async () => {
      const state = await this.readState();
      const result = await work(state);
      await this.writeState(state);
      return result;
    });

    this.queue = operation.catch(() => {});
    return operation;
  }

  read(work) {
    const operation = this.queue.then(async () => {
      const state = await this.readState();
      return work(state);
    });

    this.queue = operation.catch(() => {});
    return operation;
  }
}
