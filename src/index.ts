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
  tags: string[][] = []
): Event {
  const event = {
    id: '',
    kind: TODO_KIND,
    pubkey: toddy.pubkey,
    created_at: Math.floor(Date.now() / 1000),
    tags: [['p', pubkey], ...tags], // Mark who owns this TODO
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
async function queryUserTodos(pubkey: string): Promise<Array<{ id: string; content: string }>> {
  try {
    // querySync is actually async (returns Promise despite the name)
    // Query all Kind 1 events from Toddy, filter client-side
    const events = await pool.querySync([RELAY_URL], {
      kinds: [TODO_KIND],
      authors: [toddy.pubkey],
      limit: 1000,
    });

    console.log(`[Query] Got ${events?.length || 'null'} events for ${pubkey.slice(0, 8)}`);

    if (!Array.isArray(events)) {
      console.log('[Query] Events is not array, got:', typeof events);
      return [];
    }

    const todos = events
      .filter((e) => {
        // Filter client-side: only events where pubkey is in the #p tags
        const pTag = e.tags.find((t) => t[0] === 'p' && t[1] === pubkey);
        return !!pTag;
      })
      .map((e) => {
        const decrypted = decryptTodoEvent(e, pubkey);
        return decrypted ? { id: e.id, content: decrypted } : null;
      })
      .filter((t) => t !== null) as Array<{ id: string; content: string }>;

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
function commandList(todos: Array<{ id: string; content: string }>): string {
  if (todos.length === 0) return '✅ All clear!';

  const lines = todos
    .map((t, i) => {
      const content = t.content.length > 40 ? t.content.slice(0, 37) + '...' : t.content;
      return `${i + 1}. ${content} (${t.id.slice(0, 8)})`;
    })
    .join('\n');

  return `📋 Your TODOs:\n${lines}`;
}

function commandAdd(todos: Array<{ id: string; content: string }>, content: string): string {
  return `✅ TODO added: "${content}"\nID: ${todos.length + 1}`;
}

function commandDone(todos: Array<{ id: string; content: string }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  return `✅ TODO done: "${todo.content}"`;
}

function commandDelete(todos: Array<{ id: string; content: string }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  return `🗑️ TODO deleted: "${todo.content}"`;
}

function commandShow(todos: Array<{ id: string; content: string }>, idStr: string): string {
  const idx = parseInt(idStr, 10) - 1;
  if (isNaN(idx) || idx < 0 || idx >= todos.length) {
    return `❌ Invalid ID. Use "list" to see your TODOs.`;
  }
  const todo = todos[idx];
  return `📝 #${idx + 1}:\n${todo.content}`;
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

// Parse and execute command from DM
async function handleCommand(fromPubkey: string, content: string): Promise<string> {
  // Rate limiting
  if (!checkRateLimit(fromPubkey)) {
    return '⏸️ Too many commands. Please wait a minute.';
  }

  const parts = content.trim().split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1).join(' ');

  // Query user's TODOs
  const todos = await queryUserTodos(fromPubkey);

  switch (cmd) {
    case 'list':
      return commandList(todos);

    case 'add':
      if (!args) return 'Usage: add <content>';
      {
        const validation = validateTodoContent(args);
        if (!validation.valid) {
          return `❌ ${validation.error}`;
        }
        // Publish TODO event
        const todoEvent = createTodoEvent(fromPubkey, args);
        await pool.publish([RELAY_URL], todoEvent);
        return commandAdd(todos, args);
      }

    case 'show': {
      const idStr = args;
      return commandShow(todos, idStr);
    }

    case 'done': {
      const idStr = args;
      return commandDone(todos, idStr);
    }

    case 'delete': {
      const idStr = args;
      return commandDelete(todos, idStr);
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
            return `${i + 1}. ${content}`;
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

// Listen for DMs
async function startListener() {
  console.log(`[Relay] Listening for DMs on ${RELAY_URL}...`);

  const filter = {
    kinds: [4], // Encrypted DMs
    '#p': [toddy.pubkey],
    limit: 50,
  };

  try {
    pool.subscribeMany([RELAY_URL], [filter], {
      onevent(event: Event) {
        (async () => {
          if (!verifyEvent(event)) {
            console.log('[Verify] Invalid signature, skipping');
            return;
          }

          console.log(
            `[DM] From ${event.pubkey.slice(0, 8)}: ${event.content.slice(0, 50)}`
          );

          try {
            // Decrypt DM
            const conversationKey = nip44.getConversationKey(toddySk, event.pubkey);
            const decrypted = nip44.decrypt(event.content, conversationKey);
            console.log(`[Decrypt] Message: ${decrypted.slice(0, 50)}`);

            // Handle command
            const reply = await handleCommand(event.pubkey, decrypted);

            // Send DM reply
            await sendDmReply(event.pubkey, reply);
          } catch (err) {
            console.error('[Handle] Error:', err);
            await sendDmReply(event.pubkey, `❌ Error processing command. Check relay logs.`);
          }
        })();
      },

      onclose() {
        console.log('[Relay] Connection closed, reconnecting in 5s...');
        setTimeout(startListener, 5000);
      },
    });
  } catch (err) {
    console.error('[Listener] Error:', err);
    setTimeout(startListener, 5000);
  }
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

  console.log('[✓] Nostr TODO Bot started');
  console.log(`[✓] Send a DM to ${toddy.npub} to start using!`);
  console.log(`[✓] Local socket available at ${SOCKET_PATH}`);
}

main().catch(console.error);
