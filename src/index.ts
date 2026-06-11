import 'websocket-polyfill';
import { readFileSync, unlinkSync } from 'fs';
import { resolve } from 'path';
import * as readline from 'readline';
import * as net from 'net';
import {
  Event,
  getEventHash,
  getPublicKey,
  finalizeEvent,
  nip19,
  nip44,
  SimplePool,
  verifyEvent,
} from 'nostr-tools';
import { initDatabase } from './db';
import { startServer } from './server';

// Env vars
const RELAY_URL = process.env.RELAY_URL || 'ws://127.0.0.1:7778';
const TODDY_KEY_PATH = process.env.TODDY_KEY_PATH || '/home/deploy/agents/toddy/nostr-key.json';
const SOCKET_PATH = '/tmp/toddy.sock';
const TODO_KIND = 1; // Kind 1 for encrypted TODO storage

// Load Toddy's key
let toddy: { pubkey: string; nsecHex: string; npub: string };
let toddySk: Uint8Array;

function loadToddyKey() {
  const keyData = JSON.parse(readFileSync(TODDY_KEY_PATH, 'utf8'));
  toddy = keyData;
  toddySk = new Uint8Array(Buffer.from(toddy.nsecHex, 'hex'));
  console.log(`[Toddy] Agent loaded`);
}

// Relay and pool
const pool = new SimplePool();

// Rate limiting (per pubkey, max 5 commands per minute)
const commandCounts = new Map<string, number[]>();

function checkRateLimit(pubkey: string): boolean {
  const now = Date.now();
  const oneMinuteAgo = now - 60000;

  if (!commandCounts.has(pubkey)) {
    commandCounts.set(pubkey, []);
  }

  const timestamps = commandCounts.get(pubkey)!;
  const recent = timestamps.filter((t) => t > oneMinuteAgo);

  if (recent.length >= 5) {
    return false; // Rate limit exceeded
  }

  recent.push(now);
  commandCounts.set(pubkey, recent);
  return true;
}

// Create a TODO event
function createTodoEvent(
  pubkey: string,
  content: string,
  tags: string[][] = [],
  blocknr: number = 0
): Event {
  // Build tags BEFORE calculating hash
  const allTags = [['p', pubkey], ...tags];
  if (blocknr > 0) {
    allTags.push(['blocknr', String(blocknr)]);
  }

  const event = {
    id: '',
    kind: TODO_KIND,
    pubkey: toddy.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: allTags,
    content: '', // Will be encrypted
    sig: '',
  };

  // Encrypt content for the TODO owner
  const conversationKey = nip44.getConversationKey(toddySk, pubkey);
  const encryptedContent = nip44.encrypt(content, conversationKey);
  event.content = encryptedContent;

  const hash = getEventHash(event as any);
  event.id = hash;
  const sig = finalizeEvent(event as any, toddySk);

  return sig;
}

// Decrypt a TODO event
function decryptTodoEvent(event: Event, pubkey: string): string | null {
  try {
    const conversationKey = nip44.getConversationKey(toddySk, pubkey);
    return nip44.decrypt(event.content, conversationKey);
  } catch (err) {
    console.error('[Decrypt] Error:', err);
    return null;
  }
}

// Query TODOs for a user from relay
async function queryUserTodos(pubkey: string): Promise<Array<{ id: string; content: string; blocknr?: number }>> {
  try {
    // querySync is actually async (returns Promise despite the name)
    // Query all Kind 1 events from Toddy, filter client-side
    console.log(`[Query] Fetching TODOs for pubkey ${pubkey.slice(0, 8)}...`);
    const events = await pool.querySync([RELAY_URL], {
      kinds: [TODO_KIND],
      authors: [toddy.pubkey],
      limit: 1000,
    });

    console.log(`[Query] Got ${events?.length || 'null'} total events`);
    if (events && events.length > 0) {
      console.log(`[Query] Sample event tags:`, events[0].tags.slice(0, 3));
    }

    if (!Array.isArray(events)) {
      console.log('[Query] Events is not array, got:', typeof events);
      return [];
    }

    // First pass: collect all event IDs marked as deleted or done
    const deleteMarkers = new Set<string>();
    const doneMarkers = new Set<string>();
    events.forEach((e) => {
      const eTag = e.tags.find((t) => t[0] === 'e');
      const deleteTag = e.tags.find((t) => t[0] === 'e' && t[3] === 'delete');
      const doneTag = e.tags.find((t) => t[0] === 'e' && t[3] === 'done');
      if (deleteTag && eTag) {
        deleteMarkers.add(eTag[1]);
      }
      if (doneTag && eTag) {
        doneMarkers.add(eTag[1]);
      }
    });

    const todos = events
      .filter((e) => {
        // Filter out delete/done markers
        const isMarker = e.tags.some((t) => t[0] === 'e' && (t[3] === 'delete' || t[3] === 'done'));
        if (isMarker) return false;

        // Skip if this TODO was marked deleted or done
        if (deleteMarkers.has(e.id) || doneMarkers.has(e.id)) return false;

        // Filter client-side: only events where pubkey is in the #p tags
        const pTag = e.tags.find((t) => t[0] === 'p' && t[1] === pubkey);
        return !!pTag;
      })
      .map((e) => {
        const decrypted = decryptTodoEvent(e, pubkey);
        if (!decrypted) return null;

        // Extract block number from tags
        const blocknrTag = e.tags.find((t) => t[0] === 'blocknr');
        const blocknr = blocknrTag ? parseInt(blocknrTag[1], 10) : undefined;

        return { id: e.id, content: decrypted, blocknr };
      })
      .filter((t) => t !== null) as Array<{ id: string; content: string; blocknr?: number }>;

    return todos;
  } catch (err) {
    console.error('[Query] Error:', err);
    return [];
  }
}

// Create and send DM reply
async function sendDmReply(recipientPubkey: string, message: string): Promise<void> {
  try {
    // DM via NIP-17 pattern
    const event = {
      id: '',
      kind: 4, // Encrypted DM
      pubkey: toddy.pubkey,
      created_at: Math.floor(Date.now() / 1000),
      tags: [['p', recipientPubkey]],
      content: '', // Will be encrypted
      sig: '',
    };

    // Encrypt DM
    const conversationKey = nip44.getConversationKey(toddySk, recipientPubkey);
    const encryptedContent = nip44.encrypt(message, conversationKey);
    event.content = encryptedContent;

    const hash = getEventHash(event as any);
    event.id = hash;
    const sig = finalizeEvent(event as any, toddySk);

    await pool.publish([RELAY_URL], sig);
    console.log(`[DM] Sent to ${recipientPubkey.slice(0, 8)}`);
  } catch (err) {
    console.error('[DM] Error:', err);
  }
}

// Command handlers
function commandList(todos: Array<{ id: string; content: string; blocknr?: number }>): string {
  if (todos.length === 0) return '✅ All clear!';

  const lines = todos
    .map((t, i) => {
      const content = t.content.length > 40 ? t.content.slice(0, 37) + '...' : t.content;
      const blockInfo = t.blocknr ? ` (block ${t.blocknr})` : '';
      return `${i + 1}. ${content}${blockInfo}`;
    })
    .join('\n');

  return `📋 Your TODOs:\n${lines}`;
}

function commandAdd(todos: Array<{ id: string; content: string; blocknr?: number }>, content: string): string {
  return `✅ TODO added: "${content}"\nID: ${todos.length + 1}`;
}

function commandDone(todos: Array<{ id: string; content: string; blocknr?: number }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  return `✅ TODO done: "${todo.content}"`;
}

function commandDelete(todos: Array<{ id: string; content: string; blocknr?: number }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  return `🗑️ TODO deleted: "${todo.content}"`;
}

function commandShow(todos: Array<{ id: string; content: string; blocknr?: number }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  const blockInfo = todo.blocknr ? `\nCreated at block ${todo.blocknr}` : '';
  return `📝 #${idx + 1}:\n${todo.content}${blockInfo}`;
}

function commandHelp(): string {
  return `🪿 Toddy TODO Bot — Commands:
- list          Show all TODOs
- add <text>    Add a new TODO
- show <id>     Show full content
- done <id>     Mark as done
- delete <id>   Delete TODO
- search <txt>  Find TODOs
- help          Show this message`;
}

// Helper: get current block number from mempool.space or local Umbrel node
async function getCurrentBlocknr(): Promise<number> {
  try {
    // Try local Umbrel node first (via Tailscale)
    const localResponse = await fetch('http://100.111.14.11:3006/api/blocks/tip/height', {
      timeout: 3000,
    }).catch(() => null);

    if (localResponse?.ok) {
      const height = await localResponse.text();
      return parseInt(height, 10);
    }
  } catch (err) {
    console.log('[Block] Local node unreachable');
  }

  try {
    // Fallback to mempool.space public API
    const response = await fetch('https://mempool.space/api/blocks/tip/height', {
      timeout: 5000,
    });
    if (response.ok) {
      const height = await response.text();
      return parseInt(height, 10);
    }
  } catch (err) {
    console.log('[Block] Mempool API unreachable');
  }

  // Fallback: return 0 (we'll still track it)
  return 0;
}

// Helper: load agents and look up pubkey by name
function loadAgents(): Record<string, any> {
  try {
    const agentsPath = '/home/deploy/agents/agents.json';
    const agentsData = JSON.parse(readFileSync(agentsPath, 'utf8'));
    return agentsData.agents || [];
  } catch (err) {
    console.log('[Agents] Failed to load agents.json');
    return [];
  }
}

// Helper: extract target gans from command (e.g., "add test >>@commy" -> "commy")
function extractTargetGans(content: string): { cleanContent: string; targetGans?: string } {
  const match = content.match(/>>@(\w+)$/);
  if (match) {
    const gansnaam = match[1];
    const cleanContent = content.replace(/\s*>>@\w+$/, '').trim();
    return { cleanContent, targetGans: gansnaam };
  }
  return { cleanContent: content };
}

// Helper: look up gans pubkey by name
function getGansPubkey(gansnaam: string): string | null {
  const agents = loadAgents();
  const agent = agents.find((a: any) => a.name.toLowerCase() === gansnaam.toLowerCase());
  return agent?.pubkey || null;
}

// Input validation
function validateTodoContent(content: string): { valid: boolean; error?: string } {
  const MAX_LENGTH = 500;
  const INVALID_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

  if (content.length === 0) {
    return { valid: false, error: 'Content cannot be empty' };
  }
  if (content.length > MAX_LENGTH) {
    return { valid: false, error: `Content too long (max ${MAX_LENGTH} chars)` };
  }
  if (INVALID_CHARS.test(content)) {
    return { valid: false, error: 'Invalid characters in content' };
  }

  return { valid: true };
}

// Parse and execute command from DM or socket
async function handleCommand(fromPubkey: string, content: string): Promise<string> {
  let actualFromPubkey = fromPubkey;

  // Check if command includes explicit pubkey: @pubkey:command
  const pubkeyMatch = content.match(/^@([a-f0-9]{64}):/);
  if (pubkeyMatch) {
    actualFromPubkey = pubkeyMatch[1];
    content = content.slice(pubkeyMatch[0].length);
  }

  // Rate limiting
  if (!checkRateLimit(actualFromPubkey)) {
    return '⏸️ Too many commands. Please wait a minute.';
  }

  const parts = content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  // Query user's TODOs
  const todos = await queryUserTodos(actualFromPubkey);

  switch (cmd) {
    case 'list':
      return commandList(todos);

    case 'add':
      if (!args) return 'Usage: add <content> [>>@gansnaam]';
      {
        console.log(`[Add] Raw args: "${args}"`);
        // Extract target gans if specified
        const { cleanContent, targetGans } = extractTargetGans(args);
        console.log(`[Add] Parsed - cleanContent: "${cleanContent}", targetGans: "${targetGans || 'none'}"`);

        if (!cleanContent) return 'Usage: add <content> [>>@gansnaam]';

        const validation = validateTodoContent(cleanContent);
        if (!validation.valid) {
          return `❌ ${validation.error}`;
        }

        // Determine target pubkey
        let targetPubkey = fromPubkey;
        let targetName = 'yourself';

        if (targetGans) {
          const gansPubkey = getGansPubkey(targetGans);
          if (!gansPubkey) {
            return `❌ Unknown gans: ${targetGans}`;
          }
          targetPubkey = gansPubkey;
          targetName = targetGans;
        }

        // Get current block number and publish TODO event
        const blocknr = await getCurrentBlocknr();
        const todoEvent = createTodoEvent(targetPubkey, cleanContent, [], blocknr);

        await pool.publish([RELAY_URL], todoEvent);
        const blockInfo = blocknr > 0 ? ` (block ${blocknr})` : '';
        return `✅ TODO added for ${targetName}: "${cleanContent}"${blockInfo}`;
      }

    case 'show': {
      const idStr = args;
      return commandShow(todos, idStr);
    }

    case 'done': {
      const idStr = args;
      const idx = parseInt(idStr, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= todos.length) {
        return `❌ Invalid ID. Use "list" to see your TODOs.`;
      }
      const todo = todos[idx];

      // Get current block and publish a done marker event
      const doneBlocknr = await getCurrentBlocknr();

      // Build tags BEFORE hashing
      const doneTags = [
        ['p', actualFromPubkey],
        ['e', todo.id, '', 'done'],
      ];
      if (doneBlocknr > 0) {
        doneTags.push(['done_blocknr', String(doneBlocknr)]);
      }

      const doneEvent = {
        id: '',
        kind: TODO_KIND,
        pubkey: toddy.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: doneTags,
        content: '', // Encrypted marker
        sig: '',
      };

      const conversationKey = nip44.getConversationKey(toddySk, actualFromPubkey);
      const encryptedContent = nip44.encrypt('DONE', conversationKey);
      doneEvent.content = encryptedContent;

      const hash = getEventHash(doneEvent as any);
      doneEvent.id = hash;
      const sig = finalizeEvent(doneEvent as any, toddySk);

      await pool.publish([RELAY_URL], sig);
      const blockInfo = doneBlocknr > 0 ? ` (block ${doneBlocknr})` : '';
      return `✅ ${todo.content}${blockInfo}`;
    }

    case 'delete': {
      const idStr = args;
      const idx = parseInt(idStr, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= todos.length) {
        return `❌ Invalid ID. Use "list" to see your TODOs.`;
      }
      const todo = todos[idx];

      // Get current block and publish a delete marker event
      const deleteBlocknr = await getCurrentBlocknr();

      // Build tags BEFORE hashing
      const deleteTags = [
        ['p', actualFromPubkey],
        ['e', todo.id, '', 'delete'],
      ];
      if (deleteBlocknr > 0) {
        deleteTags.push(['deleted_blocknr', String(deleteBlocknr)]);
      }

      const deleteEvent = {
        id: '',
        kind: TODO_KIND,
        pubkey: toddy.pubkey,
        created_at: Math.floor(Date.now() / 1000),
        tags: deleteTags,
        content: '', // Encrypted marker
        sig: '',
      };

      const conversationKey = nip44.getConversationKey(toddySk, actualFromPubkey);
      const encryptedContent = nip44.encrypt('DELETED', conversationKey);
      deleteEvent.content = encryptedContent;

      const hash = getEventHash(deleteEvent as any);
      deleteEvent.id = hash;
      const sig = finalizeEvent(deleteEvent as any, toddySk);

      await pool.publish([RELAY_URL], sig);
      const blockInfo = deleteBlocknr > 0 ? ` (block ${deleteBlocknr})` : '';
      return `🗑️ ${todo.content}${blockInfo}`;
    }

    case 'search':
      if (!args) return 'Usage: search <keyword>';
      {
        const matches = todos.filter((t) =>
          t.content.toLowerCase().includes(args.toLowerCase())
        );
        if (matches.length === 0) return `🔍 No matches for "${args}"`;
        const lines = matches
          .map((t, i) => {
            const content = t.content.length > 40 ? t.content.slice(0, 37) + '...' : t.content;
            const blockInfo = t.blocknr ? ` (block ${t.blocknr})` : '';
            return `${i + 1}. ${content}${blockInfo}`;
          })
          .join('\n');
        return `🔍 Results for "${args}":\n${lines}`;
      }

    case 'help':
      return commandHelp();

    default:
      return `❓ Unknown command "${cmd}". Type "help" for commands.`;
  }
}

// Listen for DMs (disabled for now — using CLI socket instead)
async function startListener() {
  console.log(`[Relay] DM listener disabled (using CLI socket interface instead)`);

  // TODO: Re-enable when SimplePool DM filtering is working
  // For now, all commands go through: toddy <cmd> [args]
  // which uses the Unix socket at /tmp/toddy.sock
}

// Listen for local socket commands (from CLI tool)
async function startSocketListener() {
  // Remove old socket if exists
  try {
    unlinkSync(SOCKET_PATH);
  } catch (err) {
    // File doesn't exist, that's fine
  }

  const server = net.createServer(async (socket) => {
    let buffer = '';
    let hasResponded = false;

    socket.on('data', async (data) => {
      if (hasResponded) {
        socket.end();
        return;
      }

      buffer += data.toString();

      // Process complete lines
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer

      for (const line of lines) {
        const input = line.trim();
        if (!input) continue;

        try {
          // Use Toddy's pubkey for local commands
          const reply = await handleCommand(toddy.pubkey, input);
          socket.write(`${reply}`);
          socket.end();
          hasResponded = true;
          return;
        } catch (err) {
          socket.write(`❌ Error: ${err}`);
          socket.end();
          hasResponded = true;
          return;
        }
      }
    });

    socket.on('end', () => {
      // Client disconnected
    });

    socket.on('error', (err) => {
      console.error('[Socket] Error:', err);
    });
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`[Socket] Listening on ${SOCKET_PATH}`);
  });

  server.on('error', (err) => {
    console.error('[Socket] Server error:', err);
  });
}

// Listen for local STDIN commands (only in interactive mode)
async function startStdinListener() {
  // Only start if stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) {
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
  });

  console.log('\n[CLI] Type commands (add, list, done, delete, search, help):');
  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    try {
      // Use Perry's pubkey as the default user for local commands
      const perryPubkey = toddy.pubkey; // For now, use Toddy's own pubkey as test user
      const reply = await handleCommand(perryPubkey, input);
      console.log(`${reply}\n`);
    } catch (err) {
      console.error(`❌ Error: ${err}\n`);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('[CLI] Exiting...');
    process.exit(0);
  });
}

// Main
async function main() {
  loadToddyKey();
  console.log('[✓] Toddy key loaded');

  // Initialize database
  try {
    await initDatabase();
  } catch (err) {
    console.error('[DB] Error initializing database:', err);
    process.exit(1);
  }

  // Warm up relay connection
  console.log('[Relay] Warming up connection...');
  try {
    const warmup = pool.querySync([RELAY_URL], { kinds: [999], limit: 1 });
    console.log(`[Relay] Warmup: got ${warmup?.length || 0} events`);
  } catch (err) {
    console.log('[Relay] Warmup failed (non-fatal)');
  }

  startListener();
  startStdinListener();
  startSocketListener();
  startServer(3333);

  console.log('[✓] Nostr TODO Bot started');
  console.log(`[✓] Send a DM to ${toddy.npub} to start using!`);
  console.log(`[✓] Local socket available at ${SOCKET_PATH}`);
  console.log('[✓] Web board available at http://localhost:3333');
}

main().catch(console.error);
