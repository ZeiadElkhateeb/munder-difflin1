'use strict';

// The main-process composition root used to be one file (src/main/index.ts), and
// several tests pin behaviour there by reading it as text, because those modules
// import electron and cannot load under plain node. It is now split by domain;
// this returns the same code those tests used to read, as one string.
//
// Line endings are normalized to '\n' so a CRLF checkout (core.autocrlf=true on
// Windows) does not fail regexes written against the repository's LF text.

const fs = require('node:fs');
const path = require('node:path');

const MAIN = path.join(__dirname, '..', 'src', 'main');

/** Every file that was carved out of the original src/main/index.ts. */
const MAIN_WIRING_FILES = [
  'index.ts',
  'services.ts',
  'windows.ts',
  'quitState.ts',
  'agentSpawn.ts',
  'workers.ts',
  'schedules.ts',
  'heartbeat.ts',
  'slackService.ts',
  'webhookService.ts',
  'lifecycle.ts',
  'realtimeWiring.ts',
  'ipc/appIpc.ts',
  'ipc/catalogIpc.ts',
  'ipc/configIpc.ts',
  'ipc/fsGitIpc.ts',
  'ipc/hiveIpc.ts',
  'ipc/integrationsIpc.ts'
];

function readMainSource() {
  return MAIN_WIRING_FILES
    .map((rel) => fs.readFileSync(path.join(MAIN, rel), 'utf8').replace(/\r\n/g, '\n'))
    .join('\n');
}

module.exports = { readMainSource, MAIN_WIRING_FILES };
