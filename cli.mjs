#!/usr/bin/env node

import * as net from 'net';
import * as fs from 'fs';
import * as path from 'path';

const SOCKET_PATH = '/tmp/toddy.sock';
const AGENTS_JSON_PATH = '/home/deploy/agents/agents.json';
const AGENTS_DIR = '/home/deploy/agents';

// Load agents for >>gansnaam lookups
let agents = [];
try {
  const agentsData = JSON.parse(fs.readFileSync(AGENTS_JSON_PATH, 'utf8'));
  agents = agentsData.agents || [];
} catch (err) {
  // Agents file not found, that's ok
}

// Get pubkey for a gans name
function getGansPubkey(gansnaam) {
  // Check if it's an agent name
  const agent = agents.find(a => a.name.toLowerCase() === gansnaam.toLowerCase());
  if (agent) return agent.pubkey;

  // Try to read from agents/<gansnaam>/nostr-key.json
  try {
    const keyPath = path.join(AGENTS_DIR, gansnaam.toLowerCase(), 'nostr-key.json');
    const keyData = JSON.parse(fs.readFileSync(keyPath, 'utf8'));
    return keyData.pubkey;
  } catch (err) {
    return null;
  }
}

function findAgentName(name) {
  console.error(`[findAgentName] Looking for "${name}" in ${agents.length} agents`);
  const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
  console.error(`[findAgentName] Found: ${agent ? agent.name : 'null'}`);
  return agent ? agent.name : null;
}

function parseArgs() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    printHelp();
    process.exit(1);
  }

  const cmd = args[0];
  let targetGans = null;
  let message = args.slice(1).join(' ');

  // Check for >>gansnaam or >>@gansnaam
  const lastArg = args[args.length - 1];
  if (lastArg.startsWith('>>')) {
    // Extract gansnaam: >>commy or >>@commy -> commy
    const gansnaamMatch = lastArg.match(/>>@?(\w+)/);
    if (gansnaamMatch) {
      const gansnaam = gansnaamMatch[1];
      const found = findAgentName(gansnaam);
      if (!found) {
        console.error(`❌ Unknown gans: ${gansnaam}`);
        if (agents.length > 0) {
          console.log('Available ganzen:', agents.map((a) => a.name).join(', '));
        }
        process.exit(1);
      }
      targetGans = found;
      message = args.slice(1, -1).join(' ');
    }
  }

  return { cmd, message, targetGans };
}

function sendCommand(command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH, () => {
      socket.write(`${command}\n`);

      let response = '';
      socket.on('data', (data) => {
        response += data.toString();
      });

      socket.on('end', () => {
        resolve(response.trim());
        socket.destroy();
      });

      socket.on('error', (err) => {
        reject(err);
      });

      // Timeout if no response
      setTimeout(() => {
        socket.destroy();
        reject(new Error('Socket timeout (10s)'));
      }, 10000);
    });

    socket.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`Socket not found at ${SOCKET_PATH}. Is the bot running?`));
      } else {
        reject(err);
      }
    });
  });
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

For another gans (supports >>gansnaam):
  toddy add "text" >>gansnaam        Add TODO for gans
  toddy list >>finny                 Show Finny's TODOs

Examples:
  toddy add "Refactor Zaphunt"
  toddy add "Buy milk" >>coachy
  toddy list
  toddy done 1

Note: Bot must be running for CLI to work
  sudo systemctl status nostr-todo-bot
`);
}

async function main() {
  const { cmd, message, targetGans } = parseArgs();

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    process.exit(0);
  }

  // Determine caller pubkey
  // If called as >>gansnaam, use that gans's pubkey
  // Otherwise, try to read from TODDY_GANS env var or default to toddy
  let callerGans = process.env.TODDY_GANS || 'toddy';
  let callerPubkey = getGansPubkey(callerGans);

  if (!callerPubkey) {
    console.error(`❌ Error: Could not find pubkey for ${callerGans}`);
    process.exit(1);
  }

  // Build command with caller pubkey and optional target gans
  let command = message ? `${cmd} ${message}` : cmd;
  command = `@${callerPubkey}:${command}`;

  if (targetGans) {
    command += ` >>@${targetGans}`;
  }


  try {
    const response = await sendCommand(command);
    console.log(response);
  } catch (err) {
    console.error(`❌ Error: ${err.message}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`❌ Fatal error: ${err.message}`);
  process.exit(1);
});
