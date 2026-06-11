#!/usr/bin/env node

import 'websocket-polyfill';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  finalizeEvent,
  getEventHash,
  nip44,
  SimplePool,
} from 'nostr-tools';

const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:7778';
const TODDY_KEY_PATH = '/home/deploy/agents/toddy/nostr-key.json';

// Load Toddy's key
const toddyKey = JSON.parse(readFileSync(TODDY_KEY_PATH, 'utf8'));
const toddySk = new Uint8Array(Buffer.from(toddyKey.nsecHex, 'hex'));
const toddyPubkey = toddyKey.pubkey;

// Load all agent keys for >>gansnaam lookups
const agentsJsonPath = '/home/deploy/agents/agents.json';
let agents = [];

try {
  const agentsData = JSON.parse(readFileSync(agentsJsonPath, 'utf8'));
  agents = agentsData.agents || [];
} catch (err) {
  console.error('Warning: Could not load agents.json');
}

// Find agent by name
function findAgentPubkey(name) {
  const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  return agent ? agent.pubkey : null;
}

// Parse command line
function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const cmd = args[0];
  let targetPubkey = toddyPubkey; // Default: Perry (use Toddy's pubkey for local testing)
  let message = args.slice(1).join(' ');

  // Check for >>gansnaam
  const lastArg = args[args.length - 1];
  if (lastArg.startsWith('>>')) {
    const gansnaam = lastArg.slice(2);
    const pubkey = findAgentPubkey(gansnaam);
    if (!pubkey) {
      console.error(`❌ Unknown gans: ${gansnaam}`);
      console.log('Available ganzen:', agents.map((a) => a.name).join(', '));
      process.exit(1);
    }
    targetPubkey = pubkey;
    message = args.slice(1, -1).join(' ');
  }

  return { cmd, message, targetPubkey };
}

// Create and send DM to Toddy
async function sendCommandToDM(fromPubkey, command) {
  const pool = new SimplePool();

  try {
    const event = {
      id: '',
      kind: 4, // Encrypted DM
      pubkey: fromPubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', toddyPubkey]],
      content: '', // Will be encrypted
      sig: '',
    };

    // Encrypt DM with Toddy's pubkey
    const encryptedContent = nip44.encrypt(toddySk, toddyPubkey, command);
    event.content = encryptedContent;

    // Sign event
    const hash = getEventHash(event);
    event.id = hash;
    const sig = finalizeEvent(event, toddySk);

    // Publish to relay
    await pool.publish([RELAY_URL], sig);
    console.log(`✅ Sent to Toddy: "${command}"`);

    // Close pool
    setTimeout(() => pool.close(), 100);
  } catch (err) {
    console.error(`❌ Error sending command: ${err.message}`);
    process.exit(1);
  }
}

function printHelp() {
  console.log(`
🪿 Toddy TODO CLI

Usage:
  toddy add "text"                   Add a TODO
  toddy list                         Show all TODOs
  toddy done <id>                    Mark as done
  toddy delete <id>                  Delete TODO
  toddy search <keyword>             Search TODOs
  toddy help                         Show help

For another gans:
  toddy add "text" >>gansnaam        Add TODO for gans
  toddy list >>finny                 Show Finny's TODOs

Examples:
  toddy add "Refactor Zaphunt"
  toddy add "Buy milk" >>coachy
  toddy list
  toddy done 1
`);
}

// Main
async function main() {
  const { cmd, message, targetPubkey } = parseArgs();

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  const command = message ? `${cmd} ${message}` : cmd;
  await sendCommandToDM(targetPubkey, command);
}

main().catch((err) => {
  console.error(`❌ Error: ${err.message}`);
  process.exit(1);
});
