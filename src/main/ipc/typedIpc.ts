/**
 * Electron's ipcMain, narrowed to the channel names in src/shared/ipcChannels.ts.
 *
 * Main-process modules import `ipcMain` from here instead of from 'electron'.
 * Call sites read exactly as before (`ipcMain.handle(<channel>, …)`), but a
 * channel that is not in the contract no longer compiles. It is the same object
 * at runtime — only the type is narrower.
 */
import { ipcMain as electronIpcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import type { InvokeChannel, SyncChannel } from '../../shared/ipcChannels';

export interface TypedIpcMain {
  // `any[]` mirrors Electron's own listener type: each handler validates its args.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handle(channel: InvokeChannel, listener: (event: IpcMainInvokeEvent, ...args: any[]) => unknown): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(channel: SyncChannel, listener: (event: IpcMainEvent, ...args: any[]) => void): TypedIpcMain;
}

export const ipcMain: TypedIpcMain = electronIpcMain as unknown as TypedIpcMain;
