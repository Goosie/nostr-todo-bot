import 'websocket-polyfill';
import { readFileSync } from 'fs';
import { resolve } from 'path';
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
const TODO_KIND = 1; // Kind 1 for encrypted TODO storage

// Load Toddy's key
let toddy: { pubkey: string; nsecHex: string; npub: string };
let toddySk: Uint8Array;

function loadToddyKey() {
  const keyData = JSON.parse(readFileSync(TODDY_KEY_PATH, 'utf8'));
  toddy = keyData;
  toddySk = new Uint8Array(Buffer.from(toddy.nsecHex, 'hex'));
  console.log(`[Toddy] Loaded pubkey: ${toddy.pubkey}`);
}

// Relay and pool
const pool = new SimplePool();

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
  const encryptedContent = nip44.encrypt(toddySk, pubkey, content);
  event.content = encryptedContent;

  const hash = getEventHash(event as any);
  event.id = hash;
  const sig = finalizeEvent(event as any, toddySk);

  return sig;
}

// Decrypt a TODO event
function decryptTodoEvent(event: Event, pubkey: string): string | null {
  try {
    return nip44.decrypt(toddySk, pubkey, event.content);
  } catch (err) {
    console.error('[Decrypt] Error:', err);
    return null;
  }
}

// Query TODOs for a user from relay
async function queryUserTodos(pubkey: string): Promise<Array<{ id: string; content: string }>> {
  try {
    const events = await pool.querySync([RELAY_URL], {
      kinds: [TODO_KIND],
      tags: { p: [pubkey] },
      authors: [toddy.pubkey],
      limit: 100,
    });

    const todos = events
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
    const encryptedContent = nip44.encrypt(toddySk, recipientPubkey, message);
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

// Parse and execute command from DM
async function handleCommand(fromPubkey: string, content: string): Promise<string> {
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
      // Publish TODO event
      const todoEvent = createTodoEvent(fromPubkey, args);
      await pool.publish([RELAY_URL], todoEvent);
      return commandAdd(todos, args);

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
            const decrypted = nip44.decrypt(toddySk, event.pubkey, event.content);
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

// Main
async function main() {
  loadToddyKey();
  console.log('[✓] Toddy key loaded');

  startListener();

  console.log('[✓] Nostr TODO Bot started');
  console.log(`[✓] Send a DM to ${toddy.npub} to start using!`);
}

main().catch(console.error);
