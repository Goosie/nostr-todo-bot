#!/usr/bin/env node

import * as net from 'net';
import { readFileSync } from 'fs';

const SOCKET_PATH = '/tmp/toddy.sock';
const AGENTS_JSON_PATH = '/home/deploy/agents/agents.json';

// Load agents for >>gansnaam lookups
let agents = [];
try {
  const agentsData = JSON.parse(readFileSync(AGENTS_JSON_PATH, 'utf8'));
  agents = agentsData.agents || [];
} catch (err) {
  // Agents file not found, that's ok
}

function findAgentName(name) {
  const agent = agents.find((a) => a.name.toLowerCase() === name.toLowerCase());
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

  // Check for >>gansnaam
  const lastArg = args[args.length - 1];
  if (lastArg.startsWith('>>')) {
    const gansnaam = lastArg.slice(2);
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
        reject(new Error('Socket timeout'));
      }, 5000);
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

  // Build command with optional target gans
  let command = message ? `${cmd} ${message}` : cmd;
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

main();
