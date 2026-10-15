/**
 * The IPC contract between the renderer (through the preload bridge) and the
 * main process: every channel name, in one place.
 *
 * Both sides import their ipcMain / ipcRenderer through typed views
 * (src/main/ipc/typedIpc.ts and src/preload/index.ts) whose `channel` parameter
 * only accepts names from these lists, so a misspelled or renamed channel is a
 * compile error instead of a handler that silently never fires.
 * test/ipc-contract.test.cjs checks the other half: every channel here has
 * exactly one handler and is actually used.
 *
 * Adding a channel: add it here, register it in main, call it from preload.
 *
 * Shared between main and preload; keep it dependency-free.
 */

/** renderer → main request/response: ipcRenderer.invoke ↔ ipcMain.handle. */
export const INVOKE_CHANNELS = [
  'analytics:messageSent',
  'app:cancelClose', 'app:cancelClosingTime', 'app:confirmClose', 'app:copyToClipboard', 'app:info', 'app:openExternal', 'app:readClipboard', 'app:resetAll', 'app:setLoginItem', 'app:setNotifications', 'app:startClosingTime',
  'clipboard:saveImage',
  'config:changeHome', 'config:ensureHome', 'config:get', 'config:setAgentTokenCap', 'config:update',
  'control:autoDelivery', 'control:gateTool', 'control:halt', 'control:pause', 'control:resume', 'control:setBreakerState', 'control:snapshot', 'control:steer',
  'dialog:attachFiles', 'dialog:chooseFolder',
  'freeflow:setConfig', 'freeflow:transcribe',
  'fs:listDir', 'fs:readBinary', 'fs:readFile', 'fs:revealPath', 'fs:statAbs', 'fs:writeFile',
  'git:aheadBehind', 'git:branch', 'git:branches', 'git:checkout', 'git:commitFiles', 'git:compareRefs', 'git:diff', 'git:isRepo', 'git:log', 'git:logGraph', 'git:mainRepo', 'git:showFile', 'git:status', 'git:worktrees',
  'github:ciRuns', 'github:issues',
  'hero:payload',
  'hire:drainPending', 'hire:openFile',
  'history:add', 'history:list', 'history:search',
  'hive:addTask', 'hive:agentContext', 'hive:agentDirectory', 'hive:agentUsage', 'hive:board', 'hive:deleteTask', 'hive:inbox', 'hive:log', 'hive:memory', 'hive:memoryStatus', 'hive:memoryWakeUp', 'hive:messages', 'hive:mineNow', 'hive:patchAgentRole', 'hive:patchTask', 'hive:registry', 'hive:renameAgent', 'hive:searchMemory', 'hive:send', 'hive:setAgentHold', 'hive:setArchived', 'hive:tasks', 'hive:textSearch',
  'integrations:list', 'integrations:remove', 'integrations:setSecret', 'integrations:templates', 'integrations:test', 'integrations:upsert',
  'kg:addFiles', 'kg:get', 'kg:ingestFiles', 'kg:list', 'kg:remove', 'kg:search', 'kg:status',
  'memory:reflectNow',
  'missions:list', 'missions:save',
  'models:catalog',
  'org:getTrigger', 'org:setTrigger',
  'providerKey:clear', 'providerKey:has', 'providerKey:set',
  'pty:kill', 'pty:list', 'pty:redraw', 'pty:resize', 'pty:spawn', 'pty:write',
  'realtime:action', 'realtime:action:cancel', 'realtime:action:confirm', 'realtime:drainCompletions', 'realtime:hasKey', 'realtime:mintToken', 'realtime:setSessionLive', 'realtime:waitFor',
  'roster:write',
  'session:resolveCwd',
  'skills:catalog', 'skills:install', 'skills:local', 'skills:reveal', 'skills:uninstall',
  'slack:reply', 'slack:replyScriptPath', 'slack:setConfig', 'slack:start', 'slack:status', 'slack:stop',
  'telemetry:snapshot', 'telemetry:spans', 'telemetry:usage',
  'terminal:openAtFolder',
  'tools:status',
  'triggerHistory:clear', 'triggerHistory:decide', 'triggerHistory:list',
  'triggers:getContext', 'triggers:setContext',
  'update:checkNow', 'update:current', 'update:download', 'update:openRelease', 'update:restartAndInstall', 'update:simulate',
  'webhook:generateSecret', 'webhook:setConfig', 'webhook:start', 'webhook:status', 'webhook:stop',
  'webhooks:delete', 'webhooks:generateSecret', 'webhooks:list', 'webhooks:save', 'webhooks:status',
  'window:newFloor',
  'workers:list', 'workers:stop'
] as const;
export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];

/** renderer → main synchronous: ipcRenderer.sendSync ↔ ipcMain.on. Blocks the
 *  renderer until main replies, so reserve it for startup reads. */
export const SYNC_CHANNELS = [
  'app:readClipboardSync', 'config:homeSync', 'roster:readSync'
] as const;
export type SyncChannel = (typeof SYNC_CHANNELS)[number];

/** main → renderer push: webContents.send ↔ ipcRenderer.on. */
export const EVENT_CHANNELS = [
  'app:closeRequested', 'app:closingTime',
  'config:changed',
  'control:approvalRequest', 'control:breakerState',
  'hire:error', 'hire:import',
  'hive:agentArchived', 'hive:agentSpawned', 'hive:contextUpdate', 'hive:degraded', 'hive:hookEvent', 'hive:message', 'hive:terminalHandoff',
  'mission:autoCompact',
  'missions:updated',
  'power:resume',
  'realtime:completion', 'realtime:enqueue', 'realtime:floorDelta',
  'slack:incomingMessage',
  'telemetry:event',
  'trigger:context',
  'triggerHistory:updated',
  'update:status'
] as const;

/** Per-terminal streams, addressed by PTY id (only the owning window receives them). */
export type PtyEventChannel = `pty:data:${string}` | `pty:exit:${string}` | `pty:relaunch:${string}`;
export type EventChannel = (typeof EVENT_CHANNELS)[number] | PtyEventChannel;
